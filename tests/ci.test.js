'use strict';
/* The release signing keys stay behind the release-signing environment
   (security review SEC-005): only the build job names them, and only a
   tag push puts that job in the environment. The Pages job tries the
   deploy once more when the artifact list lags the upload (v1.0.21,
   v1.1.0); before a re-run, that run's github-pages artifact is deleted
   by hand (CONTRIBUTING.md, release step 5). The same holds for the job
   that publishes the site's page again between releases, by hand, around
   the package repositories as they are live. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CI = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');

/* the text of one top-level job, up to the next one */
const job = name => {
	const start = CI.indexOf('\n  ' + name + ':\n');
	assert.ok(start >= 0, 'job ' + name);
	const next = CI.slice(start + 1).search(/\n  [a-z][a-z-]*:\n/);
	return next < 0 ? CI.slice(start) : CI.slice(start, start + 1 + next);
};

test('ci: the signing keys are named in the build job only, which a tag push puts in release-signing', () => {
	const build = job('build');
	for (const key of [ 'secrets.VANTAGE_SIGN_KEY', 'secrets.VANTAGE_USIGN_KEY' ]) {
		assert.ok(build.includes(key), key);
		assert.equal(CI.split(key).length, build.split(key).length, key + ' outside the build job');
	}
	assert.match(build, /\n {4}environment: \$\{\{ \(github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)\) && 'release-signing' \|\| '' \}\}\n/);
	assert.match(build, /if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)\n\s+env:\n\s+SIGN_KEY:/);
});

/* the steps of a job's text, each from its "- name:" line */
const steps = text => text.split(/\n(?= {6}- name: )/).slice(1);
const uses = (list, action) => list.filter(s => s.includes('uses: ' + action + '@'));

/* the jobs that deploy to Pages: a release's, and the one run by hand */
const PAGES = [ 'repository', 'site' ];
const count = (text, s) => text.split(s).length - 1;

test('ci: a failed Pages deploy is tried once more, under the artifact name Pages is known to take', () => {
	for (const action of [ 'actions/upload-pages-artifact', 'actions/deploy-pages' ])
		assert.equal(count(CI, action + '@'), PAGES.reduce((n, name) => n + count(job(name), action + '@'), 0), action + ' outside the Pages jobs');
	assert.equal(count(CI, 'continue-on-error'), PAGES.length, 'continue-on-error on the first deploys only');
	for (const name of PAGES) pagesDeploy(job(name));
});

function pagesDeploy(repo) {
	/* the artifact keeps the name both actions use by default: Pages is
	   known to take that one, and another could not be tried before a
	   release that would depend on it */
	assert.doesNotMatch(repo, /artifact_name|PAGES_ARTIFACT|\n {10}name:/);

	const list = steps(repo);
	const upload = uses(list, 'actions/upload-pages-artifact');
	assert.equal(upload.length, 1);

	const deploys = uses(list, 'actions/deploy-pages');
	assert.equal(deploys.length, 2);

	/* first try: its failure must not end the job, and nothing else's may */
	const [ first, again ] = deploys;
	assert.match(first, /\n {8}id: deploy\n/);
	assert.match(first, /\n {8}continue-on-error: true\n/);
	assert.doesNotMatch(first, /\n {8}if:/);

	/* second try after a pause, only then, and its failure fails the job */
	const i = list.indexOf(first), j = list.indexOf(again);
	assert.ok(j > i + 1, 'a step between the two deploys');
	const wait = list.slice(i + 1, j);
	assert.equal(wait.length, 1);
	for (const s of [ wait[0], again ])
		assert.match(s, /\n {8}if: steps\.deploy\.outcome == 'failure'\n/);
	const pause = wait[0].match(/\n {8}run: sleep (\d+)\n/);
	assert.ok(pause && +pause[1] >= 10 && +pause[1] <= 120, 'a bounded pause');
	assert.match(again, /\n {8}id: deploy_again\n/);
	assert.doesNotMatch(again, /continue-on-error/);
	assert.equal(list.indexOf(again), list.length - 1, 'the second try is the last step');

	assert.match(repo, /\n {6}url: \$\{\{ steps\.deploy\.outputs\.page_url \|\| steps\.deploy_again\.outputs\.page_url \}\}\n/);
}

test('ci: the Pages jobs may write Pages and request an OIDC token, nothing else', () => {
	for (const name of PAGES)
		assert.match(job(name), /\n {4}permissions:\n {6}pages: write\n {6}id-token: write\n {4}[a-z]/, name);
});

test('ci: the site job runs by hand on main only, with no secret, and publishes the live repositories only as the latest release', () => {
	const site = job('site');
	assert.match(CI, /\n {2}workflow_dispatch:\n {4}inputs:\n {6}site:\n {8}description: .+\n {8}type: boolean\n {8}default: false\n/);
	assert.match(site, /\n {4}needs: checks\n {4}if: github\.event_name == 'workflow_dispatch' && inputs\.site && github\.ref == 'refs\/heads\/main'\n/);
	assert.doesNotMatch(site, /secrets\.|github\.token|GH_TOKEN|GITHUB_TOKEN/);

	/* each line's checksum list is the latest release's before a name in
	   it is fetched, and every package is checked against it */
	const at = s => { const i = site.indexOf(s); assert.ok(i >= 0, s); return i; };
	assert.ok(at('cmp "site/$a/SHA256SUMS" release/SHA256SUMS\n') < at('fetch "$a" $(awk'));
	assert.ok(at('cmp "site/$i/SHA256SUMS" "release/SHA256SUMS-$i"\n') < at('fetch "$i" $(awk'));
	assert.ok(at('fetch "$a" $(awk') < at('( cd "site/$a" && sha256sum -c SHA256SUMS )\n'));
	assert.ok(at('fetch "$i" $(awk') < at('( cd "site/$i" && sha256sum -c SHA256SUMS )\n'));
	assert.match(site, /\n {10}set -euo pipefail\n {10}live=/);

	/* the page's own files are the ones a release copies */
	const page = text => text.split('\n').filter(l => /^\s+(cp keys\/|cp dev\/build\/|mkdir -p site\/screenshots )/.test(l));
	assert.equal(page(site).length, 3);
	assert.deepEqual(page(site), page(job('repository')));
});

test('ci: every action is pinned to a full commit SHA with its version in a comment', () => {
	const lines = CI.split('\n').filter(l => /^\s*(- )?uses:/.test(l));
	assert.ok(lines.length > 0);
	for (const l of lines)
		assert.match(l, /^\s*(- )?uses: [\w.-]+\/[\w.\/-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/, l);
});
