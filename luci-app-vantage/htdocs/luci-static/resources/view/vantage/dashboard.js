'use strict';
'require view';

/* Entry of admin/dashboard. Vantage's dashboard is styled for the Vantage
   theme only, so it opens only while that theme is selected; with any other
   theme the page is luci-mod-dashboard's (view dashboard/index), and without
   that package LuCI's overview. The theme is read in the browser, so
   switching themes takes effect at once and never depends on the menu
   cache. */

var THEME = /(^|\/)vantage\/?$/;

return view.extend({
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	/* the view class renders itself when it is loaded, so this one only
	   chooses which to load */
	__init__: function() {
		if (THEME.test((L.env && L.env.media) || ''))
			return L.require('view.vantage.overview');

		return L.require('view.dashboard.index').catch(function() {
			window.location.replace(L.url('admin/status/overview'));
		});
	},

	render: function() {}
});
