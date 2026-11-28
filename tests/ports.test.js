'use strict';
/* A DSA switch chip's own byte counters for its ports (#156): the app's
   executable rpcd plugin luci.vantage.ports, which runs ethtool -S on
   each of the device's DSA ports; model.switchCounters, which checks its
   answer; model.rates, which never takes a rate across two sources; and
   the view, which asks every poll in a request of its own, stops asking
   where the first answer says there is nothing to get, and counts a
   port by its chip where it has its counters.

   The plugin runs as rpcd runs it, a ucode process with the arguments
   rpcd passes and the call's JSON on its standard input, under a host
   ucode binary ($UCODE, else `ucode` on PATH; skipped otherwise). Its
   copy here reads a /sys/class/net written by the test and runs a fake
   ethtool, a shell script of the test's that logs its arguments and
   prints what the test put there for the port: the test swaps the two
   path constants (and the clock) in the copy's text, as the other plugin
   tests do. The shipped plugin takes neither from its environment or its
   arguments, so nothing here can redirect it on a device. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mkTmp = require('./tmpdir');
const { load, RES } = require('./luci-stub');

const ROOT = path.join(__dirname, '..');
const PLUGIN = path.join(ROOT, 'luci-app-vantage/root/usr/libexec/rpcd/luci.vantage.ports');
const model = load('vantage.model');

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
function ucodeArgs() {
	const lib = UCODE && path.join(path.dirname(UCODE), '../lib/ucode');
	return lib && fs.existsSync(lib) ? [ '-L', lib ] : [];
}

const CLOCK_FN = 'function now_ms() {\n\tlet t = clock(true);\n\treturn t[0] * 1000 + int(t[1] / 1000000);\n}';

/* ethtool -S as the kernel's DSA core makes it: its four counters of the CPU's path first, then the driver's */
const nic = (pairs, core) => 'NIC statistics:\n' + (core === false ? [] : [ [ 'tx_packets', 10 ], [ 'tx_bytes', 1000 ], [ 'rx_packets', 20 ], [ 'rx_bytes', 2000 ] ])
	.concat(pairs).map(([ k, v ]) => '     ' + k + ': ' + v + '\n').join('');
const MT7530 = (rx, tx) => nic([ [ 'TxDrop', 0 ], [ 'TxCrcErr', 0 ], [ 'TxUnicast', 5 ], [ 'TxBytes', tx ], [ 'RxDrop', 0 ], [ 'RxUnicast', 7 ], [ 'RxBytes', rx ], [ 'RxCtrlDrop', 0 ] ]);

/* A directory with the plugin's copy, a /sys/class/net and the fake
   ethtool. o.ports: { name: uevent text } (a DSA port's by default);
   o.out: { port: what ethtool prints }; o.code: { port: its exit code };
   o.ethtool: false for none, 'plain' for a file that is not executable;
   o.sleep: { port: s ethtool waits before it prints, then notes the port in slept };
   o.step: ms the copy's clock moves at each reading. The copy's lock is in
   run/ (DIR), which it makes; root's there is this process's account, or o.uid */
function setup(o) {
	o = o || {};
	const dir = mkTmp('vantage-ports-');
	assert.match(dir, /^[A-Za-z0-9_/.-]+$/, 'a path the copy can hand to /bin/sh as it is');
	const net = path.join(dir, 'net'), bin = path.join(dir, 'bin', 'ethtool');
	fs.mkdirSync(net);
	fs.mkdirSync(path.join(dir, 'bin'));
	fs.mkdirSync(path.join(dir, 'out'));
	fs.mkdirSync(path.join(dir, 'code'));
	fs.mkdirSync(path.join(dir, 'sleep'));
	for (const [ port, sec ] of Object.entries(o.sleep || {})) fs.writeFileSync(path.join(dir, 'sleep', port), String(sec));
	for (const [ name, uevent ] of Object.entries(o.ports || {})) {
		fs.mkdirSync(path.join(net, name));
		fs.writeFileSync(path.join(net, name, 'uevent'), uevent == null ? 'DEVTYPE=dsa\nINTERFACE=' + name + '\nIFINDEX=9\n' : uevent);
	}
	for (const [ port, text ] of Object.entries(o.out || {})) fs.writeFileSync(path.join(dir, 'out', port), text);
	for (const [ port, code ] of Object.entries(o.code || {})) fs.writeFileSync(path.join(dir, 'code', port), String(code));
	if (o.ethtool !== false) {
		fs.writeFileSync(bin, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> \'' + dir + '/calls\'\n[ "$#" -eq 2 ] && [ "$1" = -S ] || exit 64\n' +
			'[ -f \'' + dir + '/sleep/\'"$2" ] && { sleep "$(cat \'' + dir + '/sleep/\'"$2")"; printf \'%s\\n\' "$2" >> \'' + dir + '/slept\'; }\n' +
			'[ -f \'' + dir + '/out/\'"$2" ] || exit 1\ncat \'' + dir + '/out/\'"$2" && printf \'%s\\n\' "$2" >> \'' + dir + '/finished\'\n' +
			'[ -f \'' + dir + '/code/\'"$2" ] && exit "$(cat \'' + dir + '/code/\'"$2")"\nexit 0\n', { mode: o.ethtool === 'plain' ? 0o644 : 0o755 });
	}
	/* a swconfig switch (#166): o.board, the device's board.json (none: no such file); o.mib: { 'switch0.1': what
	   swconfig prints for that port }; o.mibCode: its exit code; o.swconfig: false for none, 'plain' for not executable.
	   The fake logs its arguments to swcalls and takes nothing but "dev <switch> port <n> get mib" */
	const swbin = path.join(dir, 'bin', 'swconfig'), board = path.join(dir, 'board.json');
	fs.mkdirSync(path.join(dir, 'mib'));
	fs.mkdirSync(path.join(dir, 'mibcode'));
	if (o.board !== undefined) fs.writeFileSync(board, typeof o.board === 'string' ? o.board : JSON.stringify(o.board));
	for (const [ port, text ] of Object.entries(o.mib || {})) fs.writeFileSync(path.join(dir, 'mib', port), text);
	for (const [ port, code ] of Object.entries(o.mibCode || {})) fs.writeFileSync(path.join(dir, 'mibcode', port), String(code));
	if (o.swconfig !== false) {
		fs.writeFileSync(swbin, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> \'' + dir + '/swcalls\'\n' +
			'[ "$#" -eq 6 ] && [ "$1" = dev ] && [ "$3" = port ] && [ "$5 $6" = "get mib" ] || exit 64\n' +
			'[ -f \'' + dir + '/mib/\'"$2.$4" ] || exit 1\ncat \'' + dir + '/mib/\'"$2.$4"\n' +
			'[ -f \'' + dir + '/mibcode/\'"$2.$4" ] && exit "$(cat \'' + dir + '/mibcode/\'"$2.$4")"\nexit 0\n', { mode: o.swconfig === 'plain' ? 0o644 : 0o755 });
	}
	let src = fs.readFileSync(PLUGIN, 'utf8');
	for (const [ from, to ] of [
		[ /^const NET = .*$/m, 'const NET = ' + JSON.stringify(net) + ';' ],
		[ /^const ETHTOOL = .*$/m, 'const ETHTOOL = ' + JSON.stringify(bin) + ';' ],
		[ /^const SWCONFIG = .*$/m, 'const SWCONFIG = ' + JSON.stringify(swbin) + ';' ],
		[ /^const BOARD = .*$/m, 'const BOARD = ' + JSON.stringify(board) + ';' ],
		[ /^const DIR = .*$/m, 'const DIR = ' + JSON.stringify(path.join(dir, 'run')) + ';' ],
		[ /st\.uid === 0/, 'st.uid === ' + (o.uid == null ? process.getuid() : o.uid) ],
		[ CLOCK_FN, 'let ticks = 0;\nfunction now_ms() {\n\treturn ' + o.step + ' * ticks++;\n}' ]
	].slice(0, o.step == null ? 6 : 7)) {
		const next = src.replace(from, () => to);
		assert.notEqual(next, src, 'the test can change ' + from);
		src = next;
	}
	fs.writeFileSync(path.join(dir, 'plugin.uc'), src);
	return dir;
}
/* the copy run as rpcd runs it: what it printed, the arguments the fake ethtool was given (a run a line) and the ports
   whose output it wrote out whole (finished: the plugin read on to its end) */
function exec(dir, argv, input) {
	const r = spawnSync(UCODE, ucodeArgs().concat([ path.join(dir, 'plugin.uc') ], argv), { cwd: dir, encoding: 'utf8', timeout: 30000, input: input == null ? '{ "ubus_rpc_session": "x" }' : input });
	assert.equal(r.status, 0, r.stderr);
	const lines = f => fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean) : [];
	return { out: r.stdout, calls: lines('calls'), finished: lines('finished'), swcalls: lines('swcalls') };
}
/* a call's answer, each port's read time (at: ms on the monotonic clock, every port has one) taken out into ats */
function counters(o, input) {
	const r = exec(setup(o), [ 'call', 'counters' ], input), a = JSON.parse(r.out), ats = {};
	for (const [ n, p ] of Object.entries(a.ports)) {
		assert.ok(Number.isInteger(p.at) && p.at >= 0, n + ': its read time');
		ats[n] = p.at;
		delete p.at;
	}
	for (const [ sw, ports ] of Object.entries(a.switches || {})) for (const [ n, p ] of Object.entries(ports)) {
		assert.ok(Number.isInteger(p.at) && p.at >= 0, sw + ' ' + n + ': its read time');
		ats[sw + ':' + n] = p.at;
		delete p.at;
	}
	return Object.assign(a, { calls: r.calls, finished: r.finished, swcalls: r.swcalls, ats });
}
const lines = (dir, f) => fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean) : [];
async function until(what, ok) {
	for (let i = 0; i < 300 && !ok(); i++) await new Promise(r => setTimeout(r, 20));
	assert.ok(ok(), what);
}
const without = (r, ...keys) => { const c = Object.assign({}, r); for (const k of keys) delete c[k]; return c; };

/* ------------------------------------------------------------ plugin */

test('plugin: rpcd\'s list names one method that takes nothing, and starts no program', { skip: NO_UCODE }, () => {
	const dir = setup({ ports: { lan1: null }, out: { lan1: MT7530(1, 2) } });
	const r = exec(dir, [ 'list' ]);
	assert.equal(r.out, '{ "counters": {} }\n');
	assert.deepEqual(JSON.parse(r.out), { counters: {} });
	assert.deepEqual(r.calls, []);
	/* any other method rpcd could not have registered: nothing printed, nothing run */
	assert.deepEqual(exec(dir, [ 'call', 'port' ]), { out: '', calls: [], finished: [], swcalls: [] });
	assert.deepEqual(exec(dir, []), { out: '', calls: [], finished: [], swcalls: [] });
});

test('plugin: mt7530\'s counters, not the four of the CPU\'s path the DSA core puts first; whatever the call carries', { skip: NO_UCODE }, () => {
	const o = { ports: { lan1: null, lan2: null, wan: null, eth0: 'INTERFACE=eth0\nIFINDEX=2\n', 'br-lan': 'DEVTYPE=bridge\nINTERFACE=br-lan\nIFINDEX=7\n' },
		out: { lan1: MT7530(74382564128, 131657591122), lan2: MT7530(0, 0), wan: MT7530(5, 6) } };
	const r = counters(o);
	assert.deepEqual(without(r, 'took', 'finished', 'ats'), {
		v: 1, state: 'ok', more: false, calls: [ '-S lan1', '-S lan2', '-S wan' ], swcalls: [],
		ports: { lan1: { rx_bytes: 74382564128, tx_bytes: 131657591122 }, lan2: { rx_bytes: 0, tx_bytes: 0 }, wan: { rx_bytes: 5, tx_bytes: 6 } }
	});
	assert.equal(typeof r.took, 'number');
	/* the arguments rpcd writes to its standard input, a port's name among them, change nothing */
	for (const input of [ '{ "port": "-x", "ubus_rpc_session": "x" }', '{ "name": "eth0; reboot" }', '' ])
		assert.deepEqual(without(counters(o, input), 'took', 'finished', 'ats'), without(r, 'took', 'finished', 'ats'), input);
});

test('plugin: each verified driver\'s pair of names; the first pair found counts', { skip: NO_UCODE }, () => {
	const rows = {
		qca: nic([ [ 'RxBroad', 1 ], [ 'RxGoodByte', 300 ], [ 'RxBadByte', 7 ], [ 'TxByte', 400 ], [ 'TXUnicast', 3 ] ]),
		mv: nic([ [ 'in_good_octets', 500 ], [ 'in_bad_octets', 9 ], [ 'out_octets', 600 ], [ 'out_octets_a', 1 ] ]),
		b53: nic([ [ 'TxOctets', 800 ], [ 'TxDropPkts', 0 ], [ 'RxOctets', 700 ], [ 'RxGoodOctets', 650 ] ]),
		gswip: nic([ [ 'Rx64BytePkts', 1 ], [ 'RxGoodBytes', 900 ], [ 'RxBadBytes', 1 ], [ 'TxGoodBytes', 1000 ] ]),
		rtl: nic([ [ 'IfInOctets', 1100 ], [ 'EtherStatsOctets', 9 ], [ 'IfOutOctets', 1200 ] ]),
		/* two pairs printed: the table's order decides */
		both: nic([ [ 'RxOctets', 1 ], [ 'TxOctets', 2 ], [ 'RxBytes', 3 ], [ 'TxBytes', 4 ] ])
	};
	const r = counters({ ports: Object.fromEntries(Object.keys(rows).map(k => [ k, null ])), out: rows });
	assert.deepEqual(r.ports, {
		b53: { rx_bytes: 700, tx_bytes: 800 }, both: { rx_bytes: 3, tx_bytes: 4 }, gswip: { rx_bytes: 900, tx_bytes: 1000 },
		mv: { rx_bytes: 500, tx_bytes: 600 }, qca: { rx_bytes: 300, tx_bytes: 400 }, rtl: { rx_bytes: 1100, tx_bytes: 1200 }
	});
});

test('plugin: names it does not know, half a pair, a name twice or a number too long: unknown, never the CPU\'s counters', { skip: NO_UCODE }, () => {
	const out = {
		/* rtl8365mb, felix, ...: drivers that give the kernel the chip's counters already */
		other: nic([ [ 'ifInOctets', 5 ], [ 'ifOutOctets', 6 ], [ 'rx_octets', 7 ], [ 'tx_octets', 8 ] ]),
		core: nic([]),
		half: nic([ [ 'RxBytes', 5 ] ]),
		twice: nic([ [ 'RxBytes', 5 ], [ 'TxBytes', 6 ], [ 'RxBytes', 7 ] ]),
		long: nic([ [ 'RxBytes', '18446744073709551615' ], [ 'TxBytes', 6 ] ]),
		junk: 'NIC statistics:\n     RxBytes 5\n\tTxBytes: 6\nRxBytes: x\n',
		spaced: nic([ [ 'RxBytes ', 5 ], [ 'TxBytes', 6 ] ])
	};
	const r = counters({ ports: Object.fromEntries(Object.keys(out).map(k => [ k, null ])), out });
	assert.deepEqual(r.state, 'ok');
	for (const k of Object.keys(out)) assert.deepEqual(r.ports[k], { error: 'unknown' }, k);
});

test('plugin: ethtool missing or not executable: no program started, and the answer says so', { skip: NO_UCODE }, () => {
	for (const ethtool of [ false, 'plain' ]) {
		const r = counters({ ports: { lan1: null, lan2: null }, out: { lan1: MT7530(1, 2) }, ethtool });
		assert.deepEqual(without(r, 'took', 'ats'), { v: 1, state: 'no-ethtool', more: false, ports: {}, calls: [], finished: [], swcalls: [] }, String(ethtool));
	}
});

test('plugin: no DSA port: no program started, whatever else the device has', { skip: NO_UCODE }, () => {
	for (const ports of [ {}, { eth0: 'INTERFACE=eth0\nIFINDEX=2\n', 'br-lan': 'DEVTYPE=bridge\nINTERFACE=br-lan\n', 'phy0-ap0': 'DEVTYPE=wlan\nINTERFACE=phy0-ap0\n',
		/* a line that only holds the word, and a uevent past what is read */
		lan9: 'xDEVTYPE=dsa\nDEVTYPE=dsax\n DEVTYPE=dsa\n', lan8: 'INTERFACE=lan8\n' + 'X'.repeat(600) + '\nDEVTYPE=dsa\n' } ]) {
		const r = counters({ ports, out: { eth0: MT7530(1, 2), lan9: MT7530(1, 2), lan8: MT7530(1, 2) } });
		assert.deepEqual(without(r, 'took', 'ats'), { v: 1, state: 'none', more: false, ports: {}, calls: [], finished: [], swcalls: [] }, Object.keys(ports).join());
	}
});

test('plugin: ethtool failing, printing something else, nothing, or far too much: failed, never part of it', { skip: NO_UCODE }, () => {
	/* a megabyte: more than the plugin reads and a pipe holds together, so ethtool cannot finish writing it */
	const lots = nic([ [ 'RxBytes', 5 ], [ 'TxBytes', 6 ] ]) + Array.from({ length: 60000 }, (_, i) => '     filler_' + i + ': ' + i + '\n').join('');
	assert.ok(lots.length > 1 << 20);
	const r = counters({
		ports: { exit1: null, garbage: null, empty: null, lots: null, gone: null, signalled: null, ok: null },
		out: { exit1: MT7530(1, 2), garbage: 'Cannot get stats strings information: Operation not supported\n', empty: '', lots, signalled: MT7530(1, 2), ok: MT7530(1, 2) },
		/* gone: no output file, the fake exits 1 as ethtool does for a device that went away */
		code: { exit1: 1, signalled: 141 }
	});
	assert.deepEqual(r.ports, {
		empty: { error: 'failed' }, exit1: { error: 'failed' }, garbage: { error: 'failed' }, gone: { error: 'failed' },
		lots: { error: 'failed' }, ok: { rx_bytes: 1, tx_bytes: 2 }, signalled: { error: 'failed' }
	});
	assert.equal(r.state, 'ok');
	assert.equal(r.calls.length, 7, 'each port once');
	/* the plugin stops reading at its cap: the run that prints a megabyte never gets to write it all */
	assert.ok(r.finished.includes('ok') && !r.finished.includes('lots'), r.finished.join());
});

test('plugin: a port name on disk that could be read as an option or a shell word never reaches ethtool', { skip: NO_UCODE }, () => {
	const hostile = [ '-S', '--help', '-lan1', 'lan1;touch PWNED', 'lan 1', '$(touch PWNED)', '`touch PWNED`', 'a|b', 'a&b', 'a>PWNED',
		'lan1\'', 'lan1"', 'a\\b', 'a*', '[a]', '~root', 'lan1\ntouch PWNED', 'a.b', '..x', 'x'.repeat(16), 'län1', '#x' ];
	const ports = Object.fromEntries(hostile.map(n => [ n, null ]).concat([ [ 'lan1', null ], [ 'lan-2', null ], [ 'port_3', null ] ]));
	const out = Object.fromEntries(hostile.map(n => [ n.replace(/\//g, '_'), MT7530(1, 2) ]).filter(([ n ]) => !n.includes('\n')).concat([ [ 'lan1', MT7530(1, 2) ], [ 'lan-2', MT7530(3, 4) ], [ 'port_3', MT7530(5, 6) ] ]));
	const dir = setup({ ports, out });
	const r = exec(dir, [ 'call', 'counters' ]), a = JSON.parse(r.out);
	assert.deepEqual(Object.keys(a.ports), [ 'lan-2', 'lan1', 'port_3' ]);
	assert.deepEqual(r.calls, [ '-S lan-2', '-S lan1', '-S port_3' ]);
	/* the copy runs in dir: whatever a name made the shell do would land there */
	assert.deepEqual(fs.readdirSync(dir).filter(f => /PWNED/.test(f)), [], 'nothing the names say was run');
});

test('plugin: at most 32 ports, in name order; more says there were others', { skip: NO_UCODE }, () => {
	const names = Array.from({ length: 40 }, (_, i) => 'lan' + String(i).padStart(2, '0'));
	const r = counters({ ports: Object.fromEntries(names.map(n => [ n, null ])), out: Object.fromEntries(names.map((n, i) => [ n, MT7530(i, i) ])) });
	assert.deepEqual(Object.keys(r.ports), names.slice(0, 32));
	assert.equal(r.more, true);
	assert.deepEqual(r.calls, names.slice(0, 32).map(n => '-S ' + n));
	assert.equal(counters({ ports: { lan1: null }, out: { lan1: MT7530(1, 2) } }).more, false);
});

test('plugin: after its time budget no port is read; the rest are said to be left out', { skip: NO_UCODE }, () => {
	const names = [ 'lan1', 'lan2', 'lan3', 'lan4', 'lan5' ];
	const o = { ports: Object.fromEntries(names.map(n => [ n, null ])), out: Object.fromEntries(names.map((n, i) => [ n, MT7530(i, i) ])) };
	/* the clock moves 400 ms at each reading: the start, then one before each port (400, 800, 1200 ...) */
	const r = counters(Object.assign({ step: 400 }, o));
	assert.deepEqual(r.ports, { lan1: { rx_bytes: 0, tx_bytes: 0 }, lan2: { rx_bytes: 1, tx_bytes: 1 }, lan3: { error: 'time' }, lan4: { error: 'time' }, lan5: { error: 'time' } });
	assert.deepEqual(r.calls, [ '-S lan1', '-S lan2' ]);
	assert.equal(r.took, 400 * 6);
	/* each port's time is the reading just before its ethtool, not the call's start */
	assert.deepEqual(r.ats, { lan1: 400, lan2: 800, lan3: 1200, lan4: 1600, lan5: 2000 });
	/* a budget spent before the first port: none read, and still an answer */
	assert.deepEqual(counters(Object.assign({ step: 1000 }, o)).calls, []);
});

test('plugin: one read at a time: a call that finds the lock held answers busy at once and starts nothing', { skip: NO_UCODE }, async () => {
	const o = { ports: { lan1: null, lan2: null }, out: { lan1: MT7530(1, 2), lan2: MT7530(3, 4) } };
	const dir = setup(o), held = path.join(dir, 'held'), run = path.join(dir, 'run');
	/* the first call makes the directory and the lock file: root's alone */
	assert.equal(JSON.parse(exec(dir, [ 'call', 'counters' ]).out).state, 'ok');
	assert.deepEqual([ fs.statSync(run).mode & 0o777, fs.readdirSync(run), fs.statSync(path.join(run, 'lock')).mode & 0o777, fs.statSync(path.join(run, 'lock')).size ], [ 0o700, [ 'lock' ], 0o600, 0 ]);
	fs.unlinkSync(path.join(dir, 'calls'));
	/* another process holds the lock, as a call that is reading does */
	const holder = require('child_process').spawn(UCODE, ucodeArgs().concat([ '-e', 'import { open, writefile } from "fs"; let f = open(' + JSON.stringify(path.join(run, 'lock')) +
		', "a"); f.lock("x"); writefile(' + JSON.stringify(held) + ', "1"); sleep(1500);' ]), { stdio: 'ignore' });
	await until('the lock is held', () => fs.existsSync(held));
	const t = Date.now(), busy = exec(dir, [ 'call', 'counters' ]);
	assert.ok(Date.now() - t < 1000, 'answered at once, not after the holder');
	assert.deepEqual(without(JSON.parse(busy.out), 'took'), { v: 1, state: 'busy', more: false, ports: {} });
	assert.deepEqual(busy.calls, [], 'no program started');
	await new Promise(r => holder.once('exit', r));
	const ok = exec(dir, [ 'call', 'counters' ]);
	assert.deepEqual([ JSON.parse(ok.out).state, ok.calls ], [ 'ok', [ '-S lan1', '-S lan2' ] ], 'free again once the holder is gone');
	/* nothing written but that empty file: the plugin's own is not touched */
	const before = fs.statSync(path.join(dir, 'plugin.uc'));
	exec(dir, [ 'call', 'counters' ]);
	assert.deepEqual([ fs.statSync(path.join(dir, 'plugin.uc')).mtimeMs, fs.statSync(path.join(dir, 'plugin.uc')).size ], [ before.mtimeMs, before.size ]);
	assert.deepEqual([ fs.readdirSync(run), fs.statSync(path.join(run, 'lock')).size ], [ [ 'lock' ], 0 ]);
});

/* The lock used to be on the plugin's own file, which any account may open for reading: one that held a lock on
   it kept every call busy, and an upgrade put another file in its place while a call still read */
test('plugin: a lock held on the plugin\'s own file stops no call; without a lock of its own to have, busy and nothing started', { skip: NO_UCODE }, async () => {
	const o = { ports: { lan1: null }, out: { lan1: MT7530(1, 2) } };
	const dir = setup(o), held = path.join(dir, 'held');
	const holder = require('child_process').spawn(UCODE, ucodeArgs().concat([ '-e', 'import { open, writefile } from "fs"; let f = open(' + JSON.stringify(path.join(dir, 'plugin.uc')) +
		', "r"); f.lock("x"); writefile(' + JSON.stringify(held) + ', "1"); sleep(30000);' ]), { stdio: 'ignore' });
	await until('the plugin\'s file is locked', () => fs.existsSync(held));
	const r = exec(dir, [ 'call', 'counters' ]);
	const gone = new Promise(resolve => holder.once('exit', resolve));
	holder.kill('SIGKILL');
	await gone;
	assert.deepEqual([ JSON.parse(r.out).state, r.calls ], [ 'ok', [ '-S lan1' ] ]);
	/* the directory not as the plugin makes it: open to others, a link, a file, another account's (on a router: not root's) */
	for (const [ make, uid ] of [
		[ d => { fs.mkdirSync(d); fs.chmodSync(d, 0o755); } ],
		[ d => { fs.mkdirSync(d + '-real', { mode: 0o700 }); fs.symlinkSync(d + '-real', d); } ],
		[ d => fs.writeFileSync(d, 'a file') ],
		[ d => fs.mkdirSync(d, { mode: 0o700 }), process.getuid() + 1 ]
	]) {
		const at = setup(Object.assign({ uid }, o)), run = path.join(at, 'run');
		make(run);
		const busy = exec(at, [ 'call', 'counters' ]);
		assert.deepEqual([ without(JSON.parse(busy.out), 'took'), busy.calls ], [ { v: 1, state: 'busy', more: false, ports: {} }, [] ]);
		if (fs.lstatSync(run).isDirectory()) assert.deepEqual(fs.readdirSync(run), [], 'no file made in it');
		if (fs.existsSync(run + '-real')) assert.deepEqual(fs.readdirSync(run + '-real'), []);
	}
	/* the lock file there and not to be opened (a directory under its name): busy as well */
	const blocked = setup(o);
	fs.mkdirSync(path.join(blocked, 'run', 'lock'), { recursive: true, mode: 0o700 });
	fs.chmodSync(path.join(blocked, 'run'), 0o700);
	const b = exec(blocked, [ 'call', 'counters' ]);
	assert.deepEqual([ JSON.parse(b.out).state, b.calls ], [ 'busy', [] ]);
});

test('plugin: the lock goes with a call rpcd kills, and stays while that call\'s ethtool still runs', { skip: NO_UCODE }, async () => {
	const dir = setup({ ports: { lan1: null, lan2: null }, out: { lan1: MT7530(1, 2), lan2: MT7530(3, 4) }, sleep: { lan1: 2 } });
	const call = () => require('child_process').spawn(UCODE, ucodeArgs().concat([ path.join(dir, 'plugin.uc'), 'call', 'counters' ]), { cwd: dir, stdio: 'ignore' });
	/* a call whose ethtool hangs (here: sleeps 2 s), killed as rpcd kills one after its timeout */
	const a = call();
	await until('its ethtool runs', () => lines(dir, 'calls').length === 1);
	const gone = new Promise(r => a.once('exit', r));
	a.kill('SIGKILL');
	await gone;
	/* the shell and ethtool it started hold the lock: no second ethtool meanwhile */
	assert.deepEqual([ JSON.parse(exec(dir, [ 'call', 'counters' ]).out).state, lines(dir, 'calls') ], [ 'busy', [ '-S lan1' ] ]);
	await until('that ethtool ended', () => lines(dir, 'slept').length === 1);
	await until('the lock is free', () => JSON.parse(exec(dir, [ 'call', 'counters' ]).out).state === 'ok');
	/* a call killed with nothing of its own left running frees the lock at once */
	fs.unlinkSync(path.join(dir, 'sleep', 'lan1'));
	const held = path.join(dir, 'held');
	const holder = require('child_process').spawn(UCODE, ucodeArgs().concat([ '-e', 'import { open, writefile } from "fs"; let f = open(' + JSON.stringify(path.join(dir, 'run', 'lock')) +
		', "a"); f.lock("xn"); writefile(' + JSON.stringify(held) + ', "1"); sleep(30000);' ]), { stdio: 'ignore' });
	await until('the lock is held', () => fs.existsSync(held));
	assert.equal(JSON.parse(exec(dir, [ 'call', 'counters' ]).out).state, 'busy');
	const killed = new Promise(r => holder.once('exit', r));
	holder.kill('SIGKILL');
	await killed;
	assert.equal(JSON.parse(exec(dir, [ 'call', 'counters' ]).out).state, 'ok');
});

/* ------------------------------------------------------------- model */

/* ------------------------------------------------- swconfig (#166) */

/* board.json of a router with a swconfig switch: the CPU's port 0 on eth0, WAN on 1, LAN on 2 to 5 */
const BOARD = { switch: { switch0: { enable: true, reset: true, ports: [ { num: 0, device: 'eth0', need_tag: false, want_untag: false },
	{ num: 1, role: 'wan' }, { num: 2, role: 'lan', index: 1 }, { num: 3, role: 'lan', index: 2 }, { num: 4, role: 'lan', index: 3 }, { num: 5, role: 'lan', index: 4 } ] } } };
/* no real board: five WAN ports, for five reads in one call */
const WAN5 = { switch: { switch0: { ports: [ { num: 0, device: 'eth0' } ].concat([ 1, 2, 3, 4, 5 ].map(num => ({ num, role: 'wan' }))) } } };
/* what "swconfig dev switch0 port N get mib" prints: ar8xxx as OpenWrt 25.12 has it (the reporter's), with its sizes */
const AR8 = (rx, tx) => 'MIB counters\nRxGoodByte  : ' + rx + ' (132.9 GiB)\nTxByte      : ' + tx + ' (11.3 GiB)\n';

test('plugin: a swconfig switch\'s WAN port, read with "swconfig dev <switch> port <n> get mib": one program a call; no LAN port, never the CPU\'s', { skip: NO_UCODE }, () => {
	const mib = { 'switch0.1': AR8('142801579826', '12169709114'), 'switch0.2': AR8(10, 20), 'switch0.3': 'No MIB data\n', 'switch0.4': AR8(1, 2), 'switch0.5': AR8(3, 4), 'switch0.0': AR8(9, 9) };
	const r = counters({ board: BOARD, mib });
	assert.deepEqual(without(r, 'took', 'ats', 'finished'), { v: 1, state: 'ok', more: false, ports: {}, calls: [],
		swcalls: [ 'dev switch0 port 1 get mib' ], switches: { switch0: { 1: { rx_bytes: 142801579826, tx_bytes: 12169709114 } } } });
	assert.deepEqual(Object.keys(r.ats), [ 'switch0:1' ]);
	/* a counter the chip has not moved yet */
	assert.deepEqual(counters({ board: WAN5, mib }).switches.switch0[3], { rx_bytes: 0, tx_bytes: 0 });
	/* white space around the board file's object is none of its text */
	assert.deepEqual(counters({ board: '\n ' + JSON.stringify(BOARD) + '\n\n', mib }).swcalls, [ 'dev switch0 port 1 get mib' ]);
	/* the role as board.json writes it and nothing like it; a CPU port never, whatever its role */
	const odd = { switch: { switch0: { ports: [ { num: 0, device: 'eth0', role: 'wan' }, { num: 1, role: 'WAN' }, { num: 2, role: [ 'wan' ] }, { num: 3, role: 'wan6' }, { num: 4 }, { num: 5, role: 'wan' } ] } } };
	assert.deepEqual(counters({ board: odd, mib }).swcalls, [ 'dev switch0 port 5 get mib' ]);
});

test('plugin: each swconfig driver\'s pair of names; ethtool\'s names alone are none of swconfig\'s', { skip: NO_UCODE }, () => {
	const mib = (pairs, head) => (head === undefined ? 'Port 1 MIB counters\n' : head) + pairs.map(([ k, v ]) => (k + ' '.repeat(36)).slice(0, Math.max(k.length, 20)) + ': ' + v + '\n').join('');
	const out = {
		'switch0.1': AR8(11, 12),
		/* b53 prints no heading */
		'switch0.2': mib([ [ 'TxOctets', 22 ], [ 'TxDropPkts', 0 ], [ 'RxOctets', 21 ] ], ''),
		'switch0.3': mib([ [ 'IfInOctets', 31 ], [ 'EtherStatsOctets', 99 ], [ 'IfOutOctets', 32 ] ]),
		'switch0.4': mib([ [ 'ifInOctets', 41 ], [ 'ifOutOctets', 42 ] ]),
		/* mt7530's and the Marvell names are ethtool's (DSA): not known from swconfig */
		'switch0.5': mib([ [ 'RxBytes', 51 ], [ 'TxBytes', 52 ], [ 'in_good_octets', 53 ], [ 'out_octets', 54 ] ])
	};
	const r = counters({ board: WAN5, mib: out });
	assert.deepEqual(r.switches.switch0, { 1: { rx_bytes: 11, tx_bytes: 12 }, 2: { rx_bytes: 21, tx_bytes: 22 }, 3: { rx_bytes: 31, tx_bytes: 32 },
		4: { rx_bytes: 41, tx_bytes: 42 }, 5: { error: 'unknown' } });
});

test('plugin: swconfig failing, printing something else, half a pair, a name twice or far too much: failed or unknown, never part of it', { skip: NO_UCODE }, () => {
	const out = {
		'switch0.1': AR8(1, 2),                                         /* exit 3 below */
		'switch0.2': 'MIB counters\nRxGoodByte  : 5\n',
		'switch0.3': 'MIB counters\nRxGoodByte  : 5\nTxByte      : 6\nRxGoodByte  : 7\n',
		'switch0.4': 'MIB counters\nRxGoodByte  : 18446744073709551615\nTxByte      : 6\n',
		'switch0.5': 'MIB counters\n' + 'RxGoodByte  : 5\nTxByte      : 6\n' + 'x'.repeat(40000) + '\n'
	};
	const r = counters({ board: WAN5, mib: out, mibCode: { 'switch0.1': 3 } });
	assert.deepEqual(r.switches.switch0, { 1: { error: 'failed' }, 2: { error: 'unknown' }, 3: { error: 'unknown' }, 4: { error: 'unknown' }, 5: { error: 'failed' } });
});

test('plugin: a read the switch driver answers "not supported" (swconfig ends with 246 and prints nothing) is unknown, so the page asks no more; any other failure is that call\'s', { skip: NO_UCODE }, () => {
	/* ar8216.c with its counters off: -EOPNOTSUPP, which swconfig ends with as 256 less libnl's 10 */
	const r = counters({ board: BOARD, mib: { 'switch0.1': '' }, mibCode: { 'switch0.1': 246 } });
	assert.deepEqual([ r.state, r.switches.switch0, r.swcalls ], [ 'ok', { 1: { error: 'unknown' } }, [ 'dev switch0 port 1 get mib' ] ]);
	assert.equal(model.switchCounters(without(r, 'calls', 'finished', 'swcalls', 'ats')).none, true);
	/* no answer from the chip in time (255), no such switch (1), the same status after it printed something: asked again at the next poll */
	for (const [ text, code ] of [ [ '', 255 ], [ '', 1 ], [ '', 247 ], [ 'x\n', 246 ] ]) {
		const f = counters({ board: BOARD, mib: { 'switch0.1': text }, mibCode: { 'switch0.1': code } });
		assert.deepEqual(f.switches.switch0[1], { error: 'failed' }, JSON.stringify([ text, code ]));
		assert.equal(model.switchCounters(without(f, 'calls', 'finished', 'swcalls', 'ats')).none, false);
	}
	/* a port the fake has nothing for (it exits 1) */
	assert.deepEqual(counters({ board: BOARD, mib: {} }).switches.switch0[1], { error: 'failed' });
	/* the Realtek drivers print "error" for a counter they could not read this time: failed, though the other is there */
	const rtl = 'Port 1 MIB counters\n' + 'IfInOctets                          : error\n' + 'IfOutOctets                         : 5\n';
	assert.deepEqual(counters({ board: BOARD, mib: { 'switch0.1': rtl } }).switches.switch0[1], { error: 'failed' });
	assert.deepEqual(counters({ board: BOARD, mib: { 'switch0.1': rtl.replace('error', '4') } }).switches.switch0[1], { rx_bytes: 4, tx_bytes: 5 });
	/* another counter's error leaves the two byte counters as read */
	assert.deepEqual(counters({ board: BOARD, mib: { 'switch0.1': rtl.replace('error', '4') + 'EtherStatsUnderSizeOctets           : error\n' } }).switches.switch0[1], { rx_bytes: 4, tx_bytes: 5 });
});

/* a board file whose first 65536 bytes, all that is read of it, end at a brace inside its port list */
const CUT = (() => {
	const tail = '","switch":{"switch0":{"ports":[{"num":1,"role":"wan"}';
	return '{"pad":"' + 'x'.repeat(65536 - 8 - tail.length) + tail + ',{"num":0,"device":"eth0"}]}}}';
})();

test('plugin: no swconfig, no board file, no switch in it, or DSA ports as well: swconfig is never started', { skip: NO_UCODE }, () => {
	assert.deepEqual([ CUT[65535], JSON.parse(CUT).switch.switch0.ports.length ], [ '}', 2 ]);
	const none = { v: 1, state: 'none', more: false, ports: {}, calls: [], swcalls: [] };
	for (const o of [ { board: BOARD, swconfig: false }, { board: BOARD, swconfig: 'plain' }, {}, { board: {} }, { board: { switch: {} } }, { board: 'null' }, { board: { switch: 'x' } },
		{ board: { switch: { switch0: { ports: [ { num: 0, device: 'eth0' } ] } } } },
		/* an empty board file, one cut short, one over the bytes read of it: never handed to json(), which would end the call */
		{ board: '' }, { board: '{"switch": {"switch0": {"ports": [ {"num": 1, "role": "wan"' }, { board: JSON.stringify(Object.assign({ pad: 'x'.repeat(70000) }, BOARD)) }, { board: CUT },
		/* a switch without a WAN port (the WAN is a device of its own there) */
		{ board: { switch: { switch0: { ports: [ { num: 0, device: 'eth0' }, { num: 1, role: 'lan', index: 1 }, { num: 2, role: 'lan', index: 2 } ] } } } } ])
		assert.deepEqual(without(counters(Object.assign({ mib: { 'switch0.1': AR8(1, 2) } }, o)), 'took', 'ats', 'finished'), none, JSON.stringify(o).slice(0, 60));
	/* a DSA device: its ports by ethtool, and board.json's switch (none there in practice) is not looked at */
	const dsa = counters({ ports: { lan1: null }, out: { lan1: MT7530(5, 6) }, board: BOARD, mib: { 'switch0.1': AR8(1, 2) } });
	assert.deepEqual([ dsa.state, dsa.ports, dsa.switches, dsa.calls, dsa.swcalls ], [ 'ok', { lan1: { rx_bytes: 5, tx_bytes: 6 } }, undefined, [ '-S lan1' ], [] ]);
});

test('plugin: a switch name or a port number in board.json that could be read as an option or a shell word never reaches swconfig', { skip: NO_UCODE }, () => {
	const role = 'wan';
	const ports = [ { num: 1, role }, { num: '2', role }, { num: -1, role }, { num: 64, role }, { num: 1.5, role }, { num: null, role }, { role }, null, 'x', { num: 3, device: 'eth1', role }, { num: 4, role } ];
	const board = { switch: { 'switch0': { ports }, '-x': { ports }, 'sw;reboot': { ports }, 'sw 0': { ports }, '$(id)': { ports }, 'a.b': { ports }, ['x'.repeat(16)]: { ports }, 'sw_1-a': { ports: [ { num: 0, role } ] }, 'bad': { ports: 'x' } } };
	const r = counters({ board, mib: { 'switch0.1': AR8(1, 2), 'switch0.4': AR8(3, 4), 'sw_1-a.0': AR8(5, 6) } });
	assert.deepEqual(r.swcalls, [ 'dev sw_1-a port 0 get mib', 'dev switch0 port 1 get mib', 'dev switch0 port 4 get mib' ]);
	assert.deepEqual(r.switches, { 'sw_1-a': { 0: { rx_bytes: 5, tx_bytes: 6 } }, switch0: { 1: { rx_bytes: 1, tx_bytes: 2 }, 4: { rx_bytes: 3, tx_bytes: 4 } } });
});

test('plugin: at most 32 switch ports in all, and none after the time budget', { skip: NO_UCODE }, () => {
	const many = n => ({ ports: Array.from({ length: n }, (_, i) => ({ num: i, role: 'wan' })) });
	const mib = {};
	for (const sw of [ 'a', 'b' ]) for (let i = 0; i < 40; i++) mib[sw + '.' + i] = AR8(i, i);
	const r = counters({ board: { switch: { b: many(20), a: many(20) } }, mib });
	assert.deepEqual([ r.more, Object.keys(r.switches.a).length, Object.keys(r.switches.b).length, r.swcalls.length ], [ true, 20, 12, 32 ]);
	/* the copy's clock moves 400 ms a reading: the budget of 1 s is over before the fourth port */
	const slow = counters({ board: WAN5, mib: { 'switch0.1': AR8(1, 2), 'switch0.2': AR8(1, 2), 'switch0.3': AR8(1, 2), 'switch0.4': AR8(1, 2), 'switch0.5': AR8(1, 2) }, step: 400 });
	assert.deepEqual(Object.values(slow.switches.switch0).map(p => p.error || 'read'), [ 'read', 'read', 'time', 'time', 'time' ]);
	assert.equal(slow.swcalls.length, 2);
});

test('model: switchCounters keeps the counters of well-formed ports and says when there is nothing to ask for', () => {
	const ok = model.switchCounters({ v: 1, state: 'ok', took: 12, more: false, ports: {
		lan1: { rx_bytes: 5, tx_bytes: 6, at: 7000 }, lan2: { error: 'unknown', at: 7001 }, lan3: { error: 'failed' }, lan4: { error: 'time' },
		'bad name': { rx_bytes: 1, tx_bytes: 1, at: 7000 }, lan5: { rx_bytes: -1, tx_bytes: 1, at: 7000 }, lan6: { rx_bytes: '5', tx_bytes: 6, at: 7000 }, lan7: 'x',
		/* a reading without its time (when the device read it) is none: rated by when it came in, it would be wrong */
		lan8: { rx_bytes: 5, tx_bytes: 6 }, lan9: { rx_bytes: 5, tx_bytes: 6, at: -1 }, lan10: { rx_bytes: 5, tx_bytes: 6, at: '7000' } } });
	assert.deepEqual(JSON.parse(JSON.stringify(ok)), { state: 'ok', counters: { lan1: { rx: 5, tx: 6, at: 7000 } }, swports: {}, none: false });
	assert.equal(Object.getPrototypeOf(ok.counters), null);
	/* nothing to get: no DSA port, no ethtool, every port read with names the plugin does not know */
	assert.equal(model.switchCounters({ v: 1, state: 'none', ports: {} }).none, true);
	assert.equal(model.switchCounters({ v: 1, state: 'no-ethtool', ports: {} }).none, true);
	assert.equal(model.switchCounters({ v: 1, state: 'ok', ports: { lan1: { error: 'unknown' }, lan2: { error: 'unknown' }, lan3: { error: 'time' } } }).none, true);
	/* asked and failed is not nothing: ethtool may answer next time */
	assert.equal(model.switchCounters({ v: 1, state: 'ok', ports: { lan1: { error: 'unknown' }, lan2: { error: 'failed' } } }).none, false);
	assert.equal(model.switchCounters({ v: 1, state: 'ok', ports: { lan1: { error: 'time' } } }).none, false);
	for (const junk of [ null, {}, 'x', [ 1 ], { v: 2, state: 'ok', ports: {} }, { v: 1, state: 'later', ports: {} } ])
		assert.equal(model.switchCounters(junk), null, JSON.stringify(junk));
	/* another call was reading: no answer this time, as a failed call, never "nothing to get" */
	assert.equal(model.switchCounters({ v: 1, state: 'busy', took: 0, more: false, ports: {} }), null);
	/* the plugin's own cap */
	const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [ 'p' + i, { rx_bytes: i, tx_bytes: i, at: 7000 } ]));
	assert.equal(Object.keys(model.switchCounters({ v: 1, state: 'ok', ports: many }).counters).length, 32);
});

test('model: switchCounters keeps a swconfig switch\'s ports by its name and their numbers (#166)', () => {
	const good = { rx_bytes: 5, tx_bytes: 6, at: 7000 };
	const r = model.switchCounters({ v: 1, state: 'ok', took: 5, more: false, ports: {}, switches: {
		switch0: { 1: good, 2: { error: 'unknown', at: 7001 }, 3: { error: 'time' }, x: good, 100: good, 64: good, '01': { rx_bytes: 9, tx_bytes: 9, at: 7000 }, '-1': good, '1.5': good, 4: { rx_bytes: 1, tx_bytes: 2 }, 5: { rx_bytes: -1, tx_bytes: 2, at: 1 }, 63: good },
		'bad name': { 1: good }, sw1: 'x', sw2: { 0: good } } });
	assert.deepEqual(JSON.parse(JSON.stringify(r)), { state: 'ok', counters: {}, swports: { switch0: { 1: { rx: 5, tx: 6, at: 7000 }, 63: { rx: 5, tx: 6, at: 7000 } }, sw2: { 0: { rx: 5, tx: 6, at: 7000 } } }, none: false });
	assert.equal(Object.getPrototypeOf(r.swports), null);
	/* every port read with names the plugin does not know: nothing to ask for, as for a DSA switch */
	assert.equal(model.switchCounters({ v: 1, state: 'ok', ports: {}, switches: { switch0: { 1: { error: 'unknown' }, 2: { error: 'unknown' } } } }).none, true);
	assert.equal(model.switchCounters({ v: 1, state: 'ok', ports: {}, switches: { switch0: { 1: { error: 'unknown' }, 2: { error: 'failed' } } } }).none, false);
	/* the plugin's own cap, over all switches */
	const many = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [ i, good ]));
	const capped = model.switchCounters({ v: 1, state: 'ok', ports: {}, switches: { a: many(20), b: many(20) } }).swports;
	assert.equal(Object.keys(capped.a).length + Object.keys(capped.b).length, 32);
	/* as many switches as the plugin reads ports of: nine with a WAN port each are all kept */
	const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [ 'sw' + i, { 1: good } ]));
	assert.equal(Object.keys(model.switchCounters({ v: 1, state: 'ok', ports: {}, switches: nine }).swports).length, 9);
	/* an answer without switches (a DSA device, an older plugin) has none */
	assert.deepEqual(JSON.parse(JSON.stringify(model.switchCounters({ v: 1, state: 'ok', ports: {} }).swports)), {});
});

test('model: lineChip: the one port of a swconfig switch a line is, tagged or untagged, where the port is in no other VLAN; none where its VLAN has no port or several', () => {
	const switches = { eth0: { name: 'switch0', vlan: 2, ports: [ { num: 1, role: 'wan', index: null, vlans: 1 } ] },
		'eth0.1': { name: 'switch0', vlan: 1, ports: [ { num: 2, vlans: 1 }, { num: 3, vlans: 1 } ] }, 'eth1.2': { name: 'switch1', vlan: 2, ports: [ { num: 4, vlans: 1 } ] },
		eth2: { name: 'switch0', vlan: 5, ports: [] }, eth3: { name: 'bad name!', vlan: 5, ports: [ { num: 1, vlans: 1 } ] },
		/* internet on VLAN 35 and IPTV on VLAN 100 of the same port: the chip counts both there */
		'eth4.35': { name: 'switch2', vlan: 35, ports: [ { num: 5, vlans: 2 } ] }, 'eth4.100': { name: 'switch2', vlan: 100, ports: [ { num: 5, vlans: 2 } ] },
		/* a port in a VLAN that reaches no CPU port as well (the plugin counted it), one of an older plugin, one whose VLANs were not all read */
		'eth5.2': { name: 'switch3', vlan: 2, ports: [ { num: 1, vlans: 2 } ] }, 'eth6.2': { name: 'switch4', vlan: 2, ports: [ { num: 1 } ] }, 'eth7.2': { name: 'switch5', vlan: 2, ports: [ { num: 1, vlans: 0 } ] } };
	const chip = line => model.lineChip(line, switches);
	/* untagged on the CPU's device (the reporter's), and tagged */
	assert.deepEqual(chip({ dev: 'eth0', statsDev: 'eth0' }), { sw: 'switch0', num: 1, key: 'switch0:1' });
	assert.deepEqual(chip({ dev: 'eth1.2', statsDev: 'eth1.2' }), { sw: 'switch1', num: 4, key: 'switch1:4' });
	/* a line on top of the port's device (PPPoE): by the device it is counted on */
	assert.deepEqual(chip({ dev: 'pppoe-wan', statsDev: 'eth0' }), { sw: 'switch0', num: 1, key: 'switch0:1' });
	for (const line of [ { dev: 'eth0.1', statsDev: 'eth0.1' }, { dev: 'eth2', statsDev: 'eth2' }, { dev: 'eth3', statsDev: 'eth3' }, { dev: 'br-lan', statsDev: 'eth9' }, { dev: 'wan', statsDev: 'wan' }, {}, null,
		{ dev: 'eth4.35', statsDev: 'eth4.35' }, { dev: 'eth4.100', statsDev: 'eth4.100' }, { dev: 'eth5.2', statsDev: 'eth5.2' }, { dev: 'eth6.2', statsDev: 'eth6.2' }, { dev: 'eth7.2', statsDev: 'eth7.2' } ])
		assert.equal(chip(line), null, JSON.stringify(line));
	for (const none of [ null, undefined, {}, 'x', [] ]) assert.equal(model.lineChip({ dev: 'eth0', statsDev: 'eth0' }, none), null);
});

test('model: lineRate is of the line\'s device less its VLANs, whatever its switch port', () => {
	const line = { statsDev: 'eth0', minus: [ 'eth0.1' ], chip: { sw: 'switch0', num: 1, key: 'switch0:1' } };
	const rates = { eth0: { rx: 10, tx: 10 }, 'eth0.1': { rx: 3, tx: 4 }, 'switch0:1': { rx: 1, tx: 2 } };
	assert.deepEqual(model.lineRate(line, rates), { rx: 7, tx: 6 });
});

test('model: rates never take a rate across two sources; a key whose source changed starts over', () => {
	const a = model.rates(null, { lan1: { rx: 0, tx: 0, src: 'switch' }, eth0: { rx: 0, tx: 0 } }, 0);
	const b = model.rates(a.next, { lan1: { rx: 5000, tx: 1000, src: 'switch' }, eth0: { rx: 500, tx: 0 } }, 5000);
	assert.deepEqual([ b.rates.lan1, b.rates.eth0 ], [ { rx: 8000, tx: 1600 }, { rx: 800, tx: 0 } ]);
	/* the chip's counters stayed out: the kernel's, far lower, are no rate against them */
	const c = model.rates(b.next, { lan1: { rx: 10, tx: 10 } }, 10000);
	assert.equal(c.rates.lan1, undefined);
	/* and back: the chip's again are no rate against the kernel's */
	const d = model.rates(c.next, { lan1: { rx: 20000, tx: 2000, src: 'switch' } }, 15000);
	assert.equal(d.rates.lan1, undefined);
	const e = model.rates(d.next, { lan1: { rx: 25000, tx: 3000, src: 'switch' } }, 20000);
	assert.deepEqual(e.rates.lan1, { rx: 8000, tx: 1600 });
});

test('model: a chip\'s counters at a steady rate give that rate, however late each reading came in (the reviewer\'s case)', () => {
	/* 19 Mbit/s on a port, read every 5 s on the device's clock; the answers came in alternately 0.1 s and 1.5 s after their poll */
	let prev = null;
	const got = [];
	for (let k = 0; k < 8; k++) {
		const read = 5000 * k, came = 1.8e12 + 5000 * k + (k % 2 ? 1500 : 100), bytes = 19e6 / 8 * read / 1000;
		const r = model.rates(prev, { lan1: { rx: bytes, tx: bytes, src: 'switch', at: 9e6 + read } }, came);
		prev = r.next;
		if (k) got.push(r.rates.lan1.rx);
	}
	assert.deepEqual(got, Array(7).fill(19e6));
	/* a key without its own time keeps the poll's, as every other counter does */
	const a = model.rates(null, { eth0: { rx: 0, tx: 0 } }, 1000), b = model.rates(a.next, { eth0: { rx: 1000, tx: 0 } }, 6000);
	assert.deepEqual(b.rates.eth0, { rx: 1600, tx: 0 });
});

test('model: a device clock that went back (the router started again) starts a chip\'s port over, then rates it again', () => {
	const at = (prev, rx, t) => model.rates(prev, { lan1: { rx, tx: 0, src: 'switch', at: t } }, 1.8e12 + t);
	const a = at(null, 5e9, 9e6), b = at(a.next, 5e9 + 625000, 9e6 + 5000);
	assert.equal(b.rates.lan1.rx, 1e6);
	/* the router restarted: its monotonic clock and the chip's counters from near zero */
	const c = at(b.next, 1000, 30000);
	assert.equal(c.rates.lan1, undefined, 'no rate across the restart');
	assert.equal(c.next.lan1.at, 30000, 'the new reading is the base');
	const d = at(c.next, 1000 + 625000, 35000);
	assert.equal(d.rates.lan1.rx, 1e6, 'and the next is rated');
});

/* ------------------------------------------------------------- view */

const REPLIES = {};
function loadView() {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const stubs = {
		view: { extend: p => p },
		rpc: { declare: o => function(...args) { const f = REPLIES[o.object + ' ' + o.method]; return f ? f(...args) : Promise.resolve(null); } },
		poll: { active() { return true; } }, ui: {}, dom: {}
	};
	const params = [], values = [];
	for (const m of src.matchAll(/^'require ([\w.-]+)(?: as (\w+))?';$/gm)) {
		params.push(m[2] || m[1]);
		values.push(Object.prototype.hasOwnProperty.call(stubs, m[1]) ? stubs[m[1]] : load(m[1]));
	}
	return new Function(...params, src)(...values);
}
const view = loadView();

/* askSwitch with the test's timers: c.reply() answers a call (null: it stays out until the test settles it, c.out) */
async function switchCalls(fn) {
	const saved = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
	const c = { asked: 0, timers: [], seq: 0, out: [], reply: null };
	global.setTimeout = (f, ms) => { const id = ++c.seq; c.timers.push({ id, f, ms }); return id; };
	global.clearTimeout = id => { c.timers = c.timers.filter(x => x.id !== id); };
	c.flush = () => new Promise(r => setImmediate(r));
	c.fire = async () => { const due = c.timers; c.timers = []; due.forEach(x => x.f()); await c.flush(); };
	REPLIES['luci.vantage.ports counters'] = () => { c.asked++; return c.reply ? c.reply() : new Promise((resolve, reject) => c.out.push({ resolve, reject })); };
	c.self = Object.create(view);
	c.ask = async () => { const box = [ undefined ]; c.self.askSwitch().then(v => { box[0] = v; }); await c.flush(); return box; };
	try { await fn(c); }
	finally {
		Object.assign(global, saved);
		delete REPLIES['luci.vantage.ports counters'];
	}
}
/* the plugin's answer: a port with counters read at 7000 ms on the device's clock */
const answer = ports => () => Promise.resolve({ v: 1, state: 'ok', took: 9, more: false,
	ports: Object.fromEntries(Object.entries(ports).map(([ n, p ]) => [ n, p.rx_bytes != null ? Object.assign({ at: 7000 }, p) : p ])) });

test('view: asked every poll while the first answer had counters, whatever later ones say', () => switchCalls(async c => {
	c.reply = answer({ lan1: { rx_bytes: 1, tx_bytes: 2 } });
	assert.deepEqual(JSON.parse(JSON.stringify((await c.ask())[0])), { state: 'ok', counters: { lan1: { rx: 1, tx: 2, at: 7000 } }, swports: {}, none: false });
	c.reply = answer({ lan1: { error: 'unknown' } });
	for (let i = 0; i < 3; i++) assert.equal((await c.ask())[0].none, true);
	assert.equal(c.asked, 4, 'decided by the first answer only');
	/* a call that failed is asked again */
	c.reply = () => Promise.reject(new Error('XHR request timed out'));
	assert.equal((await c.ask())[0], null);
	assert.equal((await c.ask())[0], null);
	assert.equal(c.asked, 6);
	assert.equal(c.timers.length, 0, 'no deadline left behind');
}));

test('view: once it has answered, no later answer ends the asking: not a missing object, a refusal or nothing to get', () => switchCalls(async c => {
	const absent = msg => () => Promise.reject(new Error('RPC call to luci.vantage.ports/counters failed with ' + msg));
	const none = state => () => Promise.resolve({ v: 1, state, took: 0, more: false, ports: {} });
	const later = [ absent('error -32000: Object not found'), absent('error -32002: Access denied'), absent('ubus code 4: Resource not found'),
		absent('ubus code 3: Method not found'), none('none'), none('no-ethtool'), answer({ lan1: { error: 'unknown' } }) ];
	c.reply = answer({ lan1: { rx_bytes: 1, tx_bytes: 2 } });
	await c.ask();
	/* rpcd reloading after a package install: its objects gone for a moment, then back */
	for (const reply of later) {
		c.reply = reply;
		await c.ask();
		c.reply = answer({ lan1: { rx_bytes: 3, tx_bytes: 4 } });
		assert.deepEqual((await c.ask())[0].counters.lan1, { rx: 3, tx: 4, at: 7000 }, 'asked again after ' + reply);
	}
	assert.equal(c.asked, 1 + 2 * later.length);
}));

test('view: the first answer that says there is nothing to get, or no object, ends the asking for the page', () => switchCalls(async c => {
	for (const [ what, reply ] of [
		[ 'no DSA port', () => Promise.resolve({ v: 1, state: 'none', took: 0, more: false, ports: {} }) ],
		[ 'no ethtool', () => Promise.resolve({ v: 1, state: 'no-ethtool', took: 0, more: false, ports: {} }) ],
		[ 'names it does not know', answer({ lan1: { error: 'unknown' }, lan2: { error: 'unknown' } }) ],
		[ 'no object (rpcd not reloaded, the plugin removed)', () => Promise.reject(new Error('RPC call to luci.vantage.ports/counters failed with error -32000: Object not found')) ],
		[ 'no such plugin file any more', () => Promise.reject(new Error('RPC call to luci.vantage.ports/counters failed with ubus code 4: Resource not found')) ]
	]) {
		c.self = Object.create(view);
		c.asked = 0;
		c.reply = reply;
		await c.ask();
		c.reply = answer({ lan1: { rx_bytes: 1, tx_bytes: 2 } });
		for (let i = 0; i < 5; i++) assert.equal((await c.ask())[0], null, what);
		assert.equal(c.asked, 1, what + ': asked once');
	}
	/* a first call that failed decides nothing */
	c.self = Object.create(view);
	c.asked = 0;
	c.reply = () => Promise.reject(new Error('RPC call to luci.vantage.ports/counters failed with ubus code 7: Request timed out'));
	await c.ask();
	c.reply = () => Promise.resolve({ v: 1, state: 'none', took: 0, more: false, ports: {} });
	await c.ask();
	await c.ask();
	assert.equal(c.asked, 2, 'the first answer after it does');
}));

test('view: six answers of a swconfig switch running without one counter, on a page that has had none, end the asking; a counter once, and no run of them does; a DSA switch\'s are not counted', () => switchCalls(async c => {
	/* a switch whose reads fail every time (a driver without counters, for one): failed is no "nothing to get" by itself */
	const dry = () => Promise.resolve({ v: 1, state: 'ok', took: 3, more: false, ports: {}, switches: { switch0: { 1: { error: 'failed', at: 7000 } } } });
	c.reply = dry;
	for (let i = 0; i < 6; i++) assert.equal((await c.ask())[0].none, false, 'answer ' + i);
	for (let i = 0; i < 4; i++) assert.equal((await c.ask())[0], null);
	assert.equal(c.asked, 6);
	/* busy and failed calls are no answers: they neither count nor break the run */
	c.self = Object.create(view);
	c.asked = 0;
	for (let i = 0; i < 5; i++) await c.ask();
	c.reply = () => Promise.resolve({ v: 1, state: 'busy', took: 0, more: false, ports: {} });
	for (let i = 0; i < 3; i++) await c.ask();
	c.reply = dry;
	await c.ask();
	await c.ask();
	assert.equal(c.asked, 9, 'five, three busy, the sixth');
	/* a counter once on this page: asked for good */
	c.self = Object.create(view);
	c.asked = 0;
	c.reply = dry;
	for (let i = 0; i < 5; i++) await c.ask();
	c.reply = () => Promise.resolve({ v: 1, state: 'ok', took: 3, more: false, ports: {}, switches: { switch0: { 1: { rx_bytes: 1, tx_bytes: 2, at: 7000 } } } });
	await c.ask();
	c.reply = dry;
	for (let i = 0; i < 10; i++) await c.ask();
	assert.equal(c.asked, 16);
	/* a DSA switch whose every read fails: asked every poll, as since #156 (its first answer was no "nothing to get") */
	c.self = Object.create(view);
	c.asked = 0;
	c.reply = () => Promise.resolve({ v: 1, state: 'ok', took: 3, more: false, ports: { lan1: { error: 'failed', at: 7000 }, lan2: { error: 'failed', at: 7001 } } });
	for (let i = 0; i < 12; i++) assert.equal((await c.ask())[0].none, false);
	assert.equal(c.asked, 12);
}));

test('view: busy is no answer this time: the page keeps asking, and the first real answer decides', () => switchCalls(async c => {
	const busy = () => Promise.resolve({ v: 1, state: 'busy', took: 0, more: false, ports: {} });
	c.reply = busy;
	for (let i = 0; i < 5; i++) assert.equal((await c.ask())[0], null, 'busy ' + i);
	assert.equal(c.asked, 5, 'asked every poll');
	/* busy, then counters, then busy again: still asked */
	c.reply = answer({ lan1: { rx_bytes: 1, tx_bytes: 2 } });
	assert.deepEqual((await c.ask())[0].counters.lan1, { rx: 1, tx: 2, at: 7000 });
	c.reply = busy;
	await c.ask();
	await c.ask();
	assert.equal(c.asked, 8);
	/* busy first, then an answer of nothing to get: that one ends the asking */
	c.self = Object.create(view);
	c.asked = 0;
	c.reply = busy;
	await c.ask();
	c.reply = () => Promise.resolve({ v: 1, state: 'none', took: 0, more: false, ports: {} });
	await c.ask();
	await c.ask();
	await c.ask();
	assert.equal(c.asked, 2);
}));

test('view: a poll waits 2 s for the answer at most; while a call is out no other is made', () => switchCalls(async c => {
	const first = await c.ask();
	assert.deepEqual([ c.asked, c.timers.map(t => t.ms), first[0] ], [ 1, [ 2000 ], undefined ], 'the poll waits, with a deadline');
	await c.fire();
	assert.equal(first[0], null, 'and goes on without it');
	const second = await c.ask();
	assert.deepEqual([ c.asked, second[0], c.timers.length ], [ 1, null, 0 ], 'not asked again while the first is out');
	c.out.shift().resolve({ v: 1, state: 'ok', took: 2500, more: false, ports: { lan1: { rx_bytes: 1, tx_bytes: 2, at: 7000 } } });
	await c.flush();
	c.reply = answer({ lan1: { rx_bytes: 3, tx_bytes: 4 } });
	assert.deepEqual((await c.ask())[0].counters.lan1, { rx: 3, tx: 4, at: 7000 });
	assert.equal(c.asked, 2);
}));

test('view: a port counts by its chip where the poll has its counters, never a line\'s own device, and a rate is of one source', () => {
	const savedL = global.L, savedW = global.window;
	global.L = { env: {} };
	global.window = { sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null, setItem() {} } };
	try {
		const self = Object.create(view);
		self.initState({ board: {}, canWrite: false, canRdns: false, mdns: null });
		const wan = { interface: 'wan', up: true, proto: 'dhcp', device: 'wan', l3_device: 'wan', metric: 10, route: [ { target: '0.0.0.0', mask: 0, nexthop: '203.0.113.1' } ] };
		const dsa = (rx, tx) => ({ devtype: 'dsa', carrier: true, speed: '1000F', statistics: { rx_bytes: rx, tx_bytes: tx } });
		/* t s after the start: the kernel's counters crawl (what passes the CPU), the chip's run at the port's rate */
		const raw = (t, hw) => ({ at: 1.8e12 + t * 1000, info: { localtime: 1.8e9 + t }, stat: '', ifaces: [ wan ], wifi: null, hints: {}, thermal: [], fdb: [], assoc: {}, hapd: {}, hapdStatus: {}, iwinfo: {},
			devs: { lan1: dsa(t * 10, t * 20), lan2: dsa(t * 30, t * 40), wan: dsa(t * 1000, t * 2000) },
			hw: hw === false ? null : { state: 'ok', none: false, counters: Object.assign(Object.create(null), {
				lan1: { rx: 5e9 + t * 1e6, tx: 7e9 + t * 2e6 }, wan: { rx: 1e12 + t * 9e6, tx: 1e12 } }) } });
		const rates = () => JSON.parse(JSON.stringify([ self.st.devRates.lan1 || null, self.st.devRates.lan2 || null, self.st.devRates.wan || null ]));
		self.ingest(raw(0));
		self.ingest(raw(5));
		/* lan1: the chip's; lan2: the kernel's (no counters of the chip for it); wan, the line's: the kernel's */
		assert.deepEqual(rates(), [ { rx: 8e6, tx: 16e6 }, { rx: 240, tx: 320 }, { rx: 8000, tx: 16000 } ]);
		/* the chip's counters stayed out this poll: no rate for lan1, not the kernel's against the chip's */
		self.ingest(raw(10, false));
		assert.deepEqual(rates(), [ null, { rx: 240, tx: 320 }, { rx: 8000, tx: 16000 } ]);
		/* and the step back to the chip's is none either; then the chip's again */
		self.ingest(raw(15));
		assert.deepEqual(rates()[0], null);
		self.ingest(raw(20));
		assert.deepEqual(rates()[0], { rx: 8e6, tx: 16e6 });
	} finally {
		global.L = savedL;
		global.window = savedW;
	}
});

/* A router whose WAN is port 1 of a swconfig switch, untagged on eth0, the CPU's device, which carries the LAN's VLAN
   too: the kernel's counters of eth0 run at 3 and 4 MB/s, the chip's of port 1 at the line's own 2 MB/s down and 0.1 up.
   raw(t, o): the poll t s after the start; o.hw false: no answer from the counters plugin; o.down/o.up: the chip's bytes
   so far; o.map false: no answer from luci.vantage wired (no switch map); o.switches, o.dev: another map, another device.
   pushed: [ second, down rate ] of every point written to the line's history */
async function swBed(fn) {
	const savedL = global.L, savedW = global.window, savedD = global.document, savedNow = Date.now;
	global.L = { env: {}, resolveDefault: (v, d) => Promise.resolve(v).catch(() => d) };
	/* setTimeout: the lane's early second CPU sample, which a test takes itself */
	global.window = { sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null, setItem() {} }, setTimeout: () => 1 };
	global.document = { hidden: false };
	const b = { asked: [], pushed: [], clock: 1.8e12, held: null, reads: 0 };
	Date.now = () => b.clock;
	/* the kernel's counters of a device the fast lane asks for, at the bed's clock; b.held: answers kept back until released */
	REPLIES['network.device status'] = name => {
		b.asked.push(name);
		const t = (b.clock - 1.8e12) / 1000, reply = { statistics: { rx_bytes: t * 3e6, tx_bytes: t * 4e6 } };
		return b.held ? new Promise(resolve => b.held.push(() => resolve(reply))) : Promise.resolve(reply);
	};
	/* /proc/stat, a quarter busy between two reads */
	REPLIES['file read'] = () => { const k = b.reads++; return Promise.resolve('cpu  ' + (100 + 25 * k) + ' 0 0 ' + (900 + 75 * k) + ' 0 0 0 0\ncpu0 ' + (100 + 25 * k) + ' 0 0 ' + (900 + 75 * k) + ' 0 0 0 0\n'); };
	try {
		const self = b.self = Object.create(view);
		self.initState({ board: {}, canWrite: false, canRdns: false, mdns: null });
		self.el = {};
		self.idle = () => false;
		self.paintFast = () => {};
		self.keepCpu = cpu => { b.cpu = cpu.pct; };
		self.pushNet = (key, at, r) => { b.pushed.push([ Math.round((at - 1.8e12) / 1000), r.rx ]); };
		const SWITCHES = { eth0: { name: 'switch0', vlan: 2, ports: [ { num: 1, role: 'wan', index: null, vlans: 1 } ] }, 'eth0.1': { name: 'switch0', vlan: 1, ports: [ { num: 2, vlans: 1 }, { num: 3, vlans: 1 } ] } };
		b.raw = (t, o) => {
			o = o || {};
			const dev = o.dev || 'eth0';
			const wan = { interface: 'wan', up: true, proto: 'dhcp', device: dev, l3_device: dev, metric: 10, route: [ { target: '0.0.0.0', mask: 0, nexthop: '203.0.113.1' } ] };
			return { at: 1.8e12 + t * 1000, info: { localtime: 1.8e9 + t }, stat: '', ifaces: [ wan ], wifi: null, hints: {}, thermal: [], fdb: [], assoc: {}, hapd: {}, hapdStatus: {}, iwinfo: {},
				wiredOk: o.map !== false, switches: o.map === false ? {} : o.switches || SWITCHES, switchState: {},
				devs: { [dev]: { type: 'ethernet', carrier: true, speed: '1000F', statistics: { rx_bytes: t * 3e6, tx_bytes: t * 4e6 } } },
				hw: o.hw === false ? null : { state: 'ok', none: false, counters: Object.create(null),
					swports: { switch0: { 1: { rx: 1e12 + (o.down != null ? o.down : t * 2e6), tx: 5e11 + (o.up != null ? o.up : t * 1e5), at: 9e6 + t * 1000 } } } } };
		};
		b.poll = (t, o) => { b.clock = 1.8e12 + t * 1000; b.self.ingest(b.raw(t, o)); };
		b.line = () => JSON.parse(JSON.stringify(b.self.st.uplinkRate));
		b.port = () => b.self.st.chip && b.self.st.chip.key;
		await fn(b);
	} finally {
		global.L = savedL;
		global.window = savedW;
		global.document = savedD;
		Date.now = savedNow;
		delete REPLIES['network.device status'];
		delete REPLIES['file read'];
	}
}
const CHIP = { rx: 16e6, tx: 8e5 }, KERNEL = { rx: 24e6, tx: 32e6 };

test('view: the main line that is one port of a swconfig switch is counted by that port\'s chip (#166); a reading that stays out is bridged for 20 s, and the fast lane keeps off it', () => swBed(async b => {
	const self = b.self;
	b.poll(0);
	/* from the port's first reading: no rate yet, and never the kernel's of eth0 */
	assert.deepEqual([ self.m.uplink.chip, b.port(), b.line() ], [ { sw: 'switch0', num: 1, key: 'switch0:1' }, 'switch0:1', null ]);
	b.poll(5);
	assert.deepEqual(b.line(), CHIP);
	/* the fast lane reads the kernel's counters: it leaves this line alone, and what the poll found stays */
	await self.fastSample();
	assert.deepEqual([ b.asked, b.line(), self.st.fastDev ], [ [], CHIP, null ]);
	/* and goes on sampling the CPU: its own sample is not started over at every tick */
	await self.fastSample();
	assert.deepEqual([ b.asked, b.line(), Math.round(b.cpu) ], [ [], CHIP, 25 ]);
	/* the chip's counters stayed out (another call was reading): the last rate stays, not the kernel's */
	b.poll(10, { hw: false });
	assert.deepEqual([ b.line(), b.port() ], [ CHIP, 'switch0:1' ]);
	/* and the next reading is rated across both polls (3 MB/s between 5 s and 15 s), not started over */
	b.poll(15, { down: 4e7, up: 2.5e6 });
	const MID = { rx: 24e6, tx: 16e5 };
	assert.deepEqual(b.line(), MID);
	/* out for less than 20 s: its last rate; then the kernel's again, and the fast lane has the device back */
	for (const t of [ 20, 25, 30 ]) { b.poll(t, { hw: false }); assert.deepEqual([ b.line(), b.port() ], [ MID, 'switch0:1' ], 'at ' + t); }
	b.poll(35, { hw: false });
	assert.deepEqual([ b.line(), b.port() ], [ KERNEL, null ]);
	await self.fastSample();
	assert.deepEqual(b.asked, [ 'eth0' ]);
	/* back: by the chip again at once, rated across the whole gap from its last reading */
	b.poll(40, { down: 9e7, up: 5e6 });
	assert.deepEqual([ b.line(), b.port() ], [ CHIP, 'switch0:1' ]);
	b.poll(45, { down: 1e8, up: 5.5e6 });
	assert.deepEqual(b.line(), CHIP);
	/* the chip's counters went back (the switch was reset): the last rate for that poll, then the new ones' */
	b.poll(50, { down: 1000, up: 500 });
	assert.deepEqual([ b.line(), b.port() ], [ CHIP, 'switch0:1' ]);
	b.poll(55, { down: 1000 + 1e7, up: 500 + 5e5 });
	assert.deepEqual(b.line(), CHIP);
	/* the history got a point for every rate measured, none for one held over; the kernel's one while it was the kernel's */
	assert.deepEqual(b.pushed, [ [ 5, 16e6 ], [ 15, 24e6 ], [ 35, 24e6 ], [ 40, 16e6 ], [ 45, 16e6 ], [ 55, 16e6 ] ]);
}));

test('view: the chip\'s last rate is held by time, however often the page polls (#166)', () => swBed(async b => {
	b.poll(0);
	b.poll(5);
	/* a poll every 2 s without a reading: its rate until 20 s after it was measured, then the kernel's */
	for (const t of [ 7, 9, 11, 13, 15, 17, 19, 21, 23 ]) { b.poll(t, { hw: false }); assert.deepEqual([ b.line(), b.port() ], [ CHIP, 'switch0:1' ], 'at ' + t); }
	b.poll(25, { hw: false });
	assert.equal(b.port(), null);
}));

test('view: the line never shows another line\'s rate: a new main line on the switch port starts with none (#166)', () => swBed(async b => {
	/* the main line on a device of its own, counted by the kernel */
	b.poll(0, { dev: 'eth5' });
	b.poll(5, { dev: 'eth5' });
	assert.deepEqual([ b.line(), b.port() ], [ KERNEL, null ]);
	/* it moves to the switch port: the port's first reading is no rate, and not what eth5 showed */
	b.poll(10);
	assert.deepEqual([ b.line(), b.port() ], [ null, 'switch0:1' ]);
	b.poll(15);
	assert.deepEqual(b.line(), CHIP);
	assert.deepEqual(b.pushed, [ [ 5, 24e6 ], [ 15, 16e6 ] ]);
	/* the same port reaches this device as another device now, and has no reading this poll: not the rate it had as eth0 */
	b.poll(20, { dev: 'eth9', hw: false, switches: { eth9: { name: 'switch0', vlan: 2, ports: [ { num: 1, role: 'wan', index: null, vlans: 1 } ] } } });
	assert.deepEqual([ b.self.m.uplink.chip.key, b.line(), b.port() ], [ 'switch0:1', null, null ]);
}));

test('view: the line keeps its switch port while the switch map is out for a poll, and gives it up when the map says otherwise (#166)', () => swBed(async b => {
	b.poll(0);
	b.poll(5);
	/* luci.vantage wired gave no answer: no map, but the counters came, at another rate (6 MB/s down): that poll's rate */
	b.poll(10, { map: false, down: 4e7 });
	assert.deepEqual([ b.self.m.uplink.chip, b.line(), b.port() ], [ null, { rx: 48e6, tx: 8e5 }, 'switch0:1' ]);
	b.poll(15, { down: 5e7 });
	assert.deepEqual(b.line(), CHIP);
	/* the map came and has another VLAN on the port now: the kernel's at once */
	b.poll(20, { switches: { eth0: { name: 'switch0', vlan: 2, ports: [ { num: 1, role: 'wan', index: null, vlans: 2 } ] } } });
	assert.deepEqual([ b.line(), b.port() ], [ KERNEL, null ]);
	/* no map for a long time, the counters coming all the while: the port for 20 s since the map last named it, no longer */
	b.poll(25);
	b.poll(30);
	for (const t of [ 35, 40, 45 ]) { b.poll(t, { map: false }); assert.deepEqual([ b.line(), b.port() ], [ CHIP, 'switch0:1' ], 'at ' + t); }
	b.poll(50, { map: false });
	assert.deepEqual([ b.line(), b.port() ], [ KERNEL, null ]);
}));

test('view: a fast-lane answer for a device that is no longer the main line\'s is not its rate', () => swBed(async b => {
	const self = b.self;
	b.poll(0, { dev: 'eth5' });
	b.poll(5, { dev: 'eth5' });
	await self.fastSample();
	b.clock += 2000;
	await self.fastSample();
	assert.deepEqual([ b.asked, b.line() ], [ [ 'eth5', 'eth5' ], KERNEL ]);
	/* the next sample stays out while a full poll makes eth6 the line */
	b.clock += 2000;
	b.held = [];
	const out = self.fastSample();
	self.ingest(b.raw(10, { dev: 'eth6' }));
	assert.equal(b.line(), null);
	const n = b.pushed.length;
	b.held.forEach(f => f());
	b.held = null;
	await out;
	assert.deepEqual([ b.line(), b.pushed.length ], [ null, n ]);
}));

test('view: a fast-lane answer that comes in after the full poll gave the line to the chip leaves the chip\'s rate (#166)', () => swBed(async b => {
	const self = b.self;
	b.poll(0);
	b.poll(5);
	/* the chip's counters stay out until its rate is no longer held: the kernel's, and the fast lane samples eth0 */
	for (const t of [ 10, 15, 20, 25 ]) b.poll(t, { hw: false });
	assert.deepEqual([ b.line(), b.port() ], [ KERNEL, null ]);
	await self.fastSample();
	b.clock += 2000;
	await self.fastSample();
	assert.deepEqual([ b.asked, b.line() ], [ [ 'eth0', 'eth0' ], KERNEL ], 'the lane\'s own rate of eth0');
	/* its next sample is asked for, and stays out while a full poll brings the chip's counters back */
	b.clock += 2000;
	b.held = [];
	const out = self.fastSample();
	self.ingest(b.raw(30));
	assert.deepEqual([ b.line(), b.port() ], [ CHIP, 'switch0:1' ]);
	const n = b.pushed.length;
	b.held.forEach(f => f());
	b.held = null;
	await out;
	assert.deepEqual([ b.line(), b.port(), b.pushed.length ], [ CHIP, 'switch0:1', n ], 'the kernel\'s late rate is not the line\'s');
}));

test('view: a line whose VLAN has several switch ports, a port shared with another VLAN, or one the plugin does not read, stays on the kernel\'s counters', () => swBed(async b => {
	/* the WAN's VLAN on ports 1 and 5; on port 1 that another VLAN has too; on port 4 alone, where the plugin has the board's WAN port 1 and no other */
	for (const [ ports, chip ] of [ [ [ { num: 1, vlans: 1 }, { num: 5, vlans: 1 } ], null ], [ [ { num: 1, vlans: 2 } ], null ], [ [ { num: 4, vlans: 1 } ], { sw: 'switch0', num: 4, key: 'switch0:4' } ] ]) {
		const self = b.self = Object.create(view);
		self.initState({ board: {}, canWrite: false, canRdns: false, mdns: null });
		self.pushNet = () => {};
		const switches = { eth0: { name: 'switch0', vlan: 2, ports } };
		b.poll(0, { switches });
		b.poll(5, { switches });
		assert.deepEqual([ self.m.uplink.chip, b.port(), b.line() ], [ chip, null, KERNEL ], JSON.stringify(ports));
	}
}));

test('view: a chip\'s counters are rated by when the device read them, however late each answer came in', () => {
	const savedL = global.L, savedW = global.window;
	global.L = { env: {} };
	global.window = { sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null, setItem() {} } };
	try {
		const self = Object.create(view);
		self.initState({ board: {}, canWrite: false, canRdns: false, mdns: null });
		const wan = { interface: 'wan', up: true, proto: 'dhcp', device: 'wan', l3_device: 'wan', metric: 10, route: [ { target: '0.0.0.0', mask: 0, nexthop: '203.0.113.1' } ] };
		const dsa = { devtype: 'dsa', carrier: true, speed: '1000F', statistics: { rx_bytes: 1, tx_bytes: 1 } };
		/* poll k: the batch at 5 s steps; the chip read at 5 s steps on the device's clock, its answer held back 0.1 s, then 1.5 s, ... */
		const raw = k => ({ at: 1.8e12 + k * 5000 + (k % 2 ? 1500 : 100), info: { localtime: 1.8e9 + k * 5 }, stat: '', ifaces: [ wan ], wifi: null, hints: {}, thermal: [], fdb: [], assoc: {}, hapd: {}, hapdStatus: {}, iwinfo: {},
			devs: { lan1: dsa, wan: dsa }, hw: { state: 'ok', none: false, counters: Object.assign(Object.create(null), { lan1: { rx: k * 5 * 19e6 / 8, tx: k * 5 * 1e6 / 8, at: 123e6 + k * 5000 } }) } });
		self.ingest(raw(0));
		for (let k = 1; k < 6; k++) {
			self.ingest(raw(k));
			assert.deepEqual(JSON.parse(JSON.stringify(self.st.devRates.lan1)), { rx: 19e6, tx: 1e6 }, 'poll ' + k);
		}
	} finally {
		global.L = savedL;
		global.window = savedW;
	}
});

test('view: a busy answer reaches ingest as none (the kernel\'s counters for that step), and the next poll asks again', async () => {
	const saved = { L: global.L, document: global.document };
	global.document = { hidden: false, documentElement: { getAttribute: () => null } };
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	let asked = 0;
	REPLIES['luci.vantage.ports counters'] = () => { asked++; return Promise.resolve({ v: 1, state: 'busy', took: 0, more: false, ports: {} }); };
	try {
		const self = Object.create(view);
		assert.equal((await self.fetch()).hw, null);
		REPLIES['luci.vantage.ports counters'] = () => { asked++; return answer({ lan1: { rx_bytes: 1, tx_bytes: 2 } })(); };
		assert.deepEqual(JSON.parse(JSON.stringify((await self.fetch()).hw.counters)), { lan1: { rx: 1, tx: 2, at: 7000 } });
		assert.equal(asked, 2);
	} finally {
		Object.assign(global, saved);
		if (saved.document === undefined) delete global.document;
		delete REPLIES['luci.vantage.ports counters'];
	}
});

test('view: the call is a request of its own, in every poll\'s fetch, and what it answers reaches ingest', async () => {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.ok(src.includes("var callSwitchCounters = rpc.declare({ object: 'luci.vantage.ports', method: 'counters', expect: { '': {} }, reject: true, nobatch: true });"));
	const saved = { L: global.L, document: global.document };
	global.document = { hidden: false, documentElement: { getAttribute: () => null } };
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	let asked = 0;
	REPLIES['luci.vantage.ports counters'] = () => { asked++; return answer({ lan1: { rx_bytes: 1, tx_bytes: 2 } })(); };
	try {
		const self = Object.create(view);
		const raw = await self.fetch();
		assert.deepEqual([ asked, JSON.parse(JSON.stringify(raw.hw)) ], [ 1, { state: 'ok', counters: { lan1: { rx: 1, tx: 2, at: 7000 } }, swports: {}, none: false } ]);
		await self.fetch();
		assert.equal(asked, 2, 'every poll');
	} finally {
		Object.assign(global, saved);
		if (saved.document === undefined) delete global.document;
		delete REPLIES['luci.vantage.ports counters'];
	}
});
