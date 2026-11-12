// Shares with the network's other access points, through usteer's node
// data (set_node_data: usteer sends it to its peers with the node's own
// state, so they read it in remote_info): this device's name, model and
// uptime, the wired hosts downstream of it, its stations' signal and
// traffic (bit/s since the last run) and the IPv4 addresses its host hints
// know, and on a router with hardware offload each host's internet traffic.
// Run every 10 s by /etc/init.d/vantage-mesh; without usteer it does
// nothing. It goes to the LAN only, as usteer's own station reports do.

import { connect } from 'ubus';
import { readfile, writefile, access } from 'fs';

const KEY = 'vantage';
const MAX_HOSTS = 64;
const MAX_STA = 128;
const MAX_IPS = 192;
const PREV = '/tmp/vantage-mesh-share.json';
const RE_IPV4 = /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/;
const RE_MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const RE_DEV = /^[A-Za-z0-9_.@-]{1,15}$/;

let u = connect();
let local = u?.call('usteer', 'local_info');
let nodes = (type(local) == 'object') ? sort(keys(local)) : [];

if (!length(nodes))
	exit(0);

function wireless(dev) {
	return access('/sys/class/net/' + dev + '/phy80211') || access('/sys/class/net/' + dev + '/wireless');
}

function speed(dev) {
	let s = +trim(readfile('/sys/class/net/' + dev + '/speed') ?? '');

	return (s > 0 && s < 1000000) ? s : null;
}

// the uplink: the port the default gateway's MAC is learned on
// and this device's own address there, which its peers' bridges learn
let gw = null, l3 = null;

for (let i in (u.call('network.interface', 'dump')?.interface ?? []))
	for (let r in (i.route ?? []))
		if (!gw && r.target == '0.0.0.0' && r.mask == 0 && r.nexthop && r.nexthop != '0.0.0.0') {
			gw = r.nexthop;
			l3 = i.l3_device;
		}

function addr(dev) {
	let a = (dev && match(dev, RE_DEV)) ? lc(trim(readfile('/sys/class/net/' + dev + '/address') ?? '')) : null;

	return (a && match(a, RE_MAC)) ? a : null;
}

// a router's default route leaves over a line with no MAC (PPPoE): its
// LAN bridge's address then
let lan = null;

for (let i in (u.call('network.interface', 'dump')?.interface ?? []))
	if (i.interface == 'lan')
		lan = i.l3_device;

let self = addr(l3) ?? addr(lan);

let gwmac = null;

if (gw)
	for (let mac, h in (u.call('luci-rpc', 'getHostHints') ?? {}))
		if (!gwmac && index(h?.ipaddrs ?? [], gw) >= 0)
			gwmac = lc(mac);

let hosts = u.call('luci.vantage', 'wired')?.hosts ?? [];
let up = null;

for (let h in hosts)
	if (gwmac && h.mac == gwmac)
		up = h.port;

// a port with one host: its traffic is the host's (bit/s since the last
// run, from the port's counters; rx = from the host)
let per = {};

for (let h in hosts)
	if (type(h?.port) == 'string')
		per[h.port] = (per[h.port] ?? 0) + 1;

let now = clock(true)?.[0] ?? 0, prev = json(readfile(PREV) ?? 'null') ?? {}, next = { at: now, b: {}, p: {}, f: {} };
let dt = (type(prev.at) == 'int' && now > prev.at && now - prev.at < 120) ? now - prev.at : 0;

function counter(dev, which) {
	let v = trim(readfile('/sys/class/net/' + dev + '/statistics/' + which + '_bytes') ?? '');

	return length(v) ? +v : null;
}

function port_rate(dev) {
	let rx = counter(dev, 'rx'), tx = counter(dev, 'tx'), p = prev.p?.[dev];

	if (rx == null || tx == null)
		return [ null, null ];
	next.p[dev] = [ rx, tx ];
	return (dt && type(p) == 'array' && rx >= p[0] && tx >= p[1]) ? [ int((rx - p[0]) * 8 / dt), int((tx - p[1]) * 8 / dt) ] : [ null, null ];
}

let out = [], seen = {};

for (let h in hosts) {
	if (length(out) >= MAX_HOSTS)
		break;
	if (type(h?.mac) != 'string' || !match(h.mac, RE_MAC) || seen[h.mac] ||
	    type(h.port) != 'string' || !match(h.port, RE_DEV) || h.port == up || wireless(h.port))
		continue;
	seen[h.mac] = true;
	let r = (per[h.port] == 1) ? port_rate(h.port) : [ null, null ];
	push(out, [ h.mac, h.port, speed(h.port), r[0], r[1] ]);
}

// stations: signal, link rate to it (kbit/s; hostapd counts 100 bit/s)
// and traffic since the last run
let sta = [];

for (let obj in filter(u.list() ?? [], o => index(o, 'hostapd.') == 0 && o != 'hostapd.')) {
	let c = u.call(obj, 'get_clients')?.clients;

	for (let mac, s in (type(c) == 'object' ? c : {})) {
		mac = lc(mac);
		if (length(sta) >= MAX_STA || !match(mac, RE_MAC) || type(s) != 'object' || !s.authorized)
			continue;
		let rx = +(s.bytes?.rx ?? 0), tx = +(s.bytes?.tx ?? 0), p = prev.b?.[mac];
		next.b[mac] = [ rx, tx ];
		let ok = dt && type(p) == 'array' && rx >= p[0] && tx >= p[1];
		push(sta, [ mac, ok ? int((rx - p[0]) * 8 / dt) : null, ok ? int((tx - p[1]) * 8 / dt) : null,
			(+s.signal < 0) ? +s.signal : null, (+s.rate?.tx > 0) ? int(+s.rate.tx / 100) : null ]);
	}
}

// addresses: what the host hints know (a router's DHCP leases)
let ips = [], hints = u.call('luci-rpc', 'getHostHints') ?? {}, ip2mac = {}, lanmac = {};

for (let mac, h in hints) {
	if (!match(lc(mac), RE_MAC))
		continue;
	lanmac[lc(mac)] = true;
	for (let ip in (h?.ipaddrs ?? []))
		if (type(ip) == 'string' && match(ip, RE_IPV4)) {
			ip2mac[ip] = lc(mac);
			if (length(ips) < MAX_IPS)
				push(ips, [ lc(mac), ip ]);
		}
	for (let ip in (h?.ip6addrs ?? []))
		if (type(ip) == 'string')
			ip2mac[ip] = lc(mac);
}

// internet traffic per host (a router with MediaTek hardware offload):
// offloaded flows bypass every netdev and conntrack counter, so read the
// packet engine's own per-flow bytes. A flow from a local address is the
// host's upload (found by its address), one to it its download (by the
// destination MAC). LAN to LAN traffic never passes the engine.
const RE_LOCAL = /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|f[cd]|fe80)/i;
let inet = {}, ppe = false;

for (let n in [ 0, 1 ]) {
	let s = readfile('/sys/kernel/debug/ppe' + n + '/bind');

	if (s == null)
		continue;
	ppe = true;
	for (let line in split(s, '\n')) {
		let m = match(line, /^(\S+) BND .*orig=(\S+)->\S+ .*eth=([0-9a-f:]{17})->([0-9a-f:]{17}).* bytes=([0-9]+)/);

		if (!m)
			continue;
		let src = replace(m[2], /^\[?([^\]]+?)\]?:[0-9]+$/, '$1');
		let key = n + m[1] + m[2], bytes = +m[5], p = prev.f?.[key];
		next.f[key] = bytes;
		if (!dt || p == null || bytes < p)
			continue;
		let up = !!match(src, RE_LOCAL), mac = up ? ip2mac[src] : lc(m[4]);
		if (!mac || !lanmac[mac])
			continue;
		let a = inet[mac] ?? (inet[mac] = [ 0, 0 ]);
		a[up ? 0 : 1] += bytes - p;
	}
}

let net = [];

for (let mac, a in inet)
	if (length(net) < MAX_STA)
		push(net, [ mac, int(a[0] * 8 / dt), int(a[1] * 8 / dt) ]);

writefile(PREV, next);

let info = u.call('system', 'info'), board = u.call('system', 'board');
let name = trim(readfile('/proc/sys/kernel/hostname') ?? '');

u.call('usteer', 'set_node_data', {
	node: nodes[0],
	data: { [KEY]: { v: 1, name: substr(name, 0, 63), model: substr(board?.model ?? '', 0, 63), uptime: info?.uptime,
		mac: self, up, wired: out, sta, ips, inet: ppe ? net : null } }
});
