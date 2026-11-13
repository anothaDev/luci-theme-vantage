// Shares with the network's other access points, through usteer's node
// data (set_node_data: usteer sends it to its peers with the node's own
// state, so they read it in remote_info): this device's name, model and
// uptime, the wired hosts downstream of it, its stations' signal and
// traffic (bit/s since the last run) and the IPv4 addresses its host hints
// know.
// Run by /etc/init.d/vantage-mesh every 10 s, or every second while a
// LuCI session on this device or any peer was active in the last HOT_S
// (it writes the next interval to INTERVAL); without usteer it does
// nothing. It goes to the LAN only, as usteer's own station reports do.

import { connect } from 'ubus';
import { cursor } from 'uci';
import { readfile, writefile, access } from 'fs';

const KEY = 'vantage';
const MAX_HOSTS = 64;
const MAX_STA = 128;
const MAX_IPS = 192;
const PREV = '/tmp/vantage-mesh-share.json';
const MAX_PAST = 128;
const INTERVAL = '/tmp/vantage-mesh-interval';
const HOT_S = 30;
const RE_IPV4 = /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/;
const RE_IPV6 = /^[0-9a-f:]{2,39}$/i;
const RE_MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const RE_DEV = /^[A-Za-z0-9_.@-]{1,15}$/;

let u = connect();
let local = u?.call('usteer', 'local_info');
let nodes = (type(local) == 'object') ? sort(keys(local)) : [];

if (!length(nodes)) {
	writefile(INTERVAL, '10');
	exit(0);
}

// someone is looking: a LuCI session here used within HOT_S (rpcd resets
// a session's expiry on every call), or a peer that says so
let hot = false;

for (let s in (u.call('session', 'list', {}, 'multiple') ?? []))
	if (type(s) == 'object' && s.timeout > 0 && s.expires > 0 && s.timeout - s.expires < HOT_S && s.data?.username)
		hot = true;

let peers_hot = false;

for (let k, v in (u.call('usteer', 'remote_info') ?? {}))
	if (v?.node_info?.[KEY]?.hot === true)
		peers_hot = true;

writefile(INTERVAL, (hot || peers_hot) ? '1' : '10');

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

// dt in seconds, from milliseconds: at one run a second, whole seconds
// would be off by up to half
let ck = clock(true), now = (ck?.[0] ?? 0) * 1000 + int((ck?.[1] ?? 0) / 1000000);
let prev = json(readfile(PREV) ?? 'null') ?? {}, next = { ms: now, b: {}, p: {} };
let dt = (type(prev.ms) == 'int' && now > prev.ms && now - prev.ms < 120000) ? (now - prev.ms) / 1000.0 : 0;

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

// the stations of the last day: a station that left is no wired host
// while a bridge still remembers its MAC (usteer forgets it in minutes)
next.w = {};
for (let mac, t in (type(prev.w) == 'object' ? prev.w : {}))
	if (match(mac, RE_MAC) && type(t) == 'int' && now - t < 86400000 && length(next.w) < MAX_PAST)
		next.w[mac] = t;
for (let s in sta)
	next.w[s[0]] = now;
let past = slice(sort(keys(next.w), (a, b) => next.w[b] - next.w[a]), 0, MAX_PAST);

// addresses: what the host hints know (a router's DHCP leases)
let ips = [], hints = u.call('luci-rpc', 'getHostHints') ?? {};

for (let mac, h in hints) {
	if (!match(lc(mac), RE_MAC))
		continue;
	for (let ip in (h?.ipaddrs ?? []))
		if (type(ip) == 'string' && match(ip, RE_IPV4) && length(ips) < MAX_IPS)
			push(ips, (type(h?.name) == 'string' && h.name != '') ? [ lc(mac), ip, substr(h.name, 0, 63) ] : [ lc(mac), ip ]);
}

// a host with a DHCP reservation but no lease or neighbour entry now (a
// device that sleeps, or renewed long ago): its reserved address
{
	let have = {};
	for (let w in ips)
		have[w[0]] = true;
	cursor()?.foreach('dhcp', 'host', function(s) {
		let ip = s.ip, name = s.name;
		for (let mac in (type(s.mac) == 'array' ? s.mac : split(s.mac ?? '', ' '))) {
			mac = lc(mac);
			if (!match(mac, RE_MAC) || have[mac] || type(ip) != 'string' || !match(ip, RE_IPV4) || length(ips) >= MAX_IPS)
				continue;
			have[mac] = true;
			push(ips, (type(name) == 'string' && name != '') ? [ mac, ip, substr(name, 0, 63) ] : [ mac, ip ]);
		}
	});
}

writefile(PREV, next);

// the public addresses of a router (its default route leaves over an
// address that is not private): IPv4 there, and a global IPv6 on the same
// line (wan6), so its access points can show them. An access point's
// default route is on its LAN, so it shares none.
let wan = null;
{
	let ifs = u.call('network.interface', 'dump')?.interface ?? [], v4 = null, dev = null, v6 = null;
	for (let i in ifs)
		for (let r in (i.route ?? []))
			if (!v4 && r.target == '0.0.0.0' && r.mask == 0)
				for (let a in (i['ipv4-address'] ?? []))
					if (!v4 && type(a?.address) == 'string' && match(a.address, RE_IPV4) && !match(a.address, RE_LOCAL)) {
						v4 = a.address;
						dev = i.l3_device;
					}
	if (v4)
		for (let i in ifs)
			if (i.l3_device == dev)
				for (let a in (i['ipv6-address'] ?? []))
					if (!v6 && type(a?.address) == 'string' && match(a.address, RE_IPV6) && !match(a.address, RE_LOCAL))
						v6 = a.address;
	if (v4)
		wan = [ v4, v6 ];
}

let info = u.call('system', 'info'), board = u.call('system', 'board');
let name = trim(readfile('/proc/sys/kernel/hostname') ?? '');

u.call('usteer', 'set_node_data', {
	node: nodes[0],
	data: { [KEY]: { v: 1, name: substr(name, 0, 63), model: substr(board?.model ?? '', 0, 63), uptime: info?.uptime,
		mac: self, up, wired: out, sta, ips, wan, past, hot } }
});
