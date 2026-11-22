'use strict';
const mkTmp = require('./tmpdir');
/* luci-app-vantage-traffic's rpcd plugin (root/usr/share/rpcd/ucode/
   luci.vantage-traffic, #110): per-host byte counters from the kernel's
   connection accounting, read from /proc/net/nf_conntrack.

   What it must do: know an entry again however its timeout and state
   move, count both directions the right way round (a host that opened
   the connection, one a port forward reaches, two hosts of this router's
   networks), find IPv6 hosts by the neighbour table's spelling, keep
   counters that only grow whoever reads, count a reset counter (nlbwmon's
   zero-on-read) from zero, follow an address the neighbour table does
   not give a host yet so that it does not count whole later, cap entries
   and hosts, say when accounting is off and when entries are offloaded,
   share one read among all callers for 5 s (30 s with Low-power router),
   stop reading the table after its time budget and wait longer after a
   slow read, and hand out nothing but MACs and byte counts.

   The real plugin runs under a host ucode binary ($UCODE, else `ucode` on
   PATH; skipped otherwise) with rtnl and uci replaced by the doubles in
   tests/ucode/traffic-stubs, its paths pointed at files written here and
   its clock driven by the test (tests/ucode/traffic-harness.uc). The
   table is text: nothing here touches a firewall. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'luci-app-vantage-traffic');
const PLUGIN = path.join(PKG, 'root/usr/share/rpcd/ucode/luci.vantage-traffic');
const BENCH = path.join(ROOT, 'dev/traffic/bench.uc');
const HARNESS = path.join(__dirname, 'ucode/traffic-harness.uc');
const STUBS = path.join(__dirname, 'ucode/traffic-stubs');

function findUcode() {
	const cands = [ process.env.UCODE ].concat((process.env.PATH || '').split(path.delimiter).map(d => d && path.join(d, 'ucode')));
	for (const c of cands) {
		if (!c) continue;
		try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (e) {}
	}
	return null;
}
const UCODE = findUcode();
const NO_UCODE = UCODE ? false : 'no ucode binary (set UCODE=/path/to/ucode)';

const CLOCK_FN = 'function now_ms() {\n\tlet t = clock(true);\n\treturn t[0] * 1000 + int(t[1] / 1000000);\n}';
const RETURN = "return { 'luci.vantage.traffic': methods };";

/* the plugin with its paths in dir, the test's clock and parse/norm handed out */
function pluginCopy(src, dir) {
	const swaps = [
		[ /^const TABLE = .*$/m, 'const TABLE = ' + JSON.stringify(path.join(dir, 'nf_conntrack')) + ';' ],
		[ /^const ACCT = .*$/m, 'const ACCT = ' + JSON.stringify(path.join(dir, 'acct')) + ';' ],
		[ CLOCK_FN, 'function now_ms() {\n\tglobal.CLOCK.reads++;\n\tlet t = global.CLOCK.t;\n\tglobal.CLOCK.t += global.CLOCK.step;\n\treturn t;\n}' ],
		[ RETURN, "return { 'luci.vantage.traffic': methods, test: { parse, norm } };" ]
	];
	for (const [ from, to ] of swaps) {
		const next = src.replace(from, () => to);
		assert.notEqual(next, src, 'the test can change ' + from);
		src = next;
	}
	return src;
}

/* runs the harness on the plugin (or an altered source of it): its output, parsed */
function run(input, source) {
	const dir = mkTmp('vantage-traffic-');
	const copy = path.join(dir, 'plugin.uc'), inp = path.join(dir, 'input.json');
	fs.writeFileSync(copy, pluginCopy(source == null ? fs.readFileSync(PLUGIN, 'utf8') : source, dir));
	fs.writeFileSync(inp, JSON.stringify(input));
	const r = spawnSync(UCODE, [ '-L', STUBS, '-D', 'PLUGIN=' + copy, '-D', 'INPUT=' + inp, '-D', 'TABLE=' + path.join(dir, 'nf_conntrack'),
		'-D', 'ACCT=' + path.join(dir, 'acct'), HARNESS ], { encoding: 'utf8', maxBuffer: 64 << 20 });
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout);
}

/* one line as the kernel prints it ("%-8s %u %-8s %u %ld "), accounting on */
const PROTO = { tcp: 6, udp: 17, icmp: 1, unknown: 47 };
function line(o) {
	const name = o.proto || 'tcp';
	const head = (o.v6 ? 'ipv6     10 ' : 'ipv4     2 ') + name.padEnd(8) + ' ' + (o.num != null ? o.num : PROTO[name]) + ' ' +
		(o.timeout || 7438) + ' ' + (o.state === undefined ? 'ESTABLISHED ' : o.state ? o.state + ' ' : '');
	const ports = o.sport != null ? ` sport=${o.sport} dport=${o.dport}` : '', back = o.sport != null ? ` sport=${o.dport} dport=${o.sport}` : '';
	const orig = `src=${o.src} dst=${o.dst}${ports}` + (o.acct === false ? '' : ` packets=1 bytes=${o.ob}`);
	const reply = `src=${o.rsrc} dst=${o.rdst}${back}` + (o.acct === false ? '' : ` packets=1 bytes=${o.rb}`);
	/* the kernel prints [HW_OFFLOAD] or [OFFLOAD] in place of [ASSURED] */
	return `${head}${orig}${o.unreplied ? ' [UNREPLIED]' : ''} ${reply} ${o.hw ? '[HW_OFFLOAD]' : o.offload ? '[OFFLOAD]' : '[ASSURED]'} mark=0 zone=0 use=2`;
}
const at = (o, x) => Object.assign({}, o, x);

const M1 = '00:00:5e:00:53:01', M2 = '00:00:5e:00:53:02', M3 = '00:00:5e:00:53:03';
const V6A = '2001:0db8:0000:0000:0000:0000:0000:0010', V6R = '2001:0db8:0001:0000:0000:0000:0000:0005';
/* the neighbour tables as rtnl dumps them: two networks of this router, IPv6 in its short form */
const n4 = (dst, lladdr, state) => ({ family: 2, dev: 'br-lan', dst, lladdr, state: state == null ? 2 : state });
const n6 = (dst, lladdr, state) => ({ family: 10, dev: 'br-lan', dst, lladdr, state: state == null ? 4 : state });
const NEIGH = { 2: [ n4('192.0.2.10', M1), n4('192.0.2.20', M2), n4('198.51.100.30', M3), n4('203.0.113.254', '00:00:5e:00:53:fe') ], 10: [ n6('2001:db8::10', M1) ] };

const OUT = { src: '192.0.2.10', dst: '203.0.113.5', sport: 40000, dport: 443, rsrc: '203.0.113.5', rdst: '203.0.113.200' };
const SIX = { v6: true, src: V6A, dst: V6R, sport: 40001, dport: 443, rsrc: V6R, rdst: V6A };
/* a port forward: opened from outside, the host is the reply's source */
const FWD = { src: '203.0.113.9', dst: '203.0.113.200', sport: 50000, dport: 8443, rsrc: '192.0.2.20', rdst: '203.0.113.9' };
/* between two of this router's networks: both hosts count it */
const LAN = { src: '192.0.2.10', dst: '198.51.100.30', sport: 40002, dport: 445, rsrc: '198.51.100.30', rdst: '192.0.2.10' };
/* this router's own lookup: no host of its networks */
const OWN = { proto: 'udp', state: '', src: '203.0.113.200', dst: '203.0.113.53', sport: 40003, dport: 53, rsrc: '203.0.113.53', rdst: '203.0.113.200' };
const NEW = { src: '192.0.2.20', dst: '203.0.113.7', sport: 40004, dport: 443, rsrc: '203.0.113.7', rdst: '203.0.113.200' };

/* a call: the table, accounting on, the neighbours above, at `now` ms */
const call = (table, now, x) => Object.assign({ table, acct: '1\n', neigh: NEIGH, power: null, now }, x || {});
const calls = list => run({ mode: 'calls', calls: list });
const of = (r, mac) => r.reply.hosts.find(h => h.mac === mac);

/* a table of n made-up entries (a quarter IPv6) over m hosts, each 100
   bytes from its host and 1000 to it, k times over */
function table(n, m, k) {
	const out = [];
	for (let i = 0; i < n; i++) {
		const h = i % m, up = 1000 + i + k * 100, down = 5000 + i + k * 1000;
		if (i % 4 === 3) {
			const a = '2001:0db8:0000:0000:0000:0000:0000:' + (h + 1).toString(16).padStart(4, '0'), b = '2001:0db8:0001:0000:0000:0000:0000:' + (i % 250 + 1).toString(16).padStart(4, '0');
			out.push(line({ v6: true, src: a, dst: b, sport: 10000 + i, dport: 443, ob: up, rsrc: b, rdst: a, rb: down }));
		}
		else {
			const a = (h < 254 ? '192.0.2.' : '198.51.100.') + (h % 254 + 1), b = '203.0.113.' + (i % 250 + 1);
			out.push(line({ src: a, dst: b, sport: 10000 + i, dport: 443, ob: up, rsrc: b, rdst: '203.0.113.254', rb: down }));
		}
	}
	return out;
}
function neighOf(m) {
	const v4 = [], v6 = [];
	for (let h = 0; h < m; h++) {
		const mac = '02:00:5e:00:' + (h >> 8).toString(16).padStart(2, '0') + ':' + (h & 255).toString(16).padStart(2, '0');
		v4.push(n4((h < 254 ? '192.0.2.' : '198.51.100.') + (h % 254 + 1), mac));
		v6.push(n6('2001:db8::' + (h + 1).toString(16), mac));
	}
	return { 2: v4, 10: v6 };
}
const sum = (r, k) => r.reply.hosts.reduce((s, h) => s + h[k], 0);

test('traffic plugin: an entry keeps its key while its timeout and state move; the reply is the second src=', { skip: NO_UCODE }, () => {
	const [ a, b, c, d, e, f, g ] = run({ mode: 'parse', lines: [
		line(at(OUT, { ob: 1, rb: 2 })),
		line(at(OUT, { ob: 9, rb: 8, timeout: 12, state: 'TIME_WAIT' })),
		line(at(NEW, { ob: 3, rb: 0, unreplied: true, state: 'SYN_SENT' })),
		line(at(SIX, { ob: 5, rb: 6, offload: true })),
		line(at(OUT, { acct: false })),
		line(at(SIX, { ob: 5, rb: 6, hw: true })),
		'ipv4     2 tcp      6 7438 ESTABLISHED'
	] });
	assert.equal(a.key, b.key);
	assert.deepEqual([ a.osrc, a.obytes, a.rsrc, a.rbytes, a.acct, a.off, a.hw ], [ '192.0.2.10', 1, '203.0.113.5', 2, true, false, false ]);
	assert.deepEqual([ b.obytes, b.rbytes ], [ 9, 8 ]);
	assert.deepEqual([ c.obytes, c.rsrc, c.rbytes ], [ 3, '203.0.113.7', 0 ], 'unreplied: the reply has no bytes yet');
	assert.deepEqual([ d.osrc, d.off, d.hw ], [ V6A, true, false ]);
	assert.equal(e.acct, false, 'no bytes= with accounting off');
	assert.equal(e.key, a.key, 'the same entry without its counters');
	assert.deepEqual([ f.off, f.hw ], [ false, true ]);
	assert.equal(g, null);
	/* two protocols the kernel has no tracker for print the same name: their numbers tell them apart */
	const [ gre, ipip, tcp, udp ] = run({ mode: 'parse', lines: [
		line({ proto: 'unknown', num: 47, state: '', src: '192.0.2.10', dst: '203.0.113.5', rsrc: '203.0.113.5', rdst: '203.0.113.200', ob: 1, rb: 1 }),
		line({ proto: 'unknown', num: 4, state: '', src: '192.0.2.10', dst: '203.0.113.5', rsrc: '203.0.113.5', rdst: '203.0.113.200', ob: 1, rb: 1 }),
		line(at(OUT, { ob: 1, rb: 1 })),
		line(at(OUT, { proto: 'udp', state: '', ob: 1, rb: 1 }))
	] });
	assert.notEqual(gre.key, ipip.key);
	assert.notEqual(tcp.key, udp.key);
	assert.ok(!/7438|ESTABLISHED|bytes|packets/.test(tcp.key), tcp.key);
	const junk = run({ mode: 'parse', lines: [ '', 'ipv5 src=1', 'ipv4 src=', 'x'.repeat(5000), 'ipv4     2 tcp      6 1 src=192.0.2.1 dst=192.0.2.2 bytes=-5 src=192.0.2.2 bytes=99999999999999999999' ] });
	assert.deepEqual(junk.slice(0, 4), [ null, null, null, null ]);
	assert.deepEqual([ junk[4].obytes, junk[4].rbytes ], [ 0, 0 ], 'a count that is no count is 0');
});

test('traffic plugin: counters per MAC, the right way round, as this router counts them, and they only grow', { skip: NO_UCODE }, () => {
	const t1 = [ line(at(OUT, { ob: 1000, rb: 5000 })), line(at(SIX, { ob: 200, rb: 800 })), line(at(FWD, { ob: 300, rb: 3000 })),
		line(at(LAN, { ob: 100, rb: 50 })), line(at(OWN, { ob: 70, rb: 90 })), 'not a line' ];
	const t2 = [ line(at(OUT, { ob: 1500, rb: 9000, timeout: 7000 })),
		/* the IPv6 entry ended; the forward's counters were reset */
		line(at(FWD, { ob: 100, rb: 1000 })), line(at(LAN, { ob: 100, rb: 50 })), line(at(NEW, { ob: 10, rb: 20 })) ];
	const [ r1, r2, r3, r4, r5, r6 ] = calls([ call(t1, 0), call(t2, 5000),
		/* another viewer half a second later: the same answer, nothing read */
		call(t2, 5500),
		call(t2, 10000),
		/* ten minutes without traffic */
		call(t2, 10000 + 600001),
		call(t2, 10000 + 605001) ]);
	/* rx: from the host, tx: to it, as a port's counters */
	assert.deepEqual(r1.reply.hosts, [
		{ mac: M1, rx: 1000 + 200 + 100, tx: 5000 + 800 + 50 },
		{ mac: M2, rx: 3000, tx: 300 },
		{ mac: M3, rx: 50, tx: 100 }
	]);
	assert.deepEqual([ r1.reply.acct, r1.reply.entries, r1.reply.partial, r1.reply.zeroed ], [ true, 6, false, 0 ]);
	assert.deepEqual(of(r2, M1), { mac: M1, rx: 1300 + 500, tx: 5850 + 4000 });
	assert.deepEqual(of(r2, M2), { mac: M2, rx: 3000 + 1000 + 10, tx: 300 + 100 + 20 }, 'a reset counter counts from zero; a new entry whole');
	assert.deepEqual(of(r2, M3), of(r1, M3));
	assert.equal(r2.reply.zeroed, 1);
	assert.deepEqual(r3.reply, r2.reply, 'read again within 5 s: the last answer');
	assert.deepEqual([ r3.dumps, r3.uci, r3.clock ], [ 0, 0, 1 ], 'and nothing read for it');
	assert.deepEqual(r4.reply.hosts, r2.reply.hosts, 'the same table read again adds nothing');
	assert.notEqual(r4.reply.at, r2.reply.at);
	assert.deepEqual(r5.reply.hosts, [], 'ten minutes without traffic: gone');
	assert.deepEqual(r6.reply.hosts, [], 'and not back at 0 for its idle connections');
	/* nothing in any answer but MACs and counts */
	for (const r of [ r1, r2, r5 ]) {
		assert.deepEqual(Object.keys(r.reply).sort(), [ 'acct', 'at', 'dropped', 'entries', 'every', 'hosts', 'hw', 'low', 'offloaded', 'partial', 'slow', 'took', 'v', 'zeroed' ]);
		for (const h of r.reply.hosts) assert.deepEqual(Object.keys(h), [ 'mac', 'rx', 'tx' ]);
		assert.doesNotMatch(JSON.stringify(r.reply), /203\.0\.113|192\.0\.2|198\.51\.100|2001:|db8/i, 'no address of either end');
	}
});

test('traffic plugin: an address the neighbour table gives no host yet is followed, so it does not count whole later', { skip: NO_UCODE }, () => {
	const t = (ob, rb) => [ line(at(SIX, { ob, rb })) ];
	const none = { 2: [], 10: [] };
	const [ a, b ] = calls([ call(t(4000, 9000), 0, { neigh: none }), call(t(4100, 9500), 5000) ]);
	assert.deepEqual(a.reply.hosts, [], 'followed, not counted');
	assert.deepEqual(b.reply.hosts, [ { mac: M1, rx: 100, tx: 500 } ], 'from then on, not since it began');
	/* neighbour entries that name no host: failed, incomplete, without ARP, a group or empty MAC; a failed dump */
	const bad = { 2: [ n4('192.0.2.10', M1, 0x20), n4('192.0.2.10', M1, 0x01), n4('192.0.2.10', M1, 0x40), n4('192.0.2.10', '01:00:5e:00:53:01'),
		n4('192.0.2.10', '00:00:00:00:00:00'), n4('192.0.2.10', 'not a mac'), { dst: 7, lladdr: M1, state: 2 } ], 10: null };
	const [ c ] = calls([ call([ line(at(OUT, { ob: 1, rb: 1 })), line(at(SIX, { ob: 1, rb: 1 })) ], 0, { neigh: bad }) ]);
	assert.deepEqual([ c.reply.hosts, c.dumps ], [ [], 2 ]);
	/* a static entry (PERMANENT) and a stale one name their host */
	const [ d ] = calls([ call([ line(at(OUT, { ob: 1, rb: 2 })), line(at(SIX, { ob: 3, rb: 4 })) ], 0,
		{ neigh: { 2: [ n4('192.0.2.10', M1.toUpperCase(), 0x80) ], 10: [ n6('2001:db8::10', M2, 0x04) ] } }) ]);
	assert.deepEqual(d.reply.hosts, [ { mac: M1, rx: 1, tx: 2 }, { mac: M2, rx: 3, tx: 4 } ]);
});

test('traffic plugin: accounting off, no table, offloaded entries', { skip: NO_UCODE }, () => {
	const t = [ line(at(OUT, { ob: 1000, rb: 5000 })) ];
	const [ on, off, again ] = calls([ call(t, 0), call(t, 5000, { acct: '0\n' }), call(t, 10000) ]);
	assert.equal(on.reply.hosts.length, 1);
	assert.deepEqual([ off.reply.acct, off.reply.hosts, off.reply.entries, off.dumps ], [ false, [], 0, 0 ], 'switched off: the table is not read, nothing kept');
	assert.deepEqual(again.reply.hosts, [ { mac: M1, rx: 1000, tx: 5000 } ], 'on again: counted afresh');
	/* no switch to read: the entries decide */
	const [ bare ] = calls([ call([ line(at(OUT, { acct: false })) ], 0, { acct: null }) ]);
	assert.deepEqual([ bare.reply.acct, bare.reply.hosts, bare.reply.entries ], [ false, [], 1 ]);
	const [ known ] = calls([ call(t, 0, { acct: null }) ]);
	assert.equal(known.reply.acct, true);
	/* no connection tracking at all */
	const [ gone ] = calls([ call(null, 0, { acct: null }) ]);
	assert.deepEqual([ gone.reply.acct, gone.reply.hosts, gone.reply.entries ], [ null, [], 0 ]);
	const [ fl ] = calls([ call([ line(at(OUT, { ob: 1, rb: 1, offload: true })), line(at(SIX, { ob: 1, rb: 1, hw: true })), line(at(FWD, { ob: 1, rb: 1 })) ], 0) ]);
	assert.deepEqual([ fl.reply.offloaded, fl.reply.hw ], [ 1, 1 ]);
	assert.equal(fl.reply.hosts.length, 2, 'offloaded entries are counted all the same');
});

test('traffic plugin: at most 16384 entries a read and 512 hosts, nothing counted twice', { skip: NO_UCODE }, () => {
	const neigh = neighOf(300);
	const [ a, b, c ] = calls([ call(table(17000, 300, 0), 0, { neigh }), call(table(17000, 300, 1), 5000, { neigh }), call(table(17000, 300, 2), 10000, { neigh }) ]);
	assert.deepEqual([ a.reply.partial, a.reply.entries ], [ 'entries', 16384 ]);
	assert.deepEqual([ sum(b, 'rx') - sum(a, 'rx'), sum(b, 'tx') - sum(a, 'tx') ], [ 16384 * 100, 16384 * 1000 ], 'the entries read again add their growth only');
	assert.deepEqual([ sum(c, 'rx') - sum(b, 'rx'), sum(c, 'tx') - sum(b, 'tx') ], [ 16384 * 100, 16384 * 1000 ]);
	const [ many ] = calls([ call(table(4096, 600, 0), 0, { neigh: neighOf(600) }) ]);
	assert.equal(many.reply.hosts.length, 512);
	assert.ok(many.reply.dropped > 0);
	assert.equal(many.reply.partial, false);
});

test('traffic plugin: one read serves every caller for 5 s, 30 s with Low-power router', { skip: NO_UCODE }, () => {
	const t = [ line(at(OUT, { ob: 1000, rb: 5000 })) ];
	const r = calls([ call(t, 1000), call(t, 3000), call(t, 5499), call(t, 5500), call(t, 9999),
		call(t, 20000, { power: 'low' }), call(t, 35000, { power: 'low' }), call(t, 49499, { power: 'low' }), call(t, 49500, { power: 'low' }) ]);
	assert.deepEqual(r.map(x => x.reply.at), [ 1000, 1000, 1000, 5500, 5500, 20000, 20000, 20000, 49500 ],
		'a poll every 5 s gets a fresh read each time (the window less 500 ms for its jitter); every 30 s with Low-power router');
	assert.deepEqual(r.map(x => x.dumps), [ 2, 0, 0, 2, 0, 2, 0, 0, 2 ], 'a shared answer reads nothing');
	assert.deepEqual(r.map(x => [ x.reply.every, x.reply.low ]).filter((x, i) => [ 0, 5, 8 ].includes(i)), [ [ 5000, false ], [ 30000, true ], [ 30000, true ] ]);
	assert.equal(r[1].uci, 0, 'the Low-power option is read only for a read');
});

test('traffic plugin: the table is read for 500 ms at most; a slow read lengthens the wait before the next', { skip: NO_UCODE }, () => {
	/* each look at the clock: 10 ms on. A look every 64 entries: the 50th is past 500 ms */
	const big = table(5000, 100, 0), neigh = neighOf(100);
	const r = calls([ call(big, 0, { neigh, step: 10 }), call(big, 20000, { neigh, step: 10 }), call(big, 25000, { neigh, step: 10 }) ]);
	assert.deepEqual([ r[0].reply.partial, r[0].reply.entries ], [ 'time', 64 * 50 ]);
	assert.deepEqual([ r[0].reply.took, r[0].reply.slow, r[0].reply.every ], [ 510, true, 510 * 50 ], 'slower than 100 ms: the next read 50 times as late');
	assert.equal(r[1].reply.at, 0, 'shared until then');
	assert.equal(r[2].reply.at, 25000);
	/* entries a partial read did not reach: the next read that does counts their growth, not all they carried */
	const all = calls([ call(table(5000, 100, 0), 0, { neigh }), call(table(5000, 100, 1), 5000, { neigh, step: 10 }), call(table(5000, 100, 2), 30500, { neigh }) ]);
	assert.deepEqual(all.map(x => [ x.reply.partial, x.reply.entries ]), [ [ false, 5000 ], [ 'time', 3200 ], [ false, 5000 ] ]);
	assert.equal(sum(all[1], 'rx') - sum(all[0], 'rx'), 3200 * 100);
	assert.equal(sum(all[2], 'rx') - sum(all[1], 'rx'), 3200 * 100 + 1800 * 200, 'the 1800 the partial read missed: what they added since the read before');
	/* never read before, they count whole */
	const late = calls([ call(table(5000, 100, 0), 0, { neigh, step: 10 }), call(table(5000, 100, 1), 30000, { neigh }) ]);
	let whole = 0;
	for (let i = 3200; i < 5000; i++) whole += 1000 + i + 100;
	assert.equal(sum(late[1], 'rx') - sum(late[0], 'rx'), 3200 * 100 + whole);
	/* fast reads: 5 s; never more than two minutes */
	const quick = calls([ call(big, 0, { neigh, step: 1 }) ]);
	assert.deepEqual([ quick[0].reply.partial, quick[0].reply.slow, quick[0].reply.every ], [ false, false, 5000 ]);
	const stuck = calls([ call(big, 0, { neigh, step: 3000 }) ]);
	assert.deepEqual([ stuck[0].reply.entries, stuck[0].reply.took, stuck[0].reply.every ], [ 64, 6000, 120000 ]);
});

/* #134, as for the dashboard's plugin (tests/plugin.test.js): the module
   that may not load comes before the two LuCI's own script uses too */
const LUCI_SHARED = [ 'uci', 'ubus', 'fs' ];
function pluginImports() {
	const re = /^import\s+(?:\{([^}]*)\}|\*\s+as\s+\w+)\s+from\s+'([^']+)';/gm;
	return [ ...fs.readFileSync(PLUGIN, 'utf8').matchAll(re) ].map(m =>
		({ module: m[2], names: m[1] == null ? null : m[1].split(',').map(n => n.trim().split(/\s+/)[0]).filter(Boolean) }));
}

test('traffic plugin: imports uci and fs after every other module (#134)', () => {
	const mods = pluginImports().map(i => i.module);
	assert.deepEqual(mods, [ 'rtnl', 'uci', 'fs' ]);
	const first = mods.findIndex(m => LUCI_SHARED.includes(m));
	assert.deepEqual(mods.slice(first).filter(m => !LUCI_SHARED.includes(m)), [], 'imported after uci, ubus or fs: ' + mods.join(', '));
});

test('traffic plugin: a module that cannot load stops it before uci and fs are loaded (#134)', { skip: NO_UCODE }, () => {
	const load = fail => {
		const dir = mkTmp('vantage-trafficimp-');
		for (const { module, names } of pluginImports())
			fs.writeFileSync(path.join(dir, module + '.uc'), "'use strict';\n" + `push(global.LOADED, ${JSON.stringify(module)});\n` +
				(module === fail ? `die(${JSON.stringify(module + ' stand-in: cannot load')});\n` : '') + 'function f() {}\nconst C = {};\n' +
				`export { ${(names || [ 'request' ]).map(n => 'f as ' + n).concat(names ? [] : [ "C as 'const'" ]).join(', ')} };\n`);
		const harness = path.join(dir, 'load.uc');
		fs.writeFileSync(harness, "'use strict';\nglobal.LOADED = [];\nlet err = null, obj = null;\n" +
			"try { obj = loadfile(PLUGIN, { raw_mode: true })()?.['luci.vantage.traffic']; } catch (e) { err = e.message; }\n" +
			"print(sprintf('%J\\n', { loaded: global.LOADED, err, methods: obj ? sort(keys(obj)) : null }));\n");
		const r = spawnSync(UCODE, [ '-L', dir, '-D', 'PLUGIN=' + PLUGIN, harness ], { encoding: 'utf8' });
		assert.equal(r.status, 0, r.stderr);
		return JSON.parse(r.stdout);
	};
	const ok = load(null);
	assert.deepEqual([ ok.loaded, ok.methods ], [ [ 'rtnl', 'uci', 'fs' ], [ 'hosts' ] ], ok.err);
	const r = load('rtnl');
	assert.match(String(r.err), /rtnl stand-in: cannot load/);
	assert.deepEqual([ r.loaded, r.methods ], [ [ 'rtnl' ], null ]);
});

test('traffic plugin: compiles as rpcd loads it; every regular expression is a module constant', { skip: NO_UCODE }, () => {
	const r = spawnSync(UCODE, [ '-L', STUBS, '-c', '-o', '/dev/null', PLUGIN ], { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	const bad = [];
	fs.readFileSync(PLUGIN, 'utf8').split('\n').forEach((l, i) => {
		const code = l.replace(/\/\/.*$/, '');
		if (/^const RE_[A-Z0-9_]+ = \//.test(code)) return;
		if (/(?:[(,=:!&|?]|\breturn)\s*\/(?![/*])/.test(code)) bad.push((i + 1) + ': ' + l.trim());
	});
	assert.deepEqual(bad, []);
});

/* dev/traffic/bench.uc runs on a router without the package: it carries
   the plugin's counting code, which must be the plugin's own */
test('traffic benchmark: its counting code is the plugin\'s, byte for byte', () => {
	const plugin = fs.readFileSync(PLUGIN, 'utf8'), bench = fs.readFileSync(BENCH, 'utf8');
	const block = (src, name) => {
		const m = new RegExp('^function ' + name + '\\([^)]*\\) \\{\\n[\\s\\S]*?\\n\\}$', 'm').exec(src);
		assert.ok(m, name);
		return m[0];
	};
	for (const name of [ 'now_ms', 'count', 'kv', 'parse', 'norm', 'add', 'feed' ]) assert.equal(block(bench, name), block(plugin, name), name);
	for (const c of [ 'MAX_ENTRIES', 'MAX_HOSTS', 'STOP_MS', 'CHECK_EVERY', 'KEEP_MS' ])
		assert.equal(new RegExp('^const ' + c + ' = .*$', 'm').exec(bench)[0], new RegExp('^const ' + c + ' = .*$', 'm').exec(plugin)[0], c);
	assert.doesNotMatch(bench, /^import .*'(rtnl|uci|ubus)'/m, 'only what a stock OpenWrt has: ucode and its fs module');
});

test('traffic benchmark: runs, writes only its own file and prints a line per size', { skip: NO_UCODE }, t => {
	const dir = mkTmp('vantage-trafficbench-');
	fs.writeFileSync(path.join(dir, 'kept'), 'x');
	const r = spawnSync(UCODE, [ BENCH, dir, '500', '2000' ], { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	const rows = r.stdout.split('\n').filter(l => /^\s*\d+ entries/.test(l));
	assert.equal(rows.length, 2, r.stdout);
	for (const l of rows) t.diagnostic(l.trim());
	assert.deepEqual(fs.readdirSync(dir), [ 'kept' ], 'its table removed, nothing else touched');
	const bad = spawnSync(UCODE, [ BENCH, path.join(dir, 'no-such-dir') ], { encoding: 'utf8' });
	assert.notEqual(bad.status, 0);
});
