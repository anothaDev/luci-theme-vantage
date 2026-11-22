// Runs luci-app-vantage-traffic's rpcd plugin outside rpcd, for
// tests/traffic.test.js:
//
//   ucode -L tests/ucode/traffic-stubs -D PLUGIN=<copy> -D INPUT=<input.json> \
//       -D TABLE=<file> -D ACCT=<file> tests/ucode/traffic-harness.uc
//
// The copy is the plugin with its TABLE and ACCT paths pointed at the
// files given here, its clock replaced by global CLOCK ({ t, step, reads }:
// each reading returns t and adds step) and parse and norm handed out
// beside its object (test.js does that). rtnl and uci are the doubles in
// traffic-stubs/.
//
// input { mode: 'parse', lines: [ .. ] }: parse() of each line.
// input { mode: 'calls', calls: [ { table, acct, neigh, power, now, step } ] }:
// for each call the table's lines (null: no table), the accounting
// switch's text (null: no such file), the neighbour dumps, the power
// option and the clock; then `hosts`, called as rpcd calls it from a
// browser. Prints [ { reply, dumps, uci, clock } ] (clock: readings).
'use strict';

import { readfile, writefile, unlink } from 'fs';

let input = json(readfile(INPUT));
let plugin = loadfile(PLUGIN, { raw_mode: true })();
let obj = plugin?.['luci.vantage.traffic'];

if (type(obj) != 'object' || type(obj.hosts?.call) != 'function')
	die('plugin does not return luci.vantage.traffic with a hosts method');

global.CLOCK = { t: 0, step: 0, reads: 0 };

if (input.mode == 'parse') {
	print(sprintf('%J', map(input.lines, plugin.test.parse)), '\n');
}
else if (input.mode == 'calls') {
	let out = [];
	for (let c in input.calls) {
		if (c.table == null)
			unlink(TABLE);
		else if (writefile(TABLE, join('', map(c.table, (l) => l + '\n'))) == null)
			die('harness: cannot write the table');
		if (c.acct == null)
			unlink(ACCT);
		else if (writefile(ACCT, c.acct) == null)
			die('harness: cannot write the accounting switch');
		global.STUB = { neigh: c.neigh ?? {}, power: c.power, dumps: 0, uci: 0 };
		global.CLOCK = { t: c.now ?? 0, step: c.step ?? 0, reads: 0 };
		let reply = obj.hosts.call({ args: {} });
		push(out, { reply: json(sprintf('%J', reply)), dumps: global.STUB.dumps, uci: global.STUB.uci, clock: global.CLOCK.reads });
	}
	print(sprintf('%J', out), '\n');
}
else
	die('harness: unknown mode');
