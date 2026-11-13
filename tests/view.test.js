'use strict';
/* Pieces of the dashboard view (view/vantage/overview.js) that take input
   from outside the device replies: the URL hash (deep links) and the
   history kept in sessionStorage. The view is loaded with stub LuCI
   modules; only the methods under test run. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { load, RES } = require('./luci-stub');

const REPLIES = {};
/* the view's `ui`: tests set ui.menu */
const UI = {};
/* LuCI's poll: tests pause it */
const POLL = { on: true, active() { return this.on; } };

function loadView(dom) {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const stubs = {
		view: { extend: p => p },
		/* replies come from REPLIES['object method'](...args) when set */
		rpc: { declare: o => function(...args) { const f = REPLIES[o.object + ' ' + o.method]; return f ? f(...args) : Promise.resolve(null); } },
		poll: POLL, ui: UI, dom: dom || {}
	};
	const params = [], values = [];
	for (const m of src.matchAll(/^'require ([\w.-]+)(?: as (\w+))?';$/gm)) {
		params.push(m[2] || m[1]);
		values.push(Object.prototype.hasOwnProperty.call(stubs, m[1]) ? stubs[m[1]] : load(m[1]));
	}
	return new Function(...params, src)(...values);
}

const view = loadView();

function withLocation(hash, fn) {
	const cleared = [];
	const saved = { location: global.location, history: global.history };
	global.location = { hash, pathname: '/cgi-bin/luci/admin/dashboard', search: '' };
	global.history = { replaceState: (s, t, url) => cleared.push(url) };
	try { return fn(cleared); }
	finally { global.location = saved.location; global.history = saved.history; }
}

function openFor(hash) {
	const self = Object.create(view);
	self.m = { radios: [ { id: 'radio0' }, { id: 'radio1' } ] };
	self.opened = [];
	self.openDrawer = function(kind, id) { this.opened.push([ kind, id ]); };
	return withLocation(hash, cleared => {
		self.openFromHash();
		return { opened: self.opened, cleared };
	});
}

test('deep links: a station MAC or a known radio opens its drawer', () => {
	assert.deepEqual(openFor('#client=00-00-5E-00-53-21').opened, [ [ 'client', '00:00:5e:00:53:21' ] ]);
	assert.deepEqual(openFor('#client=00%3A00%3A5e%3A00%3A53%3A21').opened, [ [ 'client', '00:00:5e:00:53:21' ] ]);
	assert.deepEqual(openFor('#radio=radio1').opened, [ [ 'radio', 'radio1' ] ]);
	assert.deepEqual(openFor('#uplink=anything').opened, [ [ 'uplink', '' ] ], 'a name the device has no line of: the main line');
	assert.deepEqual(openFor('#uplink').opened, [ [ 'uplink', '' ] ], 'the main line, whichever it is');
	assert.deepEqual(openFor('#device=%3Cb%3E').opened, [ [ 'device', 'device' ] ], 'device takes no id');
});

test('deep links: arbitrary text, unknown radios and bad escapes are dropped, not shown', () => {
	const lure = '#radio=URGENT%3A%20firmware%20compromised%20-%20re-enter%20password%20at%20http%3A%2F%2Fevil.example';
	for (const hash of [ lure, '#client=URGENT%3A%20call%20support', '#radio=radio9', '#client=%E0%A4%A', '#radio=%E2%80%AEevil',
		'#client=01-00-5E-00-53-21x', '#client=' + 'a'.repeat(300) ]) {
		let r;
		assert.doesNotThrow(() => { r = openFor(hash); }, hash);
		assert.deepEqual(r.opened, [], hash);
		assert.deepEqual(r.cleared, [ '/cgi-bin/luci/admin/dashboard' ], `${hash}: cleared from the address bar`);
	}
	/* hashes that are not deep links are left alone */
	for (const hash of [ '', '#', '#tab=wifi' ]) assert.deepEqual(openFor(hash), { opened: [], cleared: [] }, hash);
});

test('stored history: keys from sessionStorage cannot replace a prototype', () => {
	const savedL = global.L;
	global.L = { env: {} };
	const stored = JSON.stringify({ net: JSON.parse('{"__proto__":[[1,2,3]],"constructor":[[1,2,3]],"radio0":[[1,2,3]]}'), clients: {} });
	const saved = global.window;
	global.window = {
		sessionStorage: { getItem: () => stored, setItem() {} },
		localStorage: { getItem: () => null, setItem() {} }
	};
	try {
		const self = Object.create(view);
		self.initState({ board: {}, canWrite: false, canRdns: false, mdns: null });
		const net = self.st.hist.net;
		assert.equal(Object.getPrototypeOf(net), null);
		assert.ok(Object.prototype.hasOwnProperty.call(net, '__proto__'), 'kept as an ordinary key');
		assert.equal(typeof net.map, 'undefined', 'no Array methods through the prototype');
		assert.equal(self.st.rdnsOff, true, 'reverse DNS off without its group');
		for (const k of [ 'devRates', 'staRates', 'radioRates', 'ssidRates', 'isNew' ])
			assert.equal(Object.getPrototypeOf(self.st[k]), null, k);
	} finally {
		global.window = saved;
		global.L = savedL;
	}
});

test('saving a name: set_alias with the normalised MAC, names reloaded after every outcome', async () => {
	const calls = [];
	const self = Object.create(view);
	self.aliases = Object.create(null);
	let reloads = 0;
	self.loadAliases = () => { reloads++; return Promise.resolve({}); };
	const outcomes = [
		[ () => Promise.resolve({ ok: true, op: 'add', mac: '00:00:5e:00:53:21' }), true ],
		[ () => Promise.resolve({ ok: false, error: 'too-many' }), 'This device already stores 512 names; remove some first.' ],
		[ () => Promise.resolve({ ok: false, error: 'failed' }), 'The device could not write /etc/config/vantage.' ],
		[ () => Promise.resolve(6), false ],
		[ () => Promise.reject(new Error('RPCError')), false ]
	];
	for (const [ reply, want ] of outcomes) {
		REPLIES['luci.vantage set_alias'] = (...a) => { calls.push(a); return reply(); };
		const before = reloads;
		assert.deepEqual(await self.saveAlias('00-00-5E-00-53-21', 'TV', 'tv'), want);
		assert.equal(reloads, before + 1, 'aliases reloaded');
	}
	assert.deepEqual(calls[0], [ '00:00:5e:00:53:21', 'TV', 'tv' ]);
	/* removing a name, and an unknown icon: sent as empty strings */
	REPLIES['luci.vantage set_alias'] = (...a) => { calls.push(a); return Promise.resolve({ ok: true }); };
	await self.saveAlias('00:00:5e:00:53:21', 'TV', 'rocket');
	await self.saveAlias('00:00:5e:00:53:21', '', 'tv');
	assert.deepEqual(calls.slice(-2), [ [ '00:00:5e:00:53:21', 'TV', '' ], [ '00:00:5e:00:53:21', '', '' ] ]);
	/* refused before any call */
	const n = calls.length;
	assert.equal(typeof await self.saveAlias('01:00:5e:00:53:21', 'TV', null), 'string');
	assert.equal(typeof await self.saveAlias('00:00:5e:00:53:21', 'a\u202eb', null), 'string');
	assert.equal(calls.length, n);
	delete REPLIES['luci.vantage set_alias'];
});

test('wired-only: decided by an answered empty wireless status, never by a failed call', () => {
	const self = Object.create(view);
	self.st = { wireless: null };
	const m = radios => ({ radios: radios });
	let x = m([]);
	self.markWired(x, { wifi: null });
	assert.equal(x.wired, false, 'a failed call proves nothing');
	self.markWired(x = m([]), { wifi: {} });
	assert.equal(x.wired, true, 'answered, no radios');
	self.markWired(x = m([ { id: 'radio0' } ]), { wifi: { radio0: {} } });
	assert.equal(x.wired, false, 'radios appeared');
	self.markWired(x = m([]), { wifi: {} });
	assert.equal(x.wired, false, 'radios seen once keep the Wi-Fi layout');
	self.markWired(x = m([]), null);
	assert.equal(x.wired, false, 'a rebuild keeps the decision');
});

test('page links: a page LuCI keeps but marks unsatisfied (no block-mount) counts as absent', () => {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const block = src.match(/var menuTree = null;\nfunction hasPage\(page\) \{[\s\S]*?\n\}\n/)[0];
	const hasPage = new Function('tree', block + 'menuTree = tree; return hasPage;');
	const node = (satisfied, children) => Object.assign({ satisfied }, children ? { children } : {});
	/* as LuCI's dispatcher serves it: every node carries satisfied */
	const tree = { children: { admin: node(true, {
		system: node(true, { system: node(true), mounts: node(false) }),
		network: node(false, { wireless: node(true) })
	}) } };
	const has = hasPage(tree);
	assert.equal(has([ 'admin', 'system', 'system' ]), true);
	assert.equal(has([ 'admin', 'system', 'mounts' ]), false, 'kept in the tree, but unsatisfied');
	assert.equal(has([ 'admin', 'network', 'wireless' ]), false, 'an unsatisfied parent hides its children');
	assert.equal(has([ 'admin', 'status', 'nowhere' ]), false, 'missing');
	/* no menu (the load failed): links stay */
	assert.equal(hasPage(null)([ 'admin', 'system', 'mounts' ]), true);
});

test('wired hosts: the path counts those downstream only; filters, search and sort', () => {
	const self = Object.create(view);
	const host = (mac, port, extra) => Object.assign({ mac, port, name: 'h' + mac.slice(-2), macLabel: mac.toUpperCase(), bridge: 'br-lan', network: 'lan',
		vlan: null, seen: 5, shared: false, peers: 1, speed: { mbps: 1000, duplex: 'full' }, ips: [], nameSourceLabel: 'MAC' }, extra);
	const hosts = [
		host('00:00:5e:00:53:01', 'lan2', { seen: 30 }),
		host('00:00:5e:00:53:02', 'lan1', { shared: true, peers: 2, seen: null }),
		host('00:00:5e:00:53:03', 'lan1', { shared: true, peers: 2, ips: [ '192.0.2.30' ] }),
		host('00:00:5e:00:53:04', 'eth0', { gateway: true })
	];
	self.m = { uplink: { dev: 'eth0', statsDev: 'eth0', port: 'eth0' }, wiredHosts: hosts, clients: [], radios: [ { id: 'radio0' } ] };
	self.st = { devRates: { lan2: { rx: 1000, tx: 3000 }, lan1: { rx: 5, tx: 5 } }, staRates: {}, radioInsights: {}, uplinkRate: null };
	self.el = { clients: { scrollIntoView() {} }, filter: {} };
	self.paintClients = () => {};
	self.ui = { kind: 'wired', chip: 'all', filter: '' };

	assert.deepEqual(self.wiredPorts(), [ 'lan1', 'lan2' ], 'the uplink\'s port leads to the gateway');
	/* the path's Wired branch: a node per downstream port, their hosts counted */
	const stub = () => ({ textContent: '', getAttribute() { return null; }, setAttribute() {} });
	const branch = { ssids: self.wiredPorts().map(port => ({ port, el: stub(), name: stub(), count: stub(), rate: stub() })), title: stub(), sub: stub() };
	self.updateWiredBranch(branch);
	assert.equal(branch.title.textContent, '3 devices');
	/* a bridge with several ports, the gateway's port unknown: the
	   counters' port is a guess, so only the gateway is left out */
	self.m.uplink = { dev: 'lan1', statsDev: 'lan1', port: null };
	assert.deepEqual(self.wiredPorts(), [ 'lan1', 'lan2' ]);
	hosts[3].gateway = false;
	assert.deepEqual(self.wiredPorts(), [ 'eth0', 'lan1', 'lan2' ]);
	hosts[3].gateway = true;

	assert.deepEqual(self.filterDefs().map(d => d.slice(0, 3)), [ [ 'all', 'All', 4 ], [ 'port:eth0', 'eth0', 1 ], [ 'port:lan1', 'lan1', 2 ], [ 'port:lan2', 'lan2', 1 ] ]);
	self.ui.chip = 'port:lan1';
	assert.deepEqual(hosts.filter(h => self.matches(h)).map(h => h.mac.slice(-2)), [ '02', '03' ]);
	self.ui.chip = 'all';
	self.ui.filter = '192.0.2.30';
	assert.deepEqual(hosts.filter(h => self.matches(h)).map(h => h.mac.slice(-2)), [ '03' ]);
	self.ui.filter = 'lan2';
	assert.deepEqual(hosts.filter(h => self.matches(h)).map(h => h.mac.slice(-2)), [ '01' ]);

	assert.equal(self.portRate(hosts[0]).tx, 3000, 'alone on its port: the port\'s traffic is its own');
	assert.equal(self.portRate(hosts[1]), null, 'a shared port\'s traffic is nobody\'s');
	assert.deepEqual([ self.sortValue(hosts[0], 'live'), self.sortValue(hosts[1], 'live') ], [ 4000, -1 ]);
	assert.deepEqual([ self.sortValue(hosts[0], 'link'), self.sortValue(hosts[1], 'link') ], [ 1000, -1 ]);
	assert.equal(self.sortValue(hosts[1], 'seen'), Infinity, 'a static entry sorts last');

	const saved = global.window;
	global.window = { matchMedia: () => ({ matches: true }) };
	try { self.showWired('lan1'); }
	finally { global.window = saved; }
	assert.deepEqual([ self.ui.kind, self.ui.chip, self.ui.filter ], [ 'wired', 'port:lan1', '' ]);
});

test('health checks about clients: several weak open their list, unless the layout hides it', () => {
	const self = Object.create(view);
	const opened = [];
	let shown = true;
	self.el = { clients: { scrollIntoView() {}, getClientRects: () => shown ? [ {} ] : [] }, filter: {} };
	self.paintClients = () => {};
	self.openDrawer = (kind, id) => opened.push(kind + ':' + id);
	self.ui = { kind: 'wired', chip: 'port:lan1', filter: 'x' };
	const saved = global.window;
	global.window = { matchMedia: () => ({ matches: true }) };
	try {
		self.openCheck({ client: 'aa', list: 'weak' });
		assert.deepEqual([ self.ui.kind, self.ui.chip, self.ui.filter, opened.length ], [ 'wifi', 'weak', '', 0 ]);
		shown = false;
		self.openCheck({ client: 'aa', list: 'weak' });
		self.openCheck({ client: 'bb', list: null });
	} finally { global.window = saved; }
	assert.deepEqual(opened, [ 'client:aa', 'client:bb' ]);
});

test('wired branch: each port node shows its traffic, all its hosts\' together', () => {
	const self = Object.create(view);
	const el = () => ({ textContent: '', attrs: {}, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, setAttribute(k, v) { this.attrs[k] = v; } });
	const node = port => ({ port, el: el(), name: el(), count: el(), rate: el() });
	const host = (mac, port, extra) => Object.assign({ mac, port, name: 'h' + mac.slice(-2), speed: { mbps: 1000 } }, extra);
	self.m = { wiredHosts: [
		host('00:00:5e:00:53:01', 'lan5', { shared: true, peers: 2 }),
		host('00:00:5e:00:53:02', 'lan5', { shared: true, peers: 2 }),
		host('00:00:5e:00:53:03', 'lan6')
	] };
	self.st = { devRates: { lan5: { rx: 3000, tx: 12345678 } } };
	const b = { ssids: [ node('lan5'), node('lan6') ], title: el(), sub: el() };
	self.updateWiredBranch(b);
	const [ shared, alone ] = b.ssids;
	/* full units: each its own where they differ */
	assert.deepEqual([ shared.name.textContent, shared.count.textContent, shared.rate.textContent ], [ 'lan5', '2 devices', '↓ 12.3 Mbit/s  ↑ 3 kbit/s' ]);
	assert.equal(shared.el.attrs.title, 'Show the devices on lan5\nPort total: ↓ 12.3 Mbit/s · ↑ 3 kbit/s');
	assert.deepEqual([ alone.name.textContent, alone.rate.textContent, alone.el.attrs.title ], [ 'lan6 · h03', '—', 'Show the devices on lan6' ], 'no counters yet: a dash, no total');
	assert.equal(b.sub.textContent, '↓ 12.3 Mbit/s');
});

test('names beyond a poll: reverse DNS and the vendor table for wired hosts too', async () => {
	const self = Object.create(view);
	const asked = [];
	let ouiLoads = 0;
	REPLIES['network.rrdns lookup'] = (addrs) => { asked.push(...addrs); return Promise.resolve({ '192.0.2.40': 'nas.home.arpa' }); };
	const savedL = global.L;
	global.L = { require: () => { ouiLoads++; return Promise.resolve({}); }, resolveDefault: (p, d) => Promise.resolve(p).catch(() => d) };
	try {
		self.st = { rdns: {}, mdnsOff: true, mdnsAt: 0 };
		let rerendered = 0;
		self.rerender = () => { rerendered++; };
		/* no Wi-Fi clients at all: a router's wired hosts alone */
		self.resolveMore({ clients: [], wiredHosts: [ { mac: '00:00:5e:00:53:40', ips: [ '192.0.2.40' ], nameSource: 'mac' } ] });
		await new Promise(r => setTimeout(r, 0));
		assert.deepEqual(asked, [ '192.0.2.40' ], 'a wired host\'s address is looked up');
		assert.equal(self.st.rdns['192.0.2.40'], 'nas.home.arpa');
		assert.equal(ouiLoads, 1, 'a wired host known only by its MAC loads the vendor table');
		assert.ok(rerendered >= 1);
	}
	finally { global.L = savedL; delete REPLIES['network.rrdns lookup']; }
});

test('wired reply: hosts kept, a crowded bridge flagged, anything else read as none', async () => {
	const self = Object.create(view);
	const savedL = global.L;
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	try {
		const host = { mac: '00:00:5e:00:53:01', port: 'lan1', bridge: 'br-lan', vlan: null, seen: 3 };
		const read = async reply => { REPLIES['luci.vantage wired'] = () => Promise.resolve(reply); const r = await self.fetch(); return [ r.fdb, r.fdbCrowded ]; };
		assert.deepEqual(await read({ hosts: [ host ] }), [ [ host ], false ]);
		assert.deepEqual(await read({ hosts: [], crowded: true }), [ [], true ]);
		assert.deepEqual(await read({ hosts: 'x', crowded: 'yes' }), [ [], false ]);
		assert.deepEqual(await read(null), [ [], false ]);
		REPLIES['luci.vantage wired'] = () => Promise.reject(new Error('ubus code 6'));
		const failed = await self.fetch();
		assert.deepEqual([ failed.fdb, failed.fdbCrowded ], [ [], false ], 'a failed call');
	}
	finally { global.L = savedL; delete REPLIES['luci.vantage wired']; }
});

/* iwinfo info costs the router 15-22 ms an interface: asked for a radio's
   first interface, and for another only until hostapd gives its BSSID;
   each reading stands for 30 s, unless the interface's state moves (its
   channel in hostapd's status, its radio in luci.vantage wireless) */
test('iwinfo info: once a radio, and for a network hostapd does not answer for; kept 30 s unless the state moves', async () => {
	const asked = [], hapdOff = new Set(), chan = {};
	let radioUp = true;
	const ifc = (ifname, mode) => ({ ifname, section: ifname, config: { mode: mode || 'ap', ssid: 'S-' + ifname } });
	REPLIES['luci.vantage wireless'] = () => Promise.resolve({
		radio0: { up: true, config: { band: '2g' }, interfaces: [ ifc('wl0'), ifc('wl0-1'), ifc('wl0-sta', 'sta') ] },
		radio1: { up: radioUp, config: { band: '5g' }, interfaces: [ ifc('wl1') ] }
	});
	REPLIES['iwinfo info'] = device => { asked.push(device); return Promise.resolve({ channel: 6, bssid: '00:00:5E:00:53:0' + device.length }); };
	for (const ifn of [ 'wl0', 'wl0-1', 'wl0-sta', 'wl1' ])
		REPLIES['hostapd.' + ifn + ' get_status'] = () => (ifn === 'wl0-sta' || hapdOff.has(ifn)) ? Promise.reject(new Error('not found')) : Promise.resolve({ bssid: '00:00:5e:00:53:a' + ifn.length, ssid: 'S-' + ifn, channel: chan[ifn] || 1 });
	const self = Object.create(view);
	const savedL = global.L, now = Date.now;
	let t = 1e12;
	Date.now = () => t;
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	const poll = async ms => { t += ms; return self.fetch(); };
	try {
		let r = await poll(0);
		assert.deepEqual(asked.splice(0).sort(), [ 'wl0', 'wl0-1', 'wl0-sta', 'wl1' ], 'the first poll asks every interface');
		r = await poll(5e3);
		assert.deepEqual(asked.splice(0), [], 'then nothing for 30 s');
		assert.equal(r.iwinfo.wl0.channel, 6, 'the reading stands');
		assert.equal(r.hapdStatus['wl0-1'].bssid, '00:00:5e:00:53:a5', 'its BSSID comes from hostapd');
		assert.equal(r.iwinfo['wl0-1'], undefined, 'and not from its first poll\'s iwinfo, kept');
		assert.equal(r.iwinfo['wl0-sta'].channel, 6, 'one hostapd does not serve keeps its reading');
		await poll(25e3);
		assert.deepEqual(asked.splice(0).sort(), [ 'wl0', 'wl0-sta', 'wl1' ], 'after 30 s: a radio\'s first, and the one hostapd does not serve');
		/* hostapd reports wl1 on another channel: asked at the next poll */
		chan.wl1 = 44;
		await poll(5e3);
		assert.deepEqual(asked.splice(0), [], 'the new status is this poll\'s');
		await poll(5e3);
		assert.deepEqual(asked.splice(0), [ 'wl1' ], 'the channel moved: wl1 again');
		/* its radio goes down: asked at once */
		radioUp = false;
		await poll(5e3);
		assert.deepEqual(asked.splice(0), [ 'wl1' ], 'the radio went down: wl1 again');
		await poll(5e3);
		assert.deepEqual(asked.splice(0), [], 'and kept again');
		hapdOff.add('wl0-1');
		await poll(5e3);
		await poll(5e3);
		/* 30 s have passed for wl0 and wl0-sta as well */
		assert.deepEqual(asked.splice(0).sort(), [ 'wl0', 'wl0-1', 'wl0-sta' ], 'hostapd gone quiet: asked again');
	}
	finally {
		global.L = savedL; Date.now = now;
		for (const k of Object.keys(REPLIES)) if (/^(luci\.vantage wireless|iwinfo info|hostapd\.)/.test(k)) delete REPLIES[k];
	}
});

/* Low-power router (#101): the slow parts once every 30 s, their last
   replies in between; the rest every poll */
test('Low-power router: Wi-Fi state, temperatures, wired hosts, iwinfo and client capabilities once every 30 s', async () => {
	const count = {};
	const reply = (key, v) => { REPLIES[key] = (...a) => { count[key] = (count[key] || 0) + 1; return Promise.resolve(typeof v === 'function' ? v(...a) : v); }; };
	reply('luci.vantage wireless', { radio0: { up: true, config: { band: '2g' }, interfaces: [ { ifname: 'wl0', section: 'wl0', config: { mode: 'ap' } } ] } });
	reply('luci.vantage thermal', [ { zone: 'thermal_zone0', type: 'cpu', temp: 50000 } ]);
	reply('luci.vantage wired', { hosts: [ { mac: '00:00:5e:00:53:01', port: 'lan1', bridge: 'br-lan', seen: 1 } ] });
	reply('iwinfo info', { channel: 6 });
	reply('luci.vantage survey', [ { mhz: 2437, noise: -110 } ]);
	reply('iwinfo survey', [ { mhz: 2437, noise: 146 } ]);
	reply('hostapd.wl0 get_clients', { clients: {} });
	reply('hostapd.wl0 get_status', { bssid: '00:00:5e:00:53:aa' });
	reply('system info', {});
	const self = Object.create(view);
	const saved = { L: global.L, document: global.document, now: Date.now };
	let t = 1e12, power = 'low';
	Date.now = () => t;
	global.document = { hidden: false, documentElement: { getAttribute: n => n === 'data-vt-power' ? power : null } };
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	const slowKeys = [ 'luci.vantage wireless', 'luci.vantage thermal', 'luci.vantage wired', 'luci.vantage survey', 'hostapd.wl0 get_clients' ];
	const slowCount = () => slowKeys.map(k => count[k] || 0);
	try {
		const first = await self.fetch();
		assert.deepEqual(slowCount(), [ 1, 1, 1, 1, 1 ]);
		t += 10e3;
		const kept = await self.fetch();
		assert.deepEqual(slowCount(), [ 1, 1, 1, 1, 1 ], 'not again within 30 s');
		assert.equal(count['system info'], 2, 'the rest every poll');
		assert.equal(count['hostapd.wl0 get_status'], 2);
		assert.deepEqual([ kept.wifi, kept.thermal, kept.fdb, kept.iwinfo, kept.hapd, kept.survey ], [ first.wifi, first.thermal, first.fdb, first.iwinfo, first.hapd, first.survey ], 'their last replies');
		assert.equal(count['iwinfo info'], 1);
		t += 20e3;
		await self.fetch();
		assert.deepEqual(slowCount(), [ 2, 2, 2, 2, 2 ], 'again after 30 s');
		assert.equal(count['iwinfo info'], 2);
		power = 'normal';
		t += 1e3;
		const off = await self.fetch();
		assert.deepEqual(slowCount(), [ 3, 3, 3, 3, 3 ], 'off: every poll');
		assert.equal(count['iwinfo info'], 2, 'iwinfo info on its own 30 s');
		assert.deepEqual(off.survey.wl0, [ { mhz: 2437, noise: -110 } ], 'the survey every poll');
		assert.equal(count['iwinfo survey'], undefined, 'never rpcd\'s iwinfo survey, which crashes rpcd on drivers other than nl80211\'s (#124)');
	}
	finally {
		global.L = saved.L; Date.now = saved.now;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
		for (const k of Object.keys(REPLIES)) if (/^(luci\.vantage (wireless|thermal|wired|survey)|iwinfo (info|survey)|hostapd\.|system info)/.test(k)) delete REPLIES[k];
	}
});

test('switch ports: LuCI is asked on the side for a switch with hosts behind it, at most every 30 s from the call; a failure is not known', async () => {
	const calls = [], STATE = [ { port: 1, link: true, speed: 1000, duplex: true } ];
	const lan = n => ({ num: n, role: 'lan', index: n + 1 });
	let answer = () => Promise.resolve({ result: STATE }), slow = 0;
	REPLIES['luci.vantage wired'] = () => Promise.resolve({
		hosts: [ { mac: '00:00:5e:00:53:11', port: 'eth1.1', bridge: 'br-lan', seen: 1 } ],
		switches: { 'eth1.1': { name: 'switch0', vlan: 1, ports: [ lan(0), lan(1) ] }, 'eth1.2': { name: 'switch1', vlan: 2, ports: [ lan(4) ] }, 'eth9': { name: 'bad name;', vlan: 3, ports: [] } }
	});
	REPLIES['luci getSwconfigPortState'] = name => { calls.push(name); return answer(); };
	/* the base replies take `slow` ms of the device's clock */
	REPLIES['system info'] = () => { t += slow; return Promise.resolve({}); };
	const flush = () => new Promise(r => setImmediate(r));
	const self = Object.create(view);
	const now = Date.now, savedL = global.L;
	let t = 1e12;
	Date.now = () => t;
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).catch(() => d) };
	const poll = async ms => { t += ms; const r = await self.fetch(); await flush(); return r; };
	try {
		const a = await poll(0);
		assert.deepEqual(calls, [ 'switch0' ], 'only the switch with hosts behind it');
		assert.equal(a.switches['eth1.1'].name, 'switch0');
		assert.equal(a.switchState.switch0, null, 'asked on the side: not waited for');
		assert.deepEqual((await poll(5e3)).switchState.switch0, STATE, 'the answer from the next poll');
		assert.deepEqual((await poll(24e3)).switchState.switch0, STATE, 'kept');
		assert.equal(calls.length, 1, 'not again within 30 s');
		await poll(1e3);
		assert.equal(calls.length, 2);

		/* 30 s from the call: base replies that took 10 s put the call 10 s
		   into the poll; 20 s after it, nothing is asked */
		slow = 10e3;
		await poll(30e3);
		slow = 0;
		assert.equal(calls.length, 3);
		await poll(20e3);
		assert.equal(calls.length, 3, 'counted from the call, not the poll');
		await poll(10e3);
		assert.equal(calls.length, 4);

		/* an error reply, no ports, or a failed call: not known (null), not
		   "every port down" */
		for (const bad of [ () => Promise.resolve({ error: 'No such switch' }), () => Promise.resolve({ result: [] }), () => Promise.reject(new Error('denied')) ]) {
			answer = bad;
			await poll(30e3);
			assert.equal((await poll(1e3)).switchState.switch0, null);
		}
		/* a call that never answers holds up no poll */
		answer = () => new Promise(() => {});
		const done = await Promise.race([ poll(30e3).then(() => 'polled'), new Promise(r => setTimeout(() => r('stuck'), 200)) ]);
		assert.equal(done, 'polled');
	} finally {
		Date.now = now;
		global.L = savedL;
		delete REPLIES['luci.vantage wired'];
		delete REPLIES['luci getSwconfigPortState'];
		delete REPLIES['system info'];
	}
});

/* #83: with the Vantage theme installed but another one selected, the
   dashboard makes way for LuCI's own landing page. The dashboard alone
   (no theme package) works under any theme. */
test('another theme: the dashboard steps aside only when the Vantage theme is installed', () => {
	const DASH = [ 'admin', 'status', 'dashboard' ], OVERVIEW = [ 'admin', 'status', 'overview' ];
	/* Vantage is the theme in use */
	assert.equal(view.asidePage('/luci-static/vantage', true, true, true), null);
	assert.equal(view.asidePage('/luci-static/vantage/', true, false, true), null, 'a trailing slash');
	/* another theme, Vantage's installed: LuCI's dashboard, else Status -> Overview */
	assert.deepEqual(view.asidePage('/luci-static/argon', true, true, true), DASH);
	assert.deepEqual(view.asidePage('/luci-static/argon', true, true, false), DASH);
	assert.deepEqual(view.asidePage('/luci-static/argon', true, false, true), OVERVIEW);
	assert.deepEqual(view.asidePage('/luci-static/bootstrap-dark', true, false, true), OVERVIEW);
	assert.deepEqual(view.asidePage('/luci-static/vantage-old', true, false, true), OVERVIEW, 'another name is another theme');
	/* neither page for this user: the dashboard, not an access error */
	assert.equal(view.asidePage('/luci-static/argon', true, false, false), null);
	/* the dashboard only: stays under any theme */
	assert.equal(view.asidePage('/luci-static/argon', false, true, true), null);
	assert.equal(view.asidePage('/luci-static/bootstrap', false, false, true), null);
	assert.equal(view.asidePage('/luci-static/argon', 'yes', true, true), null, 'only a yes from the probe counts');
	/* LuCI named no theme: no decision, as before */
	for (const media of [ undefined, null, '', '/', 42 ])
		assert.equal(view.asidePage(media, true, true, true), null, String(media));
	const a = view.asidePage('/luci-static/argon', true, true, true);
	a.push('x');
	assert.deepEqual(view.asidePage('/luci-static/argon', true, true, true), DASH, 'a fresh path each time');
});

const node = (satisfied, children) => Object.assign({ satisfied }, children ? { children } : {});
const menuWith = (dashboard, overview = node(true)) => ({ children: { admin: node(true, { status: node(true, Object.assign({ overview }, dashboard ? { dashboard } : {})) }) } });
const SCRIPT = { ok: true, status: 200, headers: { get: h => /^content-type$/i.test(h) ? 'application/javascript; charset=UTF-8' : null } };
const NOT_FOUND = { ok: false, status: 404, headers: { get: h => /^content-type$/i.test(h) ? 'text/html' : null } };
const HTML_200 = { ok: true, status: 200, headers: { get: h => /^content-type$/i.test(h) ? 'text/html; charset=UTF-8' : null } };

/* load() with media as L.env.media; theme: the reply to the theme probe
   (an object, or an Error to reject); menu: the menu tree, or null for a
   failed load. 'dashboard' when load() resolved, 'waiting' when it is
   still pending (it never resolves after location.replace) */
async function openDashboard(media, theme, menu) {
	const replaced = [], probes = [], asked = [];
	const saved = { L: global.L, fetch: global.fetch, window: global.window, menu: UI.menu };
	global.L = {
		env: { media, resource_version: '25.12-1' },
		resource: p => '/luci-static/resources/' + p,
		url: (...a) => '/cgi-bin/luci/' + a.join('/'),
		resolveDefault: (p, d) => Promise.resolve(p).catch(() => d)
	};
	global.fetch = (url, opts) => {
		if (url !== '/luci-static/resources/menu-vantage.js') return Promise.resolve({ ok: false, text: () => Promise.resolve('') });
		probes.push((opts && opts.method) || 'GET');
		return theme instanceof Error ? Promise.reject(theme) : Promise.resolve(theme);
	};
	global.window = { location: { replace: url => replaced.push(url) } };
	UI.menu = { load: () => menu ? Promise.resolve(menu) : Promise.reject(new Error('menu failed')) };
	REPLIES['system board'] = () => { asked.push('board'); return Promise.resolve({}); };
	try {
		const out = await Promise.race([ Object.create(view).load().then(() => 'dashboard'), new Promise(r => setTimeout(() => r('waiting'), 100)) ]);
		return { out, replaced, probes, asked };
	} finally {
		global.L = saved.L;
		global.fetch = saved.fetch;
		if (saved.window === undefined) delete global.window; else global.window = saved.window;
		UI.menu = saved.menu;
		delete REPLIES['system board'];
	}
}

test('another theme: load() decides before the dashboard asks for anything', async () => {
	const stays = { out: 'dashboard', replaced: [], asked: [ 'board' ] };
	const pick = r => ({ out: r.out, replaced: r.replaced, asked: r.asked });

	/* Vantage in use: no probe at all */
	let r = await openDashboard('/luci-static/vantage', SCRIPT, menuWith(node(true)));
	assert.deepEqual(pick(r), stays);
	assert.deepEqual(r.probes, [], 'nothing asked under Vantage');

	/* another theme with Vantage's installed: replaced, nothing of the dashboard loaded */
	r = await openDashboard('/luci-static/argon', SCRIPT, menuWith(node(true)));
	assert.deepEqual(pick(r), { out: 'waiting', replaced: [ '/cgi-bin/luci/admin/status/dashboard' ], asked: [] });
	assert.deepEqual(r.probes, [ 'HEAD' ]);
	r = await openDashboard('/luci-static/argon', SCRIPT, menuWith(null));
	assert.deepEqual(pick(r), { out: 'waiting', replaced: [ '/cgi-bin/luci/admin/status/overview' ], asked: [] }, 'no luci-mod-dashboard');
	r = await openDashboard('/luci-static/argon', SCRIPT, menuWith(node(false)));
	assert.deepEqual(r.replaced, [ '/cgi-bin/luci/admin/status/overview' ], 'luci-mod-dashboard, but not for this user');
	r = await openDashboard('/luci-static/argon', SCRIPT, null);
	assert.deepEqual(r.replaced, [ '/cgi-bin/luci/admin/status/overview' ], 'no menu: the page every LuCI has');
	assert.deepEqual(pick(await openDashboard('/luci-static/argon', SCRIPT, menuWith(null, node(false)))), stays, 'a user without Status -> Overview');

	/* the dashboard only, or no clear answer: the dashboard, as before */
	assert.deepEqual(pick(await openDashboard('/luci-static/argon', NOT_FOUND, menuWith(node(true)))), stays, '404');
	assert.deepEqual(pick(await openDashboard('/luci-static/bootstrap', HTML_200, menuWith(node(true)))), stays, 'an error page with 200');
	assert.deepEqual(pick(await openDashboard('/luci-static/argon', new TypeError('Failed to fetch'), menuWith(node(true)))), stays, 'no answer');
	r = await openDashboard(undefined, SCRIPT, menuWith(node(true)));
	assert.deepEqual([ pick(r), r.probes ], [ stays, [] ], 'no media');
});

test('another theme: the probed file is the theme package\'s alone, the target the app\'s menu entry', () => {
	const ROOT = path.join(__dirname, '..');
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.match(src, /fetch\(L\.resource\('menu-vantage\.js'\)/);
	assert.ok(fs.existsSync(path.join(ROOT, 'luci-theme-vantage/htdocs/luci-static/resources/menu-vantage.js')), 'luci-theme-vantage ships it');
	assert.ok(!fs.existsSync(path.join(RES, 'menu-vantage.js')), 'luci-app-vantage must not');
	const menu = JSON.parse(fs.readFileSync(path.join(ROOT, 'luci-app-vantage/root/usr/share/luci/menu.d/zz-luci-app-vantage.json'), 'utf8'));
	assert.match(src, /var LUCI_DASHBOARD = \[ 'admin', 'status', 'dashboard' \];/);
	assert.equal(menu['admin/status/dashboard'].action.path, 'dashboard/index', 'luci-mod-dashboard\'s page');
	assert.equal(menu['admin/dashboard'].action.path, 'vantage/overview');
});

test('header: model and hostname once each, one of them when it holds the other', () => {
	const id = d => view.identity(d);
	assert.deepEqual(id({ model: 'Example AX3000', hostname: 'example-ax3000' }), [ 'Example AX3000' ]);
	assert.deepEqual(id({ model: 'Example AX3000', hostname: 'AX3000' }), [ 'Example AX3000' ], 'the model holds the hostname');
	assert.deepEqual(id({ model: 'AX3000', hostname: 'ax3000-attic' }), [ 'ax3000-attic' ], 'the hostname holds the model');
	assert.deepEqual(id({ model: 'Example AX3000', hostname: 'attic' }), [ 'Example AX3000', 'attic' ]);
	assert.deepEqual(id({ model: 'Example AX3000', hostname: null }), [ 'Example AX3000' ]);
	assert.deepEqual(id({ model: 'Example AX3000', hostname: '--' }), [ 'Example AX3000', '--' ], 'nothing to compare: both');
});

test('health: the theme\'s refresh dot hears a warning or an error, nothing else', () => {
	const saved = global.document;
	const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
	global.document = { documentElement: root };
	try {
		for (const [ level, want ] of [ [ 'ok', '' ], [ 'warn', 'warn' ], [ 'err', 'err' ], [ 'unknown', '' ], [ 'info', '' ] ]) {
			const self = Object.create(view);
			self.st = { summary: { level, headline: 'x' } };
			self.m = { clients: [], device: {}, wired: false };
			self.el = { orb: {}, headline: { textContent: '' }, subline: { textContent: '' } };
			self.identity = () => [];
			self.paintHead();
			assert.equal(self.el.orb.className, 'vt-orb vt-orb-' + level);
			assert.equal(root.attrs['data-vt-alert'], want, level);
		}
	} finally {
		if (saved === undefined) delete global.document; else global.document = saved;
	}
});

test('live pill: under the Vantage theme only when not live; under another theme always', () => {
	const saved = { L: global.L, document: global.document };
	const pill = () => ({ className: '', hidden: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
	const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
	const run = (media, st) => {
		global.L = { env: { media } };
		global.document = { hidden: false, documentElement: root };
		const self = Object.create(view);
		self.st = Object.assign({ paused: false, lastErr: null, lastOk: Date.now() }, st);
		self.el = { live: pill(), liveText: { textContent: '' } };
		self.paintLive();
		return [ self.el.live.hidden, self.el.live.className ];
	};
	try {
		assert.deepEqual(run('/luci-static/vantage', {}), [ true, 'vt-livepill vt-live-ok' ], 'the theme\'s poll indicator says it');
		assert.deepEqual(run('/luci-static/vantage', { lastErr: new Error('x') }), [ false, 'vt-livepill vt-live-err' ]);
		assert.equal(root.attrs['data-vt-live'], 'err', 'the theme\'s refresh dot hears it');
		assert.deepEqual(run('/luci-static/vantage/', { paused: true }), [ false, 'vt-livepill vt-live-paused' ]);
		assert.deepEqual(run('/luci-static/bootstrap', {}), [ false, 'vt-livepill vt-live-ok' ]);
	} finally {
		global.L = saved.L;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
	}
});

test('paused from LuCI\'s indicator: the pill says so (once, under the Vantage theme) and nothing moves', () => {
	const saved = { L: global.L, document: global.document, window: global.window };
	const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
	/* the flow dots are compositor animations, paused and played with the
	   motion; the pulses (the ring, the beat) stand paused and the clock
	   (tickMotion) moves them while it runs, and stops when nothing may move */
	const anim = () => ({ state: 'running', play() { this.state = 'running'; }, pause() { this.state = 'paused'; } });
	const pulse = () => ({ currentTime: 0, playState: 'paused' });
	const frames = [], timers = [];
	global.window = { requestAnimationFrame: fn => frames.push(fn), setTimeout: fn => timers.push(fn), dispatchEvent() {} };
	const make = media => {
		global.L = { env: { media } };
		global.document = { hidden: false, documentElement: root };
		const self = Object.create(view);
		const cls = new Set();
		self.st = { paused: false, lastErr: null, lastOk: Date.now() };
		self.el = { live: { className: '', hidden: false, setAttribute() {} }, liveText: { textContent: '' },
			root: { classList: { toggle: (c, on) => on ? cls.add(c) : cls.delete(c) } } };
		self.wireMap = { a: { anims: [ anim(), anim() ], steps: [], speed: 1 } };
		self.clock = { anims: [ { a: pulse(), dur: 5000, at: 0 } ], raf: 0, timer: 0, last: 0 };
		self.backdrop = { paused: false, pause(on) { this.paused = on; }, wants() { return false; }, period() { return 50; }, frame() { return false; } };
		self.cls = cls;
		return self;
	};
	try {
		POLL.on = false;
		let self = make('/luci-static/vantage');
		self.paintLive();
		assert.equal(self.el.live.className, 'vt-livepill vt-live-paused');
		assert.equal(self.el.live.hidden, true, 'the theme\'s indicator already says Paused');
		assert.equal(self.el.liveText.textContent, 'Paused');
		assert.equal(root.attrs['data-vt-live'], 'paused');
		assert.ok(self.cls.has('vt-still'), 'the status circle stands still');
		assert.deepEqual(self.wireMap.a.anims.map(a => a.state), [ 'paused', 'paused' ], 'the flow dots stop where they are');
		assert.equal(frames.length, 0, 'the clock does not start');
		self.tickMotion(100);
		assert.deepEqual([ frames.length, timers.length, self.clock.anims[0].a.currentTime ], [ 0, 0, 0 ], 'a tick moves nothing and asks for no frame');
		assert.equal(self.backdrop.paused, true, 'the backdrop keeps its last frame');
		POLL.on = true;
		self.paintLive();
		assert.equal(self.el.live.className, 'vt-livepill vt-live-ok');
		assert.ok(!self.cls.has('vt-still'));
		assert.deepEqual(self.wireMap.a.anims.map(a => a.state), [ 'running', 'running' ], 'and go on from there');
		assert.equal(frames.length, 1, 'the clock starts');
		frames.pop()(100);
		frames.pop() && assert.fail('a tick asks for its next frame through a timer, not at once');
		assert.equal(timers.length, 1, 'the next frame waits for the clock');
		self.tickMotion(150);
		assert.equal(self.clock.anims[0].a.currentTime, 50, 'the pulse goes on from there, 50 ms a tick');
		assert.equal(self.backdrop.paused, false);
		POLL.on = false;
		self = make('/luci-static/bootstrap');
		self.paintLive();
		assert.deepEqual([ self.el.live.hidden, self.el.liveText.textContent ], [ false, 'Paused' ], 'another theme: the pill says it');
	} finally {
		POLL.on = true;
		global.L = saved.L;
		if (saved.window === undefined) delete global.window; else global.window = saved.window;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
	}
});

test('clients: a pick (filter, quick filter, Wi-Fi or wired) shows the new height at once; a poll keeps the hold', () => {
	const self = Object.create(view);
	let laid = 0;
	self.held = { clients: { h: 6000, since: 1 }, chart: { h: 300, since: 1 } };
	self.paintClients = () => {};
	self.scheduleLayout = () => { laid++; };
	self.el = { filter: { value: '' } };
	self.ui = { kind: 'wired', chip: 'all', filter: '' };
	self.setFilter('phone');
	assert.equal(self.held.clients, undefined, 'released');
	assert.ok(self.held.chart, 'other tiles keep theirs');
	assert.equal(laid, 1);
	self.held.clients = { h: 6000, since: 1 };
	self.pickClients();
	assert.equal(self.held.clients, undefined);
	/* the Wi-Fi/Wired switch and the quick filters go through pickClients */
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.match(src, /ui\.kind = k\[0\]; ui\.chip = 'all'; self\.pickClients\(\);/);
	assert.match(src, /ui\.chip = d\[0\]; self\.filterMenu\(false\); self\.pickClients\(\);/);
	assert.match(src, /'input': function\(ev\) \{ self\.ui\.filter = ev\.target\.value; self\.pickClients\(\); \}/);
});

test('deep links: moving from an open drawer to a client names the client', () => {
	const self = Object.create(view);
	self.ui = { drawer: { kind: 'radio', id: 'radio1' } };
	self.el = { drawer: { hidden: false } };
	let painted = 0;
	self.paintDrawer = () => { painted++; };
	self.paintClients = () => {};
	const cleared = withLocation('#radio=radio1', c => { self.openDrawer('client', '00:00:5e:00:53:21'); return c; });
	assert.deepEqual(cleared, [ '#client=00%3A00%3A5e%3A00%3A53%3A21' ]);
	assert.deepEqual(self.ui.drawer, { kind: 'client', id: '00:00:5e:00:53:21' });
	assert.equal(painted, 1);
});

/* a tree of { tag, attrs, children } from E() stubs, as text and classes */
function withDom(fn) {
	const saved = { E: global.E, document: global.document };
	const node = () => ({ setAttribute() {}, appendChild() {}, style: { setProperty() {} } });
	global.document = { createElementNS: node };
	global.E = (tag, attrs, children) => ({ tag, attrs: attrs || {}, children: [].concat(children == null ? [] : children), style: { setProperty() {} },
		classList: { add() {}, remove() {}, toggle() {} }, appendChild(c) { this.children.push(c); return c; } });
	try { return fn(); }
	finally {
		if (saved.E === undefined) delete global.E; else global.E = saved.E;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
	}
}
const texts = n => n == null || n === '' ? [] : typeof n === 'string' ? [ n ] : n.children ? n.children.flatMap(texts) : [];
const classes = n => n && typeof n === 'object' && n.children ? [ n.attrs && n.attrs['class'] ].concat(n.children.flatMap(classes)).filter(Boolean) : [];

test('names made up from the MAC: the plain name beside the MAC, no source badge; one line keeps the octets', () => {
	const self = Object.create(view);
	const priv = { mac: '02:00:5e:00:53:11', macLabel: '02:00:5E:00:53:11', name: 'Private device 53:11', plainName: 'Private device',
		nameSource: 'private', nameSourceLabel: 'Private', secondary: '02:00:5E:00:53:11', icon: 'phone' };
	const named = Object.assign({}, priv, { name: 'phone', plainName: 'phone', nameSource: 'dhcp', nameSourceLabel: 'DHCP', secondary: '192.0.2.44' });
	withDom(() => {
		const row = self.whoCell(priv, []);
		assert.deepEqual(texts(row), [ 'Private device', '02:00:5E:00:53:11' ]);
		assert.ok(!classes(row).some(c => /vt-src/.test(c)), 'no PRIVATE badge');
		/* an address as the second line: the octets stay to tell it apart */
		assert.deepEqual(texts(self.whoCell(Object.assign({}, priv, { secondary: '192.0.2.50' }), [])), [ 'Private device 53:11', '192.0.2.50' ]);
		const who = self.drawerWho(priv);
		assert.deepEqual(texts(who[1]), [ 'Private device', '02:00:5E:00:53:11' ]);
		/* a real name keeps its source */
		assert.deepEqual(texts(self.whoCell(named, [])), [ 'phone', 'DHCP', '192.0.2.44' ]);
		assert.deepEqual(texts(self.drawerWho(named)[1]), [ 'phone', 'DHCP', '192.0.2.44' ]);
	});
});

/* other lines to the internet (#88): failover and mwan3 lines beside the main one */
const LINE = (iface, dev, metric) => ({ iface, l3dev: dev, dev, statsDev: dev, port: dev, proto: 'dhcp', up: true, carrier: true, speed: { mbps: 1000, duplex: 'full' },
	ipv4: [ '203.0.113.' + (metric + 2) + '/29' ], ipv6: [], gateway: '203.0.113.' + (metric + 1), defaultRoute: true, metric, dns: [], stats: { rx_bytes: 10, tx_bytes: 20 }, isWan: true, uptime: 60 });

test('other lines: in the path\'s key, one chart row each, every line\'s history by its interface', () => {
	const self = Object.create(view);
	const wan = LINE('wan', 'eth1', 10);
	self.m = { wired: true, networks: [ { name: 'lan', up: true } ], radios: [ { id: 'radio0', bandLabel: '5 GHz' } ], ssids: [], wiredHosts: [], uplink: wan, uplinks: [ wan ] };
	const one = self.heroKey();
	assert.deepEqual(self.extraLines(), []);
	assert.deepEqual(self.chartSeries().map(s => s.key), [ 'up:wan', 'radio0' ]);
	self.m.uplinks = [ wan, LINE('wanb', 'eth2', 20) ];
	assert.notEqual(self.heroKey(), one, 'a line that comes or goes rebuilds the path');
	assert.deepEqual(self.chartSeries().map(s => [ s.key, s.label, s.dn, s.up ]), [
		[ 'up:wan', 'Uplink eth1', 1, 2 ], [ 'up:wanb', 'Uplink eth2', 1, 2 ], [ 'radio0', '5 GHz radio', 2, 1 ] ]);
	self.m.wired = false;
	assert.match(self.heroKey(), /lines=wanb$/);
	/* the model caps the lines (model.MAX_LINES); no line: an empty row */
	assert.deepEqual(self.extraLines({ uplinks: null }), []);
	self.m.uplink = null;
	self.m.uplinks = [];
	assert.deepEqual(self.chartSeries().map(s => s.key), [ 'uplink', 'radio0' ]);
});

test('other lines: a deep link opens a line the device has, the main one by its name too; any other name opens the main one', () => {
	const at = (hash, uplinks) => {
		const self = Object.create(view);
		self.m = { radios: [], uplinks };
		self.opened = [];
		self.openDrawer = function(kind, id) { this.opened.push([ kind, id ]); };
		withLocation(hash, () => self.openFromHash());
		return self.opened;
	};
	const lines = [ LINE('wan', 'eth1', 10), LINE('wanb', 'eth2', 20) ];
	assert.deepEqual(at('#uplink=wanb', lines), [ [ 'uplink', 'wanb' ] ]);
	assert.deepEqual(at('#uplink=wan', lines), [ [ 'uplink', 'wan' ] ], 'the main line by its own name: that interface');
	assert.deepEqual(at('#uplink', lines), [ [ 'uplink', '' ] ]);
	assert.deepEqual(at('#uplink=%3Cb%3Ewanb', lines), [ [ 'uplink', '' ] ]);
	assert.deepEqual(at('#uplink=wanb', lines.slice(0, 1)), [ [ 'uplink', '' ] ], 'a line that is gone');
	/* the main line has an id no interface can have */
	const self = Object.create(view);
	self.ui = {};
	self.el = { drawer: { hidden: false } };
	self.paintDrawer = () => {};
	self.paintClients = () => {};
	assert.deepEqual(withLocation('', c => { self.openDrawer('uplink', ''); self.openDrawer('uplink', 'uplink'); return c; }), [ '#uplink', '#uplink=uplink' ]);
});

test('other lines: each node shows its name, gateway and live rates, wired into the device; the main one is marked', () => {
	const self = Object.create(view);
	const el = () => ({ textContent: '', attrs: {}, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, setAttribute(k, v) { this.attrs[k] = v; } });
	const ln = id => ({ id, el: el(), kicker: el(), title: el(), dn: el(), up: el() });
	const wan = LINE('wan', 'eth1', 10), wanb = LINE('wanb', 'eth2', 20), lte = Object.assign(LINE('lte', 'wwan0', 30), { gateway: null, carrier: false, speed: null });
	const h = new Proxy({ lines: [ ln('wanb'), ln('lte'), ln('gone') ], radios: [] }, { get: (t, k) => k in t ? t[k] : (t[k] = el()) });
	self.hero = h;
	self.m = { wired: true, networks: [], radios: [], ssids: [], wiredHosts: [], device: { model: 'Router', uptime: 1 }, uplink: wan, uplinks: [ wan, wanb, lte ] };
	self.st = { uplinkRate: { rx: 2e6, tx: 1e5 }, devRates: { eth2: { rx: 12345678, tx: 3000 }, wwan0: { rx: 0, tx: 0 } } };
	self.updateHero();
	assert.equal(h.gwKicker.textContent, 'wan', 'beside other lines the main one goes by its name');
	const [ b, l ] = h.lines;
	assert.deepEqual([ b.kicker.textContent, b.title.textContent, b.dn.textContent, b.up.textContent ], [ 'wanb', '203.0.113.21', '↓ 12.3 Mbit/s', '↑ 3 kbit/s' ]);
	assert.equal(b.el.attrs.title, 'wanb · eth2 · 1 Gbit/s · full duplex');
	assert.equal(b.el.attrs['class'], 'vt-node vt-node-gw vt-node-line');
	assert.deepEqual([ l.title.textContent, l.dn.textContent, l.up.textContent ], [ 'wwan0', 'idle', '' ], 'no gateway address: the device; nothing moving: idle');
	assert.equal(l.el.attrs['class'], 'vt-node vt-node-gw vt-node-line vt-node-off', 'no carrier');
	assert.deepEqual([ b.active, l.active ], [ true, false ]);
	/* one wire per line into the device, numbered for nesting */
	assert.deepEqual(self.wireList().filter(w => w.line != null).map(w => [ w.key, w.from === h.lines[w.line].el, w.to === h.ap, w.speed ]),
		[ [ 'l:wanb', true, true, 2 ], [ 'l:lte', true, true, 1 ], [ 'l:gone', true, true, 1 ] ]);
	/* one line: the gateway's own kicker */
	h.lines = [];
	self.m.uplinks = [ wan ];
	self.updateHero();
	assert.equal(h.gwKicker.textContent, 'Internet');
});

test('no Wi-Fi: the path has the Wired branch too, even beside a network called wired (#98)', t => {
	const self = Object.create(view);
	const host = (mac, port, extra) => Object.assign({ mac: '00:00:5e:00:53:' + mac, name: mac, nameSource: 'mac', port, shared: false, speed: null, gateway: false }, extra);
	const wan = LINE('wan', 'eth1', 10);
	const hosts = [ host('01', 'lan5'), host('02', 'lan5'), host('03', 'lan5'), host('04', 'lan6'), host('05', 'eth1', { gateway: true }) ];
	self.m = { wired: true, networks: [ { name: 'lan', proto: 'static', dev: 'br-lan', up: true, ipv4: '192.0.2.1/24' }, { name: 'wired', dev: 'br-wired', up: true } ],
		radios: [], ssids: [], wiredHosts: hosts, device: { model: 'Router', uptime: 1 }, uplink: wan, uplinks: [ wan ] };
	self.st = { uplinkRate: null, devRates: { lan5: { rx: 1000, tx: 3000 }, 'br-lan': { rx: 1, tx: 2 } } };
	const nodes = [];
	self.el = { path: { childNodes: [], classList: { toggle() {} }, setAttribute() {}, getAttribute() { return null; }, insertBefore(c) { nodes.push(c); return c; } }, wires: {}, flows: {} };
	const key = self.heroKey();
	assert.match(key, /\nwired=lan5,lan6\n/);
	const savedL = global.L;
	global.L = { url: () => '/network' };
	t.after(() => { if (savedL === undefined) delete global.L; else global.L = savedL; });
	withDom(() => {
		const bare = global.E;
		global.E = (...args) => Object.assign(bare(...args), { getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, setAttribute(k, v) { this.attrs[k] = v; } });
		self.buildHeroNodes(key);
		const h = self.hero;
		assert.deepEqual(h.radios.map(b => b.id), [ 'lan', 'wired', ':wired' ], 'beside the networks, and not mistaken for one');
		const b = h.radios[2];
		assert.deepEqual(b.ssids.map(sn => sn.port), [ 'lan5', 'lan6' ]);
		self.updateHero();
		assert.equal(b.title.textContent, '4 devices', 'the hosts on its ports, not the gateway');
		assert.deepEqual(b.ssids.map(sn => [ sn.name.textContent, sn.count.textContent ]), [ [ 'lan5', '3 devices' ], [ 'lan6 · 04', '—' ] ], 'one host alone on a port goes by its name');
		assert.equal(h.radios[0].title.textContent, 'lan', 'the networks still fill in');
		const keys = self.wireList().map(w => w.key);
		assert.equal(new Set(keys).size, keys.length, 'one wire per key');
		assert.ok(keys.includes('r:wired') && keys.includes('r::wired') && keys.includes('s::wired:port:lan6'));
	});
	/* a port that comes or goes rebuilds the path */
	hosts.push(host('06', 'lan7'));
	assert.notEqual(self.heroKey(), key);
});

test('other lines: the uplink drawer shows the line asked for, its rates and route metric', () => {
	const self = Object.create(view);
	const wan = LINE('wan', 'eth1', 10), wanb = LINE('wanb', 'eth2', 20);
	self.m = { uplink: wan, uplinks: [ wan, wanb ] };
	self.st = { uplinkRate: { rx: 1e6, tx: 2e6 }, devRates: { eth2: { rx: 3e6, tx: 4e6 } }, hist: { net: { uplink: [], 'up:wanb': [] } } };
	withDom(() => {
		const d = self.drawerUplink('wanb'), all = texts({ children: d.title.concat(d.body) });
		assert.ok(all.includes('Uplink · wanb'));
		assert.ok(all.includes('3 Mbit/s') && all.includes('4 Mbit/s'), 'its own rates');
		assert.deepEqual(all.slice(all.indexOf('Route metric'), all.indexOf('Route metric') + 2), [ 'Route metric', '20' ]);
		const main = texts({ children: [].concat(self.drawerUplink('').title, self.drawerUplink('').body) });
		assert.ok(main.includes('Uplink · wan') && main.includes('1 Mbit/s') && main.includes('10'));
		/* a backup named "uplink" is that backup, not the main line */
		const named = LINE('uplink', 'eth3', 30);
		self.m.uplinks = [ wan, named ];
		assert.ok(texts({ children: self.drawerUplink('uplink').title }).includes('Uplink · uplink'));
		assert.ok(texts({ children: self.drawerUplink('').title }).includes('Uplink · wan'));
		/* failover: wanb is the main line now, its drawer still wanb's, at the fast lane's rate */
		self.m = { uplink: wanb, uplinks: [ wanb ] };
		const now = texts({ children: [].concat(self.drawerUplink('wanb').title, self.drawerUplink('wanb').body) });
		assert.ok(now.includes('Uplink · wanb') && now.includes('1 Mbit/s'));
		/* wan is down: said so under its own name, not wanb's details */
		const gone = texts({ children: [].concat(self.drawerUplink('wan').title, self.drawerUplink('wan').body) });
		assert.deepEqual(gone.filter(t => /Uplink|down/.test(t)), [ 'Uplink · wan', 'This line is down or has no default route now.' ]);
		assert.ok(!gone.some(t => /wanb|eth2/.test(t)));
		/* one line: no metric row */
		self.m.uplinks = [ wanb ];
		assert.ok(!texts({ children: self.drawerUplink('').body }).includes('Route metric'));
	});
});

test('stored history: it belongs to one login', () => {
	const savedWindow = global.window, savedL = global.L, box = {};
	const hist = sid => JSON.stringify({ sid, cpu: [ [ 1, 2 ], [ 3, 4 ] ], clients: { '00:00:5E:00:53:01': [ [ 1, 2 ] ] } });
	global.window = {
		sessionStorage: { getItem: () => box.v || null, setItem(k, v) { box.v = v; } },
		localStorage: { getItem: () => null, setItem() {} }
	};
	global.L = { env: { sessionid: '0123456789abcdef0123456789abcdef' } };
	const load = () => { const self = Object.create(view); self.initState({ board: {}, canWrite: false, canRdns: false, mdns: null }); return self; };
	const now = Date.now();
	try {
		box.v = hist('89abcdef').replace('[[1,2],[3,4]]', JSON.stringify([ [ now - 2000, 2 ], [ now - 1000, 4 ] ]));
		assert.equal(load().st.hist.cpu.length, 2, 'the same login keeps its history');
		box.v = hist('ffffffff');
		const other = load();
		assert.equal(other.st.hist.cpu.length, 0, 'another login starts empty');
		assert.deepEqual(Object.keys(other.st.clientHist), []);
	} finally {
		global.window = savedWindow;
		global.L = savedL;
	}
});

/* #101: the CPU tile shows the browser's last reading of this router
   (local storage, the router's origin's: every tab), if under ten
   minutes old, while the first measurement runs; not a dash */
test('CPU: the last reading stands in for ten minutes while the first is measured', () => {
	const savedWindow = global.window, savedL = global.L, box = {};
	global.window = {
		sessionStorage: { getItem: () => null, setItem() {} },
		localStorage: { getItem: k => k === 'vantage.cpu.v1' ? box.v || null : null, setItem(k, v) { if (k === 'vantage.cpu.v1') box.v = v; } }
	};
	global.L = { env: { sessionid: '0123456789abcdef0123456789abcdef' } };
	const load = () => { const self = Object.create(view); self.initState({ board: {}, canWrite: false, canRdns: false, mdns: null }); return self; };
	const put = v => { box.v = JSON.stringify(v); };
	const now = Date.now();
	try {
		put({ pct: 12.5, cores: [ 10, null ], t: now - 9 * 60e3 });
		const held = load().st;
		assert.deepEqual(held.cpu, { pct: 12.5, cores: [ 10, null ], t: now - 9 * 60e3 });
		assert.equal(held.cores, 2);
		put({ pct: 12.5, cores: [ 10, 15 ], t: now - 11 * 60e3 });
		assert.equal(load().st.cpu, null, 'older than ten minutes');
		for (const bad of [ { pct: 120, cores: [], t: now }, { pct: 5, cores: [ 'x' ], t: now }, { pct: 5, cores: {}, t: now }, { pct: 5, cores: [], t: now + 60000 }, { pct: 5, cores: [] }, 'junk' ]) {
			put(bad);
			assert.equal(load().st.cpu, null, JSON.stringify(bad));
		}
		/* a reading is kept for the next page, at most every 10 s */
		box.v = null;
		const self = load();
		const stat = (busy, idle) => 'cpu  ' + busy + ' 0 0 ' + idle + ' 0 0 0 0 0 0\ncpu0 ' + busy + ' 0 0 ' + idle + ' 0 0 0 0 0 0\n';
		const raw = (t, st) => ({ at: t, info: { localtime: t / 1000 }, stat: st, ifaces: [], wifi: null, hints: {}, thermal: [], fdb: [], assoc: {}, hapd: {}, hapdStatus: {}, iwinfo: {}, devs: {} });
		self.ingest(raw(1.8e12, stat(100, 900)));
		assert.equal(box.v || null, null, 'nothing measured yet');
		self.ingest(raw(1.8e12 + 5000, stat(150, 1050)));
		const kept = JSON.parse(box.v);
		assert.deepEqual([ Math.round(kept.pct), kept.cores.map(Math.round) ], [ 25, [ 25 ] ]);
		assert.ok(Math.abs(kept.t - Date.now()) < 5000);
		self.ingest(raw(1.8e12 + 10000, stat(300, 1100)));
		assert.equal(Math.round(JSON.parse(box.v).pct), 25, 'not again within 10 s');
		assert.equal(Math.round(self.st.cpu.pct), 75, 'though shown');
		assert.deepEqual(load().st.cpu.pct, kept.pct, 'and shown on the next page');
	} finally {
		global.window = savedWindow;
		global.L = savedL;
	}
});

/* the first reading takes two samples a second apart: the second is
   asked 1.1 s after the first, not at the 2 s lane's next tick */
test('CPU: 0 % until the first reading, its second sample a second after the first', async () => {
	const savedWindow = global.window, savedL = global.L, savedDoc = global.document, timers = [];
	/* ticks a call: under a second's worth (100) gives no reading */
	let ticks = 100;
	const steps = [ 0, 60, 150, 150 ];
	global.window = { sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null, setItem() {} },
		setTimeout: (f, ms) => { timers.push(ms); return timers.length; } };
	global.document = { hidden: false, documentElement: { getAttribute: () => null } };
	global.L = { env: {}, resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	REPLIES['file read'] = () => { ticks += steps.shift() || 150; return Promise.resolve('cpu  ' + ticks + ' 0 0 0 0 0 0 0 0 0\ncpu0 ' + ticks + ' 0 0 0 0 0 0 0 0 0\n'); };
	try {
		const self = Object.create(view);
		self.initState({ board: {}, canWrite: false, canRdns: false, mdns: null });
		self.el = { root: {} };
		self.m = { uplink: null };
		self.fastLive = () => true;
		self.idle = () => false;
		self.paintFast = () => {};
		assert.equal(self.cpuShown(), null, 'no sample from the router: a dash');
		await self.refreshFast();
		assert.deepEqual(timers, [ 1100 ], 'the first sample: the second asked in 1.1 s');
		assert.deepEqual(self.cpuShown(), { pct: 0, cores: [ 0 ] }, 'until then 0 %, not a dash');
		await self.refreshFast();
		assert.deepEqual(timers, [ 1100 ], 'one timer at a time');
		self.cpuSoon = 0;
		await self.refreshFast();
		assert.ok(self.st.cpu && self.st.cpuMeasured, 'a reading');
		assert.equal(self.cpuShown(), self.st.cpu);
		/* the lane's tick and the early sample share a call in flight */
		let calls = 0;
		const saved = REPLIES['file read'];
		REPLIES['file read'] = (...a) => { calls++; return saved(...a); };
		await Promise.all([ self.refreshFast(), self.refreshFast() ]);
		assert.equal(calls, 1, 'one call for both');
		await self.refreshFast();
		assert.equal(calls, 2, 'and the next one after it');
		await self.refreshFast();
		assert.deepEqual(timers, [ 1100 ], 'and none once measured');
	} finally {
		global.window = savedWindow; global.L = savedL;
		if (savedDoc === undefined) delete global.document; else global.document = savedDoc;
		delete REPLIES['file read'];
	}
});

test('other lines: a failover starts the new main line on its own history; a restored "uplink" of nobody is dropped', () => {
	const saved = global.window, savedL = global.L;
	const box = {};
	global.L = { env: {} };
	global.window = {
		sessionStorage: { getItem: () => box.v || null, setItem(k, v) { box.v = v; } },
		localStorage: { getItem: () => null, setItem() {} }
	};
	const wan = { interface: 'wan', up: true, proto: 'dhcp', device: 'eth1', l3_device: 'eth1', metric: 10, route: [ { target: '0.0.0.0', mask: 0, nexthop: '203.0.113.1' } ] };
	const wanb = { ...wan, interface: 'wanb', device: 'eth2', l3_device: 'eth2', metric: 20, route: [ { target: '0.0.0.0', mask: 0, nexthop: '203.0.113.9' } ] };
	const raw = (t, ifaces) => ({ at: t, info: { localtime: t / 1000 }, stat: '', ifaces, wifi: null, hints: {}, thermal: [], fdb: [], assoc: {}, hapd: {}, hapdStatus: {}, iwinfo: {},
		devs: { eth1: { statistics: { rx_bytes: t * 10, tx_bytes: t } }, eth2: { statistics: { rx_bytes: t * 3, tx_bytes: t } } } });
	try {
		box.v = JSON.stringify({ net: { uplink: [ [ 1, 2, 3 ] ], 'up:wan': [ [ 1, 2, 3 ] ] } });
		const self = Object.create(view);
		self.initState({ board: {}, canWrite: false, canRdns: false, mdns: null });
		assert.deepEqual(Object.keys(self.st.hist.net), [ 'up:wan' ], 'whose "uplink" it was is unknown');
		self.st.hist.net['up:wan'] = [];
		const t0 = 1.8e12;
		for (let k = 0; k < 4; k++) self.ingest(raw(t0 + k * 5000, [ wan, wanb ]));
		const net = self.st.hist.net;
		assert.deepEqual([ net['up:wan'].length, net['up:wanb'].length ], [ 3, 3 ]);
		assert.equal(net['up:wan'][2][1], 5000 * 10 * 8 / 5, 'wan\'s own rate');
		/* wan fails: wanb is the main line and goes on in its own history */
		for (let k = 4; k < 6; k++) self.ingest(raw(t0 + k * 5000, [ wanb ]));
		assert.equal(self.m.uplink.iface, 'wanb');
		assert.deepEqual([ net['up:wan'].length, net['up:wanb'].length ], [ 3, 5 ]);
		assert.ok(net['up:wanb'].every(p => p[1] === 5000 * 3 * 8 / 5), 'wanb\'s rate only');
		assert.deepEqual(self.chartSeries().map(s => s.key), [ 'up:wanb' ]);
		/* gone longer than the chart shows: no history left */
		self.ingest(raw(t0 + 6 * 5000 + 5 * 60 * 1000, [ wanb ]));
		assert.ok(!('up:wan' in net));
		assert.ok(!('uplink' in JSON.parse(box.v).net));
	} finally {
		global.window = saved;
		global.L = savedL;
	}
});

test('other lines: hosts on a backup line\'s port are the way to its gateway, not wired clients', () => {
	const self = Object.create(view);
	const wan = LINE('wan', 'eth1', 10), wanb = Object.assign(LINE('wanb', 'br-lan.20', 20), { dev: 'lan4', statsDev: 'lan4', port: 'lan4' });
	self.m = { uplink: wan, uplinks: [ wan, wanb ], wiredHosts: [ { mac: '00:00:5e:00:53:c9', port: 'lan4' }, { mac: '00:00:5e:00:53:c1', port: 'lan1' } ] };
	assert.deepEqual(self.wiredPorts(), [ 'lan1' ]);
	assert.deepEqual([ self.linePort('lan4'), self.linePort('lan1'), self.linePort(null) ], [ true, false, false ]);
	/* the backup's port unknown (the VLAN's own counters): nothing left out */
	wanb.port = null;
	assert.deepEqual(self.wiredPorts(), [ 'lan1', 'lan4' ]);
});

test('nothing moves while another window has the focus or Low-power router is on; the numbers go on', () => {
	const saved = { L: global.L, document: global.document };
	let power = 'normal';
	const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return k === 'data-vt-power' ? power : null; } };
	global.L = { env: { media: '/luci-static/vantage' } };
	global.document = { hidden: false, documentElement: root };
	const cls = new Set();
	const self = Object.create(view);
	self.st = { paused: false, lastErr: null, lastOk: Date.now() };
	self.el = { live: { className: '', hidden: false, setAttribute() {} }, liveText: { textContent: '' },
		root: { classList: { toggle: (c, on) => on ? cls.add(c) : cls.delete(c) } } };
	self.backdrop = { paused: false, pause(on) { this.paused = on; } };
	try {
		POLL.on = true;
		self.paintLive();
		assert.ok(!cls.has('vt-still'));
		self.focused = false;
		self.paintLive();
		assert.ok(cls.has('vt-still'), 'another window has the focus');
		assert.equal(self.el.live.className, 'vt-livepill vt-live-ok', 'still live');
		self.focused = true;
		self.paintLive();
		assert.ok(!cls.has('vt-still'));
		power = 'low';
		self.paintLive();
		assert.ok(cls.has('vt-still'), 'Low-power router');
		assert.equal(self.backdrop.paused, true);
	} finally {
		global.L = saved.L;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
	}
});


test('Low-power router: the same still picture as reduced motion, no backdrop, and back with the pick kept', () => {
	const saved = { L: global.L, document: global.document };
	let power = 'low';
	const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return k === 'data-vt-power' ? power : null; } };
	global.L = { env: { media: '/luci-static/vantage' } };
	global.document = { hidden: false, documentElement: root };
	const cls = new Set(), styles = [];
	const self = Object.create(view);
	self.st = { paused: false, lastErr: null, lastOk: Date.now() };
	self.el = { live: { className: '', hidden: false, setAttribute() {} }, liveText: { textContent: '' },
		root: { classList: { toggle: (c, on) => on ? cls.add(c) : cls.delete(c) } } };
	self.backdrop = { paused: false, pause(on) { this.paused = on; }, style(v) { styles.push(v); } };
	self.backdropStyle = 'stars';
	let wired = 0;
	self.paintWireState = () => { wired++; };
	try {
		POLL.on = true;
		self.applyPower();
		assert.ok(cls.has('vt-low') && cls.has('vt-still'));
		assert.deepEqual(styles.splice(0), [ 'none' ], 'no backdrop');
		assert.equal(wired, 1, 'the wires redrawn without flow dots');
		self.showBackdrop('grid');
		assert.deepEqual(styles.splice(0), [ 'none' ], 'a new pick waits');
		power = 'normal';
		self.applyPower();
		assert.ok(!cls.has('vt-low') && !cls.has('vt-still'));
		assert.deepEqual(styles, [ 'grid' ], 'the pick back');
	} finally {
		global.L = saved.L;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
	}
});

test('polls: the fast lane is registered before the full poll (#101: no second full poll on load)', () => {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const fast = src.indexOf('poll.add(L.bind(this.refreshFast, this), FAST_S);'), full = src.indexOf('poll.add(L.bind(this.refresh, this), POLL_S);');
	assert.ok(fast > 0 && full > fast);
	assert.ok(src.indexOf('this.inputAt = this.fullAt = Date.now();') > 0 && src.indexOf('this.inputAt = this.fullAt = Date.now();') < fast, 'load() counts as the last full poll');
});

test('Low-power router: after 5 minutes without input, the full poll every 30 s and no fast lane; the next input is live at once', async () => {
	const saved = { L: global.L, document: global.document, now: Date.now };
	let power = 'low', t = 1e12, reads = 0;
	Date.now = () => t;
	global.document = { hidden: false, documentElement: { getAttribute: k => k === 'data-vt-power' ? power : null, setAttribute() {} } };
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d), env: {} };
	REPLIES['file read'] = () => { reads++; return Promise.resolve({ data: '' }); };
	const self = Object.create(view);
	let fetches = 0;
	self.fetch = () => { fetches++; return Promise.resolve({}); };
	self.ingest = () => {}; self.paint = () => {}; self.paintLive = () => {};
	self.st = { lastOk: t, paused: false };
	self.el = {};
	self.m = { uplink: null };
	self.inputAt = t;
	try {
		t += 60e3;
		await self.refresh(); await self.refreshFast();
		assert.deepEqual([ fetches, reads ], [ 1, 1 ], 'watched: as always');
		t += 5 * 60e3;
		assert.equal(self.idle(), true);
		await self.refreshFast();
		assert.equal(reads, 1, 'idle: no fast lane');
		await self.refresh();
		assert.equal(fetches, 2, 'the first idle poll');
		t += 5e3; await self.refresh();
		t += 20e3; await self.refresh();
		assert.equal(fetches, 2, 'not within 30 s');
		t += 6e3; await self.refresh();
		assert.equal(fetches, 3, 'every 30 s');
		t += 4e3;
		self.noteInput();
		assert.equal(fetches, 4, 'input: at once');
		assert.equal(self.idle(), false);
		await self.refreshFast();
		assert.equal(reads, 2, 'and the fast lane again');
		power = 'normal';
		t += 60 * 60e3;
		assert.equal(self.idle(), false, 'never idle when Low-power router is off');
	} finally {
		global.L = saved.L; Date.now = saved.now;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
		delete REPLIES['file read'];
	}
});

/* the full poll: one at a time, 2 s from the last one's start, idle (Low-power
   router) every 30 s, a clock stepped back as time gone; input while LuCI's
   refresh is paused asks nothing */
test('refresh: one at a time, spaced from the start, survives a clock step, input asks only while LuCI polls', async () => {
	const saved = { L: global.L, document: global.document, now: Date.now };
	let t = 1e12, power = 'normal', release = null, fetches = 0;
	Date.now = () => t;
	global.document = { hidden: false, documentElement: { getAttribute: k => k === 'data-vt-power' ? power : null } };
	global.L = { env: {} };
	const self = Object.create(view);
	self.fetch = () => { fetches++; return new Promise(r => { release = r; }); };
	self.ingest = () => {}; self.paint = () => {}; self.paintLive = () => {};
	self.st = { lastOk: t, paused: false };
	self.inputAt = self.fullAt = t;
	const done = async () => { release({}); await new Promise(r => setImmediate(r)); };
	try {
		t += 1e3; self.refresh();
		assert.equal(fetches, 0, 'within 2 s of load()');
		t += 4e3; self.refresh();
		assert.equal(fetches, 1);
		t += 5e3; self.refresh();
		assert.equal(fetches, 1, 'one at a time');
		t += 1e3; await done();
		t += 1e3; self.refresh();
		assert.equal(fetches, 2, 'a slow fetch: spaced from its start, not its end');
		await done();
		t -= 3600e3; self.refresh();
		assert.equal(fetches, 3, 'a clock stepped back an hour: not stopped');
		await done();
		/* hidden, then shown within the idle spacing: not "Paused while hidden" */
		power = 'low'; self.inputAt = t - 10 * 60e3;
		t += 30e3; self.refresh(); await done();
		global.document.hidden = true; self.refresh();
		assert.equal(self.st.paused, true);
		global.document.hidden = false; t += 5e3; self.refresh();
		assert.equal(self.st.paused, false, 'shown again: not paused, though the idle spacing holds the fetch');
		/* LuCI's refresh paused: input asks nothing; resumed: it does */
		const n = fetches;
		POLL.on = false; t += 60e3; self.noteInput();
		assert.equal(fetches, n, 'paused from its indicator');
		self.inputAt = t - 10 * 60e3; POLL.on = true; self.noteInput();
		assert.equal(fetches, n + 1);
		await done();
	} finally {
		POLL.on = true;
		global.L = saved.L; Date.now = saved.now;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
	}
});

test('Low-power router: a failed slow reply is asked again at the next poll; a radio read from the config keeps iwinfo on every interface', async () => {
	const saved = { L: global.L, document: global.document, now: Date.now };
	let t = 1e12, fail = true;
	const count = {};
	Date.now = () => t;
	global.document = { hidden: false, documentElement: { getAttribute: k => k === 'data-vt-power' ? 'low' : null } };
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	const cnt = k => { count[k] = (count[k] || 0) + 1; };
	REPLIES['luci.vantage wireless'] = () => { cnt('wifi'); return fail ? Promise.reject(new Error('timeout')) : Promise.resolve({ radio0: { source: 'config', config: {}, interfaces: [ { ifname: 'ra0', config: {} }, { ifname: 'ra1', config: {} } ] } }); };
	REPLIES['luci.vantage thermal'] = () => { cnt('thermal'); return Promise.resolve([]); };
	REPLIES['luci.vantage wired'] = () => { cnt('wired'); return Promise.resolve({ hosts: [] }); };
	REPLIES['iwinfo info'] = d => { cnt('iw ' + d); return Promise.resolve({ channel: 36 }); };
	REPLIES['hostapd.ra0 get_status'] = () => Promise.resolve({ bssid: '00:00:5e:00:53:a0' });
	REPLIES['hostapd.ra1 get_status'] = () => Promise.resolve({ bssid: '00:00:5e:00:53:a1' });
	const self = Object.create(view);
	try {
		const first = await self.fetch();
		assert.equal(first.wifi, null, 'no answer is not "no radios"');
		t += 5e3; await self.fetch();
		assert.equal(count.wifi, 2, 'asked again at once, not kept for 30 s');
		fail = false;
		t += 5e3; await self.fetch();
		t += 5e3; await self.fetch();
		assert.equal(count.wifi, 3, 'an answer is kept');
		t += 30e3; await self.fetch();
		t += 30e3; await self.fetch();
		assert.deepEqual([ count['iw ra0'], count['iw ra1'] ], [ 3, 3 ], 'from the config: each interface says whether it is up');
	} finally {
		global.L = saved.L; Date.now = saved.now;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
		for (const k of Object.keys(REPLIES)) if (/^(luci\.vantage (wireless|thermal|wired)|iwinfo info|hostapd\.)/.test(k)) delete REPLIES[k];
	}
});

test('#110: the weak filter leaves quiet stations out, as the card does; the quiet row keeps its error and busy state across rebuilds', async () => {
	const self = Object.create(view);
	self.quiet = { '00:00:5e:00:53:01': true };
	self.ui = { chip: 'weak', filter: '' };
	self.st = { staRates: {} };
	const far = { mac: '00:00:5e:00:53:01', signal: -84, name: 'Far' }, near = { mac: '00:00:5e:00:53:02', signal: -80, name: 'Near' };
	assert.equal(self.isWeak(far), false);
	assert.equal(self.isWeak(near), true);
	assert.equal(self.matches(far), false);
	assert.equal(self.matches(near), true);
	self.canWrite = true;
	self.loadAliases = () => Promise.resolve({});
	let painted = 0;
	self.rehealth = () => { painted++; };
	REPLIES['luci.vantage set_quiet'] = () => Promise.resolve({ ok: false, error: 'too-many' });
	const savedL = global.L;
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).catch(() => d) };
	try {
		const busy = self.saveQuiet(near.mac, true);
		assert.equal(await self.saveQuiet(near.mac, true), false, 'one save at a time');
		await busy;
		assert.equal(painted, 1);
		assert.match(self.quietSaid['00:00:5e:00:53:02'], /already keeps 512/, 'the error waits for the rebuilt row');
		assert.ok(!self.quietBusy['00:00:5e:00:53:02']);
	} finally {
		global.L = savedL;
		delete REPLIES['luci.vantage set_quiet'];
	}
});

test('#110: the quiet row, once shown for a station, stays while its signal crosses the line', () => {
	const self = Object.create(view);
	const shown = [];
	self.quietRow = c => { shown.push(c.signal); return 'row'; };
	const body = c => {
		const quietOn = !!(self.quiet && self.quiet[c.mac]);
		if (quietOn || (c.signal != null && c.signal < insight.WEAK_DBM)) self.quietShown = c.mac;
		return !c.gone && (quietOn || self.quietShown === c.mac) ? self.quietRow(c, quietOn) : '';
	};
	/* the same rule as drawerClient, read from the source */
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.ok(src.includes("if (quietOn || (c.signal != null && c.signal < insight.WEAK_DBM)) this.quietShown = c.mac;"));
	assert.ok(src.includes("var quietRow = !c.gone && (quietOn || this.quietShown === c.mac) ? this.quietRow(c, quietOn) : '';"));
	const insight = load('vantage.insight');
	assert.equal(body({ mac: 'a', signal: -70 }), '', 'never weak: no row');
	assert.equal(body({ mac: 'a', signal: -80 }), 'row');
	assert.equal(body({ mac: 'a', signal: -70 }), 'row', 'kept');
	assert.equal(body({ mac: 'b', signal: -60 }), '', 'another station: its own rule');
});

test('#110: a rebuilt quiet row shows the last attempt\'s error and stays disabled while a save is under way', () => {
	const saved = { E: global.E };
	global.E = (tag, attrs, children) => ({ tag, attrs: attrs || {}, children: [].concat(children == null ? [] : children), addEventListener() {} });
	try {
		const self = Object.create(view);
		self.canWrite = true;
		const mac = '00:00:5e:00:53:02';
		self.quietSaid = { [mac]: 'The device could not write /etc/config/vantage.' };
		self.quietBusy = { [mac]: true };
		const row = self.quietRow({ mac: mac.toUpperCase() }, false);
		const [ box, , err ] = row.children;
		assert.equal(box.disabled, true, 'busy: disabled');
		assert.equal(box.checked, false);
		assert.deepEqual(err.children, [ 'The device could not write /etc/config/vantage.' ]);
		self.canWrite = false;
		assert.equal(self.quietRow({ mac }, false), '', 'no grant, not set: nothing');
	} finally {
		if (saved.E === undefined) delete global.E; else global.E = saved.E;
	}
});

/* luci-rpc getHostHints reads the leases and the ARP table: every 30 s,
   and for the three polls after a station or wired host first appears */
test('host hints: every 30 s, and again for three polls when a station or host is new', async () => {
	let hints = 0, stations = [ { mac: '00:00:5e:00:53:01' } ];
	REPLIES['luci-rpc getHostHints'] = () => { hints++; return Promise.resolve({ '00:00:5e:00:53:01': { name: 'one' } }); };
	REPLIES['luci.vantage wireless'] = () => Promise.resolve({ radio0: { up: true, config: {}, interfaces: [ { ifname: 'wl0', config: { mode: 'ap' } } ] } });
	REPLIES['iwinfo assoclist'] = () => Promise.resolve(stations);
	const self = Object.create(view);
	const savedL = global.L, now = Date.now;
	let t = 1e12;
	Date.now = () => t;
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	const poll = async ms => { t += ms; return self.fetch(); };
	try {
		let r = await poll(0);
		assert.equal(hints, 1);
		r = await poll(5e3);
		assert.equal(hints, 1, 'kept');
		assert.equal(r.hints['00:00:5e:00:53:01'].name, 'one', 'the last reply');
		await poll(25e3);
		assert.equal(hints, 2, 'again after 30 s');
		stations = stations.concat([ { mac: '00:00:5e:00:53:02' } ]);
		await poll(5e3);
		assert.equal(hints, 2, 'the new station is this poll\'s');
		/* a failed call spends none of the three */
		const ok = REPLIES['luci-rpc getHostHints'];
		REPLIES['luci-rpc getHostHints'] = () => { hints++; return Promise.reject(new Error('timeout')); };
		const failed = await poll(5e3);
		assert.equal(failed.hints['00:00:5e:00:53:01'].name, 'one', 'the last reply kept');
		REPLIES['luci-rpc getHostHints'] = ok;
		await poll(5e3); await poll(5e3); await poll(5e3);
		assert.equal(hints, 6, 'then three answered polls in a row');
		await poll(5e3);
		assert.equal(hints, 6, 'and kept again');
	}
	finally {
		global.L = savedL; Date.now = now;
		for (const k of Object.keys(REPLIES)) if (/^(luci-rpc getHostHints|luci\.vantage wireless|iwinfo assoclist)/.test(k)) delete REPLIES[k];
	}
});

/* a pulse CSS cancelled since the last step (the dot's state changed) is
   dropped, not stepped: a time written to it would bring it back, paused,
   with nothing left to stop it (review of 1.0.19) */
test('motion clock: a cancelled pulse is dropped, not stepped', () => {
	const live = { playState: 'paused', currentTime: 0 }, gone = { playState: 'idle', currentTime: null };
	const self = Object.create(view);
	self.clock = { anims: [ { a: live, dur: 1000, at: 0 }, { a: gone, dur: 1000, at: 0 } ] };
	self.wireMap = {};
	const saved = global.window;
	global.window = { dispatchEvent() {} };
	try {
		self.stepMotion(50, 1000);
		assert.equal(live.currentTime, 50);
		assert.equal(gone.currentTime, null, 'not written: it stays cancelled');
		assert.deepEqual(self.clock.anims.map(x => x.a), [ live ]);
	} finally { global.window = saved; }
});

/* ------------------------------------------- paired access points (#127) */

/* a small DOM: elements as LuCI's E() and dom.content() build them, text
   nodes as strings; enough for the path, the list cells and the drawers */
class FNode {
	constructor(tag) {
		this.tag = tag; this.attrs = {}; this.childNodes = []; this.on = {}; this.text = null;
		this.style = { setProperty(k, v) { this[k] = v; } };
		const self = this;
		this.classList = {
			add(c) { const l = (self.attrs.class || '').split(' ').filter(Boolean); if (!l.includes(c)) l.push(c); self.attrs.class = l.join(' '); },
			remove(c) { self.classList.toggle(c, false); },
			toggle(c, on) { const l = (self.attrs.class || '').split(' ').filter(x => x && x !== c); if (on) l.push(c); self.attrs.class = l.join(' '); },
			contains(c) { return (self.attrs.class || '').split(' ').includes(c); }
		};
	}
	get children() { return this.childNodes.filter(n => n instanceof FNode); }
	getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
	setAttribute(k, v) { this.attrs[k] = String(v); }
	appendChild(n) { this.childNodes.push(n); return n; }
	insertBefore(n, ref) { const i = this.childNodes.indexOf(ref); this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n); return n; }
	removeChild(n) { this.childNodes.splice(this.childNodes.indexOf(n), 1); return n; }
	addEventListener(t, f) { this.on[t] = f; }
	get textContent() { return this.text != null ? this.text : this.childNodes.map(n => typeof n === 'string' ? n : n.textContent).join(''); }
	set textContent(v) { this.text = String(v); this.childNodes = []; }
	/* every element below, this one first */
	all() { return [ this ].concat(...this.children.map(c => c.all())); }
	find(cls) { return this.all().filter(n => (n.attrs.class || '').split(' ').includes(cls)); }
	html() {
		const a = Object.keys(this.attrs).sort().map(k => ' ' + k + '=' + JSON.stringify(this.attrs[k])).join('');
		return '<' + this.tag + a + '>' + (this.text != null ? JSON.stringify(this.text) : '') + this.childNodes.map(n => typeof n === 'string' ? JSON.stringify(n) : n.html()).join('') + '</' + this.tag + '>';
	}
}
function append(n, ch) { [].concat(ch).forEach(c => { if (c instanceof FNode) n.appendChild(c); else if (c != null) n.childNodes.push(String(c)); }); }
const fdom = { content(el, ch) { el.childNodes = []; el.text = null; append(el, ch); } };
const dview = loadView(fdom);
function withFakeDom(fn) {
	const saved = { E: global.E, document: global.document, window: global.window };
	global.E = (tag, attrs, children) => {
		const n = new FNode(tag);
		for (const [ k, v ] of Object.entries(attrs || {})) if (typeof v === 'function') n.on[k] = v; else if (v != null) n.setAttribute(k, v);
		if (Array.isArray(children)) append(n, children);
		else if (children != null) n.innerHTML = String(children);
		return n;
	};
	global.document = { createElementNS: (ns, tag) => new FNode(tag) };
	global.window = { matchMedia: () => ({ matches: true }) };
	try { return fn(); }
	finally { Object.assign(global, saved); }
}

const AP_ID = '0123456789abcdef';
/* a router with one Wi-Fi network, two stations, a host on lan2 and one
   behind ap-hall on lan1, and its WAN */
function apModel(collector) {
	const model = load('vantage.model');
	const m = model.build({
		ifaces: [
			{ interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.1', mask: 24 } ], route: [] },
			{ interface: 'wan', up: true, l3_device: 'wan', device: 'wan', 'ipv4-address': [ { address: '203.0.113.2', mask: 24 } ],
				route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.0.2.10' } ] }
		],
		devs: { 'br-lan': { devtype: 'bridge', 'bridge-members': [ 'lan1', 'lan2', 'phy0-ap0' ] }, lan1: { devtype: 'ethernet', carrier: true, speed: '1000F' },
			lan2: { devtype: 'ethernet', carrier: true, speed: '1000F' }, wan: { devtype: 'ethernet', carrier: true, speed: '1000F' }, 'phy0-ap0': { devtype: 'wlan' } },
		wifi: { radio0: { up: true, config: { band: '5g', channel: '36', htmode: 'HE80' }, interfaces: [ { ifname: 'phy0-ap0', config: { ssid: 'Home', mode: 'ap', network: [ 'lan' ] } } ] } },
		assoc: { 'phy0-ap0': [ { mac: '00:00:5E:00:53:01', signal: -50 }, { mac: '00:00:5E:00:53:02', signal: -80 } ] },
		hints: { '00:00:5E:00:53:31': { name: 'printer', ipaddrs: [ '192.0.2.131' ] }, '00:00:5E:00:53:21': { name: 'phone', ipaddrs: [ '192.0.2.121' ] } },
		fdb: [ { mac: '02:00:5e:10:00:01', port: 'lan1', bridge: 'br-lan', seen: 1 }, { mac: '00:00:5e:00:53:31', port: 'lan1', bridge: 'br-lan', seen: 1 },
			{ mac: '00:00:5e:00:53:32', port: 'lan2', bridge: 'br-lan', seen: 1 } ],
		collector
	});
	m.wired = false;
	return m;
}
/* ap-hall at the gateway's address: a branch, never the gateway */
const hall = (extra, report) => Object.assign({ id: AP_ID, name: 'ap-hall', addr: '192.0.2.10', state: 'ok', error: null, age: 3, report: Object.assign({
	name: 'OpenWrt', model: 'Example AP', uptime: 3600, mac: '02:00:5e:10:00:01',
	ssids: [ { ifname: 'phy1-ap0', bssid: '02:00:5e:10:00:11', ssid: 'Hall', freq: 5180, channel: 36, band: '5g' } ],
	stations: [ { mac: '00:00:5e:00:53:21', ifname: 'phy1-ap0', signal: -88, rxRate: 72200, txRate: 144400, rx: 8000, tx: 64000, connected: 60 } ],
	wired: [ { mac: '00:00:5e:00:53:31', port: 'lan2', speed: 1000 }, { mac: '00:00:5e:00:53:41', port: 'lan3', speed: 100, rx: 4000, tx: 9000 } ] }, report) }, extra);

function hero(m) {
	const self = Object.create(dview);
	self.m = m;
	self.st = { devRates: {}, radioRates: {}, ssidRates: {}, staRates: {}, uplinkRate: null };
	self.el = { path: new FNode('div'), wires: new FNode('svg'), flows: new FNode('div') };
	self.el.path.appendChild(self.el.wires);
	self.el.path.appendChild(self.el.flows);
	self.buildHeroNodes(self.heroKey());
	self.updateHero();
	return self;
}

test('paired access points: without one the path has nothing new: no mesh class, no rows, no branch, no wider nodes', () => withFakeDom(() => {
	const self = hero(apModel(null));
	const path = self.el.path;
	assert.equal(path.getAttribute('class'), 'vt-path');
	assert.doesNotMatch(path.html(), /vt-leaf|vt-node-peer|vt-branches-label|vt-path-mesh|vt-path-sib/);
	const ssid = path.find('vt-node-ssid').filter(n => n.textContent.startsWith('Home'))[0];
	assert.equal(ssid.find('vt-node-body')[0].children.length, 2, 'the SSID node: its name and its dots, no rows');
	assert.doesNotMatch(self.heroKey(), /aps=/);
	assert.equal(self.wireList().filter(w => w.elbow).length, 0);
}));

test('paired access points: a branch each with the pairing name and the address as text, rows only under the mesh class; never the gateway or a relabel', () => withFakeDom(() => {
	const self = hero(apModel({ aps: [ hall() ] }));
	const path = self.el.path;
	assert.equal(path.getAttribute('class'), 'vt-path vt-path-mesh', 'a router (WAN uplink): no sibling layout');
	const peer = path.find('vt-node-peer')[0];
	assert.deepEqual(peer.find('vt-node-body')[0].children.map(n => n.textContent), [ 'Access point', 'ap-hall', '192.0.2.10', 'up 1h 0m', '1 client · 2 wired', '↓ 73.0  ↑ 12.0 kbit/s' ]);
	assert.match(peer.getAttribute('title'), /Calls itself OpenWrt\nExample AP\n192\.0\.2\.10/, 'what it calls itself only as a detail');
	assert.ok(!path.all().some(n => n.tag === 'a' && /ap-hall|192\.0\.2\.10/.test(n.html())), 'no link to the access point');
	assert.deepEqual([ self.hero.gwKicker.textContent, self.hero.gwTitle.textContent ], [ 'Internet', '192.0.2.10' ],
		'the gateway node stays the gateway, at the access point\'s address too');
	assert.equal(path.find('vt-node-ap')[0].find('vt-node-kicker')[0].textContent, 'This access point', 'no "This router"');
	/* its SSID: the station's row by this device's name for it */
	const rows = path.find('vt-leaf-row');
	assert.deepEqual(rows.map(r => r.children.map(c => c.textContent)), [
		/* this device's SSID: rows too, with an access point paired */
		[ 'Unknown device 53:01', '', '-50', '', '' ],
		[ 'Unknown device 53:02', '', '-80', '', '' ],
		/* ap-hall's SSID and its wired hosts, the busiest first */
		[ 'phone', '192.0.2.121', '-88', '↓64.0k', '↑8.00k' ],
		[ 'Unknown device 53:41', '', '100 Mbit/s', '↓9.00k', '↑4.00k' ],
		[ 'printer', '192.0.2.131', '1 Gbit/s', '', '' ]
	]);
	assert.match(self.heroKey(), new RegExp('\\naps=' + AP_ID + '=s:phy1-ap0,w$'));
}));

test('paired access points: one not reporting is dimmed with its state, without SSIDs or rows', () => withFakeDom(() => {
	for (const [ extra, text, more ] of [ [ { state: 'waiting', age: null, report: null }, 'Waiting for its first report' ],
		/* offline: why, where the collector says; when it last reported in the tooltip */
		[ { state: 'offline', error: 'unreachable', age: 120, report: null }, 'Not reachable over SSH', 'Offline · last report 2 min ago' ],
		[ { state: 'offline', error: 'timeout', age: null, report: null }, 'Did not answer in time', 'Offline' ],
		[ { state: 'offline', age: 120 }, 'Offline · last report 2 min ago' ], [ { state: 'offline', age: null }, 'Offline' ],
		[ { state: 'error', error: 'hostkey' }, 'Host key changed: pair again' ], [ { state: 'error', error: 'denied' }, 'Refused this device\'s key' ],
		[ { state: 'error', error: 'missing', report: null }, 'Vantage add-on not installed on it', 'Vantage\'s access point add-on is not installed on it' ],
		[ { state: 'error', error: 'unreachable' }, 'Not reachable over SSH' ], [ { state: 'error', error: 'timeout' }, 'Did not answer in time' ],
		[ { state: 'error', error: 'invalid' }, 'Sent a report that could not be read' ] ]) {
		const self = hero(apModel({ aps: [ hall(extra) ] }));
		const peer = self.el.path.find('vt-node-peer')[0];
		assert.match(peer.getAttribute('class'), /vt-node-off/);
		assert.equal(peer.find('vt-node-body')[0].children[4].textContent, text);
		assert.deepEqual(peer.getAttribute('title').split('\n').slice(0, more ? 2 : 1), more ? [ text, more ] : [ text ]);
		assert.equal(peer.find('vt-node-body')[0].children[5].textContent, '', 'no rates');
		const branch = self.el.path.find('vt-branch-peer')[0];
		assert.equal(branch.find('vt-node-ssid').length + branch.find('vt-leaf-row').length, 0, extra.state);
		assert.equal(self.m.clients.filter(c => c.ap).length, 0);
	}
}));

test('paired access points: on an access point their wires come from the gateway, an elbow only where it passes below this device', () => withFakeDom(() => {
	const m = apModel({ aps: [ hall() ] });
	m.uplink = Object.assign({}, m.uplink, { isWan: false });
	const self = hero(m);
	assert.match(self.el.path.getAttribute('class'), /vt-path-sib/);
	const w = self.wireList().filter(x => x.elbow)[0];
	assert.ok(w && w.from === self.hero.gw && w.alt === self.hero.ap);
	const wires = load('vantage.wires');
	const at = { gw: { l: 0, r: 150, t: 50, b: 100, cy: 75 }, ap: { l: 300, r: 480, t: 50, b: 110, cy: 80 } };
	/* the choice drawWires makes, on the rects it measures */
	const pick = to => (to.l > at.gw.r && to.cy > at.ap.b) ? 'elbow' : 'curve';
	assert.equal(pick({ l: 600, r: 800, t: 200, b: 260, cy: 230 }), 'elbow');
	assert.equal(pick({ l: 600, r: 800, t: 50, b: 110, cy: 80 }), 'curve', 'beside the device: it would cross it');
	assert.equal(pick({ l: 34, r: 300, t: 400, b: 460, cy: 430 }), 'curve', 'stacked (a phone)');
	assert.match(wires.elbow(at.gw, { l: 600, t: 200, b: 260, cy: 230 }).d, /^M24\.0 100\.0V220\.0Q/);
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.ok(src.includes('var elbow = !!w.elbow && rect(w.to).l > rect(w.from).r && rect(w.to).cy > rect(w.alt).b;'), 'the same rule as drawWires');
}));

test('paired access points: chips per access point id and one for this device, by what each lists; a host noted behind one is still on its port', () => {
	const self = Object.create(view);
	const m = apModel({ aps: [ hall({}, { stations: [ { mac: '00:00:5e:00:53:21', ifname: 'phy1-ap0', signal: -88 }, { mac: '00:00:5e:00:53:22', ifname: 'phy1-ap0', signal: -60 } ] }),
		hall({ id: 'fedcba9876543210', name: 'ap-den', state: 'offline' }, { mac: '02:00:5e:10:00:02' }) ] });
	self.m = m;
	self.st = { staRates: {}, devRates: {} };
	self.el = { clients: { scrollIntoView() {} }, filter: {} };
	self.paintClients = () => {};
	self.ui = { kind: 'wifi', chip: 'all', filter: '' };
	const defs = () => self.filterDefs().map(d => d.slice(0, 3));
	assert.deepEqual(defs().filter(d => d[0] === 'here' || /^ap:/.test(d[0])), [ [ 'here', 'This device', 2 ], [ 'ap:' + AP_ID, 'Via ap-hall', 2 ] ], 'none for one without stations');
	const ids = list => list.filter(c => self.matches(c)).map(c => c.mac.slice(-2));
	self.ui.chip = 'ap:' + AP_ID;
	assert.deepEqual(ids(m.clients), [ '21', '22' ]);
	self.ui.chip = 'here';
	assert.deepEqual(ids(m.clients), [ '01', '02' ]);
	self.ui.chip = 'all';
	self.ui.filter = 'ap-hall';
	assert.deepEqual(ids(m.clients), [ '21', '22' ], 'found by the access point\'s name');
	self.ui.filter = '192.0.2.10';
	assert.deepEqual(ids(m.clients), [ '21', '22' ], 'and its address');
	self.ui.filter = '';

	self.ui.kind = 'wired';
	assert.deepEqual(defs(), [ [ 'all', 'All', 4 ], [ 'port:lan1', 'lan1', 2 ], [ 'port:lan2', 'lan2', 1 ], [ 'here', 'This device', 3 ], [ 'ap:' + AP_ID, 'Via ap-hall', 2 ] ],
		'the noted host counts on its port and here; the added one on no port');
	self.ui.chip = 'port:lan1';
	assert.deepEqual(ids(m.wiredHosts), [ '01', '31' ]);
	self.ui.chip = 'ap:' + AP_ID;
	assert.deepEqual(ids(m.wiredHosts), [ '31', '41' ], 'added, or heard here behind it');
	assert.deepEqual(self.wiredPorts(), [ 'lan1', 'lan2' ], 'no port for an added host');

	/* the branch opens the list it has entries in */
	const saved = global.window;
	global.window = { matchMedia: () => ({ matches: true }) };
	try {
		self.showAp(AP_ID);
		assert.deepEqual([ self.ui.kind, self.ui.chip ], [ 'wifi', 'ap:' + AP_ID ]);
		self.showAp('fedcba9876543210');
		assert.deepEqual([ self.ui.kind, self.ui.chip ], [ 'wired', 'ap:fedcba9876543210' ]);
	} finally { global.window = saved; }
});

test('paired access points: a host moved from the wired list to an access point\'s station: its branch, the chips and both lists agree', () => withFakeDom(() => {
	/* the printer, heard on lan1 behind ap-hall, is one of its stations */
	const stations = [ { mac: '00:00:5e:00:53:21', ifname: 'phy1-ap0', signal: -60 }, { mac: '00:00:5e:00:53:31', ifname: 'phy1-ap0', signal: -58, rx: 1000, tx: 2000 } ];
	const before = apModel({ aps: [ hall({}, { stations: stations.slice(0, 1) }) ] });
	const m = apModel({ aps: [ hall({}, { stations }) ] });
	assert.deepEqual([ m.clients.length, m.wiredHosts.length ], [ before.clients.length + 1, before.wiredHosts.length - 1 ]);
	const self = hero(m);
	self.ui = { kind: 'wifi', chip: 'all', filter: '' };
	const chip = id => self.filterDefs().filter(d => d[0] === id)[0];
	assert.deepEqual(chip('ap:' + AP_ID).slice(0, 3), [ 'ap:' + AP_ID, 'Via ap-hall', 2 ]);
	assert.deepEqual(chip('all')[2], m.clients.length);
	self.ui.chip = 'ap:' + AP_ID;
	assert.deepEqual(m.clients.filter(c => self.matches(c)).map(c => c.name), [ 'phone', 'printer' ]);
	/* its branch: 2 clients, the printer's row on its SSID by the router's name */
	const peer = self.el.path.find('vt-node-peer')[0];
	assert.equal(peer.find('vt-node-body')[0].children[4].textContent, '2 clients · 1 wired', 'as the chips: the printer is a client now');
	const ssid = self.el.path.find('vt-branch-peer')[0].find('vt-node-ssid')[0];
	assert.deepEqual(ssid.find('vt-leaf-name').map(n => n.textContent), [ 'printer', 'phone' ]);
	assert.equal(ssid.find('vt-node-sub')[0].textContent, '2 clients');
	/* the wired list: lan1 keeps ap-hall itself, the printer is gone from it */
	self.ui = { kind: 'wired', chip: 'all', filter: '' };
	assert.deepEqual(self.filterDefs().map(d => d.slice(0, 3)).filter(d => /^(all|port:|here|ap:)/.test(d[0])),
		[ [ 'all', 'All', 3 ], [ 'port:lan1', 'lan1', 1 ], [ 'port:lan2', 'lan2', 1 ], [ 'here', 'This device', 2 ], [ 'ap:' + AP_ID, 'Via ap-hall', 1 ] ]);
	assert.deepEqual(self.wiredPorts(), [ 'lan1', 'lan2' ]);
	assert.ok(!m.wiredHosts.some(h => h.mac === '00:00:5e:00:53:31'));
}));

/* review F2, F3: a branch shows what the model gave its access point, as
   the lists and the chips do, never what the access point reports */
test('paired access points: a MAC an access point claims that stayed this device\'s, or went to another, is no row or count of its branch', () => withFakeDom(() => {
	const claim = (mac, signal) => ({ mac, ifname: 'phy1-ap0', signal, rxRate: 72200, txRate: 144400, rx: 8000, tx: 64000 });
	/* this device's own station and a host on lan2 (ap-hall is on lan1), with strong signals */
	const m = apModel({ aps: [ hall({}, { stations: [ claim('00:00:5e:00:53:01', -20), claim('00:00:5e:00:53:32', -21), claim('00:00:5e:00:53:21', -60) ],
		wired: [ { mac: '00:00:5e:00:53:32', port: 'lan9', speed: 10, rx: 1, tx: 1 }, { mac: '00:00:5e:00:53:02', port: 'lan9' } ] }) ] });
	const self = hero(m);
	const branch = self.el.path.find('vt-branch-peer')[0], peer = branch.find('vt-node-peer')[0];
	assert.deepEqual(branch.find('vt-leaf-row').map(r => r.children.map(c => c.textContent)), [ [ 'phone', '192.0.2.121', '-60', '↓64.0k', '↑8.00k' ] ]);
	assert.equal(peer.find('vt-node-body')[0].children[4].textContent, '1 client');
	assert.equal(peer.find('vt-node-body')[0].children[5].textContent, '↓ 64.0  ↑ 8 kbit/s', 'its traffic: its one station\'s');
	assert.equal(branch.find('vt-node-ssid').length, 1, 'no wired node: no host is behind it');
	self.ui = { kind: 'wifi', chip: 'all', filter: '' };
	assert.deepEqual(self.filterDefs().filter(d => /^ap:/.test(d[0])).map(d => d.slice(1, 3)), [ [ 'Via ap-hall', 1 ] ], 'the chip agrees');
	assert.doesNotMatch(self.heroKey(), /,w$/);

	/* a station two list: under the one that hears it best, once */
	const two = apModel({ aps: [ hall({}, { stations: [ claim('00:00:5e:00:53:51', -70) ], wired: [] }),
		hall({ id: 'fedcba9876543210', name: 'ap-den' }, { mac: '02:00:5e:10:00:02', stations: [ claim('00:00:5e:00:53:51', -50) ], wired: [] }) ] });
	const both = hero(two);
	const branches = both.el.path.find('vt-branch-peer');
	assert.deepEqual(branches.map(b => b.find('vt-leaf-row').length), [ 0, 1 ]);
	assert.deepEqual(branches.map(b => b.find('vt-node-peer')[0].find('vt-node-body')[0].children[4].textContent), [ '0 clients', '1 client' ]);
	assert.deepEqual(branches.map(b => b.find('vt-node-ssid')[0].find('vt-node-sub')[0].textContent), [ '0 clients', '1 client' ]);
	both.ui = { kind: 'wifi', chip: 'all', filter: '' };
	assert.deepEqual(both.filterDefs().filter(d => /^ap:/.test(d[0])).map(d => d.slice(1, 3)), [ [ 'Via ap-den', 1 ] ]);
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.doesNotMatch(src, /\ba\.(sta|hosts)\b/, 'the view never reads a report\'s own lists');
}));

/* review F4: insight.presence (insight.test.js) needs to know which access
   points are reporting now */
test('paired access points: presence is told which ones report now', () => {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const calls = [ ...src.matchAll(/insight\.presence\(([\s\S]*?)\);\n/g) ].map(m => m[1].replace(/\s+/g, ' '));
	assert.deepEqual(calls, [ "st.presence, m.clients, now, GONE_KEEP_MS, m.accessPoints.filter(function(a) { return a.state === 'ok'; }).map(function(a) { return a.id; })" ]);
});

/* review F5 */
test('paired access points: an SSID node and the wired node never share an id, whatever the interface is called', () => withFakeDom(() => {
	const ssid = ifname => ({ ifname, ssid: 'Hall', freq: 5180, channel: 36, band: '5g' });
	const key = report => Object.assign(Object.create(dview), { m: apModel({ aps: [ hall({}, report) ] }) }).heroKey();
	const two = key({ ssids: [ ssid('x'), ssid('w') ], stations: [], wired: [] });
	const wired = key({ ssids: [ ssid('x') ], stations: [], wired: [ { mac: '00:00:5e:00:53:61', port: 'lan3' } ] });
	assert.deepEqual([ two.split('\n').pop(), wired.split('\n').pop() ], [ 'aps=' + AP_ID + '=s:x,s:w', 'aps=' + AP_ID + '=s:x,w' ]);
	const self = hero(apModel({ aps: [ hall({}, { ssids: [ ssid('w'), ssid(':wired'), ssid('wired') ], stations: [], wired: [ { mac: '00:00:5e:00:53:61', port: 'lan3' } ] }) ] }));
	assert.deepEqual(self.m.accessPoints[0].nodes.map(n => n.id), [ 'w', 'wired' ], 'no interface has a colon in its name');
	const keys = self.wireList().map(w => w.key);
	assert.equal(new Set(keys).size, keys.length, 'one wire a key');
	assert.deepEqual(keys.filter(k => k.includes(':ap:')), [ 'r::ap:' + AP_ID, 's::ap:' + AP_ID + ':s:w', 's::ap:' + AP_ID + ':s:wired', 's::ap:' + AP_ID + ':w' ]);
	assert.deepEqual(self.el.path.find('vt-branch-peer')[0].find('vt-ssid-name').map(n => n.textContent), [ '5 GHz Hall', '5 GHz Hall', 'Wired' ]);
}));

/* review F8 (names): a pairing name has up to 63 characters */
test('paired access points: a long name is cut in the list\'s pill and link cell, whole in their titles', () => withFakeDom(() => {
	const long = 'a' + 'b'.repeat(62);
	const self = Object.create(dview);
	self.m = apModel({ aps: [ hall({ name: long }) ] });
	self.st = { staRates: {}, devRates: {} };
	const added = self.m.wiredHosts.filter(h => h.ap)[0], noted = self.m.wiredHosts.filter(h => h.behind)[0];
	const tree = list => { const n = new FNode('x'); append(n, list); return n; };
	const cells = tree(self.wiredCells(added, 0));
	const pill = cells.find('vt-pill-ap')[0], link = cells.find('vt-phy-ap')[0];
	assert.deepEqual([ pill.textContent, pill.getAttribute('title') ], [ 'via ' + long, 'Wired to ' + long + ', port lan3' ]);
	assert.equal(link.textContent, long + ' · lan3');
	assert.equal(cells.find('vt-td-link')[0].getAttribute('title'), 'Port lan3 of ' + long);
	assert.equal(tree(self.wiredCells(noted, 0)).find('vt-pill-ap')[0].getAttribute('title'), 'Behind ' + long + ', its port lan2');
	const css = fs.readFileSync(path.join(RES, 'vantage/app.css'), 'utf8');
	/* the link cell's line is a flex row elsewhere: a block here, or no ellipsis shows */
	assert.match(css, /\.vt-app \.vt-phy\.vt-phy-ap \{ display: block;/);
	for (const cls of [ 'vt-pill-ap', 'vt-phy.vt-phy-ap', 'vt-net-via' ]) {
		const body = (new RegExp('\\.vt-app \\.' + cls.replace(/\./g, '\\.') + ' \\{([^}]*)\\}').exec(css) || [])[1] || '';
		for (const decl of [ 'max-width: 150px;', 'overflow: hidden;', 'text-overflow: ellipsis;' ]) assert.ok(body.includes(decl), cls + ': ' + decl);
	}
}));

test('paired access points: their stations in no warning, picture or head count, and their rates are theirs', () => withFakeDom(() => {
	const self = Object.create(dview);
	/* its station on 2.4 GHz, this device's on 5 GHz */
	const m = apModel({ aps: [ hall({}, { ssids: [ { ifname: 'phy1-ap0', ssid: 'Hall', freq: 2437, channel: 6, band: '2g' } ] }) ] });
	self.m = m;
	self.quiet = {};
	const remote = m.clients.filter(c => c.ap)[0];
	assert.equal(remote.signal, -88);
	assert.equal(self.isWeak(remote), false);
	assert.equal(self.isWeak(m.clients.filter(c => c.mac === '00:00:5e:00:53:02')[0]), true);
	assert.deepEqual(self.signalPicture()[0].children.map(n => [ n.getAttribute('class'), n.style.width ]), [ [ 'vt-dist-4', '50.00%' ], [ 'vt-dist-1', '50.00%' ] ]);
	assert.deepEqual(self.bandPicture()[0].children.map(n => [ n.getAttribute('class'), n.style.width ]), [ [ 'vt-chip-band vt-band-5g', '100.00%' ] ], 'no 2.4 GHz of the access point\'s');
	self.st = { summary: { level: 'ok', headline: 'x' } };
	self.el = { orb: {}, headline: new FNode('div'), subline: new FNode('div') };
	self.board = {};
	global.document.documentElement = { setAttribute() {} };
	self.paintHead();
	assert.match(self.el.subline.textContent, /2 clients$/, 'this device\'s two, not the access point\'s');
}));

test('paired access points: the list and the drawers show the address as text and link to no other host', t => withFakeDom(() => {
	const savedL = global.L;
	global.L = { url: (...p) => '/cgi-bin/luci/' + p.join('/') };
	t.after(() => { global.L = savedL; });
	const self = Object.create(dview);
	const m = apModel({ aps: [ hall() ] });
	self.m = m;
	self.st = { staRates: { '00:00:5e:00:53:21': { rx: 8000, tx: 64000 } }, devRates: {}, clientHist: {}, gone: [] };
	self.ui = {};
	self.el = {};
	self.quiet = {};
	self.canWrite = false;
	const remote = m.clients.filter(c => c.ap)[0];
	const added = m.wiredHosts.filter(h => h.ap)[0], noted = m.wiredHosts.filter(h => h.behind)[0];
	const tree = list => { const n = new FNode('x'); append(n, list); return n; };
	const client = tree(self.drawerClient(remote.mac).body);
	assert.match(client.textContent, /Connected to ap-hall, a paired access point/);
	assert.match(client.textContent, /Access pointap-hall192\.0\.2\.10/);
	assert.match(client.textContent, /To device144 Mbit\/sFrom device72\.2 Mbit\/s/);
	assert.doesNotMatch(client.html(), /vt-quiet/, 'no quiet row: it is in no warning');
	const wired = tree(self.drawerWired(added).body);
	assert.match(wired.textContent, /Access pointap-hall192\.0\.2\.10Portlan3/);
	const local = tree(self.drawerWired(noted).body);
	assert.match(local.textContent, /Portlan1/, 'heard here: its own port');
	assert.match(local.textContent, /Access pointap-hallits port lan2/);
	assert.ok(local.all().some(n => n.tag === 'a'), 'this device\'s own page link stays');
	for (const t of [ client, wired, tree(self.clientCells(remote, 0)), tree(self.wiredCells(added, 0)) ])
		assert.ok(!t.all().some(n => n.tag === 'a'), 'no link on a paired access point\'s entry');
	const cells = tree(self.wiredCells(noted, 0));
	assert.ok(cells.find('vt-pill').some(p => p.textContent === 'behind ap-hall' && p.getAttribute('title') === 'Behind ap-hall, its port lan2'));
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.doesNotMatch(src, /\.(hostname|host|port|protocol|pathname)\s*=[^=]|target': '_blank'/, 'no address put into a link');
}));

/* the model keeps the other access points that list an entry on it (ap.also,
   behind.also): named in the entry's details, nowhere else */
test('paired access points: an entry another one reports too names it in its details only: one line, as text, not in the list or on the path', t => withFakeDom(() => {
	const savedL = global.L;
	global.L = { url: (...p) => '/cgi-bin/luci/' + p.join('/') };
	t.after(() => { global.L = savedL; });
	const DEN_ID = 'fedcba9876543210', DEN = { id: DEN_ID, name: 'ap-den' };
	/* ap-den hears ap-hall's station too, weaker, and lists the same wired host */
	const den = hall({ id: DEN_ID, name: 'ap-den', addr: '192.0.2.11' }, { mac: '02:00:5e:10:00:02',
		ssids: [ { ifname: 'phy0-ap0', bssid: '00:00:5e:00:53:b0', ssid: 'Den', freq: 2437, channel: 6, band: '2g' } ],
		stations: [ { mac: '00:00:5e:00:53:21', ifname: 'phy0-ap0', signal: -95 } ], wired: [ { mac: '00:00:5e:00:53:41', port: 'lan9', speed: 10 } ] });
	const tree = list => { const n = new FNode('x'); append(n, list); return n; };
	const page = m => Object.assign(Object.create(dview), { m, st: { staRates: {}, devRates: {}, clientHist: {}, gone: [] }, ui: {}, el: {}, quiet: {}, canWrite: false });
	const parts = m => ({ remote: m.clients.filter(c => c.ap)[0], added: m.wiredHosts.filter(h => h.ap)[0], noted: m.wiredHosts.filter(h => h.behind)[0] });
	const drawers = (self, e) => [ tree(self.drawerClient(e.remote.mac).body), tree(self.drawerWired(e.added).body), tree(self.drawerWired(e.noted).body) ];
	const lines = n => n.all().filter(s => s.tag === 'small' && /^Also reported by /.test(s.textContent));
	const rows = (self, e) => [ tree(self.clientCells(e.remote, 0)).html(), tree(self.wiredCells(e.added, 0)).html(), tree(self.wiredCells(e.noted, 0)).html() ];

	/* one access point: no line anywhere */
	const one = apModel({ aps: [ hall() ] });
	for (const d of drawers(page(one), parts(one))) assert.doesNotMatch(d.textContent, /Also reported/);

	const m = apModel({ aps: [ hall(), den ] }), e = parts(m), self = page(m);
	assert.deepEqual([ e.remote.ap.name, e.remote.ap.also, e.added.ap.name, e.added.ap.also ], [ 'ap-hall', [ DEN ], 'ap-hall', [ DEN ] ], 'placed as with one, the other kept by the model');
	/* a host of this device noted as behind ap-hall: the model's field for another that lists it there (tests/model.test.js) */
	e.noted.behind.also = [ DEN ];
	const [ client, wired, local ] = drawers(self, e);
	assert.match(client.textContent, /Access pointap-hall192\.0\.2\.10Also reported by ap-denBSSID/, 'under the access point it is on');
	assert.match(wired.textContent, /Access pointap-hall192\.0\.2\.10Also reported by ap-denPortlan3/);
	assert.match(local.textContent, /Access pointap-hallits port lan2Also reported by ap-den/);
	for (const d of [ client, wired, local ]) {
		assert.deepEqual(lines(d).map(s => s.childNodes), [ [ 'Also reported by ap-den' ] ], 'one line, a text node');
		assert.equal(d.textContent.split('Also reported').length, 2, 'once');
	}
	/* several: their names in the model's order, joined; a name is text whatever it holds */
	e.remote.ap.also = [ DEN, { id: '1111111111111111', name: 'ap-loft' }, { id: '2222222222222222', name: '<b>attic</b>' } ];
	const many = tree(self.drawerClient(e.remote.mac).body);
	assert.deepEqual(lines(many).map(s => s.childNodes), [ [ 'Also reported by ap-den, ap-loft, <b>attic</b>' ] ]);
	assert.ok(!many.all().some(n => n.tag === 'b'), 'no element made of a name');
	/* an empty or broken field: no line */
	for (const junk of [ [], null, 'ap-den', {} ]) {
		e.remote.ap.also = junk;
		assert.deepEqual(lines(tree(self.drawerClient(e.remote.mac).body)), [], JSON.stringify(junk));
	}

	/* the list rows and the path are as without the field */
	e.remote.ap.also = [ DEN ];
	const withAlso = rows(self, e), path = hero(m).el.path.html();
	for (const r of withAlso.concat([ path ])) assert.doesNotMatch(r, /Also reported/);
	delete e.remote.ap.also; delete e.added.ap.also; delete e.noted.behind.also;
	assert.deepEqual(rows(self, e), withAlso, 'the rows');
	assert.equal(hero(m).el.path.html(), path, 'the path');
}));

test('paired access points: the report rides the slow poll; a failed call is none, never the last answer', async () => {
	const saved = { L: global.L, document: global.document, now: Date.now };
	let t = 1e12, reply = { aps: [ { id: AP_ID } ] }, low = false, asked = 0;
	Date.now = () => t;
	global.document = { hidden: false, documentElement: { getAttribute: k => k === 'data-vt-power' ? (low ? 'low' : null) : null } };
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	REPLIES['luci.vantage wireless'] = () => Promise.resolve({});
	REPLIES['luci.vantage thermal'] = () => Promise.resolve([]);
	REPLIES['luci.vantage wired'] = () => Promise.resolve({ hosts: [] });
	REPLIES['vantage.collector report'] = () => { asked++; return reply ? Promise.resolve(reply) : Promise.reject(new Error('XHR request timed out')); };
	REPLIES['session access'] = (scope, object, fn) => Promise.resolve(scope === 'access-group' && object === 'luci-app-vantage-aps-view' && fn === 'read');
	const self = Object.create(view);
	try {
		assert.deepEqual((await self.fetch()).collector, reply);
		reply = null;
		t += 5e3;
		assert.equal((await self.fetch()).collector, null, 'failed: no access points, not the last answer');
		reply = { aps: [] };
		low = true;
		t += 30e3;
		const a = await self.fetch();
		t += 5e3;
		const b = await self.fetch();
		assert.deepEqual([ a.collector, b.collector, asked ], [ reply, reply, 3 ], 'Low-power router: once a slow poll, kept until the next');
		reply = null;
		t += 30e3;
		assert.equal((await self.fetch()).collector, null);
		t += 5e3;
		assert.equal((await self.fetch()).collector, null, 'and none until the next slow poll answers');
		for (const junk of [ 'x', [ 1 ] ]) {
			reply = junk; low = false; t += 5e3;
			assert.equal((await self.fetch()).collector, null, JSON.stringify(junk));
		}
	} finally {
		global.L = saved.L; Date.now = saved.now;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
		for (const k of Object.keys(REPLIES)) if (/^(luci\.vantage (wireless|thermal|wired)|vantage\.collector|session access)/.test(k)) delete REPLIES[k];
	}
});

/* The add-on's call must not be able to hold up the dashboard. fetch() with
   the test's timers and clock: nothing here waits for real */
async function collectorPolls(fn) {
	const saved = { L: global.L, document: global.document, now: Date.now, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
	const c = { t: 1e12, timers: [], seq: 0, asked: 0, calls: [], assoc: 0, answer: null, may: true, probed: 0 };
	Date.now = () => c.t;
	global.setTimeout = (f, ms) => { const id = ++c.seq; c.timers.push({ id, f, at: c.t + ms }); return id; };
	global.clearTimeout = id => { c.timers = c.timers.filter(x => x.id !== id); };
	/* promise callbacks run, then the timers that are due ms later, then promise callbacks again */
	c.flush = () => new Promise(r => setImmediate(r));
	c.advance = async ms => {
		await c.flush();
		c.t += ms;
		for (const x of c.timers.filter(x => x.at <= c.t)) { c.timers = c.timers.filter(y => y !== x); x.f(); }
		await c.flush();
	};
	global.document = { hidden: false, documentElement: { getAttribute: () => null } };
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	REPLIES['luci.vantage wireless'] = () => Promise.resolve({ radio0: { up: true, config: { band: '5g' }, interfaces: [ { ifname: 'phy0-ap0', section: 'a', config: { mode: 'ap', ssid: 'Home' } } ] } });
	REPLIES['luci.vantage thermal'] = () => Promise.resolve([]);
	REPLIES['luci.vantage wired'] = () => Promise.resolve({ hosts: [ { mac: '00:00:5e:00:53:31', port: 'lan1', bridge: 'br-lan', seen: 1 } ] });
	REPLIES['iwinfo assoclist'] = () => { c.assoc++; return Promise.resolve([ { mac: '00:00:5E:00:53:01', signal: -50 } ]); };
	/* c.answer: a reply for a call that answers at once; null for one that stays out until the test settles it (c.calls) */
	REPLIES['vantage.collector report'] = () => {
		c.asked++;
		return c.answer ? c.answer() : new Promise((resolve, reject) => { c.calls.push({ resolve, reject }); });
	};
	/* c.may: whether the login has the add-on's read group (rpcd answers false for a group that is not there) */
	REPLIES['session access'] = (scope, object, fn) => { c.probed++; return Promise.resolve(scope === 'access-group' && object === 'luci-app-vantage-aps-view' && fn === 'read' && c.may); };
	c.self = Object.create(view);
	/* a poll started now: [ its result once it has one, else null ] */
	c.poll = () => { const box = [ null ]; c.self.fetch().then(r => { box[0] = r; }, e => { box[0] = e; }); return box; };
	try { await fn(c); }
	finally {
		Object.assign(global, { L: saved.L, setTimeout: saved.setTimeout, clearTimeout: saved.clearTimeout });
		Date.now = saved.now;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
		for (const k of Object.keys(REPLIES)) if (/^(luci\.vantage (wireless|thermal|wired)|vantage\.collector|iwinfo assoclist|session access)/.test(k)) delete REPLIES[k];
	}
}

test('paired access points: the collector\'s call is a request of its own, and a poll waits 4 s for it at most', () => collectorPolls(async c => {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	/* LuCI sends the calls of one moment as one request and answers them together, unless one says nobatch */
	const alone = [ ...src.matchAll(/rpc\.declare\(\{ object: '([^']+)', method: '([^']+)'[^\n]*\bnobatch: true[^\n]*\}\)/g) ].map(m => m[1] + ' ' + m[2]);
	assert.deepEqual(alone, [ 'vantage.collector report' ]);

	/* it does not answer: the device's own calls are made and answered as always */
	const first = c.poll();
	await c.advance(0);
	assert.deepEqual([ c.asked, c.assoc, c.timers.length ], [ 1, 1, 1 ], 'asked once; the stations asked for meanwhile; one deadline');
	assert.equal(first[0], null, 'the poll waits');
	await c.advance(3999);
	assert.equal(first[0], null, 'up to the deadline');
	await c.advance(1);
	assert.ok(first[0] && !(first[0] instanceof Error), 'and then goes on');
	assert.deepEqual([ first[0].fdb.map(h => h.mac), first[0].assoc['phy0-ap0'].length, first[0].collector ], [ [ '00:00:5e:00:53:31' ], 1, null ],
		'with the poll\'s other data, and the access points it had: none');
	assert.deepEqual([ first[0].started, first[0].at ], [ 1e12, 1e12 ], 'stamped when the device answered, not when the wait ended');
	assert.equal(c.timers.length, 0);
}));

/* The dashboard without the add-on (every user of 1.0.x), and a login that has the dashboard alone: the add-on's
   read group is not theirs, and rpcd says so once */
test('paired access points: a login without the add-on\'s read group never calls the collector, and is asked about the group once', () => collectorPolls(async c => {
	c.may = false;
	c.answer = () => Promise.resolve({ aps: [ { id: AP_ID } ] });
	for (let i = 0; i < 30; i++) {
		const p = c.poll();
		await c.advance(0);
		assert.deepEqual([ p[0] && p[0].collector, c.asked, c.timers.length ], [ null, 0, 0 ], 'poll ' + i);
		await c.advance(5e3);
	}
	assert.equal(c.probed, 1, 'one question about the group for the whole page');
}));

test('paired access points: where no collector answers (nothing paired), it is asked again once a minute, not every poll', () => collectorPolls(async c => {
	const reply = { aps: [ { id: AP_ID } ] };
	c.answer = () => Promise.reject(new Error('RPC call to vantage.collector/report failed with error -32000: Object not found'));
	for (let i = 0; i < 12; i++) {
		const p = c.poll();
		await c.advance(0);
		assert.deepEqual([ p[0] && p[0].collector, c.asked ], [ null, 1 ], 'poll ' + i + ': not asked again');
		await c.advance(5e3);
	}
	/* a minute after that answer: again, and an access point paired meanwhile is there */
	c.answer = () => Promise.resolve(reply);
	const p = c.poll();
	await c.advance(0);
	assert.deepEqual([ p[0].collector, c.asked ], [ reply, 2 ]);
	/* any other failure (a timeout, a refusal) is asked again at the next poll, as before */
	for (const text of [ 'XHR request timed out', 'RPC call to vantage.collector/report failed with error -32002: Access denied' ]) {
		c.answer = () => Promise.reject(new Error(text));
		await c.advance(5e3);
		c.poll();
		await c.advance(0);
		const asked = c.asked;
		c.answer = () => Promise.resolve(reply);
		await c.advance(5e3);
		const q = c.poll();
		await c.advance(0);
		assert.deepEqual([ q[0].collector, c.asked ], [ reply, asked + 1 ], text);
	}
}));

test('paired access points: an answer from before a pause is not shown as this poll\'s', () => collectorPolls(async c => {
	const reply = { aps: [ { id: AP_ID } ] }, newer = { aps: [ { id: AP_ID, name: 'ap-hall' } ] };
	c.answer = () => Promise.resolve(reply);
	const ok = c.poll();
	await c.advance(0);
	assert.deepEqual(ok[0].collector, reply);
	/* the tab was hidden for ten minutes; the first call after it stays out past the deadline */
	c.answer = null;
	await c.advance(600e3);
	const back = c.poll();
	await c.advance(4e3);
	assert.deepEqual([ back[0] && back[0].collector, c.asked ], [ null, 2 ], 'no access points rather than those of ten minutes ago');
	/* its answer, late, is the next poll's */
	c.calls.shift().resolve(newer);
	c.answer = () => Promise.resolve(newer);
	await c.advance(5e3);
	const next = c.poll();
	await c.advance(0);
	assert.deepEqual(next[0].collector, newer);
}));

test('paired access points: while the collector\'s call is out no second one is made and no later poll waits; its late answer is the next poll\'s', () => collectorPolls(async c => {
	const reply = { aps: [ { id: AP_ID } ] }, newer = { aps: [ { id: AP_ID, name: 'ap-hall' } ] };
	/* an answer in time, as before */
	c.answer = () => Promise.resolve(reply);
	const ok = c.poll();
	await c.advance(0);
	assert.deepEqual([ ok[0].collector, c.asked, c.timers.length ], [ reply, 1, 0 ], 'no waiting, and no deadline left behind');
	/* the next call does not answer: the poll goes on with the answer it had */
	c.answer = null;
	await c.advance(5e3);
	const late = c.poll();
	await c.advance(4e3);
	assert.ok(late[0], 'the poll is over at the deadline');
	assert.deepEqual([ late[0].collector, c.asked ], [ reply, 2 ]);
	/* the polls after it: no second call beside the one that is out, and no wait. The answer it had stands for two
	   slow polls and the wait; older than that it says nothing of now, and no access points are shown */
	for (let i = 0; i < 3; i++) {
		await c.advance(5e3);
		const p = c.poll();
		await c.advance(0);
		assert.deepEqual([ p[0] && p[0].collector, c.asked, c.calls.length, c.timers.length ], [ i === 0 ? reply : null, 2, 1, 0 ], 'poll ' + i);
	}
	/* it answers after all: the next poll has that answer, and asks again */
	c.calls.shift().resolve(newer);
	await c.advance(5e3);
	const next = c.poll();
	await c.advance(0);
	assert.deepEqual([ next[0], c.asked, c.calls.length ], [ null, 3, 1 ], 'a new call, out again');
	await c.advance(4e3);
	assert.deepEqual(next[0] && next[0].collector, newer);
	/* Low-power router, between two slow polls: the late answer is not kept back for the next slow one */
	c.answer = () => Promise.resolve(newer);
	c.calls.shift().resolve(newer);
	global.document.documentElement.getAttribute = k => k === 'data-vt-power' ? 'low' : null;
	await c.advance(30e3);
	const slow = c.poll();
	await c.advance(0);
	assert.deepEqual([ slow[0].collector, c.asked ], [ newer, 4 ]);
	c.answer = null;
	await c.advance(30e3);
	const out = c.poll();
	await c.advance(4e3);
	assert.deepEqual([ out[0] && out[0].collector, c.asked ], [ newer, 5 ]);
	c.calls.shift().resolve(reply);
	await c.advance(5e3);
	const between = c.poll();
	await c.advance(0);
	assert.deepEqual([ between[0].collector, c.asked ], [ reply, 5 ], 'no call of its own, the answer that came in');
}));

test('paired access points: a failed collector call shows nothing, in time or late: no access points, no error, never the last answer', () => collectorPolls(async c => {
	const model = load('vantage.model'), reply = { aps: [ { id: AP_ID, name: 'ap-hall', addr: '192.0.2.10', state: 'waiting', error: null, age: null, report: null } ] };
	/* no such object (the add-on not installed, nothing paired), the login may not read it, no answer in LuCI's time */
	const failures = [ 'RPC call to vantage.collector/report failed with error -32000: Object not found',
		'RPC call to vantage.collector/report failed with error -32002: Access denied', 'XHR request timed out' ];
	const shown = r => model.build({ ifaces: r.ifaces, devs: r.devs, fdb: r.fdb, collector: r.collector }).accessPoints.map(a => a.name);
	for (const text of failures) {
		c.answer = () => Promise.resolve(reply);
		await c.advance(5e3);
		const had = c.poll();
		await c.advance(0);
		assert.deepEqual(shown(had[0]), [ 'ap-hall' ], 'the control');
		/* refused at once */
		c.answer = () => Promise.reject(new Error(text));
		await c.advance(5e3);
		const p = c.poll();
		await c.advance(0);
		assert.ok(p[0] && !(p[0] instanceof Error), text + ': the poll itself does not fail');
		assert.deepEqual([ p[0].collector, shown(p[0]), c.timers.length ], [ null, [], 0 ], text);
		assert.deepEqual(model.build({ ifaces: p[0].ifaces, devs: p[0].devs, fdb: p[0].fdb, collector: p[0].collector }),
			model.build({ ifaces: p[0].ifaces, devs: p[0].devs, fdb: p[0].fdb }), text + ': as without the add-on');
		/* refused after the deadline: the poll that waited keeps what it had, the next one has none */
		c.answer = () => Promise.resolve(reply);
		await c.advance(60e3);
		c.poll();
		await c.advance(0);
		c.answer = null;
		await c.advance(5e3);
		const waited = c.poll();
		await c.advance(4e3);
		assert.ok(waited[0], text + ': the poll is over at the deadline');
		assert.deepEqual(shown(waited[0]), [ 'ap-hall' ], text + ': still out');
		c.calls.shift().reject(new Error(text));
		c.answer = () => new Promise(() => {});
		await c.advance(5e3);
		const after = c.poll();
		await c.advance(4e3);
		assert.ok(after[0], text + ': and the one after it');
		assert.deepEqual([ after[0].collector, shown(after[0]) ], [ null, [] ], text + ': late');
		/* that last call never settles: the next round starts as if it had */
		c.self.collectorCall = null;
		await c.advance(60e3);
	}
	/* an answer that is no report (LuCI gives {} for a ubus status without data) names none either */
	for (const junk of [ {}, 'x', [ 1 ], 7 ]) {
		c.answer = () => Promise.resolve(junk);
		await c.advance(5e3);
		const p = c.poll();
		await c.advance(0);
		assert.deepEqual(shown(p[0]), [], JSON.stringify(junk));
	}
}));
