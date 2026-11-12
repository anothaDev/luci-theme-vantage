'use strict';
/* luci-app-vantage-aps' ucode: the shared checks (vantage.aps), the
   pairing plugin (luci.vantage-pair) in a sandbox of its own files, and
   the access point's report against a fake sysfs and ubus. Runs under a
   host ucode binary ($UCODE, else `ucode` on PATH; skipped otherwise),
   with the doubles in tests/ucode/aps-stubs. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mkTmp = require('./tmpdir');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'luci-app-vantage-aps/root');
const MODULES = path.join(PKG, 'usr/share/ucode');
const PLUGIN = path.join(PKG, 'usr/share/rpcd/ucode/luci.vantage-pair');
const REPORT = path.join(PKG, 'usr/libexec/vantage/report');
const STUBS = path.join(__dirname, 'ucode/aps-stubs');
const HARNESS = path.join(__dirname, 'ucode/aps-harness.uc');

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
	const args = [ '-L', STUBS, '-L', MODULES ];
	const lib = UCODE && path.join(path.dirname(UCODE), '../lib/ucode');
	if (lib && fs.existsSync(lib)) args.push('-L', lib);
	return args;
}

/* an Ed25519 public key blob in base64, its 32 key bytes all `fill` */
const blob = fill => Buffer.concat([ Buffer.from([ 0, 0, 0, 11 ]), Buffer.from('ssh-ed25519'), Buffer.from([ 0, 0, 0, 32 ]), Buffer.alloc(32, fill) ]);
const key = fill => blob(fill).toString('base64');
/* dropbear's key file for it: string "ssh-ed25519", 32 private bytes, the 32 public ones */
const keyFile = fill => Buffer.concat([ Buffer.from([ 0, 0, 0, 11 ]), Buffer.from('ssh-ed25519'), Buffer.from([ 0, 0, 0, 64 ]), Buffer.alloc(32, 0xee), Buffer.alloc(32, fill) ]);

const K1 = key(1), K2 = key(2), K3 = key(3);
const routerCode = (k, n) => [ 'vantage-router', '1', 'ssh-ed25519', k, n ].join(' ');
const AP_MAC = '00:00:5e:00:53:a1';
const apCode = (k, a, p, n, m) => [ 'vantage-ap', '1', 'ssh-ed25519', k, a, String(p), m || AP_MAC, n ].join(' ');

/* ------------------------------------------------------------ module */

function runModule(cases) {
	const dir = mkTmp('vantage-aps-');
	const file = path.join(dir, 'cases.json');
	fs.writeFileSync(file, JSON.stringify(cases));
	const r = spawnSync(UCODE, ucodeArgs().concat([ '-D', 'MODE=module', '-D', 'CASES=' + file, HARNESS ]), { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout);
}

test('vantage.aps: keys are exactly an Ed25519 blob', { skip: NO_UCODE }, () => {
	const bad19 = 'AAAAC3NzaC1lZDI1NTE5AAAAIQ' + K1.slice(26);
	const rsa = Buffer.concat([ Buffer.from([ 0, 0, 0, 7 ]), Buffer.from('ssh-rsa'), Buffer.alloc(40, 1) ]).toString('base64');
	const cases = [ K1, K1 + '=', K1.slice(0, -1), bad19, rsa, K1 + ' ', ' ' + K1, K1.replace(/.$/, '!'), 12, null, '' ];
	const r = runModule(cases.map(v => [ 'key', v ]));
	assert.deepEqual(r, [ K1, null, null, null, null, null, null, null, null, null, null ]);
});

test('vantage.aps: names, addresses, ports', { skip: NO_UCODE }, () => {
	const names = [ 'ap-hall', 'AP.2_x', 'a', 'x'.repeat(63), 'x'.repeat(64), '-ap', '.ap', 'ap hall', 'ap\nhall', 'ap;rm', '', 7 ];
	assert.deepEqual(runModule(names.map(v => [ 'name', v ])), [ 'ap-hall', 'AP.2_x', 'a', 'x'.repeat(63), null, null, null, null, null, null, null, null ]);
	const addrs = [
		[ '192.0.2.10', '192.0.2.10' ], [ '198.51.100.255', '198.51.100.255' ], [ '0.1.2.3', null ], [ '127.0.0.1', null ],
		[ '224.0.0.1', null ], [ '255.255.255.255', null ], [ '192.0.2.256', null ], [ '192.0.2.01', null ], [ '192.0.2', null ],
		[ ' 192.0.2.1', null ], [ '2001:db8::1', '2001:db8::1' ], [ '2001:DB8::A', '2001:db8::a' ], [ '2001:db8:0:0:0:0:0:1', '2001:db8:0:0:0:0:0:1' ],
		[ 'fe80::1', null ], [ 'ff02::1', null ], [ '::1', null ], [ '::', null ], [ '2001:db8::1::2', null ], [ '2001:db8:::1', null ],
		[ '1:2:3:4:5:6:7:8:9', null ], [ '[2001:db8::1]', null ], [ '2001:db8::1%br-lan', null ], [ 'router.lan', null ], [ 5, null ]
	];
	assert.deepEqual(runModule(addrs.map(a => [ 'addr', a[0] ])), addrs.map(a => a[1]));
	const ports = [ [ 22, 22 ], [ '22', 22 ], [ 65535, 65535 ], [ 0, null ], [ 65536, null ], [ '2a', null ], [ -1, null ], [ 22.5, null ] ];
	assert.deepEqual(runModule(ports.map(p => [ 'port', p[0] ])), ports.map(p => p[1]));
	assert.deepEqual(runModule([ [ 'name_of', 'My Router!', 'router' ], [ 'name_of', '---', 'router' ], [ 'name_of', null, 'access-point' ], [ 'name_of', 'x'.repeat(80), 'r' ] ]),
		[ 'My-Router-', 'router', 'access-point', 'x'.repeat(63) ]);
});

test('vantage.aps: codes parse only in their exact form', { skip: NO_UCODE }, () => {
	const ok = routerCode(K1, 'gw');
	const r = runModule([
		[ 'parse_router', ok ], [ 'parse_router', '  ' + ok + '\r\n' ], [ 'parse_router', ok.replace(/ /g, '\t') ],
		[ 'parse_router', ok + ' extra' ], [ 'parse_router', ok.replace('vantage-router 1', 'vantage-router 2') ],
		[ 'parse_router', ok.replace('ssh-ed25519', 'ssh-rsa') ], [ 'parse_router', routerCode(K1, 'g w') ],
		[ 'parse_router', routerCode(K1, 'gw\ncommand="sh"') ], [ 'parse_router', routerCode(K1, 'gw') + ' '.repeat(600) + 'x' ],
		[ 'parse_router', apCode(K1, '192.0.2.10', 22, 'ap') ], [ 'parse_router', null ],
		[ 'parse_ap', apCode(K2, '192.0.2.10', 22, 'ap-hall') ], [ 'parse_ap', apCode(K2, '2001:DB8::10', '2222', 'ap') ],
		[ 'parse_ap', apCode(K2, '192.0.2.10', 0, 'ap') ], [ 'parse_ap', apCode(K2, 'fe80::1', 22, 'ap') ],
		[ 'parse_ap', apCode(K2, '192.0.2.10', 22, 'ap') + ' x' ], [ 'parse_ap', ok ],
		[ 'router_code', K1, 'gw' ], [ 'ap_code', K2, '192.0.2.10', 22, AP_MAC, 'ap' ],
		[ 'parse_ap', apCode(K2, '192.0.2.10', 22, 'ap', '00:00:5E:00:53:A1') ], [ 'parse_ap', apCode(K2, '192.0.2.10', 22, 'ap', '01:00:5e:00:53:a1') ],
		[ 'parse_ap', apCode(K2, '192.0.2.10', 22, 'ap', '00:00:00:00:00:00') ], [ 'parse_ap', apCode(K2, '192.0.2.10', 22, 'ap', '00-00-5e-00-53-a1') ],
		[ 'parse_ap', [ 'vantage-ap', '1', 'ssh-ed25519', K2, '192.0.2.10', '22', 'ap' ].join(' ') ]
	]);
	assert.deepEqual(r.slice(0, 3), [ { key: K1, name: 'gw' }, { key: K1, name: 'gw' }, { key: K1, name: 'gw' } ]);
	assert.deepEqual(r.slice(3, 11), [ null, null, null, null, null, null, null, null ]);
	assert.deepEqual(r.slice(11, 17), [ { key: K2, addr: '192.0.2.10', port: 22, mac: AP_MAC, name: 'ap-hall' }, { key: K2, addr: '2001:db8::10', port: 2222, mac: AP_MAC, name: 'ap' }, null, null, null, null ]);
	assert.deepEqual(r.slice(17, 19), [ ok, apCode(K2, '192.0.2.10', 22, 'ap') ]);
	/* the MAC: lower-cased; multicast, all zeros, dashes or none: no reply */
	assert.deepEqual(r.slice(19), [ { key: K2, addr: '192.0.2.10', port: 22, mac: AP_MAC, name: 'ap' }, null, null, null, null ]);
});

test('vantage.aps: the paired list keeps valid entries once, at most 16', { skip: NO_UCODE }, () => {
	const e = (i, k) => ({ id: i.toString(16).padStart(16, '0'), name: 'ap' + i, key: k, addr: '192.0.2.' + (i + 1), port: 22, mac: AP_MAC });
	const many = Array.from({ length: 20 }, (_, i) => e(i, key(10 + i)));
	const r = runModule([
		[ 'aps', JSON.stringify([ e(1, K1), e(1, K2), e(2, K1), Object.assign(e(3, K3), { addr: '127.0.0.1' }), Object.assign(e(4, key(4)), { port: '22' }), Object.assign(e(5, key(5)), { mac: null }), 'x', null ]) ],
		[ 'aps', JSON.stringify(many) ], [ 'aps', 'not json' ], [ 'aps', '{"id":1}' ], [ 'aps', null ]
	]);
	assert.deepEqual(r[0], [ e(1, K1), Object.assign(e(4, key(4)), { port: 22 }) ]);
	assert.equal(r[1].length, 16);
	assert.deepEqual(r.slice(2), [ [], [], [] ]);
});

test('vantage.aps find_addrs: where a MAC is now, from the neighbour table and the leases', { skip: NO_UCODE }, () => {
	const arp = 'IP address       HW type     Flags       HW address            Mask     Device\n' +
		'192.0.2.40       0x1         0x2         00:00:5E:00:53:A1     *        br-lan\n' +
		'192.0.2.41       0x1         0x0         00:00:5e:00:53:a1     *        br-lan\n' +
		'192.0.2.42       0x1         0x2         00:00:5e:00:53:a2     *        br-lan\n' +
		'127.0.0.1        0x1         0x2         00:00:5e:00:53:a1     *        lo\n';
	const leases = '1700000000 00:00:5e:00:53:a1 192.0.2.43 ap-hall *\n1700000000 00:00:5e:00:53:a1 192.0.2.40 ap-hall *\n' +
		'1700000000 00:00:5e:00:53:a3 192.0.2.44 other *\n1700000000 00:00:5e:00:53:a1 2001:db8::5 ap-hall *\ngarbage\n';
	const r = runModule([ [ 'find_addrs', AP_MAC, arp, leases ], [ 'find_addrs', '00:00:5E:00:53:A1', arp, null ], [ 'find_addrs', null, arp, leases ],
		[ 'find_addrs', '01:00:5e:00:53:a1', arp, leases ], [ 'find_addrs', AP_MAC, null, null ] ]);
	assert.deepEqual(r, [ [ '192.0.2.40', '192.0.2.43' ], [ '192.0.2.40' ], [], [], [] ]);
});

test('vantage.aps: no NUL byte passes a check; loopback, link-local and IPv4-mapped addresses however spelled do not either', { skip: NO_UCODE }, () => {
	/* ucode matches a regular expression against the bytes before a NUL only */
	const nul = runModule([ [ 'name', 'ap\u0000evil' ], [ 'mac', AP_MAC + '\u0000x' ], [ 'addr', '192.0.2.1\u0000x' ], [ 'key', K1 + '\u0000' ], [ 'id', '0123456789abcdef\u0000' ], [ 'port', '22\u0000' ],
		[ 'parse_router', routerCode(K1, 'gw\u0000 x') ], [ 'parse_ap', apCode(K2, '192.0.2.10', 22, 'ap') + '\u0000' ],
		[ 'normalize', { v: 1, ssids: [ { ifname: 'w0' }, { ifname: 'w0\u0000b' } ], stations: [ { mac: MAC_(1), ifname: 'w0' }, { mac: MAC_(1) + '\u0000x', ifname: 'w0' }, { mac: MAC_(2), ifname: 'w0\u0000' }, { mac: MAC_(3), ifname: 7 }, { mac: MAC_(4), ifname: true } ] } ] ]);
	assert.deepEqual(nul.slice(0, 8), [ null, null, null, null, null, null, null, null ]);
	assert.deepEqual([ nul[8].ssids.map(x => x.ifname), nul[8].stations.map(x => x.mac) ], [ [ 'w0' ], [ MAC_(1) ] ], 'one SSID, one station: no NUL twin, no ifname that is not a string');
	const addrs = [ '0::1', '::0', '0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0', '::0:1', '::2', '::ffff:c000:201', '::ffff:7f00:1', '64:ff9b::c000:201', [ 169, 254, 1, 1 ].join('.'),
		'192.0.2.1,198.51.100.1', '192.0.2.1;id', '192.0.2.1\n', '-oProxyCommand=x', '192.0.2.1/22', '192.0.2.1^x', 'root@192.0.2.1' ];
	assert.deepEqual(runModule(addrs.map(a => [ 'addr', a ])), addrs.map(() => null));
	assert.deepEqual(runModule([ [ 'addr', '100::1' ], [ 'addr', '2001:db8:0:1::20' ], [ 'addr', '2001:db8::' ] ]), [ '100::1', '2001:db8:0:1::20', '2001:db8::' ]);
});

test('vantage.aps: how a fetch ended, the state it makes, and where to look next', { skip: NO_UCODE }, () => {
	const E = (code, out, err, timedout) => [ 'fetch_error', code, out, err, !!timedout, 100 ];
	assert.deepEqual(runModule([
		E(0, '{}', ''), E(0, '{}', '', true), E(0, '', ''), E(0, 'x'.repeat(101), ''), E(0, null, ''), E(1, '{}', ''),
		E(1, '', 'dbclient: Connection to root@192.0.2.10:22 exited: Connect failed: Connection refused'), E(1, '', null),
		E(1, '', '\n\nssh-ed25519 host key mismatch for 192.0.2.10 !\nFingerprint is SHA256:x'), E(1, '', "Host '192.0.2.10' key unknown.\nexited: Not accepted automatically"),
		E(1, '', 'exited: No auth methods could be used.'), E(127, '', 'ash: /usr/libexec/vantage/report: not found'), E(126, '', 'ash: /usr/libexec/vantage/report: No such file or directory'),
		E(127, '', 'ash: something-else: not found')
	]), [ null, 'timeout', 'invalid', 'invalid', 'invalid', 'invalid', 'unreachable', 'unreachable', 'hostkey', 'hostkey', 'denied', 'missing', 'missing', 'unreachable' ]);
	assert.deepEqual(runModule([ [ 'state', true, 'timeout' ], [ 'state', false, 'timeout' ], [ 'state', false, 'unreachable' ], [ 'state', false, 'hostkey' ], [ 'state', false, 'denied' ],
		[ 'state', false, 'invalid' ], [ 'state', false, 'missing' ], [ 'state', false, null ] ]), [ 'ok', 'offline', 'offline', 'error', 'error', 'error', 'error', 'waiting' ]);
	assert.deepEqual(runModule([ 'unreachable', 'timeout', 'hostkey', 'denied', 'invalid', 'missing', null ].map(e => [ 'moved', e ])), [ true, true, true, false, false, false, false ]);
	const arp = 'h\n192.0.2.40 0x1 0x2 ' + AP_MAC + ' * br-lan\n192.0.2.44 0x1 0x2 ' + AP_MAC + ' * br-lan\n', leases = '1 ' + AP_MAC + ' 192.0.2.43 x *\n';
	assert.deepEqual(runModule([ [ 'next_addr', AP_MAC, '192.0.2.40', {}, arp, leases ], [ 'next_addr', AP_MAC, '192.0.2.40', { '192.0.2.44': true }, arp, leases ],
		[ 'next_addr', AP_MAC, '192.0.2.40', { '192.0.2.44': true, '192.0.2.43': true }, arp, leases ], [ 'next_addr', AP_MAC, '192.0.2.9', null, '', '' ] ]),
		[ '192.0.2.44', '192.0.2.43', null, null ]);
});

const MAC_ = n => '00:00:5e:00:53:' + n.toString(16).padStart(2, '0');
const MAC = n => '00:00:5e:00:53:' + n.toString(16).padStart(2, '0');

test('vantage.aps normalize: a hostile report keeps only what fits', { skip: NO_UCODE }, () => {
	const sta = (n, ifname, extra) => Object.assign({ mac: MAC(n), ifname, signal: -50, rx_rate: 1000, tx_rate: 2000, rx_bytes: 10, tx_bytes: 20, connected: 30 }, extra || {});
	const report = {
		v: 1, name: 'ap\u0001', model: 'M'.repeat(65), uptime: -5, mac: MAC(1).toUpperCase(),
		ssids: [ { ifname: 'phy0-ap0', bssid: MAC(16), ssid: 'Café', freq: 5180, channel: 36 }, { ifname: 'phy0-ap0', ssid: 'again' },
			{ ifname: 'bad name' }, { ifname: 'phy1-ap0', ssid: 'x'.repeat(33), freq: 'many' }, 'junk' ],
		stations: [ sta(32, 'phy0-ap0'), sta(32, 'phy0-ap0'), sta(33, 'nowhere'), sta(34, 'phy0-ap0', { signal: 5, rx_rate: 0, rx_bytes: -1, connected: 'x' }),
			{ mac: 'ff:ff:ff:ff:ff:fg', ifname: 'phy0-ap0' }, { mac: '00:00:00:00:00:00', ifname: 'phy0-ap0' } ],
		ports: { lan2: { speed: 1000, rx_bytes: 1, tx_bytes: 2, hosts: 1 }, lan3: { hosts: 0 }, 'x y': { hosts: 1 }, lan4: 'x' },
		wired: [ { mac: MAC(48), port: 'lan2' }, { mac: MAC(48), port: 'lan2' }, { mac: MAC(32), port: 'lan2' }, { mac: MAC(1), port: 'lan2' },
			{ mac: MAC(49), port: 'lan3' }, { mac: MAC(50), port: 'lan9' } ]
	};
	const [ r, wrongV, notObj, big ] = runModule([ [ 'normalize', report ], [ 'normalize', Object.assign({}, report, { v: 2 }) ], [ 'normalize', 'x' ],
		[ 'normalize', { v: 1, ssids: [ { ifname: 'w0' } ], stations: Array.from({ length: 300 }, (_, i) => ({ mac: '02:00:5e:00:' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0'), ifname: 'w0' })),
			wired: Array.from({ length: 200 }, (_, i) => ({ mac: '02:00:5e:01:' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0'), port: 'lan2' })),
			ports: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [ 'p' + i, { hosts: 1 } ]).concat([ [ 'lan2', { hosts: 1 } ] ])) } ]
	]);
	assert.equal(wrongV, null);
	assert.equal(notObj, null);
	assert.deepEqual(r, {
		name: '', model: '', uptime: null, mac: MAC(1),
		ssids: [ { ifname: 'phy0-ap0', bssid: MAC(16), ssid: 'Café', freq: 5180, channel: 36 }, { ifname: 'phy1-ap0', bssid: null, ssid: '', freq: null, channel: null } ],
		stations: [ sta(32, 'phy0-ap0'), { mac: MAC(34), ifname: 'phy0-ap0', signal: null, rx_rate: null, tx_rate: 2000, rx_bytes: null, tx_bytes: 20, connected: null } ],
		ports: { lan2: { speed: 1000, rx_bytes: 1, tx_bytes: 2, hosts: 1 } },
		wired: [ { mac: MAC(48), port: 'lan2' } ]
	});
	assert.equal(big.stations.length, 256);
	assert.equal(big.wired.length, 0, 'lan2 is not among the first 32 ports, so its hosts go');
	assert.equal(Object.keys(big.ports).length, 32);
});

test('vantage.aps normalize: names and SSIDs are well-formed UTF-8 without controls', { skip: NO_UCODE }, () => {
	const texts = [ 'Café', 'a\tb', 'a\u007fb', 'x'.repeat(32), 'x'.repeat(33), '\u{1F4FA}' ];
	const r = runModule(texts.map(t => [ 'normalize', { v: 1, ssids: [ { ifname: 'w0', ssid: t } ] } ]));
	assert.deepEqual(r.map(x => x.ssids[0].ssid), [ 'Café', '', '', 'x'.repeat(32), '', '\u{1F4FA}' ]);
});

test('vantage.aps view: rates from two reports, none across a reset or on a shared port', { skip: NO_UCODE }, () => {
	const cur = { name: 'ap', model: '', uptime: 1, mac: null, ssids: [ { ifname: 'w0', bssid: null, ssid: 's', freq: 5180, channel: 36 } ],
		stations: [ { mac: MAC(32), ifname: 'w0', signal: -50, rx_rate: 1, tx_rate: 2, rx_bytes: 2000, tx_bytes: 1000, connected: 3 } ],
		ports: { lan2: { speed: 100, rx_bytes: 500, tx_bytes: 600, hosts: 1 }, lan3: { speed: null, rx_bytes: 900, tx_bytes: 900, hosts: 2 } },
		wired: [ { mac: MAC(48), port: 'lan2' }, { mac: MAC(49), port: 'lan3' }, { mac: MAC(50), port: 'lan3' } ] };
	const prev = { stations: [ { mac: MAC(32), rx_bytes: 1000, tx_bytes: 2000 } ], ports: { lan2: { rx_bytes: 0, tx_bytes: 100 }, lan3: { rx_bytes: 0, tx_bytes: 0 } } };
	const [ v, first ] = runModule([ [ 'view', cur, prev, 10 ], [ 'view', cur, null, 0 ] ]);
	assert.deepEqual(v.ssids, [ { ifname: 'w0', bssid: null, ssid: 's', freq: 5180, channel: 36, band: '5g' } ]);
	assert.deepEqual(v.stations, [ { mac: MAC(32), ifname: 'w0', signal: -50, rxRate: 1, txRate: 2, rx: 800, tx: null, connected: 3 } ]);
	assert.deepEqual(v.wired, [ { mac: MAC(48), port: 'lan2', speed: 100, rx: 400, tx: 400 },
		{ mac: MAC(49), port: 'lan3', speed: null, rx: null, tx: null }, { mac: MAC(50), port: 'lan3', speed: null, rx: null, tx: null } ]);
	assert.deepEqual(first.stations[0].rx, null);
	assert.deepEqual(first.wired[0].rx, null);
	/* counters a terabyte apart, or near the top of 64 bits: no rate, and no wrapped number */
	const huge = Object.assign({}, cur, { stations: [ Object.assign({}, cur.stations[0], { rx_bytes: 9223372036854775807, tx_bytes: 1000 + 1099511627776 }) ] });
	const [ h ] = runModule([ [ 'view', huge, { stations: [ { mac: MAC(32), rx_bytes: 1000, tx_bytes: 1000 } ], ports: {} }, 10 ] ]);
	assert.deepEqual([ h.stations[0].rx, h.stations[0].tx ], [ null, 879609302220 ]);
});

/* ------------------------------------------------------------ plugin */

const DROPBEAR_OK = 'ELF...no-port-forwarding...command="...';
const LINE = (k, n) => 'command="/usr/libexec/vantage/report",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 ' + k + ' vantage-router@' + n;

/* a sandbox of the plugin's files: dropbear (with or without the options
   parser), its host key, dbclient, dropbearkey (copies a prepared key),
   the collector's init script (logs its argument), hostname, urandom */
function sandbox(o) {
	const dir = mkTmp('vantage-pair-');
	const p = rel => path.join(dir, rel);
	for (const d of [ 'etc/dropbear', 'etc/init.d', 'usr/sbin', 'usr/bin', 'proc', 'dev', 'sys/class/net/br-lan' ]) fs.mkdirSync(p(d), { recursive: true });
	if (o.lanMac !== null) fs.writeFileSync(p('sys/class/net/br-lan/address'), (o.lanMac ?? '00:00:5E:00:53:B1') + '\n');
	if (o.dropbear !== null) fs.writeFileSync(p('usr/sbin/dropbear'), o.dropbear ?? DROPBEAR_OK, { mode: 0o755 });
	if (o.dbclient !== false) fs.writeFileSync(p('usr/bin/dbclient'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
	fs.writeFileSync(p('keysrc'), keyFile(o.routerKey ?? 9));
	fs.writeFileSync(p('usr/bin/dropbearkey'), '#!/bin/sh\n[ "$1 $2 $3" = "-t ed25519 -f" ] && cp "' + p('keysrc') + '" "$4" && echo "$*" >> "' + p('dropbearkey.log') + '"\n', { mode: 0o755 });
	fs.writeFileSync(p('etc/init.d/vantage-collector'), '#!/bin/sh\necho "$*" >> "' + p('collector.log') + '"\n', { mode: 0o755 });
	if (o.hostKey !== null) fs.writeFileSync(p('etc/dropbear/dropbear_ed25519_host_key'), o.hostKey ?? keyFile(7), { mode: 0o600 });
	if (o.auth != null) fs.writeFileSync(p('etc/dropbear/authorized_keys'), o.auth, { mode: 0o600 });
	if (o.aps != null) { fs.mkdirSync(p('etc/vantage'), { recursive: true }); fs.writeFileSync(p('etc/vantage/aps.json'), JSON.stringify(o.aps)); }
	if (o.haveKey) { fs.mkdirSync(p('etc/vantage'), { recursive: true }); fs.writeFileSync(p('etc/vantage/id_ed25519'), keyFile(o.routerKey ?? 9), { mode: 0o600 }); }
	fs.writeFileSync(p('proc/hostname'), (o.hostname ?? 'gw') + '\n');
	fs.writeFileSync(p('dev/urandom'), Buffer.from([ 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef ]));
	return { dir, p };
}

const PATHS = {
	DIR: 'etc/vantage', KEY: 'etc/vantage/id_ed25519', APS: 'etc/vantage/aps.json', APS_TMP: 'etc/vantage/aps.json.tmp',
	AUTH: 'etc/dropbear/authorized_keys', AUTH_TMP: 'etc/dropbear/authorized_keys.vantage', HOST_KEY: 'etc/dropbear/dropbear_ed25519_host_key',
	DROPBEAR: 'usr/sbin/dropbear', DBCLIENT: 'usr/bin/dbclient', DROPBEARKEY: 'usr/bin/dropbearkey', COLLECTOR: 'etc/init.d/vantage-collector',
	HOSTNAME: 'proc/hostname', RANDOM: 'dev/urandom', NET: 'sys/class/net'
};

const UBUS_OK = {
	'service list dropbear': { dropbear: { instances: { instance1: { running: true } } } },
	'network.interface.lan status': { l3_device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.10', mask: 24 } ] }
};

/* run calls on one load of the plugin in a sandbox: { results, ubus, sb } */
function runPlugin(o, calls) {
	const sb = sandbox(o);
	let src = fs.readFileSync(PLUGIN, 'utf8');
	for (const [ name, rel ] of Object.entries(PATHS)) {
		const re = new RegExp('^const ' + name + ' = .*$', 'm');
		assert.match(src, re, name);
		src = src.replace(re, () => 'const ' + name + ' = ' + JSON.stringify((o.paths && o.paths[name]) || sb.p(rel)) + ';');
	}
	const plugin = sb.p('plugin.uc'), file = sb.p('case.json');
	fs.writeFileSync(plugin, src);
	fs.writeFileSync(file, JSON.stringify({ stub: { ubus: o.ubus ?? UBUS_OK, uci: o.uci ?? { dropbear: [ { '.type': 'dropbear', Port: '22' } ] } }, calls }));
	const r = spawnSync(UCODE, ucodeArgs().concat([ '-D', 'MODE=plugin', '-D', 'PLUGIN=' + plugin, '-D', 'CASES=' + file, HARNESS ]), { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	return Object.assign(JSON.parse(r.stdout), { sb });
}
const read = (sb, rel) => fs.existsSync(sb.p(rel)) ? fs.readFileSync(sb.p(rel), 'utf8') : null;
const mode = (sb, rel) => fs.statSync(sb.p(rel)).mode & 0o777;

test('pair: a router code is made once, from the key dropbearkey writes', { skip: NO_UCODE }, () => {
	const { results, sb } = runPlugin({}, [ { method: 'status' }, { method: 'router_code' }, { method: 'router_code' }, { method: 'status' } ]);
	assert.equal(results[0].reply.router.code, null);
	assert.deepEqual(results[1].reply, { code: routerCode(key(9), 'gw') });
	assert.deepEqual(results[2].reply, results[1].reply);
	assert.equal(results[3].reply.router.code, routerCode(key(9), 'gw'));
	assert.equal(read(sb, 'dropbearkey.log'), '-t ed25519 -f ' + sb.p('etc/vantage/id_ed25519') + '\n', 'made once');
	assert.equal(mode(sb, 'etc/vantage'), 0o700);
	const nodb = runPlugin({ dbclient: false }, [ { method: 'router_code' }, { method: 'status' } ]);
	assert.deepEqual(nodb.results[0].reply, { error: 'no-dbclient' });
	assert.equal(nodb.results[1].reply.router.code, null);
	assert.equal(read(nodb.sb, 'dropbearkey.log'), null);
	const host = runPlugin({ hostname: 'My Router' }, [ { method: 'router_code' } ]);
	assert.equal(host.results[0].reply.code, routerCode(key(9), 'My-Router'));
});

test('pair: allow_router adds one restricted line and keeps every other byte', { skip: NO_UCODE }, () => {
	const own = '# my keys\r\nssh-ed25519 ' + K3 + ' admin@laptop\r\n\r\nno-pty ssh-rsa AAAAB3Nza admin2\n';
	const { results, sb, ubus } = runPlugin({ auth: own }, [
		{ method: 'allow_router', args: { code: routerCode(K1, 'gw') } },
		{ method: 'allow_router', args: { code: routerCode(K1, 'gw') } },
		{ method: 'status' }
	]);
	const reply = apCode(key(7), '192.0.2.10', 22, 'gw', '00:00:5e:00:53:b1');
	assert.deepEqual(results[0].reply, { reply });
	assert.deepEqual(results[1].reply, { reply }, 'again: the same answer, no second line');
	assert.equal(read(sb, 'etc/dropbear/authorized_keys'), own + LINE(K1, 'gw') + '\n');
	assert.equal(mode(sb, 'etc/dropbear/authorized_keys'), 0o600);
	assert.deepEqual(results[2].reply.ap, { ssh: 'ok', routers: [ { name: 'gw', key: K1 } ], reply });
	assert.ok(ubus.every(c => [ 'service list dropbear', 'network.interface.lan status' ].includes(c)), JSON.stringify(ubus));
	assert.equal(fs.existsSync(sb.p('etc/dropbear/authorized_keys.vantage')), false);
});

test('pair: allow_router refuses bad codes, keys of the admin\'s own, a ninth router', { skip: NO_UCODE }, () => {
	const bad = [ '', routerCode(K1, 'g w'), routerCode(K1, 'gw') + '\n' + LINE(K2, 'x'), apCode(K1, '192.0.2.10', 22, 'ap'), routerCode('AAAA', 'gw') ];
	const r1 = runPlugin({ auth: 'ssh-ed25519 ' + K1 + ' admin\n' }, bad.map(code => ({ method: 'allow_router', args: { code } }))
		.concat([ { method: 'allow_router', args: { code: routerCode(K1, 'gw') } }, { method: 'allow_router', args: { code: 5 } }, { method: 'allow_router', args: { code: 'x', more: 1 } } ]));
	assert.deepEqual(r1.results.map(x => x.status === 0 ? x.reply : x.status),
		bad.map(() => ({ error: 'invalid' })).concat([ { error: 'duplicate' }, 2, 2 ]));
	assert.equal(read(r1.sb, 'etc/dropbear/authorized_keys'), 'ssh-ed25519 ' + K1 + ' admin\n');
	const eight = Array.from({ length: 8 }, (_, i) => LINE(key(20 + i), 'r' + i)).join('\n') + '\n';
	const r2 = runPlugin({ auth: eight }, [ { method: 'allow_router', args: { code: routerCode(K1, 'gw') } } ]);
	assert.deepEqual(r2.results[0].reply, { error: 'full' });
	assert.equal(read(r2.sb, 'etc/dropbear/authorized_keys'), eight);
});

test('pair: no pairing while SSH cannot hold a key to its command', { skip: NO_UCODE }, () => {
	const code = routerCode(K1, 'gw');
	const cases = [
		[ { dropbear: null }, 'no-dropbear' ],
		[ { dropbear: 'ELF built without key options' }, 'no-key-options' ],
		[ { hostKey: null }, 'no-host-key' ],
		[ { hostKey: Buffer.alloc(83, 1) }, 'no-host-key' ],
		[ { ubus: { 'network.interface.lan status': UBUS_OK['network.interface.lan status'], 'service list dropbear': { dropbear: { instances: { instance1: { running: false } } } } } }, 'not-running' ],
		[ { ubus: { 'service list dropbear': UBUS_OK['service list dropbear'] } }, 'no-address' ],
		[ { lanMac: null }, 'no-address' ],
		[ { lanMac: 'ff:ff:ff:ff:ff:fz' }, 'no-address' ],
		[ { ubus: { 'service list dropbear': UBUS_OK['service list dropbear'], 'network.interface.lan status': { l3_device: '../../etc', 'ipv4-address': [ { address: '192.0.2.10' } ] } } }, 'no-address' ]
	];
	for (const [ o, state ] of cases) {
		const { results, sb } = runPlugin(o, [ { method: 'allow_router', args: { code } }, { method: 'status' } ]);
		assert.deepEqual(results[0].reply, { error: state }, state);
		assert.equal(results[1].reply.ap.ssh, state);
		assert.equal(results[1].reply.ap.reply, null);
		assert.equal(read(sb, 'etc/dropbear/authorized_keys'), null, state + ': nothing written');
	}
});

test('pair: the reply names the first dropbear section that is on; settings that keep a router out refuse pairing', { skip: NO_UCODE }, () => {
	const code = routerCode(K1, 'gw'), sec = o => Object.assign({ '.type': 'dropbear' }, o);
	const port = uci => runPlugin({ uci: { dropbear: uci } }, [ { method: 'allow_router', args: { code } } ]).results[0].reply;
	assert.deepEqual(port([ sec({ enable: '0', Port: '22' }), sec({ Port: '2222 2223' }), sec({ Port: '2224' }) ]), { reply: apCode(key(7), '192.0.2.10', 2222, 'gw', '00:00:5e:00:53:b1') });
	assert.deepEqual(port([ sec({}) ]), { reply: apCode(key(7), '192.0.2.10', 22, 'gw', '00:00:5e:00:53:b1') });
	assert.deepEqual(port([ sec({ Port: 'x' }) ]), { reply: apCode(key(7), '192.0.2.10', 22, 'gw', '00:00:5e:00:53:b1') });
	for (const s of [ { RootLogin: '0' }, { RootLogin: 'off' }, { ForceCommand: '/bin/true' }, { keyfile: [ '/etc/dropbear/other_host_key' ] } ]) {
		const { results, sb } = runPlugin({ uci: { dropbear: [ sec({ enable: 'off' }), sec(s) ] } }, [ { method: 'allow_router', args: { code } }, { method: 'status' } ]);
		assert.deepEqual(results[0].reply, { error: 'unsupported' }, JSON.stringify(s));
		assert.equal(results[1].reply.ap.ssh, 'unsupported');
		assert.equal(read(sb, 'etc/dropbear/authorized_keys'), null);
	}
});

test('pair: a write that does not hold leaves the keys as they were', { skip: NO_UCODE }, () => {
	/* /dev/full takes the bytes and keeps none, as a full flash does: writefile reports no error */
	const own = 'ssh-ed25519 ' + K3 + ' admin@laptop\n';
	const a = runPlugin({ auth: own, paths: { AUTH_TMP: '/dev/full' } }, [ { method: 'allow_router', args: { code: routerCode(K1, 'gw') } }, { method: 'status' } ]);
	assert.deepEqual(a.results[0].reply, { error: 'failed' });
	assert.equal(read(a.sb, 'etc/dropbear/authorized_keys'), own, 'untouched');
	assert.deepEqual(a.results[1].reply.ap.routers, []);
	const b = runPlugin({ haveKey: true, paths: { APS_TMP: '/dev/full' } }, [ { method: 'add_ap', args: { code: apCode(K2, '192.0.2.20', 22, 'ap-hall') } } ]);
	assert.deepEqual(b.results[0].reply, { error: 'failed' });
	assert.equal(read(b.sb, 'etc/vantage/aps.json'), null);
	assert.equal(read(b.sb, 'collector.log'), null, 'the collector is not started for a list that was not saved');
});

test('pair: revoke_router removes only that router\'s line', { skip: NO_UCODE }, () => {
	const auth = 'ssh-ed25519 ' + K1 + ' admin\n' + LINE(K1, 'gw') + '\n' + LINE(K2, 'gw2') + '\n';
	const { results, sb } = runPlugin({ auth }, [
		{ method: 'revoke_router', args: { key: K1 } }, { method: 'revoke_router', args: { key: K1 } },
		{ method: 'revoke_router', args: { key: 'AAAA' } }, { method: 'revoke_router', args: { key: K3 } }
	]);
	assert.deepEqual(results.map(x => x.reply), [ { ok: true }, { error: 'unknown' }, { error: 'unknown' }, { error: 'unknown' } ]);
	assert.equal(read(sb, 'etc/dropbear/authorized_keys'), 'ssh-ed25519 ' + K1 + ' admin\n' + LINE(K2, 'gw2') + '\n');
});

test('pair: add_ap stores the access point and starts the collector; remove_ap stops it with the last', { skip: NO_UCODE }, () => {
	const code = apCode(K2, '192.0.2.20', 22, 'ap-hall');
	const { results, sb } = runPlugin({ haveKey: true }, [
		{ method: 'add_ap', args: { code } },
		{ method: 'add_ap', args: { code } },
		{ method: 'add_ap', args: { code: apCode(K3, '192.0.2.21', 2222, 'ap-loft'), addr: '198.51.100.7' } },
		{ method: 'add_ap', args: { code: apCode(key(4), '192.0.2.22', 22, 'x'), addr: '127.0.0.1' } },
		{ method: 'add_ap', args: { code: routerCode(K1, 'gw') } },
		{ method: 'status' },
		{ method: 'remove_ap', args: { id: '0123456789abcdef' } },
		{ method: 'remove_ap', args: { id: 'nope' } }
	]);
	const id = '0123456789abcdef';
	/* the urandom double gives the same id again: a second entry under it is refused */
	assert.deepEqual(results.slice(0, 5).map(x => x.reply), [ { id }, { error: 'duplicate' }, { error: 'failed' }, { error: 'invalid' }, { error: 'invalid' } ]);
	assert.deepEqual(results[5].reply.router.aps, [ { id, name: 'ap-hall', addr: '192.0.2.20', port: 22 } ]);
	assert.deepEqual(results.slice(6).map(x => x.reply), [ { ok: true }, { error: 'unknown' } ]);
	assert.equal(read(sb, 'collector.log'), 'enable\nstart\nstop\ndisable\n');
	const other = runPlugin({ haveKey: true }, [ { method: 'add_ap', args: { code: apCode(K3, '192.0.2.21', 2222, 'ap-loft'), addr: '198.51.100.7' } }, { method: 'status' } ]);
	assert.deepEqual(other.results[1].reply.router.aps, [ { id, name: 'ap-loft', addr: '198.51.100.7', port: 2222 } ], 'the address given wins');
	assert.deepEqual(JSON.parse(read(other.sb, 'etc/vantage/aps.json')), [ { id, name: 'ap-loft', key: K3, addr: '198.51.100.7', port: 2222, mac: AP_MAC } ], 'kept with its MAC');
	assert.equal(mode(sb, 'etc/vantage/aps.json'), 0o600);
	assert.deepEqual(JSON.parse(read(sb, 'etc/vantage/aps.json')), [], 'the last one removed');
	const nokey = runPlugin({}, [ { method: 'add_ap', args: { code } } ]);
	assert.deepEqual(nokey.results[0].reply, { error: 'no-key' });
	assert.equal(read(nokey.sb, 'collector.log'), null);
});

test('pair: at most 16 access points', { skip: NO_UCODE }, () => {
	const aps = Array.from({ length: 16 }, (_, i) => ({ id: (i + 1).toString(16).padStart(16, '0'), name: 'ap' + i, key: key(40 + i), addr: '192.0.2.' + (i + 1), port: 22, mac: AP_MAC }));
	const { results, sb } = runPlugin({ haveKey: true, aps }, [ { method: 'add_ap', args: { code: apCode(K2, '192.0.2.100', 22, 'one-more') } } ]);
	assert.deepEqual(results[0].reply, { error: 'full' });
	assert.equal(JSON.parse(read(sb, 'etc/vantage/aps.json')).length, 16);
});

/* ------------------------------------------------------------ report */

/* a fake /sys/class/net and /proc/net/arp, and the report's ubus replies */
function reportRun(o) {
	const dir = mkTmp('vantage-report-');
	const net = path.join(dir, 'net');
	const dev = (name, files) => {
		fs.mkdirSync(path.join(net, name, 'statistics'), { recursive: true });
		for (const [ f, v ] of Object.entries(files || {})) fs.writeFileSync(path.join(net, name, f), v);
	};
	dev('br-lan', { address: MAC(1) + '\n' });
	dev('lan1', { address: MAC(2) + '\n', speed: '1000\n', 'statistics/rx_bytes': '100\n', 'statistics/tx_bytes': '200\n' });
	dev('lan2', { address: MAC(3) + '\n', speed: '100\n', 'statistics/rx_bytes': '300\n', 'statistics/tx_bytes': '400\n' });
	dev('lan3', { address: MAC(4) + '\n', speed: '-1\n', 'statistics/rx_bytes': '500\n', 'statistics/tx_bytes': '600\n' });
	dev('phy0-ap0', { address: MAC(16) + '\n' });
	fs.mkdirSync(path.join(net, 'phy0-ap0', 'phy80211'));
	dev('ra0', { address: MAC(17) + '\n' });
	const arp = path.join(dir, 'arp');
	fs.writeFileSync(arp, 'IP address       HW type     Flags       HW address            Mask     Device\n' + (o.arp || []).map(a => a.join('  ')).join('\n') + '\n');
	const host = path.join(dir, 'hostname');
	fs.writeFileSync(host, (o.hostname ?? 'ap-hall') + '\n');
	let src = fs.readFileSync(REPORT, 'utf8');
	for (const [ name, v ] of Object.entries({ NET: net, ARP: arp, HOSTNAME: host })) {
		const re = new RegExp('^const ' + name + ' = .*$', 'm');
		assert.match(src, re);
		src = src.replace(re, () => 'const ' + name + ' = ' + JSON.stringify(v) + ';');
	}
	const script = path.join(dir, 'report.uc'), stub = path.join(dir, 'stub.json'), calls = path.join(dir, 'calls');
	fs.writeFileSync(script, src);
	fs.writeFileSync(stub, JSON.stringify({ ubus: o.ubus }));
	const r = spawnSync(UCODE, ucodeArgs().concat([ '-D', 'STUBFILE=' + stub, '-D', 'CALLSFILE=' + calls, script, 'ignored', 'args' ]),
		{ encoding: 'utf8', input: 'ignored stdin', env: Object.assign({}, process.env, { SSH_CLIENT: o.client ?? '', SSH_ORIGINAL_COMMAND: 'rm -rf /' }) });
	assert.equal(r.status, 0, r.stderr);
	return { out: JSON.parse(r.stdout), calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [] };
}

const REPORT_UBUS = {
	'system board': { model: 'Example AP', release: {} },
	'system info': { uptime: 1234 },
	'iwinfo devices': { devices: [ 'phy0-ap0', 'phy0-sta0', 'bad name', 'ra0' ] },
	'iwinfo info phy0-ap0': { mode: 'Master', ssid: 'Home', bssid: MAC(16).toUpperCase(), frequency: 5180, channel: 36, encryption: { enabled: true } },
	'iwinfo info phy0-sta0': { mode: 'Client', ssid: 'Upstream' },
	'iwinfo info ra0': { mode: 'Master', ssid: 'Guest', bssid: MAC(17), frequency: 2437, channel: 6 },
	'iwinfo assoclist phy0-ap0': { results: [
		{ mac: MAC(32).toUpperCase(), signal: -55, connected_time: 60, authorized: true, rx: { rate: 866000, bytes: 1000 }, tx: { rate: 650000, bytes: 2000 } },
		{ mac: MAC(33), signal: -70, authorized: false, rx: {}, tx: {} },
		{ mac: 'junk' } ] },
	'iwinfo assoclist ra0': { results: [ { mac: MAC(34), signal: -60, rx: { rate: 72000, bytes: 5 }, tx: { rate: 72000, bytes: 6 } } ] },
	'network.interface dump': { interface: [
		{ interface: 'lan', l3_device: 'br-lan', route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.0.2.1' } ] },
		{ interface: 'loopback', l3_device: 'lo', route: [] } ] },
	'luci.vantage wired': { hosts: [
		{ mac: MAC(64), port: 'lan1' }, { mac: MAC(65), port: 'lan1' },
		{ mac: MAC(66), port: 'lan2' },
		{ mac: MAC(67), port: 'lan3' }, { mac: MAC(68), port: 'lan3' },
		{ mac: MAC(69), port: 'phy0-ap0' }, { mac: MAC(70), port: 'ra0' },
		{ mac: MAC(1), port: 'lan2' }, { mac: 'bad', port: 'lan2' }, { mac: MAC(71), port: 'bad port' }, { mac: MAC(66), port: 'lan3' } ] }
};
const REPORT_CALLS = [ 'system board', 'system info', 'iwinfo devices', 'iwinfo info', 'iwinfo assoclist', 'network.interface dump', 'luci.vantage wired' ];

test('report: SSIDs, stations, and the wired hosts past the uplink', { skip: NO_UCODE }, () => {
	const { out, calls } = reportRun({ ubus: REPORT_UBUS, arp: [ [ '192.0.2.1', '0x1', '0x2', MAC(64), '*', 'br-lan' ], [ '192.0.2.99', '0x1', '0x0', MAC(65), '*', 'br-lan' ] ] });
	assert.deepEqual(out, {
		v: 1, name: 'ap-hall', model: 'Example AP', uptime: 1234, mac: MAC(1),
		ssids: [ { ifname: 'phy0-ap0', bssid: MAC(16), ssid: 'Home', freq: 5180, channel: 36 }, { ifname: 'ra0', bssid: MAC(17), ssid: 'Guest', freq: 2437, channel: 6 } ],
		stations: [
			{ mac: MAC(32), ifname: 'phy0-ap0', signal: -55, rx_rate: 866000, tx_rate: 650000, rx_bytes: 1000, tx_bytes: 2000, connected: 60 },
			{ mac: MAC(34), ifname: 'ra0', signal: -60, rx_rate: 72000, tx_rate: 72000, rx_bytes: 5, tx_bytes: 6, connected: null } ],
		ports: { lan2: { speed: 100, rx_bytes: 300, tx_bytes: 400, hosts: 1 }, lan3: { speed: null, rx_bytes: 500, tx_bytes: 600, hosts: 2 } },
		wired: [ { mac: MAC(66), port: 'lan2' }, { mac: MAC(67), port: 'lan3' }, { mac: MAC(68), port: 'lan3' } ]
	});
	for (const c of calls) assert.ok(REPORT_CALLS.some(k => c === k || c.startsWith(k + ' ')), c);
});

test('report: no uplink found, no wired hosts; the router\'s own address finds it too', { skip: NO_UCODE }, () => {
	assert.deepEqual(reportRun({ ubus: REPORT_UBUS, arp: [] }).out.wired, [], 'gateway not in the neighbour table');
	const ubus = Object.assign({}, REPORT_UBUS, { 'network.interface dump': { interface: [ { interface: 'lan', l3_device: 'br-lan', route: [] } ] } });
	assert.deepEqual(reportRun({ ubus, arp: [ [ '192.0.2.1', '0x1', '0x2', MAC(64), '*', 'br-lan' ] ] }).out.wired, [], 'no default route');
	const viaRouter = reportRun({ ubus, client: '192.0.2.9 50000 22', arp: [ [ '192.0.2.9', '0x1', '0x2', MAC(66), '*', 'br-lan' ] ] }).out;
	/* the router's MAC is listed on lan2 and lan3: both are uplinks then */
	assert.deepEqual(viaRouter.wired, [ { mac: MAC(64), port: 'lan1' }, { mac: MAC(65), port: 'lan1' } ]);
});

test('report: without ubus it prints nothing and fails', { skip: NO_UCODE }, () => {
	const dir = mkTmp('vantage-report-');
	const stub = path.join(dir, 'stub.json');
	fs.writeFileSync(stub, JSON.stringify({ no_ubus: true }));
	const r = spawnSync(UCODE, ucodeArgs().concat([ '-D', 'STUBFILE=' + stub, REPORT ]), { encoding: 'utf8' });
	assert.equal(r.status, 1);
	assert.equal(r.stdout, '');
});

test('report: one at a time; a second run gives up without a report', { skip: NO_UCODE }, async () => {
	const dir = mkTmp('vantage-report-');
	const self = path.join(dir, 'report'), stub = path.join(dir, 'stub.json');
	fs.writeFileSync(stub, JSON.stringify({ ubus: REPORT_UBUS }));
	const src = fs.readFileSync(REPORT, 'utf8').replace(/^const SELF = .*$/m, () => 'const SELF = ' + JSON.stringify(self) + ';');
	fs.writeFileSync(self, src);
	const run = () => spawnSync(UCODE, ucodeArgs().concat([ '-D', 'STUBFILE=' + stub, self ]), { encoding: 'utf8' });
	assert.equal(run().status, 0, 'alone, it reports');
	/* another holds the lock for two seconds (it says so in a file: its output is buffered until it ends) */
	const held = path.join(dir, 'held');
	const holder = require('child_process').spawn(UCODE, [ '-e', 'import { open, writefile } from "fs"; let f = open(' + JSON.stringify(self) + ', "r"); f.lock("x"); writefile(' + JSON.stringify(held) + ', "1"); sleep(2000);' ], { stdio: 'ignore' });
	for (let i = 0; i < 100 && !fs.existsSync(held); i++) await new Promise(resolve => setTimeout(resolve, 20));
	assert.ok(fs.existsSync(held), 'the lock is held');
	const second = run();
	assert.equal(second.status, 1);
	assert.equal(second.stdout, '', 'nothing printed');
	await new Promise(resolve => holder.once('exit', resolve));
	assert.equal(run().status, 0, 'and again once the first is done');
});

/* --------------------------------------------------------- collector */

const COLLECTOR = path.join(PKG, 'usr/libexec/vantage/collector');
const AP1 = { id: '00000000000000a1', name: 'ap-hall', key: K1, addr: '192.0.2.10', port: 22, mac: AP_MAC };
const AP2 = { id: '00000000000000a2', name: 'ap-den', key: K2, addr: '192.0.2.11', port: 2222, mac: '00:00:5e:00:53:a2' };
const apReport = (n, bytes, extra) => JSON.stringify(Object.assign({ v: 1, name: 'calls-itself-' + n, model: 'Example AP', uptime: 100, mac: MAC(99),
	ssids: [ { ifname: 'phy0-ap0', bssid: MAC(16), ssid: 'Home', freq: 5180, channel: 36 } ],
	stations: [ { mac: MAC(32), ifname: 'phy0-ap0', signal: -50, rx_rate: 866000, tx_rate: 650000, rx_bytes: bytes, tx_bytes: 2 * bytes, connected: 60 } ],
	ports: { lan2: { speed: 1000, rx_bytes: bytes, tx_bytes: bytes, hosts: 1 } }, wired: [ { mac: MAC(48), port: 'lan2' } ] }, extra || {})) + '\n';

/* the collector in a sandbox, under the uloop double's clock: a fake
   dbclient that logs how it was called and answers as hosts/<addr>/ says
   (out, err, code; no directory: connection refused; a file `hang`: never
   ends), a fake kill, its own paired list, neighbour table and leases.
   Returns { results: one per step, log: dbclient's calls, sb } */
function runCollector(o, steps) {
	const dir = mkTmp('vantage-collector-');
	const p = rel => path.join(dir, rel);
	for (const d of [ 'etc/vantage', 'run', 'hosts', 'bin' ]) fs.mkdirSync(p(d), { recursive: true });
	fs.writeFileSync(p('etc/vantage/aps.json'), JSON.stringify(o.aps ?? [ AP1 ]));
	fs.writeFileSync(p('etc/vantage/id_ed25519'), keyFile(9), { mode: 0o600 });
	fs.writeFileSync(p('arp'), o.arp ?? '');
	fs.writeFileSync(p('leases'), o.leases ?? '');
	for (const [ addr, h ] of Object.entries(o.hosts || {})) {
		fs.mkdirSync(p('hosts/' + addr));
		for (const [ f, v ] of Object.entries(h)) fs.writeFileSync(p('hosts/' + addr + '/' + f), String(v));
	}
	fs.writeFileSync(p('bin/dbclient'), [ '#!/bin/sh', 'S="' + dir + '"', 'for a in "$@"; do case "$a" in root@*) addr=${a#root@};; esac; done',
		'{ echo "argv: $*"; echo "home: $HOME"; echo "known_hosts: $(cat "$HOME/.ssh/known_hosts")"; } >> "$S/dbclient.log"', 'd="$S/hosts/$addr"',
		'[ -d "$d" ] || { echo "dbclient: Connection to root@$addr exited: Connect failed: Connection refused" >&2; exit 1; }',
		'[ -f "$d/err" ] && cat "$d/err" >&2', '[ -f "$d/out" ] && cat "$d/out"', 'exit "$(cat "$d/code" 2>/dev/null || echo 0)"', '' ].join('\n'), { mode: 0o755 });
	fs.writeFileSync(p('bin/kill'), '#!/bin/sh\n: > "' + dir + '/killed.$1"\n', { mode: 0o755 });
	let src = fs.readFileSync(COLLECTOR, 'utf8');
	for (const [ name, rel ] of Object.entries({ KEY: 'etc/vantage/id_ed25519', APS: 'etc/vantage/aps.json', RUN: 'run', ARP: 'arp', LEASES: 'leases', DBCLIENT: 'bin/dbclient', KILL: 'bin/kill' })) {
		const re = new RegExp('^const ' + name + ' = .*$', 'm');
		assert.match(src, re, name);
		src = src.replace(re, () => 'const ' + name + ' = ' + JSON.stringify(p(rel)) + ';');
	}
	/* the double's clock for the kernel's */
	assert.ok(src.includes('\treturn clock(true)?.[0] ?? 0;\n'), 'now()');
	src = src.replace('\treturn clock(true)?.[0] ?? 0;\n', '\treturn int(global.LOOP.now / 1000);\n');
	const script = p('collector.uc'), file = p('steps.json');
	fs.writeFileSync(script, src);
	fs.writeFileSync(file, JSON.stringify(steps.map(s => s.write ? { write: [ p(s.write[0]), s.write[1] ] } : s)));
	const r = spawnSync(UCODE, ucodeArgs().concat([ '-D', 'CASES=' + file, '-D', 'SANDBOX=' + dir, script ]), { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	const log = fs.existsSync(p('dbclient.log')) ? fs.readFileSync(p('dbclient.log'), 'utf8').trim().split('\n') : [];
	return { results: JSON.parse(r.stdout), log, calls: log.filter(l => l.startsWith('argv: ')), sb: { dir, p } };
}
const ASK = { report: true }, wait = s => ({ advance: s * 1000 });

test('collector: nothing runs without a viewer; a viewer gets one fetch per access point every 10 s for 60 s', { skip: NO_UCODE }, () => {
	const idle = runCollector({ hosts: { '192.0.2.10': { out: apReport(1, 1000) } } }, [ wait(120) ]);
	assert.deepEqual(idle.calls, [], 'no viewer, no login');
	const { results, calls, log, sb } = runCollector({ hosts: { '192.0.2.10': { out: apReport(1, 1000) } } }, [ ASK, wait(2), ASK, wait(118), ASK ]);
	assert.deepEqual(results[0].aps.map(a => [ a.id, a.name, a.addr, a.state, a.error, a.age, a.report ]), [ [ AP1.id, 'ap-hall', '192.0.2.10', 'waiting', null, null, null ] ]);
	assert.equal(results[2].aps[0].state, 'ok');
	/* exactly how dbclient is called: the pinned host key, batch mode, no passwords, a home of its own */
	assert.equal(calls[0], 'argv: -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o PasswordAuthentication=no -i ' + sb.p('etc/vantage/id_ed25519') + ' -p 22 -I 15 root@192.0.2.10 /usr/libexec/vantage/report');
	assert.equal(log[1], 'home: ' + sb.p('run/' + AP1.id));
	assert.equal(log[2], 'known_hosts: 192.0.2.10 ssh-ed25519 ' + K1);
	/* a call at 0 s and one at 2 s keep it going until 62 s: fetches at 0, 10, ... 60,
	   then none until the call at 120 s starts the next one */
	assert.equal(calls.length, 8, calls.length + ' fetches: seven while looked at, one for the last call');
	/* after the pause the last report stands until the next fetch has ended */
	assert.equal(results[4].aps[0].state, 'ok');
	assert.ok(results[4].aps[0].age >= 58, 'age ' + results[4].aps[0].age);
});

test('collector: the report is checked, carries the pairing MAC, and rates come from two reports', { skip: NO_UCODE }, () => {
	const { results } = runCollector({ hosts: { '192.0.2.10': { out: apReport(1, 1000) } } },
		[ ASK, wait(2), ASK, { write: [ 'hosts/192.0.2.10/out', apReport(1, 126000) ] }, wait(10), ASK ]);
	const first = results[2].aps[0].report, second = results[5].aps[0].report;
	assert.equal(first.mac, AP_MAC, 'the MAC of the pairing, not the one it reports');
	assert.equal(first.name, 'calls-itself-1');
	assert.deepEqual(first.ssids, [ { ifname: 'phy0-ap0', bssid: MAC(16), ssid: 'Home', freq: 5180, channel: 36, band: '5g' } ]);
	assert.deepEqual(first.stations, [ { mac: MAC(32), ifname: 'phy0-ap0', signal: -50, rxRate: 866000, txRate: 650000, rx: null, tx: null, connected: 60 } ]);
	assert.deepEqual(first.wired, [ { mac: MAC(48), port: 'lan2', speed: 1000, rx: null, tx: null } ]);
	/* 125000 bytes more in 10 s: 100 kbit/s from the station, twice that to it */
	assert.deepEqual([ second.stations[0].rx, second.stations[0].tx, second.wired[0].rx ], [ 100000, 200000, 100000 ]);
});

test('collector: why a fetch failed, and what the dashboard is told', { skip: NO_UCODE }, () => {
	const cases = [
		[ {}, 'offline', 'unreachable' ],
		[ { '192.0.2.10': { err: 'dbclient: Connection to root@192.0.2.10:22 exited:\n\nssh-ed25519 host key mismatch for 192.0.2.10 !', code: 1 } }, 'error', 'hostkey' ],
		[ { '192.0.2.10': { err: 'dbclient: Connection to root@192.0.2.10:22 exited: No auth methods could be used.', code: 1 } }, 'error', 'denied' ],
		[ { '192.0.2.10': { err: 'ash: /usr/libexec/vantage/report: not found', code: 127 } }, 'error', 'missing' ],
		[ { '192.0.2.10': { out: 'not json' } }, 'error', 'invalid' ],
		[ { '192.0.2.10': { out: JSON.stringify({ v: 2 }) } }, 'error', 'invalid' ],
		[ { '192.0.2.10': { out: 'x'.repeat(200000) } }, 'error', 'invalid' ],
		[ { '192.0.2.10': { hang: '' } }, 'offline', 'timeout' ]
	];
	for (const [ hosts, state, error ] of cases) {
		const { results, sb } = runCollector({ hosts }, [ ASK, wait(17), ASK ]);
		assert.deepEqual([ results[2].aps[0].state, results[2].aps[0].error, results[2].aps[0].report ], [ state, error, null ], error);
		if (error === 'timeout') assert.ok(fs.readdirSync(sb.dir).some(f => /^killed\.\d+$/.test(f)), 'the hung dbclient is killed after 15 s');
		/* what it printed is never left behind, and never more than the size limit allows */
		for (const f of [ 'out', 'err' ]) assert.equal(fs.existsSync(sb.p('run/' + AP1.id + '/' + f)), false, f + ' removed');
	}
});

test('collector: an access point that moved is found by its MAC, the pinned host key deciding', { skip: NO_UCODE }, () => {
	const arp = 'IP address HW type Flags HW address Mask Device\n192.0.2.77 0x1 0x2 ' + AP_MAC + ' * br-lan\n';
	const leases = '1700000000 ' + AP_MAC + ' 192.0.2.78 ap-hall *\n';
	/* gone from 192.0.2.10; another device answers at .77 with another host key; it is at .78 */
	const { results, calls, log, sb } = runCollector({ arp, leases, hosts: {
		'192.0.2.77': { err: 'ssh-ed25519 host key mismatch for 192.0.2.77 !', code: 1 },
		'192.0.2.78': { out: apReport(1, 1000) }
	} }, [ ASK, wait(1), ASK, wait(1), ASK, wait(2), ASK, wait(10), ASK ]);
	assert.deepEqual(calls.slice(0, 3).map(c => /root@(\S+)/.exec(c)[1]), [ '192.0.2.10', '192.0.2.77', '192.0.2.78' ]);
	assert.equal(log.filter(l => l.startsWith('known_hosts: '))[2], 'known_hosts: 192.0.2.78 ssh-ed25519 ' + K1, 'the same pinned key at the new address');
	/* while it looks: the error where it was paired, never the other device's */
	assert.deepEqual([ results[2].aps[0].state, results[2].aps[0].error, results[2].aps[0].addr ], [ 'offline', 'unreachable', '192.0.2.10' ]);
	assert.deepEqual([ results[6].aps[0].state, results[6].aps[0].addr ], [ 'offline', '192.0.2.10' ], 'still looking');
	assert.deepEqual([ results[8].aps[0].state, results[8].aps[0].error, results[8].aps[0].addr ], [ 'ok', null, '192.0.2.78' ]);
	assert.equal(/root@(\S+)/.exec(calls[3])[1], '192.0.2.78', 'and from then on there');
	assert.deepEqual(JSON.parse(read(sb, 'etc/vantage/aps.json')), [ AP1 ], 'the paired list is not rewritten');
	/* nothing in the tables: it stays where it was paired */
	const lost = runCollector({ hosts: {} }, [ ASK, wait(25), ASK ]);
	assert.ok(lost.calls.every(c => c.includes('root@192.0.2.10 ')), 'no other address tried');
});

test('collector: the paired list is read again when it changes, even within a second; 1024 stations in a reply', { skip: NO_UCODE }, () => {
	const many = n => JSON.stringify({ v: 1, name: 'x', ssids: [ { ifname: 'w0', freq: 2437 } ],
		stations: Array.from({ length: 256 }, (_, i) => ({ mac: '02:00:5e:' + n.toString(16).padStart(2, '0') + ':' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0'), ifname: 'w0' })) });
	const aps = Array.from({ length: 5 }, (_, i) => ({ id: (0xb0 + i).toString(16).padStart(16, '0'), name: 'ap' + i, key: key(60 + i), addr: '192.0.2.' + (20 + i), port: 22, mac: MAC(0x70 + i) }));
	const hosts = Object.fromEntries(aps.map((a, i) => [ a.addr, { out: many(i) } ]));
	const { results } = runCollector({ aps, hosts }, [ ASK, wait(2), ASK, { write: [ 'etc/vantage/aps.json', JSON.stringify(aps.slice(1)) ] }, ASK,
		{ write: [ 'etc/vantage/aps.json', JSON.stringify(aps.slice(1).concat([ AP2 ])) ] }, ASK ]);
	assert.deepEqual(results[2].aps.map(a => a.report.stations.length), [ 256, 256, 256, 256, 0 ], '1024 in all, the first access points first');
	assert.deepEqual(results[4].aps.map(a => a.name), [ 'ap1', 'ap2', 'ap3', 'ap4' ], 'removed at once');
	assert.deepEqual(results[6].aps.map(a => a.name), [ 'ap1', 'ap2', 'ap3', 'ap4', 'ap-den' ], 'and added, in the same second');
	assert.equal(results[6].aps[4].state, 'waiting');
});
