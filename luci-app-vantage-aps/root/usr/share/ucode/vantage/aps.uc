// luci-app-vantage-aps: the pairing codes and the access points' reports,
// checked one way for luci.vantage.pair and the collector.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Codes, one line each, fields apart by blanks:
//
//   vantage-router 1 ssh-ed25519 <key> <name>                 (router -> AP)
//   vantage-ap 1 ssh-ed25519 <host key> <addr> <port> <mac> <name>   (AP -> router)
//
// <key> is the base64 of an Ed25519 public key blob and nothing else.

'use strict';

const MAX_APS = 16;        // per router
const MAX_ROUTERS = 8;     // per access point
const MAX_CODE = 512;      // bytes of a pasted code

const ED25519 = 'ssh-ed25519';
const BLOB_HEAD = '\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20';
const RE_KEY = /^AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+\/]{43}$/;
const RE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const RE_NOT_NAME = /[^A-Za-z0-9._-]/g;
const RE_LEAD = /^[^A-Za-z0-9]+/;
const RE_ID = /^[0-9a-f]{16}$/;
const RE_IPV4 = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/;
const RE_IPV6 = /^[0-9a-f:]{2,39}$/;
const RE_GROUP = /^[0-9a-f]{1,4}$/;
const RE_PORT = /^[0-9]{1,5}$/;
const RE_SPACE = /[ \t\r\n]+/;
const RE_MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const RE_NETDEV = /^[A-Za-z0-9_.-]{1,15}$/;

const MAX_SSIDS = 16;
const MAX_STATIONS = 256;
const MAX_WIRED = 128;
const MAX_PORTS = 32;
const MAX_BYTES = 0x7fffffffffffffff;
const MAX_STEP = 0x10000000000;   // bytes between two reports that still make a rate (1 TiB)

/* ------------------------------------------------------------ fields */

// a string without a NUL byte: ucode matches a regular expression against
// the bytes before the first one only, so "name\0anything" would pass as
// "name"
function str(v) {
	return type(v) == 'string' && index(v, "\x00") < 0;
}

// an Ed25519 public key blob in base64: exactly 51 bytes, its header ours
function key(v) {
	if (!str(v) || !match(v, RE_KEY))
		return null;

	let b = b64dec(v);

	return (type(b) == 'string' && length(b) == 51 && substr(b, 0, 19) == BLOB_HEAD) ? v : null;
}

function name(v) {
	return (str(v) && match(v, RE_NAME)) ? v : null;
}

// a hostname as a code's name: what a name may not hold becomes '-'
function name_of(host, fallback) {
	let n = str(host) ? substr(replace(replace(host, RE_NOT_NAME, '-'), RE_LEAD, ''), 0, 63) : '';

	return name(n) ?? fallback;
}

function id(v) {
	return (str(v) && match(v, RE_ID)) ? v : null;
}

function ipv4(v) {
	let m = match(v, RE_IPV4);

	if (!m)
		return false;

	for (let i = 1; i <= 4; i++)
		if (+m[i] > 255 || (length(m[i]) > 1 && substr(m[i], 0, 1) == '0'))
			return false;

	// unicast, not 0/8, loopback nor link-local
	return +m[1] >= 1 && +m[1] <= 223 && +m[1] != 127 && !(+m[1] == 169 && +m[2] == 254);
}

function ipv6(v) {
	if (!match(v, RE_IPV6) || index(v, ':::') >= 0)
		return false;

	let parts = split(v, '::'), sides = [ [], [] ];

	if (length(parts) > 2)
		return false;

	for (let k = 0; k < length(parts); k++) {
		if (parts[k] == '')
			continue;

		for (let g in split(parts[k], ':')) {
			if (!match(g, RE_GROUP))
				return false;

			push(sides[k], hex(g));
		}
	}

	let n = length(sides[0]) + length(sides[1]);

	if ((length(parts) == 2) ? n > 7 : n != 8)
		return false;

	// the eight groups, :: filled in: judged by value, however spelled
	let groups = [ ...sides[0] ];

	for (let k = n; k < 8; k++)
		push(groups, 0);

	groups = [ ...groups, ...sides[1] ];

	// ::/8 holds no host to reach (unspecified, loopback, IPv4-mapped);
	// link-local needs a zone, multicast is no host
	return groups[0] >= 0x100 && (groups[0] & 0xffc0) != 0xfe80 && groups[0] < 0xff00;
}

// an address to reach an access point at: unicast IPv4, or IPv6 without
// brackets or zone
function addr(v) {
	if (!str(v))
		return null;

	v = lc(v);

	return (ipv4(v) || ipv6(v)) ? v : null;
}

// a unicast MAC, lower case
function mac(v) {
	v = str(v) ? lc(v) : null;

	return (v && match(v, RE_MAC) && v != '00:00:00:00:00:00' && !(hex(substr(v, 0, 2)) & 1)) ? v : null;
}

function port(v) {
	if (str(v) && match(v, RE_PORT))
		v = +v;

	return (type(v) == 'int' && v >= 1 && v <= 65535) ? v : null;
}

/* ------------------------------------------------------------- codes */

function fields(s) {
	return (str(s) && length(s) <= MAX_CODE) ? split(trim(s), RE_SPACE) : [];
}

function router_code(k, n) {
	return join(' ', [ 'vantage-router', '1', ED25519, k, n ]);
}

function ap_code(k, a, p, m, n) {
	return join(' ', [ 'vantage-ap', '1', ED25519, k, a, '' + p, m, n ]);
}

// { key, name } or null
function parse_router(s) {
	let f = fields(s);

	if (length(f) != 5 || f[0] != 'vantage-router' || f[1] != '1' || f[2] != ED25519 || !key(f[3]) || !name(f[4]))
		return null;

	return { key: f[3], name: f[4] };
}

// { key, addr, port, mac, name } or null; mac: the access point's LAN
// MAC, by which the router finds it again when its address changes
function parse_ap(s) {
	let f = fields(s);

	if (length(f) != 8 || f[0] != 'vantage-ap' || f[1] != '1' || f[2] != ED25519 || !key(f[3]) ||
	    !addr(f[4]) || !port(f[5]) || !mac(f[6]) || !name(f[7]))
		return null;

	return { key: f[3], addr: addr(f[4]), port: port(f[5]), mac: mac(f[6]), name: f[7] };
}

/* ------------------------------------------------- the paired list */

// /etc/vantage/aps.json -> [ { id, name, key, addr, port, mac } ], the valid
// entries only, at most MAX_APS, each id and key once
function aps(text) {
	let list = null, out = [], ids = {}, keys = {};

	try {
		list = (type(text) == 'string') ? json(text) : null;
	}
	catch (e) {
		list = null;
	}

	for (let a in ((type(list) == 'array') ? list : [])) {
		if (length(out) >= MAX_APS)
			break;

		if (type(a) != 'object')
			continue;

		let e = { id: id(a.id), name: name(a.name), key: key(a.key), addr: addr(a.addr), port: port(a.port), mac: mac(a.mac) };

		if (!e.id || !e.name || !e.key || !e.addr || !e.port || !e.mac || ids[e.id] || keys[e.key])
			continue;

		ids[e.id] = keys[e.key] = true;
		push(out, e);
	}

	return out;
}

// The IPv4 addresses a MAC has now, from the neighbour table
// (/proc/net/arp: complete entries) and dnsmasq's leases ("<expiry> <mac>
// <ip> ..."): where to look for an access point whose address changed.
// Safe to try: the pinned host key turns away any other device there.
function find_addrs(m, arp, leases) {
	let out = [];

	m = mac(m);

	if (!m)
		return out;

	for (let line in split(str(arp) ? arp : '', '\n')) {
		let f = split(trim(line), RE_SPACE);

		if (length(f) >= 6 && (+f[2] & 2) && mac(f[3]) == m && ipv4(f[0]) && index(out, f[0]) < 0)
			push(out, f[0]);
	}

	for (let line in split(str(leases) ? leases : '', '\n')) {
		let f = split(trim(line), RE_SPACE);

		if (length(f) >= 3 && mac(f[1]) == m && ipv4(f[2]) && index(out, f[2]) < 0)
			push(out, f[2]);
	}

	return slice(out, 0, 4);
}

// The first address its MAC has now that is neither where it is known
// (current) nor already tried; null when there is none
function next_addr(m, current, tried, arp, leases) {
	for (let to in find_addrs(m, arp, leases))
		if (to != current && !tried?.[to])
			return to;

	return null;
}

/* ---------------------------------------------------- a fetch's outcome */

const RE_HOSTKEY = /host key mismatch|Not accepted automatically|Didn't validate host key/;
const RE_DENIED = /No auth methods could be used|Permission denied|Disconnect received/;
const RE_NO_REPORT = /vantage\/report: not found|vantage\/report: No such file/;

// Why a fetch gave no report, from how dbclient ended (its exit code, the
// bytes it printed, its error text, whether it was killed for taking too
// long); null when what it printed is to be read as a report (at most
// max bytes). 'missing': the access point has no report command (the
// add-on is not installed there).
function fetch_error(code, out, err, timedout, max) {
	if (timedout)
		return 'timeout';

	if (code == 0 && type(out) == 'string' && length(out) > 0 && length(out) <= max)
		return null;

	err = (type(err) == 'string') ? err : '';

	if (match(err, RE_HOSTKEY))
		return 'hostkey';

	if (match(err, RE_DENIED))
		return 'denied';

	if (match(err, RE_NO_REPORT))
		return 'missing';

	return (code == 0 || length(out ?? '')) ? 'invalid' : 'unreachable';
}

// An access point's state on the dashboard: 'ok' with a report to show,
// 'offline' when the last fetch could not reach it, 'error' when it was
// refused or made no sense, 'waiting' before any fetch has ended
function state(shown, error) {
	return shown ? 'ok' : (error == 'unreachable' || error == 'timeout') ? 'offline' : error ? 'error' : 'waiting';
}

// After a fetch failed with error at an address: whether to look for the
// access point elsewhere (it is gone from there, or another device is)
function moved(error) {
	return error == 'unreachable' || error == 'timeout' || error == 'hostkey';
}

/* ----------------------------------------------------------- reports */

function netdev(v) {
	return (str(v) && match(v, RE_NETDEV)) ? v : null;
}

function int_in(v, lo, hi) {
	return (type(v) == 'int' && v >= lo && v <= hi) ? v : null;
}

// well-formed UTF-8 without control characters, at most max bytes; else ''
function text(v, max) {
	if (type(v) != 'string' || length(v) > max)
		return '';

	let n = length(v), i = 0;

	while (i < n) {
		let b = ord(v, i), need = 0, lo = 0x80, hi = 0xbf;

		if (b < 0x20 || b == 0x7f)
			return '';

		if (b >= 0x80) {
			if (b >= 0xc2 && b <= 0xdf) need = 1;
			else if (b >= 0xe0 && b <= 0xef) { need = 2; lo = (b == 0xe0) ? 0xa0 : 0x80; hi = (b == 0xed) ? 0x9f : 0xbf; }
			else if (b >= 0xf0 && b <= 0xf4) { need = 3; lo = (b == 0xf0) ? 0x90 : 0x80; hi = (b == 0xf4) ? 0x8f : 0xbf; }
			else return '';

			for (let j = 1; j <= need; j++) {
				let c = (i + j < n) ? ord(v, i + j) : -1;

				if (c < ((j == 1) ? lo : 0x80) || c > ((j == 1) ? hi : 0xbf))
					return '';
			}
		}

		i += need + 1;
	}

	return v;
}

function band(freq) {
	if (type(freq) != 'int')
		return null;

	if (freq >= 2400 && freq < 2500) return '2g';
	if (freq >= 4900 && freq < 5935) return '5g';
	if (freq >= 5935 && freq <= 7125) return '6g';
	if (freq >= 57000 && freq <= 71000) return '60g';

	return null;
}

// an access point's report (/usr/libexec/vantage/report), field by field:
// what does not fit is left out, the caps hold whatever it sends. null
// when it is no report at all
function normalize(r) {
	if (type(r) != 'object' || r.v !== 1)
		return null;

	let out = {
		name: text(r.name, 63), model: text(r.model, 64),
		uptime: int_in(r.uptime, 0, 0x7fffffff), mac: mac(r.mac),
		ssids: [], stations: [], ports: {}, wired: []
	};
	let ifs = {}, stas = {}, seen = {}, nports = 0;

	for (let s in ((type(r.ssids) == 'array') ? r.ssids : [])) {
		if (length(out.ssids) >= MAX_SSIDS)
			break;

		let i = (type(s) == 'object') ? netdev(s.ifname) : null;

		if (!i || ifs[i])
			continue;

		ifs[i] = true;
		push(out.ssids, { ifname: i, bssid: mac(s.bssid), ssid: text(s.ssid, 32),
			freq: int_in(s.freq, 1, 100000), channel: int_in(s.channel, 1, 255) });
	}

	for (let s in ((type(r.stations) == 'array') ? r.stations : [])) {
		if (length(out.stations) >= MAX_STATIONS)
			break;

		let m = (type(s) == 'object') ? mac(s.mac) : null, i = m ? netdev(s.ifname) : null;

		if (!i || stas[m] || !ifs[i])
			continue;

		stas[m] = true;
		push(out.stations, {
			mac: m, ifname: i,
			signal: int_in(s.signal, -120, -1),
			rx_rate: int_in(s.rx_rate, 1, 100000000), tx_rate: int_in(s.tx_rate, 1, 100000000),
			rx_bytes: int_in(s.rx_bytes, 0, MAX_BYTES), tx_bytes: int_in(s.tx_bytes, 0, MAX_BYTES),
			connected: int_in(s.connected, 0, 0x7fffffff)
		});
	}

	for (let p, v in ((type(r.ports) == 'object') ? r.ports : {})) {
		if (nports >= MAX_PORTS)
			break;

		if (!netdev(p) || type(v) != 'object' || !int_in(v.hosts, 1, MAX_WIRED))
			continue;

		out.ports[p] = { speed: int_in(v.speed, 1, 1000000), rx_bytes: int_in(v.rx_bytes, 0, MAX_BYTES),
			tx_bytes: int_in(v.tx_bytes, 0, MAX_BYTES), hosts: v.hosts };
		nports++;
	}

	// a host is wired or a station, never both; its MAC once
	for (let w in ((type(r.wired) == 'array') ? r.wired : [])) {
		if (length(out.wired) >= MAX_WIRED)
			break;

		let m = (type(w) == 'object') ? mac(w.mac) : null, p = m ? netdev(w.port) : null;

		if (!p || seen[m] || stas[m] || m == out.mac || !out.ports[p])
			continue;

		seen[m] = true;
		push(out.wired, { mac: m, port: p });
	}

	return out;
}

// bit/s between two byte counts dt seconds apart; null across a reset
function rate(now_b, prev_b, dt) {
	if (!(dt > 0) || type(now_b) != 'int' || type(prev_b) != 'int' || now_b < prev_b)
		return null;

	// more than a terabyte between two reports is no rate (and its bits
	// would not fit the multiplication)
	let d = now_b - prev_b;

	return (d <= MAX_STEP) ? int(d * 8 / dt) : null;
}

// what the dashboard gets of a report (normalize's), with rates against
// the one before it dt seconds earlier (dt 0: none yet)
function view(r, prev, dt) {
	let pst = {}, pport = (type(prev?.ports) == 'object') ? prev.ports : {};

	for (let x in (prev?.stations ?? []))
		pst[x.mac] = x;

	return {
		name: r.name, model: r.model, uptime: r.uptime, mac: r.mac,
		ssids: map(r.ssids, (x) => ({ ifname: x.ifname, bssid: x.bssid, ssid: x.ssid, freq: x.freq, channel: x.channel, band: band(x.freq) })),
		stations: map(r.stations, (x) => ({
			mac: x.mac, ifname: x.ifname, signal: x.signal, rxRate: x.rx_rate, txRate: x.tx_rate,
			rx: rate(x.rx_bytes, pst[x.mac]?.rx_bytes, dt), tx: rate(x.tx_bytes, pst[x.mac]?.tx_bytes, dt),
			connected: x.connected
		})),
		// a port's traffic is its host's only when the host has it alone
		wired: map(r.wired, (x) => {
			let p = r.ports[x.port], q = pport[x.port], one = (p.hosts == 1);

			return { mac: x.mac, port: x.port, speed: p.speed,
				rx: one ? rate(p.rx_bytes, q?.rx_bytes, dt) : null, tx: one ? rate(p.tx_bytes, q?.tx_bytes, dt) : null };
		})
	};
}

export { MAX_APS, MAX_ROUTERS, MAX_CODE, key, name, name_of, id, addr, mac, port, router_code, ap_code, parse_router, parse_ap, aps, find_addrs, next_addr, fetch_error, state, moved, band, normalize, view };
