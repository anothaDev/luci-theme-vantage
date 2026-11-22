'use strict';
/* Provider tiles (#129): tiles another package fills with data through
   its own ubus object, vantage.tile.<id> status, granted by its own ACL
   group. The data contract (model.tile), the layout's room for them
   (vantage.layout), what the view asks and when (askTiles), what it
   draws (paintTile), and the example provider in dev/replay/tiles, run
   for real when $UCODE (or ucode on PATH) is there. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { load, RES } = require('./luci-stub');
const mkTmp = require('./tmpdir');
const tiles = require('../dev/replay/tiles');

const model = load('vantage.model');
const layout = load('vantage.layout');
const ROOT = path.join(__dirname, '..');
const VIEW_SRC = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');

/* ---------------------------------------------------------- the view */

const REPLIES = {};
const UI = {};
const POLL = { on: true, active() { return this.on; } };

class FNode {
	constructor(tag) {
		this.tag = tag; this.attrs = {}; this.childNodes = []; this.on = {}; this.text = null; this.style = {};
		const self = this;
		this.classList = {
			add(c) { const l = (self.attrs.class || '').split(' ').filter(Boolean); if (!l.includes(c)) l.push(c); self.attrs.class = l.join(' '); },
			toggle(c, on) { const l = (self.attrs.class || '').split(' ').filter(x => x && x !== c); if (on) l.push(c); self.attrs.class = l.join(' '); },
			contains(c) { return (self.attrs.class || '').split(' ').includes(c); }
		};
	}
	get nodeType() { return 1; }
	get tagName() { return this.tag.toUpperCase(); }
	get children() { return this.childNodes.filter(n => n instanceof FNode); }
	get firstChild() { return this.childNodes[0] || null; }
	get parentNode() { return this.parent || null; }
	getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
	getAttributeNames() { return Object.keys(this.attrs); }
	setAttribute(k, v) { this.attrs[k] = String(v); }
	appendChild(n) { this.childNodes.push(n); if (n instanceof FNode) n.parent = this; return n; }
	removeChild(n) { this.childNodes.splice(this.childNodes.indexOf(n), 1); return n; }
	replaceChild(n, o) { this.childNodes[this.childNodes.indexOf(o)] = n; if (n instanceof FNode) n.parent = this; return o; }
	addEventListener(t, f) { this.on[t] = f; }
	get textContent() { return this.text != null ? this.text : this.childNodes.map(n => n instanceof FNode ? n.textContent : n.data).join(''); }
	all() { return [ this ].concat(...this.children.map(c => c.all())); }
	find(cls) { return this.all().filter(n => (n.attrs.class || '').split(' ').includes(cls)); }
}
const text = s => ({ nodeType: 3, data: String(s) });

function withDom(fn) {
	const saved = { E: global.E, document: global.document, L: global.L };
	global.E = (tag, attrs, children) => {
		const n = new FNode(tag);
		for (const [ k, v ] of Object.entries(attrs || {})) if (typeof v === 'function') n.on[k] = v; else if (v != null) n.setAttribute(k, v);
		if (!Array.isArray(children)) { if (children != null) n.innerHTML = String(children); return n; }
		for (const c of children) if (c instanceof FNode) n.appendChild(c); else if (c != null && c !== '') n.childNodes.push(text(c));
		return n;
	};
	global.document = { createElementNS: (ns, tag) => new FNode(tag), createTextNode: text };
	global.L = { url: (...p) => '/cgi-bin/luci/' + p.join('/'), resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	try { return fn(); }
	finally { for (const k of Object.keys(saved)) if (saved[k] === undefined) delete global[k]; else global[k] = saved[k]; }
}

function loadView() {
	const stubs = {
		view: { extend: p => p },
		rpc: { declare: o => function(...args) { const f = REPLIES[o.object + ' ' + o.method]; return f ? f(o, ...args) : Promise.resolve(null); } },
		poll: POLL, ui: UI, dom: {}
	};
	const params = [], values = [];
	for (const m of VIEW_SRC.matchAll(/^'require ([\w.-]+)(?: as (\w+))?';$/gm)) {
		params.push(m[2] || m[1]);
		values.push(Object.prototype.hasOwnProperty.call(stubs, m[1]) ? stubs[m[1]] : load(m[1]));
	}
	return new Function(...params, VIEW_SRC)(...values);
}
const view = loadView();

/* an ACL dump as rpcd answers session access without an object */
const dump = ubus => ({ 'access-group': { 'luci-app-vantage': [ 'read' ] }, ubus: Object.assign({ 'system': [ 'board', 'info' ], 'session': [ 'access', 'login' ] }, ubus) });
const DNS = () => tiles.dnsStatus({ dns_local_answered: 850, dns_queries_forwarded: 150, dns_unanswered: 2 });
const GONE = 'RPC call to vantage.tile.dns/status failed with error -32000: Object not found';

/* fetch()'s provider part with rpc stubbed. c.acl: the session's ACL;
   c.answer[id](): a provider's answer; c.took: how long the next one
   takes; c.poll(ms): askTiles ms later. c.calls: what was asked, in order */
async function tilePolls(fn) {
	const saved = { L: global.L, now: Date.now, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
	const c = { t: 1e12, acl: dump({}), took: 0, calls: [], answer: {}, timers: [] };
	Date.now = () => c.t;
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	/* the poll's deadline: run by hand (c.deadline()), not by the clock */
	global.setTimeout = (f, ms) => { c.timers.push({ f, ms }); return c.timers.length; };
	global.clearTimeout = () => {};
	REPLIES['session access'] = (o, ...args) => {
		c.calls.push([ 'acl', o.params || null, args ]);
		return Promise.resolve(args.length ? true : c.acl);
	};
	for (const id of [ 'dns', 'modem', 'abc', 'zzz' ]) REPLIES['vantage.tile.' + id + ' status'] = (o, ...args) => {
		c.calls.push([ id, args, o.nobatch === true, o.reject === true, o.params || null ]);
		c.t += c.took; c.took = 0;
		return c.answer[id] ? c.answer[id]() : Promise.reject(new Error(GONE));
	};
	c.fresh = () => { c.self = Object.create(view); };
	c.fresh();
	/* as plain objects: the view's have no prototype */
	c.poll = async ms => { c.t += ms || 0; return JSON.parse(JSON.stringify(await c.self.askTiles())); };
	c.asked = id => c.calls.filter(x => x[0] === id).length;
	try { await fn(c); }
	finally {
		Object.assign(global, { L: saved.L, setTimeout: saved.setTimeout, clearTimeout: saved.clearTimeout });
		Date.now = saved.now;
		for (const k of Object.keys(REPLIES)) delete REPLIES[k];
	}
}

/* ----------------------------------------------------- data contract */

test('contract: an answer of version 1 with a title, read field by field; text made safe', () => {
	const d = model.tile(DNS());
	assert.deepEqual(d, {
		title: 'DNS', icon: 'globe', state: 'ok', note: 'dnsmasq, since it started', every: 10, page: [ 'admin', 'network', 'dhcp' ],
		items: [
			{ label: 'Queries', value: 1000, text: null, unit: '', rate: true, max: null, level: null, trend: true },
			{ label: 'Forwarded', value: 150, text: null, unit: '', rate: true, max: null, level: null, trend: false },
			{ label: 'From cache', value: 85, text: null, unit: '%', rate: false, max: 100, level: null, trend: false },
			{ label: 'Unanswered', value: 2, text: null, unit: '', rate: false, max: null, level: null, trend: false }
		]
	});
	/* no answer, another version, no title: none */
	for (const r of [ null, undefined, 'x', 7, [], {}, { v: 2, title: 'DNS' }, { v: '1', title: 'DNS' }, { v: 1 }, { v: 1, title: '   ' }, { v: 1, title: 7 } ])
		assert.equal(model.tile(r), null, JSON.stringify(r));
	/* a key it does not know is no harm: a later version may add one */
	assert.equal(model.tile({ v: 1, title: 'T', colour: 'red', html: '<b>x</b>', items: [ { label: 'a', value: 1, onclick: 'x' } ] }).items.length, 1);
	/* text: control and reordering characters marked, cut to its length */
	const t = model.tile({ v: 1, title: 'a‮b\u0000c' + 'x'.repeat(60), note: '<img src=x onerror=alert(1)>', items: [ { label: 'L​', text: 'y'.repeat(80) } ] });
	assert.equal(t.title, 'a�b�c' + 'x'.repeat(26) + '…');
	assert.equal(Array.from(t.title).length, 32);
	assert.equal(t.note, '<img src=x onerror=alert(1)>', 'kept as text: the page writes it as a text node');
	assert.deepEqual([ t.items[0].label, Array.from(t.items[0].text).length ], [ 'L�', 48 ]);
});

test('contract: items of the form only, at most eight, one a label; units, rates, meters and levels from fixed lists', () => {
	const it = x => model.tile({ v: 1, title: 'T', items: [ x ] }).items[0] || null;
	assert.equal(it({ label: 'a' }), null, 'neither value nor text');
	assert.equal(it({ value: 1 }), null, 'no label');
	assert.equal(it({ label: 'a', value: 1, unit: 'px' }), null, 'a unit of its own');
	assert.equal(it({ label: 'a', value: 1, unit: 'kbit/s' }), null);
	assert.equal(it({ label: 'a', value: 1e15 }), null, 'past what any counter holds');
	assert.equal(it({ label: 'a', value: '12' }), null, 'a number is a number');
	assert.equal(it({ label: 'a', value: NaN }), null);
	assert.equal(it({ label: 'a', value: -1, rate: true }), null, 'a counter is never below zero');
	assert.equal(it({ label: 'a', value: 1, rate: true, unit: '%' }), null, 'a rate of a count or of bytes only');
	assert.equal(it({ label: 'a', text: 'x', rate: true }), null);
	assert.deepEqual(it({ label: 'a', value: 1, rate: true, unit: 'B', max: 10 }), { label: 'a', value: 1, text: null, unit: 'B', rate: true, max: null, level: null, trend: false }, 'no meter on a rate');
	assert.deepEqual(it({ label: 'a', value: 1, max: -5, level: 'crit', trend: 'yes' }), { label: 'a', value: 1, text: null, unit: '', rate: false, max: null, level: null, trend: false });
	assert.deepEqual(it({ label: 'a', text: 'B3', unit: 'dBm', trend: true, level: 'warn' }), { label: 'a', value: null, text: 'B3', unit: '', rate: false, max: null, level: 'warn', trend: false }, 'a text has no unit and no trend');
	for (const u of [ '', '%', 'ms', 's', 'dBm', 'dB', 'MHz', 'B', 'bit/s' ]) assert.equal(it({ label: 'a', value: 1, unit: u }).unit, u, u);
	const many = model.tile({ v: 1, title: 'T', items: Array.from({ length: 50 }, (_, i) => ({ label: 'n' + (i % 12), value: i })).concat([ 'x', null, [ 1 ] ]) }).items;
	assert.deepEqual(many.map(x => x.label), [ 'n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7' ]);
	assert.deepEqual(model.tile({ v: 1, title: 'T', items: [ { label: 'Rx', value: 1 }, { label: 'rx', value: 2 } ] }).items.map(x => x.value), [ 1 ], 'one item a label');
	assert.deepEqual(model.tile({ v: 1, title: 'T', items: 'x' }).items, []);
});

test('contract: state and icon from fixed lists; every within 5-300 s; a page only as a LuCI menu path', () => {
	const t = x => model.tile(Object.assign({ v: 1, title: 'T' }, x));
	assert.deepEqual([ t({}).state, t({}).icon, t({}).every, t({}).page, t({}).note ], [ null, 'pulse', null, null, null ]);
	assert.equal(t({ state: 'warn' }).state, 'warn');
	assert.equal(t({ state: 'critical' }).state, null);
	assert.equal(t({ icon: 'signal' }).icon, 'signal');
	for (const i of [ 'rocket', '<svg>', 'constructor', '__proto__' ]) assert.equal(t({ icon: i }).icon, 'pulse', i);
	assert.deepEqual([ 5, 300, 4, 301, 7.5, '10', -10 ].map(e => t({ every: e }).every), [ 5, 300, null, null, null, null, null ]);
	assert.deepEqual(t({ page: 'admin/services/smartdns' }).page, [ 'admin', 'services', 'smartdns' ]);
	for (const p of [ 'https://example.com/', '//example.com', 'javascript:alert(1)', 'admin/../../x', 'admin', 'admin/', 'status/overview', 'admin/a/b/c/d/e',
		'admin/a b', 'admin/a?x=1', 'admin/a#b', '/admin/network', 'admin/%2e%2e' ])
		assert.equal(t({ page: p }).page, null, p);
});

/* ------------------------------------------------------------ layout */

test('layout: provider tiles go by x and their id, at most three, after every tile of the dashboard\'s own', () => {
	assert.deepEqual(layout.extras([ 'xzz', 'xdns', 'dns', 'xDNS', 'x', 'xabcdefgh', 'xdns', 'xmodem', 'xabc', 7, null ]), [ 'xabc', 'xdns', 'xmodem' ]);
	assert.equal(layout.EXTRA_MAX, 3);
	/* no tile of the dashboard's own is one */
	for (const id of layout.TILES) assert.equal(layout.isExtra(id), false, id);
	assert.equal(layout.available('xdns', false, false, false), false, 'not on a page that has none');
	assert.equal(layout.available('xdns', false, false, false, [ 'xdns' ]), true);
	assert.equal(layout.available('xdns', false, false, false, [ 'xmodem' ]), false);
	const ids = l => l.map(e => e.id + ':' + e.c + ':' + e.w);
	assert.deepEqual(ids(layout.defaults('wide', false, true, true, [ 'xdns', 'xmodem' ])).slice(-3), [ 'ports:0:3', 'xdns:3:1', 'xmodem:3:1' ]);
	assert.deepEqual(ids(layout.defaults('mid', true, false, false, [ 'xdns' ])).slice(-1), [ 'xdns:1:1' ]);
	assert.deepEqual(ids(layout.defaults('narrow', false, false, false, [ 'xdns' ])).slice(-1), [ 'xdns:0:1' ]);
	/* a stored layout that does not name one gets it where the default has it; one that names it keeps its place */
	const saved = [ { id: 'xdns', c: 0, w: 2 }, { id: 'hero', c: 0, w: 4 }, { id: 'xgone', c: 1, w: 1 } ];
	const n = layout.normalize(saved, 'wide', false, false, false, [ 'xdns', 'xmodem' ]);
	assert.deepEqual(ids(n).slice(0, 3), [ 'xdns:0:2', 'xmodem:3:1', 'hero:0:4' ], 'after the tile it follows by default');
	assert.ok(!n.some(e => e.id === 'xgone'), 'a provider this page does not have is not laid out');
});

test('layout: a page without providers lays out as before; every layout stays in the form and the count the theme keeps', () => {
	for (const tier of [ 'wide', 'mid', 'narrow' ]) for (const wired of [ false, true ]) for (const wg of [ false, true ]) for (const ports of [ false, true ]) {
		assert.deepEqual(layout.defaults(tier, wired, wg, ports, []), layout.defaults(tier, wired, wg, ports));
		assert.deepEqual(layout.normalize([ { id: 'sys', c: 0, w: 1 } ], tier, wired, wg, ports, []), layout.normalize([ { id: 'sys', c: 0, w: 1 } ], tier, wired, wg, ports));
		assert.deepEqual(layout.normalize([ { id: 'xdns', c: 0, w: 1 }, { id: 'sys', c: 0, w: 1 } ], tier, wired, wg, ports, []), layout.normalize([ { id: 'sys', c: 0, w: 1 } ], tier, wired, wg, ports));
	}
	/* the theme's form for a stored layout, in its script and its template: every tile and three providers fit */
	const menu = fs.readFileSync(path.join(ROOT, 'luci-theme-vantage/htdocs/luci-static/resources/menu-vantage.js'), 'utf8');
	const ut = fs.readFileSync(path.join(ROOT, 'luci-theme-vantage/ucode/template/themes/vantage/header.ut'), 'utf8');
	const forms = [ /^const VIEW_LAYOUT = \/(.+)\/;$/m.exec(menu)[1], /const form = \/(.+)\/;/.exec(ut)[1] ].map(s => new RegExp(s));
	const full = layout.encode(layout.defaults('wide', false, true, true, [ 'xabcdefg', 'xdns', 'xmodem', 'xsqm' ]));
	assert.equal(full.split(' ').length, 12, 'nine of its own and three');
	for (const f of forms) assert.ok(f.test(full), full);
	assert.ok(layout.TILES.length + layout.EXTRA_MAX <= 12, 'a tile more needs the theme\'s form widened, in its script and its template together');
});

test('layout: arranging keeps the stored entry of a provider not there now, while there is room for it', () => {
	const self = Object.create(view);
	const e = (id, c, w, hide) => Object.assign({ id, c, w }, hide ? { hide: true } : {});
	const ids = l => l.map(x => x.id);
	const now = [ e('hero', 0, 4), e('xdns', 3, 1) ];
	assert.deepEqual(ids(self.keepAbsent(now, [ e('hero', 0, 4), e('xold', 0, 1, true), e('xdns', 3, 1) ])), [ 'hero', 'xold', 'xdns' ]);
	assert.deepEqual(ids(self.keepAbsent(now, [ e('xa', 0, 1), e('xb', 0, 1), e('xc', 0, 1), e('hero', 0, 4) ])), [ 'xa', 'xb', 'hero', 'xdns' ], 'three in all, those there now first');
	assert.deepEqual(ids(self.keepAbsent([ e('hero', 0, 4), e('xa', 0, 1), e('xb', 0, 1), e('xc', 0, 1) ], [ e('xold', 0, 1) ])), [ 'xold', 'hero', 'xa', 'xb', 'xc' ].filter(x => x !== 'xold'));
	assert.deepEqual(ids(self.keepAbsent(now, [ e('nope', 0, 1), e('x1', 0, 1), e('X', 0, 1) ])), ids(now));
});

/* --------------------------------------------------- asking providers */

test('a session that may ask no provider asks rpcd for its ACL once, and nothing else, ever', () => tilePolls(async c => {
	c.acl = dump({ 'luci.vantage': [ 'wireless' ], 'vantage.tile.*': [ 'status' ], 'vantage.tile.dns': [ 'read' ], 'vantage.tile.DNS': [ 'status' ],
		'vantage.tile.abcdefgh': [ 'status' ], 'xvantage.tile.dns': [ 'status' ], 'vantage.tile.dns.x': [ 'status' ] });
	for (let i = 0; i < 20; i++) assert.deepEqual(await c.poll(5e3), {}, 'poll ' + i);
	assert.deepEqual(c.calls, [ [ 'acl', null, [] ] ], 'one question, without an object: the whole ACL');
	assert.deepEqual(c.self.tileIds, []);
	/* an answer that is no ACL, or none */
	for (const a of [ null, 7, 'x', [], { ubus: [] }, { ubus: 'x' }, { ubus: { 'vantage.tile.dns': 'status' } } ]) {
		c.fresh(); c.calls = []; c.acl = a;
		assert.deepEqual(await c.poll(5e3), {});
		assert.deepEqual(c.calls.map(x => x[0]), [ 'acl' ], JSON.stringify(a));
	}
	c.fresh(); c.calls = [];
	REPLIES['session access'] = () => Promise.reject(new Error('XHR request timed out'));
	assert.deepEqual(await c.poll(5e3), {});
	assert.deepEqual(await c.poll(5e3), {});
	assert.deepEqual(c.calls, []);
}));

test('the providers a session may ask: named exactly and granted status in its ACL, the first three by id; each asked without arguments, in a request of its own', () => tilePolls(async c => {
	c.acl = dump({ 'vantage.tile.zzz': [ 'status' ], 'vantage.tile.modem': [ 'status' ], 'vantage.tile.dns': [ 'status', 'other' ], 'vantage.tile.abc': [ 'status' ] });
	c.answer = { dns: () => Promise.resolve(DNS()), abc: () => Promise.resolve({ v: 1, title: 'A' }), modem: () => Promise.resolve(tiles.modemStatus(c.t / 1000)) };
	const a = await c.poll(0);
	assert.deepEqual(c.self.tileIds, [ 'abc', 'dns', 'modem' ]);
	assert.deepEqual(Object.keys(a), [ 'abc', 'dns', 'modem' ]);
	assert.deepEqual(a.dns, { data: JSON.parse(JSON.stringify(model.tile(DNS()))), at: 1e12, failed: false }, 'the dashboard\'s reading of the answer, not the answer');
	assert.deepEqual(c.calls.filter(x => x[0] !== 'acl').map(x => x.slice(1)), [ [ [], true, true, null ], [ [], true, true, null ], [ [], true, true, null ] ], 'no argument, nobatch, a failure rejected, no parameters');
	assert.equal(c.asked('zzz'), 0, 'the fourth is not asked');
	/* the ACL once a page */
	await c.poll(5e3);
	assert.equal(c.calls.filter(x => x[0] === 'acl').length, 1);
}));

test('a provider whose first answer says it is not there is never asked again on this page and has no tile', () => tilePolls(async c => {
	c.acl = dump({ 'vantage.tile.dns': [ 'status' ] });
	for (const e of [ GONE, 'RPC call to vantage.tile.dns/status failed with error -32002: Access denied', 'RPC call to vantage.tile.dns/status failed with ubus code 3: Method not found' ]) {
		c.fresh(); c.calls = [];
		c.answer.dns = () => Promise.reject(new Error(e));
		assert.deepEqual(await c.poll(0), {}, e);
		c.answer.dns = () => Promise.resolve(DNS());
		for (let i = 0; i < 20; i++) assert.deepEqual(await c.poll(3600e3), {});
		assert.equal(c.asked('dns'), 1, e);
	}
}));

test('a provider is asked with the slow poll, no more often than its data changes; a slow one ten times as late; one gone, once a minute', () => tilePolls(async c => {
	c.acl = dump({ 'vantage.tile.dns': [ 'status' ] });
	let n = 0;
	c.answer.dns = () => Promise.resolve(Object.assign(DNS(), { every: n++ < 3 ? 10 : undefined }));
	await c.poll(0);
	assert.equal(c.asked('dns'), 1);
	await c.poll(5e3);
	assert.equal(c.asked('dns'), 1, 'every 10 s: not at the next poll');
	await c.poll(5e3);
	assert.equal(c.asked('dns'), 2, 'at the one after');
	await c.poll(5e3); await c.poll(5e3);
	assert.equal(c.asked('dns'), 3);
	await c.poll(5e3); await c.poll(5e3); await c.poll(5e3);
	assert.equal(c.asked('dns'), 5, 'the last with every waited for; without it, each slow poll');
	/* an answer after 2 s: the next question 20 s on, the last answer until then */
	c.took = 2000;
	const slow = await c.poll(5e3);
	for (let i = 0; i < 3; i++) assert.deepEqual(await c.poll(5e3), slow, 'poll ' + i);
	assert.equal(c.asked('dns'), 6);
	await c.poll(5e3);
	assert.equal(c.asked('dns'), 7);
	/* uninstalled under an open page: none now, the last answer standing a minute, a question a minute */
	c.answer.dns = () => Promise.reject(new Error(GONE));
	const gone = await c.poll(5e3);
	assert.equal(gone.dns.failed, true);
	assert.ok(gone.dns.data, 'the last answer, marked as from a call that failed');
	for (let i = 0; i < 11; i++) await c.poll(5e3);
	assert.equal(c.asked('dns'), 8);
	c.answer.dns = () => Promise.resolve(DNS());
	assert.equal((await c.poll(5e3)).dns.failed, false);
	assert.equal(c.asked('dns'), 9);
}));

test('a provider\'s call holds up a poll for 2 s at most; while it is out no second one is made and no later poll waits', () => tilePolls(async c => {
	c.acl = dump({ 'vantage.tile.dns': [ 'status' ] });
	let release;
	c.answer.dns = () => new Promise(r => { release = r; });
	let done = false;
	const first = c.poll(0).then(v => { done = true; return v; });
	await new Promise(r => setImmediate(r));
	assert.equal(done, false);
	assert.deepEqual(c.timers.map(t => t.ms), [ 2000 ], 'the deadline');
	c.timers[0].f();
	assert.deepEqual(await first, { dns: { data: null, at: 0, failed: false } }, 'no answer yet');
	/* the next poll: the call is still out */
	c.timers = [];
	assert.deepEqual(await c.poll(5e3), { dns: { data: null, at: 0, failed: false } });
	assert.equal(c.asked('dns'), 1);
	assert.deepEqual(c.timers, [], 'nothing to wait for');
	release(DNS());
	await new Promise(r => setImmediate(r));
	assert.deepEqual((await c.poll(5e3)).dns.data, JSON.parse(JSON.stringify(model.tile(DNS()))), 'the late answer is the next poll\'s');
}));

test('a provider whose tile the layout hides is not asked once it has answered', () => tilePolls(async c => {
	c.acl = dump({ 'vantage.tile.dns': [ 'status' ] });
	c.answer.dns = () => Promise.resolve(DNS());
	c.self.lay = { list: [ { id: 'hero', c: 0, w: 4 }, { id: 'xdns', c: 3, w: 1, hide: true } ] };
	await c.poll(0);
	assert.equal(c.asked('dns'), 1, 'asked once: whether it is there at all');
	for (let i = 0; i < 6; i++) await c.poll(15e3);
	assert.equal(c.asked('dns'), 1);
	c.self.lay.list[1].hide = false;
	await c.poll(15e3);
	assert.equal(c.asked('dns'), 2);
}));

/* ------------------------------------------------------------ drawing */

/* the view over a page with the given answers (tiles: tileAnswers' form) */
function page(answers, v) {
	const self = Object.create(v || view);
	self.st = { ext: Object.create(null), health: 'kept', summary: 'kept' };
	self.tileIds = Object.keys(answers);
	self.tiles = {}; self.tileNames = {}; self.el = {};
	self.m = {};
	self.noteTiles(self.m, answers, 1e12);
	self.buildProvided();
	self.paintTiles();
	return self;
}
/* an answer as tileAnswers hands it on: model.tile's reading of a reply */
const ans = (reply, extra) => Object.assign({ data: model.tile(reply), at: 1e12, failed: false }, extra);

test('a tile drawn from an answer: its name, icon, dot, link, note and items, all text', () => withDom(() => {
	const self = page({ dns: ans(DNS()) });
	assert.deepEqual(self.m.extra, [ 'xdns' ]);
	assert.deepEqual([ self.st.health, self.st.summary ], [ 'kept', 'kept' ], 'never a health check');
	const tile = self.tiles.xdns;
	assert.deepEqual([ tile.tag, tile.getAttribute('class'), tile.getAttribute('aria-label') ], [ 'section', 'vt-tile vt-ext-tile', 'DNS (dns)' ]);
	assert.equal(self.tileNames.xdns, 'DNS (dns)');
	assert.deepEqual([ tile.find('vt-ext-name')[0].textContent, tile.find('vt-ext-src')[0].textContent ], [ 'DNS', 'dns' ]);
	assert.deepEqual(tile.find('vt-status').map(s => s.getAttribute('class')), [ 'vt-status vt-status-ok' ]);
	assert.deepEqual(tile.find('vt-link'), [], 'no menu: no link');
	assert.equal(tile.find('vt-ext-note')[0].textContent, 'dnsmasq, since it started');
	const items = tile.find('vt-ext-item').map(x => [ x.find('vt-label')[0].textContent, x.find('vt-ext-val')[0].textContent ]);
	assert.deepEqual(items, [ [ 'Queries', '—' ], [ 'Forwarded', '—' ], [ 'From cache', '85%' ], [ 'Unanswered', '2' ] ], 'a counter has no rate after one answer');
	assert.equal(tile.find('vt-bar-fill')[0].style.width, '85.00%');
	/* the next answer, 10 s on: rates */
	const next = tiles.dnsStatus({ dns_local_answered: 1250, dns_queries_forwarded: 200, dns_unanswered: 2 });
	self.noteTiles(self.m, { dns: ans(next, { at: 1e12 + 10e3 }) }, 1e12 + 10e3);
	self.paintTiles();
	assert.deepEqual(tile.find('vt-ext-val').map(v => v.textContent).slice(0, 2), [ '45/s', '5/s' ]);
	assert.equal(tile.find('vt-sk').length, 1, 'the trend of Queries');
	assert.equal(self.st.ext.dns.hist.Queries.length, 1);
	/* the same answer again (between slow polls) is no sample */
	self.noteTiles(self.m, { dns: ans(next, { at: 1e12 + 10e3 }) }, 1e12 + 15e3);
	assert.equal(self.st.ext.dns.hist.Queries.length, 1);
	assert.deepEqual(Object.keys(self.st.ext.dns.rates), [ 'Queries', 'Forwarded' ]);
}));

test('units are the dashboard\'s own formats; levels colour the value, and say so in words', () => withDom(() => {
	const self = page({ modem: ans({ v: 1, title: 'Mobile', state: 'warn', items: [
		{ label: 'RSRP', value: -103, unit: 'dBm', level: 'warn' }, { label: 'SINR', value: 4.5, unit: 'dB', level: 'err' }, { label: 'RTT', value: 23.456, unit: 'ms' },
		{ label: 'Up', value: 90061, unit: 's' }, { label: 'Data', value: 1536, unit: 'B' }, { label: 'Rate', value: 2.5e6, unit: 'bit/s' }, { label: 'Ch', value: 1800, unit: 'MHz' },
		{ label: 'Band', text: 'B3', level: 'off' } ] }) });
	const vals = self.tiles.xmodem.find('vt-ext-val');
	assert.deepEqual(vals.map(v => v.textContent), [ '−103 dBm Warning', '4.5 dB Error', '23.5 ms', '1d 1h', '1.50 KiB', '2.5 Mbit/s', '1800 MHz', 'B3' ]);
	assert.deepEqual(vals.map(v => v.getAttribute('class')), [ 'vt-ext-val vt-tn vt-t-warn', 'vt-ext-val vt-tn vt-t-err', 'vt-ext-val vt-tn', 'vt-ext-val vt-tn', 'vt-ext-val vt-tn', 'vt-ext-val vt-tn', 'vt-ext-val vt-tn', 'vt-ext-val vt-tn vt-muted' ]);
	assert.equal(self.tiles.xmodem.find('vt-status')[0].textContent, 'Warning');
}));

test('hostile text stays text: no markup, handler, style or link from an answer; a link only to a page this login\'s menu has, under LuCI\'s name', () => withDom(() => {
	const evil = '<img src=x onerror=alert(1)>';
	const reply = { v: 1, title: evil, icon: '"><script>', note: 'javascript:alert(1)', page: 'admin/network/dhcp', items: [ { label: evil, text: '<a href="//example.com">x</a>' } ] };
	const tree = { children: { admin: { satisfied: true, children: { network: { satisfied: true, title: 'Network', children: { dhcp: { satisfied: true, title: 'DHCP and DNS' }, hidden: { satisfied: false, title: 'Hidden' } } } } } } };
	const self = page({ dns: ans(reply) });
	const nodes = self.tiles.xdns.all();
	assert.ok(nodes.every(n => n.innerHTML === undefined), 'no markup');
	assert.ok(nodes.every(n => !Object.keys(n.attrs).some(a => /^(on|href|src|style)/.test(a))), 'no handler, link or style');
	assert.ok(nodes.every(n => !n.tag.includes('script') && n.tag !== 'a'));
	assert.equal(self.tiles.xdns.getAttribute('aria-label'), evil + ' (dns)', 'an attribute holds it as text');
	assert.ok(self.tiles.xdns.find('vt-ext-name')[0].textContent === evil);
	/* with the menu: the link is LuCI's own page, by its menu name */
	const menuView = viewWithMenu(tree);
	const withMenu = page({ dns: ans(reply) }, menuView);
	assert.deepEqual(withMenu.tiles.xdns.find('vt-link').map(a => [ a.getAttribute('href'), a.textContent ]), [ [ '/cgi-bin/luci/admin/network/dhcp', 'DHCP and DNS' ] ]);
	for (const p of [ 'admin/network/hidden', 'admin/network/nope', 'admin/network' ]) {
		const s = page({ dns: ans(Object.assign({}, reply, { page: p })) }, menuView);
		assert.deepEqual(s.tiles.xdns.find('vt-link').map(a => a.getAttribute('href')), p === 'admin/network' ? [ '/cgi-bin/luci/admin/network' ] : [], p);
	}
}));

/* the view with LuCI's menu tree as load() leaves it (menuTree, a module variable) */
function viewWithMenu(tree) {
	const src = VIEW_SRC.replace('var menuTree = null;', 'var menuTree = ' + JSON.stringify(tree) + ';');
	assert.notEqual(src, VIEW_SRC);
	const stubs = { view: { extend: p => p }, rpc: { declare: () => () => Promise.resolve(null) }, poll: POLL, ui: UI, dom: {} };
	const params = [], values = [];
	for (const m of src.matchAll(/^'require ([\w.-]+)(?: as (\w+))?';$/gm)) {
		params.push(m[2] || m[1]);
		values.push(Object.prototype.hasOwnProperty.call(stubs, m[1]) ? stubs[m[1]] : load(m[1]));
	}
	return new Function(...params, src)(...values);
}

test('before an answer, after one it cannot read and when it does not answer, the tile says so in words', () => withDom(() => {
	const self = page({ dns: { data: null, at: 0, failed: false } });
	assert.equal(self.tiles.xdns.find('vt-ext')[0].textContent, 'Waiting for its first report');
	assert.equal(self.tiles.xdns.find('vt-tile-title')[0].textContent, 'dns', 'by its id until it has a name');
	assert.deepEqual([ self.tiles.xdns.find('vt-ext-name').length, self.tileNames.xdns ], [ 0, 'dns' ]);
	self.noteTiles(self.m, { dns: ans({ v: 2, title: 'DNS' }) }, 1e12);
	self.paintTiles();
	assert.equal(self.tiles.xdns.find('vt-ext')[0].textContent, 'Sent a report that could not be read');
	self.noteTiles(self.m, { dns: ans(DNS(), { at: 1e12 + 1 }) }, 1e12 + 1);
	self.noteTiles(self.m, { dns: ans(DNS(), { at: 1e12 + 1, failed: true }) }, 1e12 + 30e3);
	self.paintTiles();
	assert.equal(self.tiles.xdns.find('vt-ext-item').length, 4, 'a call that failed: the last answer stands');
	self.noteTiles(self.m, { dns: ans(DNS(), { at: 1e12 + 1, failed: true }) }, 1e12 + 61e3);
	self.paintTiles();
	assert.equal(self.tiles.xdns.find('vt-ext')[0].textContent, 'Did not answer in time');
	assert.equal(self.tiles.xdns.find('vt-ext-name')[0].textContent, 'DNS', 'the name it gave');
}));

test('the page keeps the dashboard\'s reading of an answer, never the answer: a reply of megabytes leaves a few hundred bytes', () => tilePolls(async c => {
	c.acl = dump({ 'vantage.tile.dns': [ 'status' ] });
	const big = 'x'.repeat(1 << 20);
	c.answer.dns = () => Promise.resolve(Object.assign(DNS(), { junk: big, note: big,
		items: DNS().items.concat(Array.from({ length: 40 }, (_, i) => ({ label: big + i, text: big, extra: big }))) }));
	const a = await c.poll(0);
	const kept = JSON.stringify(c.self.tileState) + JSON.stringify(c.self.tileAnswers());
	assert.ok(kept.length < 4096, kept.length + ' characters kept');
	assert.doesNotMatch(kept, /junk|extra|x{100}/);
	assert.equal(Array.from(a.dns.data.note).length, 64);
	assert.equal(a.dns.data.items.length, 5, 'its four, and one of the forty long labels: cut alike, one a label');
}));

test('a provider\'s dBm and MHz: 0 is a value, a fraction has three digits, in the dashboard\'s forms', () => withDom(() => {
	const self = page({ modem: ans({ v: 1, title: 'Modem', items: [
		{ label: 'TX', value: 0, unit: 'dBm' }, { label: 'RSRP', value: -97.123456, unit: 'dBm' }, { label: 'RSSI', value: -65, unit: 'dBm' },
		{ label: 'Ch', value: 1800.123456, unit: 'MHz' }, { label: 'Off', value: 0, unit: 'MHz' } ] }) });
	assert.deepEqual(self.tiles.xmodem.find('vt-ext-val').map(v => v.textContent), [ '0 dBm', '−97.1 dBm', '−65 dBm', '1800 MHz', '0 MHz' ]);
}));

test('Customize: a provider tile\'s controls are not made again while it is open (a new name waits for Done)', () => withDom(() => {
	const self = page({ dns: ans(DNS()) });
	const tile = self.tiles.xdns, before = self.tileNames.xdns;
	self.ov = {};
	tile.appendChild(self.buildOverlay('xdns'));
	const first = self.ov.xdns.root;
	self.editing = true;
	self.noteTiles(self.m, { dns: ans(Object.assign(DNS(), { title: 'Resolver' }), { at: 1e12 + 10e3 }) }, 1e12 + 10e3);
	self.paintTiles();
	assert.equal(self.ov.xdns.root, first, 'the controls under the pointer or the keyboard stay');
	assert.ok(tile.childNodes.includes(first));
	assert.equal(self.tileNames.xdns, before);
	self.editing = false;
	self.paintTiles();
	assert.notEqual(self.ov.xdns.root, first, 'closed: named again');
	assert.ok(!tile.childNodes.includes(first) && tile.childNodes.includes(self.ov.xdns.root));
	assert.match(self.tileNames.xdns, /^Resolver\b/);
	assert.equal(self.ov.xdns.root.find('vt-ov-name')[0].textContent, self.tileNames.xdns);
}));

test('an answer it cannot read leaves the tile its name, icon and page: it says so under them', () => withDom(() => {
	const self = page({ dns: ans(DNS()) });
	const head = () => self.tiles.xdns.find('vt-tile-title')[0];
	const name = self.tileNames.xdns;
	self.ov = {};
	self.tiles.xdns.appendChild(self.buildOverlay('xdns'));
	const ov = self.ov.xdns.root;
	for (const bad of [ { v: 2, title: 'DNS' }, { v: 1, title: '' }, {} ]) {
		self.noteTiles(self.m, { dns: ans(bad, { at: self.st.ext.dns.at + 10e3 }) }, self.st.ext.dns.at + 10e3);
		self.paintTiles();
		assert.equal(self.tiles.xdns.find('vt-ext')[0].textContent, 'Sent a report that could not be read');
		assert.equal(head().children[1].textContent, 'DNS', JSON.stringify(bad));
		assert.equal(self.tileNames.xdns, name);
		assert.equal(self.ov.xdns.root, ov, 'no new controls for a name that did not change');
	}
}));

test('provenance: a provider tile carries its provider\'s id from the session\'s ACL, whatever it answers; no tile of the dashboard\'s own has one', () => withDom(() => {
	/* a provider that names itself after a tile of the dashboard's own, with its icon, and claims another id */
	const self = page({ sys: ans({ v: 1, title: 'System', icon: 'cpu', id: 'hero', provider: 'luci.vantage', items: [ { label: 'CPU', value: 3, unit: '%' } ] }) });
	assert.deepEqual(self.m.extra, [ 'xsys' ], 'its layout id is x and the object\'s id');
	const tile = self.tiles.xsys, src = tile.find('vt-ext-src');
	assert.equal(src.length, 1);
	assert.deepEqual([ src[0].textContent, src[0].getAttribute('class'), src[0].getAttribute('title') ], [ 'sys', 'vt-src vt-ext-src', 'From another package: sys' ]);
	assert.equal(src[0].parent, tile.find('vt-tile-title')[0], 'in the head, after its name');
	assert.deepEqual(tile.find('vt-tile-title')[0].children.map(n => n.getAttribute('class')), [ 'vt-ico', 'vt-ext-name', 'vt-src vt-ext-src' ]);
	assert.deepEqual([ self.tileNames.xsys, tile.getAttribute('aria-label') ], [ 'System (sys)', 'System (sys)' ], 'Customize, the hidden list and the screen reader');
	/* the id is the object's: another provider with the same answer has its own */
	const other = page({ dns: ans({ v: 1, title: 'System', id: 'sys' }) });
	assert.deepEqual([ other.tiles.xdns.find('vt-ext-src')[0].textContent, other.tileNames.xdns ], [ 'dns', 'System (dns)' ]);
	/* before an answer, after one it cannot read and when it does not answer: the tag all the same */
	for (const a of [ { data: null, at: 0, failed: false }, ans({ v: 2 }), { data: null, at: 0, failed: true } ])
		assert.equal(page({ dns: a }).tiles.xdns.find('vt-ext-src')[0].textContent, 'dns', JSON.stringify(a));
	/* the dashboard's own tiles make none: the tag is made in one place */
	assert.equal((VIEW_SRC.match(/vt-ext-src/g) || []).length, 1);
	const head = VIEW_SRC.slice(VIEW_SRC.indexOf('function tileHead('), VIEW_SRC.indexOf('\n}\n', VIEW_SRC.indexOf('function tileHead(')));
	assert.doesNotMatch(head, /vt-src/);
}));

test('a model built again between polls (names changed: rerender) keeps the provider tiles, and takes no sample', () => withDom(() => {
	const self = page({ dns: ans(DNS()) });
	const laid = [];
	Object.assign(self, { lastRaw: { provided: { dns: ans(DNS()) } }, board: {}, aliases: {}, quiet: null,
		markWired() {}, markOffline() {}, notePorts() {}, stickyGen() {}, talkers() { return []; }, cpuShown() { return null; },
		paint() { laid.push((this.m.extra || []).join(' ')); } });
	self.st.hist = { cpu: [], mem: [], net: {} };
	const hist = JSON.stringify(self.st.ext.dns);
	self.rerender();
	assert.deepEqual(laid, [ 'xdns' ], 'the layout still has its tile');
	assert.equal(JSON.stringify(self.st.ext.dns), hist, 'the same answer again: no new sample, no new rate');
}));

test('a provider\'s words are looked up in LuCI\'s catalogues (title, note, labels); a text value is shown as it came', () => withDom(() => {
	const saved = global._;
	const de = { 'Mobile backup': 'Mobiles Backup', 'Standby: the main line is up': 'Bereitschaft: die Hauptleitung läuft', 'Operator': 'Betreiber', 'Home': 'Startseite' };
	global._ = s => Object.prototype.hasOwnProperty.call(de, s) ? de[s] : s;
	try {
		const self = page({ modem: ans({ v: 1, title: 'Mobile backup', note: 'Standby: the main line is up', items: [ { label: 'Operator', text: 'Home' } ] }) });
		const tile = self.tiles.xmodem;
		assert.equal(tile.find('vt-ext-name')[0].textContent, 'Mobiles Backup');
		assert.equal(tile.find('vt-ext-note')[0].textContent, 'Bereitschaft: die Hauptleitung läuft');
		assert.deepEqual([ tile.find('vt-label')[0].textContent, tile.find('vt-ext-val')[0].textContent ], [ 'Betreiber', 'Home' ], 'a value, even one that is a word LuCI translates');
	} finally { global._ = saved; }
}));

test('a page without providers builds, names and paints no tile beyond the dashboard\'s own', () => withDom(() => {
	const self = page({});
	assert.deepEqual([ self.m.extra, Object.keys(self.tiles), Object.keys(self.tileNames) ], [ [], [], [] ]);
	assert.match(VIEW_SRC, /this\.tileList = layout\.TILES\.concat\(this\.buildProvided\(\)\);/);
}));

/* ----------------------------------------------- the example provider */

const PLUGIN = path.join(ROOT, 'dev/replay/tiles/root/usr/share/rpcd/ucode/vantage.tile.dns');
const ACL = path.join(ROOT, 'dev/replay/tiles/root/usr/share/rpcd/acl.d/vantage-tile-dns.json');

function findUcode() {
	for (const c of [ process.env.UCODE ].concat((process.env.PATH || '').split(path.delimiter).map(d => d && path.join(d, 'ucode')))) {
		if (!c) continue;
		try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (e) {}
	}
	return null;
}
const UCODE = findUcode();
const NO_UCODE = UCODE ? false : 'no ucode binary (set UCODE=/path/to/ucode)';

const METRICS = [
	null,
	{ dns_local_answered: 850, dns_queries_forwarded: 150, dns_unanswered: 2, dns_auth_answered: 0, dns_stale_answered: 0 },
	{ dns_local_answered: 0, dns_queries_forwarded: 0 },
	{ dns_local_answered: 3, dns_queries_forwarded: 0, dns_auth_answered: 4, dns_stale_answered: 5, dns_unanswered: 0, dhcp_ack: 9 },
	{ dns_local_answered: 1, dns_queries_forwarded: 2 },
	tiles.metrics(Date.now() / 1000)
];

function runExample(cases) {
	const dir = mkTmp('vantage-tile-');
	const file = path.join(dir, 'cases.json');
	try {
		fs.writeFileSync(file, JSON.stringify(cases));
		const args = [ '-L', path.join(__dirname, 'ucode/tile-stubs') ];
		const lib = path.join(path.dirname(UCODE), '../lib/ucode');
		if (fs.existsSync(lib)) args.push('-L', lib);
		args.push('-D', 'PLUGIN=' + PLUGIN, '-D', 'CASES=' + file, path.join(__dirname, 'ucode/tile-harness.uc'));
		return spawnSync(UCODE, args, { encoding: 'utf8' });
	} finally {
		if (fs.existsSync(file)) fs.unlinkSync(file);
		fs.rmdirSync(dir);
	}
}

test('example provider: one object, one method without arguments; the same answers as the replay\'s stand-in, each of the contract', { skip: NO_UCODE }, () => {
	const r = runExample(METRICS);
	assert.equal(r.status, 0, r.stderr);
	const out = JSON.parse(r.stdout);
	assert.deepEqual([ out.objects, out.methods, out.args ], [ [ 'vantage.tile.dns' ], [ 'status' ], null ]);
	out.replies.forEach((reply, i) => {
		assert.deepEqual(reply, tiles.dnsStatus(METRICS[i]), 'case ' + i);
		assert.ok(model.tile(reply), 'case ' + i + ' reads');
	});
});

test('example provider: compiles as rpcd loads it, imports only ubus, and asks ubus for dnsmasq\'s metrics only', { skip: NO_UCODE }, () => {
	const r = spawnSync(UCODE, [ '-L', path.join(__dirname, 'ucode/tile-stubs'), '-c', '-o', '/dev/null', PLUGIN ], { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	const src = fs.readFileSync(PLUGIN, 'utf8');
	assert.deepEqual([ ...src.matchAll(/^.*\bimport\b.*$/gm) ].map(m => m[0]), [ 'import { connect } from \'ubus\';' ]);
	assert.deepEqual([ ...src.matchAll(/\.call\(([^)]*)\)/g) ].map(m => m[1]), [ "'dnsmasq', 'metrics'" ]);
	assert.doesNotMatch(src, /\b(system|popen|exec|writefile|unlink|require|loadfile)\b/);
});

test('example provider: its ACL group grants its one call to read, and nothing else', () => {
	const acl = JSON.parse(fs.readFileSync(ACL, 'utf8'));
	assert.deepEqual(Object.keys(acl), [ 'vantage-tile-dns' ]);
	assert.deepEqual(Object.keys(acl['vantage-tile-dns']).sort(), [ 'description', 'read' ]);
	assert.deepEqual(acl['vantage-tile-dns'].read, { ubus: { 'vantage.tile.dns': [ 'status' ] } });
	/* what the replay's session holds with --tiles: this group, and the modem stand-in's in the same form */
	assert.deepEqual(Object.keys(tiles.acl()).sort(), [ 'vantage-tile-dns', 'vantage-tile-modem' ]);
	assert.deepEqual(tiles.acl()['vantage-tile-modem'].read, { ubus: { 'vantage.tile.modem': [ 'status' ] } });
	/* the stand-ins answer the contract, and nothing but status */
	assert.ok(model.tile(tiles.transform('vantage.tile.dns', 'status').result[1]));
	assert.ok(model.tile(tiles.transform('vantage.tile.modem', 'status').result[1]));
	assert.deepEqual(tiles.transform('vantage.tile.dns', 'set').result, [ 3 ]);
	assert.equal(tiles.transform('vantage.tile.x', 'status').error.code, -32000);
});

test('docs/TILES.md shows the example provider\'s two files as they are', () => {
	const doc = fs.readFileSync(path.join(ROOT, 'docs/TILES.md'), 'utf8');
	assert.ok(doc.includes('```json\n' + fs.readFileSync(ACL, 'utf8') + '```\n'), 'its ACL file');
	assert.ok(doc.includes('```js\n' + fs.readFileSync(PLUGIN, 'utf8') + '```\n'), 'its plugin');
});
