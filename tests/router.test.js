'use strict';
/* The admin/dashboard router (view/vantage/dashboard.js): Vantage's
   dashboard opens under the Vantage theme only; any other theme gets
   luci-mod-dashboard's view, or LuCI's overview where that is not installed. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RES } = require('./luci-stub');

const SRC = fs.readFileSync(path.join(RES, 'view/vantage/dashboard.js'), 'utf8');

/* runs the router's __init__ with a fake LuCI; resolves with what it did */
function route(media, installed) {
	const log = { required: [], redirected: null };
	const L = {
		env: { media },
		url: p => '/cgi-bin/luci/' + p,
		require: name => {
			log.required.push(name);
			return installed.includes(name) ? Promise.resolve({}) : Promise.reject(new Error('404'));
		}
	};
	const win = { location: { replace: u => { log.redirected = u; } } };
	const view = { extend: proto => proto };
	const cls = new Function('view', 'L', 'window', SRC)(view, L, win);
	return Promise.resolve(cls.__init__()).then(() => log);
}

const BOTH = [ 'view.vantage.overview', 'view.dashboard.index' ];

test('router: Vantage selected opens Vantage\'s dashboard', async () => {
	for (const media of [ '/luci-static/vantage', '/luci-static/vantage/' ]) {
		const log = await route(media, BOTH);
		assert.deepEqual(log.required, [ 'view.vantage.overview' ]);
		assert.equal(log.redirected, null);
	}
});

test('router: another theme opens luci-mod-dashboard\'s view, never Vantage\'s', async () => {
	for (const media of [ '/luci-static/bootstrap', '/luci-static/argon', '/luci-static/vantage-old', '/luci-static/not-vantage', '' , undefined ]) {
		const log = await route(media, BOTH);
		assert.deepEqual(log.required, [ 'view.dashboard.index' ], String(media));
		assert.equal(log.redirected, null);
	}
});

test('router: another theme without luci-mod-dashboard goes to LuCI\'s overview', async () => {
	const log = await route('/luci-static/bootstrap', [ 'view.vantage.overview' ]);
	assert.deepEqual(log.required, [ 'view.dashboard.index' ]);
	assert.equal(log.redirected, '/cgi-bin/luci/admin/status/overview');
});

test('router: has no save buttons and renders nothing itself', () => {
	assert.match(SRC, /handleSave: null/);
	assert.match(SRC, /handleSaveApply: null/);
	assert.match(SRC, /handleReset: null/);
	assert.match(SRC, /render: function\(\) \{\}/);
});
