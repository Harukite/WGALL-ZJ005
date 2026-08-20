import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const loginHtml = fs.readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
const venues = [
  ['n1', 'N1'],
  ['ph', 'Phoenix'],
  ['ph2', 'Phoenix2'],
  ['na', 'Nado'],
  ['pd', 'PopDEX'],
];

for (const [key, name] of venues) {
  assert.match(html, new RegExp(`switchTab\\('${key}'\\)`), `${name} should have its own tab`);
  assert.match(html, new RegExp(`id="hdr-${key}"`), `${name} should have a header status badge`);
  assert.match(html, new RegExp(`id="tab-${key}"`), `${name} should have a dedicated tab panel`);
  assert.match(html, new RegExp(`key: '${key}', name: '${name}'`), `${name} should be in the venue metadata`);
  assert.match(html, new RegExp(`id="ip-${key}"`), `${name} should have its own proxy input`);
  assert.match(html, new RegExp(`id="ip-${key}-status"`), `${name} should have its own proxy status`);
}

for (const suffix of [
  'market', 'interval', 'refresh-trend', 'rec-box', 'apply-rec', 'modes', 'risk-toggle',
  'smart-fill', 'lower', 'upper', 'grid-count', 'size-base', 'leverage', 'auto-stop',
  'risk-preview', 'start-btn', 'stop-btn', 'adjust-btn', 'cancel-orders-btn', 'refill-btn',
  'action-status', 'orphan-prompt', 'orphan-recover', 'orphan-regrid', 'orphan-close',
  'st-run', 'st-price', 'st-bal', 'st-eq', 'st-pos', 'st-entry', 'st-liq', 'st-rpnl', 'st-upnl',
  'st-total', 'st-orders', 'reset-btn', 'reconnect-btn', 'range-warn', 'chart', 'fills', 'alerts',
]) {
  assert.ok(html.includes(`id="\${p}-${suffix}"`), `shared venue template should expose ${suffix}`);
}

assert.match(html, /makeOverviewCard\(meta\);\s*makeVenuePanel\(meta\);/);
assert.match(html, /exchangeCtrls\[meta\.key\] = makeExchangeCtrl\(meta\.key, meta\.key \+ '-chart'\)/);
assert.doesNotMatch(html, /makeCompactVenueCtrl|new-venue-grid|compact-venue/);
assert.doesNotMatch(html, /ip-new-status/);
assert.match(html, /\.overview-grid\s*\{[^}]*repeat\(5, minmax\(0, 1fr\)\)/);
assert.match(html, /class="btn btn-ghost auth-logout"/);
assert.match(html, /\/api\/auth\/logout/);
assert.match(html, /X-Auth-Required/);
assert.match(loginHtml, /jaychougo@gmail\.com/);
assert.match(loginHtml, /autocomplete="current-password"/);
assert.match(loginHtml, /\/api\/auth\/login/);

console.log('frontend venue UI parity contract passed');
