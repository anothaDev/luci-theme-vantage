'use strict';
/* The network path's backdrop (vantage/backdrop.js): the live rate sets
   how busy it is, packets keep to the tile's dot grid and to the path's
   band, downloads run away from the gateway, and the viewer's pick is
   kept in this browser like the chart style. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { load, RES } = require('./luci-stub');

const bd = load('vantage.backdrop');

/* draws are not looked at here, only the scene state */
global.Path2D = global.Path2D || class { moveTo() {} lineTo() {} rect() {} };

function env(extra) {
	return Object.assign({ w: 1200, h: 900, box: { t: 60, b: 820 }, origin: { x: 500, y: 440 }, count: 12, speed: bd.packetSpeed(.6), share: .7, colour: '#000', muted: '#888' }, extra);
}
const onLine = v => Math.abs(((v - bd.DOT) % bd.GRID + bd.GRID) % bd.GRID) < 1e-6 || Math.abs(((v - bd.DOT) % bd.GRID + bd.GRID) % bd.GRID - bd.GRID) < 1e-6;

test('level: one fifth per decade from 10 kbit/s to 1 Gbit/s, nothing below, bounded', () => {
	assert.equal(bd.level(0), 0);
	assert.equal(bd.level(1e4), 0);
	assert.equal(bd.level(null), 0);
	assert.equal(bd.level(NaN), 0);
	assert.equal(bd.level(-5), 0);
	assert.ok(Math.abs(bd.level(1e6) - .4) < 1e-9);
	assert.ok(Math.abs(bd.level(100e6) - .8) < 1e-9);
	assert.equal(bd.level(1e9), 1);
	assert.equal(bd.level(10e9), 1);
	let prev = -1;
	for (let b = 1e3; b < 2e9; b *= 1.7) { const l = bd.level(b); assert.ok(l >= prev); prev = l; }
});

test('counts and speeds follow the level and stay bounded', () => {
	assert.equal(bd.packetCount(1200, 760, 0), 2, 'a couple when idle');
	assert.equal(bd.packetCount(1200, 760, 1), 36, 'at most 36');
	assert.equal(bd.packetCount(300, 120, 1), 6, 'at least six at the top on a small path');
	assert.ok(bd.packetCount(1200, 760, .5) > 2 && bd.packetCount(1200, 760, .5) < 36);
	assert.ok(bd.packetSpeed(1) > bd.packetSpeed(0) && bd.packetSpeed(5) === bd.packetSpeed(1));
	assert.ok(bd.starSpeed(1) > bd.starSpeed(0) && bd.starSpeed(-1) === bd.starSpeed(0));
	/* 20 frames a second on a quiet uplink, 30 once packets move fast */
	assert.equal(bd.frameMs(0), 50);
	assert.equal(bd.frameMs(bd.level(1e5)), 50, 'still 20 at 100 kbit/s');
	assert.equal(bd.frameMs(bd.level(1e7)), 33, '30 from 10 Mbit/s');
	assert.equal(bd.frameMs(1), 33);
	for (let l = 0; l < 1; l += .05) assert.ok(bd.frameMs(l + .05) <= bd.frameMs(l), 'never slower with more traffic');
	assert.equal(bd.downShare(null, null), .7, 'before any rate');
	assert.equal(bd.downShare(100, 0), .9, 'uploads stay visible');
	assert.equal(bd.downShare(0, 100), .16, 'downloads stay visible');
	assert.ok(Math.abs(bd.downShare(3, 1) - .75) < 1e-9);
});

test('the grid is the tile\'s dot grid in app.css', () => {
	const css = fs.readFileSync(path.join(RES, 'vantage/app.css'), 'utf8');
	const rule = css.match(/\.vt-hero::before \{[^}]*\}/)[0];
	assert.match(rule, new RegExp(`circle at ${bd.DOT}px ${bd.DOT}px`));
	assert.match(rule, new RegExp(`/ ${bd.GRID}px ${bd.GRID}px`));
	assert.match(css, /\.vt-backdrop \{[^}]*position: absolute; left: 0; top: 0; pointer-events: none/);
});

test('packets: on the grid lines, inside the band, mostly in their own direction', () => {
	const e = env({ share: .9 });
	const sc = bd.packets(e);
	sc.resize(true);
	assert.equal(sc.size(), 12);
	const start = new Map(sc.items().map(p => [ p, p.x ]));
	for (let i = 0; i < 400; i++) {
		sc.step(.033);
		for (const p of sc.items()) {
			assert.ok(onLine(p.x) || onLine(p.y), `off the grid at ${p.x},${p.y}`);
			if (p.d === 0 || p.d === 2) assert.ok(onLine(p.y), 'a row while moving sideways');
			else assert.ok(onLine(p.x), 'a column while moving up or down');
			assert.ok(p.y >= e.box.t - bd.GRID && p.y <= e.box.b + bd.GRID, `out of the band at y ${p.y}`);
			assert.ok(p.d === p.main || p.d === 1 || p.d === 3, 'never against its direction');
		}
	}
	const right = sc.items().filter(p => p.main === 0).length;
	assert.ok(right >= sc.size() / 2, `downloads go right: ${right} of ${sc.size()}`);
	assert.ok([ ...start.keys() ].some(p => p.x !== start.get(p)), 'they move');
});

test('packets: more traffic brings more in from the edges, less lets the extra ones finish', () => {
	const e = env({ count: 4 });
	const sc = bd.packets(e);
	sc.resize(true);
	assert.equal(sc.size(), 4);
	e.count = 10;
	sc.resize(false);
	assert.equal(sc.size(), 10);
	const fresh = sc.items().slice(4);
	assert.ok(fresh.every(p => p.x < 0 || p.x > e.w), 'new ones enter at an edge');
	e.count = 3;
	sc.resize(false);
	assert.equal(sc.items().filter(p => !p.retire).length, 3);
	for (let i = 0; i < 2000 && sc.size() > 3; i++) sc.step(.05);
	assert.equal(sc.size(), 3, 'the retired ones leave once off the edge');
});

test('stars: stream from the origin, respawn inside the band, ease to the rate\'s speed', () => {
	const e = env({ speed: bd.starSpeed(.2) });
	const sc = bd.starfield(e);
	sc.resize(true);
	assert.ok(sc.size() >= 24 && sc.size() <= 160);
	for (let i = 0; i < 600; i++) sc.step(.033);
	for (const s of sc.items()) {
		assert.ok(s.z > .02 && s.z <= 1);
		assert.ok(Math.hypot(s.x, s.y) <= 1.0001);
	}
});

/* the dashboard keeps the viewer's pick in this browser */
function loadView() {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const stubs = { view: { extend: p => p }, rpc: { declare: () => () => Promise.resolve(null) }, poll: {}, ui: {}, dom: {} };
	const params = [], values = [];
	for (const m of src.matchAll(/^'require ([\w.-]+)(?: as (\w+))?';$/gm)) {
		params.push(m[2] || m[1]);
		values.push(Object.prototype.hasOwnProperty.call(stubs, m[1]) ? stubs[m[1]] : load(m[1]));
	}
	return new Function(...params, src)(...values);
}

function withStorage(initial, fn) {
	const store = Object.assign({}, initial), saved = global.window;
	global.window = {
		localStorage: { getItem: k => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
		sessionStorage: { getItem: () => null, setItem() {} }
	};
	try { return fn(store); } finally { global.window = saved; }
}

test('backdrop pick: read back, junk ignored, a change restyles and is remembered', () => {
	const view = loadView();
	assert.deepEqual(bd.STYLES, [ 'grid', 'stars', 'none' ]);
	for (const [ stored, want ] of [ [ undefined, 'grid' ], [ 'stars', 'stars' ], [ 'none', 'none' ],
		[ '"><img src=x>', 'grid' ], [ 'constructor', 'grid' ], [ 'STARS', 'grid' ] ])
		withStorage(stored === undefined ? {} : { 'vantage.backdrop.v1': stored }, () => {
			const self = Object.create(view);
			self.initState({});
			assert.equal(self.backdropStyle, want, String(stored));
		});

	withStorage({}, (store) => {
		const self = Object.create(view);
		self.initState({});
		const styled = [];
		self.backdrop = { style: s => styled.push(s) };
		self.setBackdrop('stars');
		assert.equal(self.backdropStyle, 'stars');
		assert.equal(store['vantage.backdrop.v1'], 'stars');
		self.setBackdrop('stars');
		self.setBackdrop('bogus');
		assert.deepEqual(styled, [ 'stars' ], 'the same or an unknown style changes nothing');
		self.setBackdrop('none');
		assert.equal(store['vantage.backdrop.v1'], 'none');
		self.setBackdrop('grid');
		assert.ok(!('vantage.backdrop.v1' in store), 'the default is not stored');
		assert.deepEqual(styled, [ 'stars', 'none', 'grid' ]);
	});
});

test('packets: a rate that keeps changing while nothing moves never grows the list', () => {
	const e = env({ count: 30 });
	const sc = bd.packets(e);
	sc.resize(true);
	for (let i = 0; i < 500; i++) { e.count = i % 2 ? 4 : 30; sc.resize(false); }
	assert.ok(sc.size() <= 30, `${sc.size()} packets`);
	assert.equal(sc.items().filter(p => !p.retire).length, 4);
});
