// How long luci-app-vantage-traffic's plugin takes to count a connection
// table of a given size, on the device this runs on (#110). In no
// package: copy it to the router and run it there. It needs ucode and
// its fs module, nothing else (a stock OpenWrt has both), not the package.
//
//   ucode bench.uc <dir> [entries ...]       (default 500 2000 8000 16384)
//
// For each size it writes a synthetic table in the kernel's format of
// /proc/net/nf_conntrack to <dir>/vantage-traffic-bench.nf_conntrack
// (documentation addresses only: 192.0.2.0/24, 198.51.100.0/24,
// 203.0.113.0/24, 2001:db8::/32; a quarter of it IPv6), counts it twice
// the way the plugin does (its own code, below: tests/traffic.test.js
// holds it to the plugin's, byte for byte), the second time with every
// counter grown, and prints how long each read took, per entry, and
// this process's memory. The second read is what the plugin does at
// every read while a dashboard is open. The file is removed at the end;
// an existing file of that name is not overwritten.
//
// Not measured: the kernel's own work to print the real table, and the
// neighbour table dumps. For the first, it also times one plain read of
// /proc/net/nf_conntrack when there is one (read only, nothing parsed).
//
// The plugin stops reading the table after STOP_MS, and after a read
// longer than 100 ms waits 50 times as long before the next.
'use strict';

import { open, unlink, stat, readfile } from 'fs';

const MAX_ENTRIES = 16384;        // entries read a time (nf_conntrack_max: 2048 up, by RAM)
const MAX_HOSTS = 512;            // hosts counted, as luci.vantage wired lists
const STOP_MS = 500;              // the table is read no longer than this
const CHECK_EVERY = 64;           // entries between looks at the clock
const KEEP_MS = 600000;           // an entry a partial read did not reach is known this long

let flows = {};
let totals = {}, ntotals = 0;

function now_ms() {
	let t = clock(true);
	return t[0] * 1000 + int(t[1] / 1000000);
}

function count(s) {
	let n = (s == null) ? 0 : int(s);
	return (n == n && n >= 0) ? n : 0;
}

function kv(s, key) {
	let i = index(s, key);
	if (i < 0)
		return null;
	s = substr(s, i + length(key));
	i = index(s, ' ');
	return (i < 0) ? s : substr(s, 0, i);
}

function parse(l) {
	if (type(l) != 'string')
		return null;
	let h = split(l, ' src=', 3), head = h[0], o = h[1], r = h[2] ?? '';
	let fam = substr(head, 0, 4);
	if ((fam != 'ipv4' && fam != 'ipv6') || length(head) < 22 || o == null)
		return null;
	let b = (fam == 'ipv4') ? 20 : 21, e = index(substr(head, b, 4), ' ');
	let sp = index(o, ' '), end = index(o, ' packets='), rs = index(r, ' ');
	let ob = kv(o, ' bytes='), x = index(r, 'OFFLOAD]'), hw = x > 2 && substr(r, x - 3, 3) == 'HW_';
	if (e <= 0 || sp <= 0)
		return null;
	if (end < 0)
		end = index(o, ' [');
	return {
		key: substr(head, 0, b + e) + ' ' + ((end < 0) ? o : substr(o, 0, end)),
		osrc: substr(o, 0, sp),
		obytes: count(ob),
		rsrc: (rs > 0) ? substr(r, 0, rs) : null,
		rbytes: count(kv(r, ' bytes=')),
		acct: ob != null,
		off: x > 0 && !hw,
		hw
	};
}

function norm(a) {
	if (index(a, ':') < 0)
		return a;
	let x = iptoarr(a);
	return x ? arrtoip(x) : null;
}

function add(mac, rx, tx, now, st) {
	let h = totals[mac];
	if (!h) {
		if (!rx && !tx)
			return;
		if (ntotals >= MAX_HOSTS) {
			if (!st.over[mac]) {
				st.over[mac] = true;
				st.dropped++;
			}
			return;
		}
		h = totals[mac] = { rx: 0, tx: 0, at: now };
		ntotals++;
	}
	h.rx += rx;
	h.tx += tx;
	if (rx || tx)
		h.at = now;
}

function feed(f, neigh, now, stop, st) {
	let memo = {};
	let who = (a) => {
		if (!exists(memo, a)) {
			let n = norm(a);
			memo[a] = (n != null) ? neigh[n] : null;
		}
		return memo[a];
	};

	for (let l = f.read('line'); length(l); l = f.read('line')) {
		if (st.entries >= MAX_ENTRIES) {
			st.partial = 'entries';
			break;
		}
		if (st.entries && !(st.entries % CHECK_EVERY) && now_ms() >= stop) {
			st.partial = 'time';
			break;
		}
		st.entries++;
		let e = parse(l);
		if (!e)
			continue;
		if (!e.acct) {
			st.noacct++;
			continue;
		}
		st.counted++;
		if (e.hw)
			st.hw++;
		else if (e.off)
			st.offloaded++;
		let prev = flows[e.key], dob = e.obytes, drb = e.rbytes;
		if (prev) {
			if (e.obytes >= prev[0] && e.rbytes >= prev[1]) {
				dob -= prev[0];
				drb -= prev[1];
			}
			else
				st.zeroed++;
			prev[0] = e.obytes;
			prev[1] = e.rbytes;
			prev[2] = now;
		}
		else
			flows[e.key] = [ e.obytes, e.rbytes, now ];
		// the host that opened it sent the original direction; one it was
		// opened to (a port forward, another of this router's networks)
		// sent the reply. As this router counts them: rx from, tx to
		let lo = who(e.osrc), lr = (e.rsrc != null) ? who(e.rsrc) : null;
		if (lo != null)
			add(lo, dob, drb, now, st);
		if (lr != null && lr != lo)
			add(lr, drb, dob, now, st);
	}

	// what the read did not see has ended, unless it stopped short: an
	// entry it did not reach is not new when one reaches it, for a while
	let gone = [], kept = 0;
	for (let k, v in flows)
		if (v[2] != now && !(st.partial && now - v[2] < KEEP_MS && kept++ < MAX_ENTRIES))
			push(gone, k);
	for (let k in gone)
		delete flows[k];
}

/* -------------------------------------------------------- the bench */

// the table, written to file: n entries over m hosts, every counter k
// steps on. Line by line, so that what this process holds is the count's
function table(file, n, m, k) {
	let out = open(file, 'w');
	if (!out)
		die(sprintf('cannot write %s\n', file));
	for (let i = 0; i < n; i++) {
		let h = i % m, up = 1000 + i + k * 100, down = 5000 + i + k * 1000;
		if (i % 4 == 3) {
			let a = sprintf('2001:0db8:0000:0000:0000:0000:0000:%04x', h + 1), b = sprintf('2001:0db8:0001:0000:0000:0000:0000:%04x', i % 250 + 1);
			out.write(sprintf('ipv6     10 tcp      6 7438 ESTABLISHED src=%s dst=%s sport=%d dport=443 packets=%d bytes=%d src=%s dst=%s sport=443 dport=%d packets=%d bytes=%d [ASSURED] mark=0 zone=0 use=2\n',
				a, b, 10000 + i % 50000, 10 + k, up, b, a, 10000 + i % 50000, 10 + k, down));
		}
		else if (i % 8 == 2) {
			let a = sprintf('%s.%d', (h < 254) ? '192.0.2' : '198.51.100', h % 254 + 1), b = sprintf('203.0.113.%d', i % 250 + 1);
			out.write(sprintf('ipv4     2 udp      17 54 src=%s dst=%s sport=%d dport=53 packets=%d bytes=%d src=%s dst=203.0.113.254 sport=53 dport=%d packets=%d bytes=%d mark=0 zone=0 use=2\n',
				a, b, 10000 + i % 50000, 1 + k, up, b, 10000 + i % 50000, 1 + k, down));
		}
		else {
			let a = sprintf('%s.%d', (h < 254) ? '192.0.2' : '198.51.100', h % 254 + 1), b = sprintf('203.0.113.%d', i % 250 + 1);
			out.write(sprintf('ipv4     2 tcp      6 7438 ESTABLISHED src=%s dst=%s sport=%d dport=443 packets=%d bytes=%d src=%s dst=203.0.113.254 sport=443 dport=%d packets=%d bytes=%d [ASSURED] mark=0 zone=0 use=2\n',
				a, b, 10000 + i % 50000, 10 + k, up, b, 10000 + i % 50000, 10 + k, down));
		}
	}
	out.close();
}

// address -> MAC as the plugin's neighbours() gives it, for m hosts
function neighbours(m) {
	let out = {};
	for (let h = 0; h < m; h++) {
		let mac = sprintf('02:00:5e:00:%02x:%02x', h >> 8, h & 255);
		out[sprintf('%s.%d', (h < 254) ? '192.0.2' : '198.51.100', h % 254 + 1)] = mac;
		out[sprintf('2001:db8::%x', h + 1)] = mac;
	}
	return out;
}

// this process's resident memory now and at its peak, KiB: what the
// plugin's state would add to rpcd is the growth from the first line on
function memory() {
	let s = readfile('/proc/self/status', 8192) ?? '', out = {};
	for (let k in [ 'VmRSS', 'VmHWM' ]) {
		let i = index(s, k + ':');
		out[k] = (i < 0) ? null : int(trim(substr(s, i + length(k) + 1, 16)));
	}
	return out;
}

// one read as the plugin makes it, without its time budget: ms
function read(file, neigh, now) {
	let f = open(file, 'r');
	if (!f)
		die(sprintf('cannot read %s\n', file));
	let st = { entries: 0, counted: 0, noacct: 0, partial: false, offloaded: 0, hw: 0, zeroed: 0, dropped: 0, over: {} };
	let t0 = now_ms();
	feed(f, neigh, now, t0 + 3600000, st);
	let ms = now_ms() - t0;
	f.close();
	return { ms, st };
}

let dir = ARGV[0], sizes = map(slice(ARGV, 1), (n) => int(n));
if (!length(sizes))
	sizes = [ 500, 2000, 8000, MAX_ENTRIES ];
if (type(dir) != 'string' || stat(dir)?.type != 'directory') {
	warn('usage: ucode bench.uc <directory> [entries ...]\n');
	exit(1);
}
for (let n in sizes)
	if (!(n > 0 && n <= MAX_ENTRIES)) {
		warn(sprintf('entries: 1 to %d\n', MAX_ENTRIES));
		exit(1);
	}

let file = dir + '/vantage-traffic-bench.nf_conntrack';
if (stat(file)) {
	warn(sprintf('%s exists; remove it or pick another directory\n', file));
	exit(1);
}

let real = open('/proc/net/nf_conntrack', 'r');
if (real) {
	let t0 = now_ms(), n = 0;
	while (length(real.read('line')))
		n++;
	real.close();
	print(sprintf('this device\'s own table: %d entries, read (not parsed) in %d ms\n', n, now_ms() - t0));
}

print(sprintf('the plugin stops reading after %d ms; below, full reads. This process before them: %s KiB\n', STOP_MS, memory().VmRSS ?? '?'));
for (let n in sizes) {
	let m = min(250, max(10, int(n / 20)));
	let neigh = neighbours(m);
	flows = {};
	totals = {};
	ntotals = 0;
	table(file, n, m, 0);
	let a = read(file, neigh, 0);
	table(file, n, m, 1);
	let b = read(file, neigh, 5000), mem = memory();
	let stops = (b.ms > STOP_MS) ? sprintf('; the plugin would stop near %d', int(n * STOP_MS / b.ms)) : '';
	print(sprintf('%6d entries, %3d hosts: first read %6d ms, next %6d ms (%d us an entry)%s; memory %s KiB, peak %s KiB\n',
		n, length(totals), a.ms, b.ms, int(b.ms * 1000 / n), stops, mem.VmRSS ?? '?', mem.VmHWM ?? '?'));
}
unlink(file);
