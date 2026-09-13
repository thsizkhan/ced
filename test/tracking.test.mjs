// TrueQuote Homes tracking tests (dependency-free).
// Executes the page's real inline <script> logic in a Node vm sandbox with a
// minimal window/document mock, then asserts on the Beacon click URL it builds.
//
// Run:  node --test test/tracking.test.mjs
//
// These tests protect the TikTok base-pixel + attribution wiring:
//  - TikTok base pixel present, PageView only (no browser-side conversion).
//  - ttclid (URL) and ttp (_ttp cookie) forwarded to Beacon when present, never fabricated.
//  - Existing Meta (fbclid/_fbp/fbc) + UTM + sub2 routing through Beacon preserved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(ROOT, 'index.html'), 'utf8');
const PIXEL_ID = 'DAIN273C77UES975010G';
const BEACON_HOST = 'track.beaconaffiliates.com';
const BEACON_PATH = '/c/-zjrXgp2CbtSmgtz';
const SERVICES = ['roofing', 'windows', 'bathroom', 'other'];

// Extract inline <script> blocks (those without a src attribute) in document order.
function inlineScripts(html) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}
const SCRIPT_SOURCE = inlineScripts(HTML).join('\n;\n');

// Build a fresh browser-like sandbox, run the page scripts, and return the global
// (so tests can call the page's own tqBeaconUrl()).
function makeEnv({ search = '', cookies = [] } = {}) {
  let jar = '';
  const document = {
    get cookie() { return jar; },
    set cookie(v) {
      const pair = String(v).split(';')[0].trim();
      if (!pair) return;
      const name = pair.slice(0, pair.indexOf('=') === -1 ? pair.length : pair.indexOf('='));
      const parts = jar ? jar.split('; ') : [];
      const i = parts.findIndex((p) => p.slice(0, p.indexOf('=')) === name);
      if (i >= 0) parts[i] = pair; else parts.push(pair);
      jar = parts.join('; ');
    },
    createElement: () => ({ set src(_v) {}, get src() { return ''; } }),
    getElementsByTagName: () => [{ parentNode: { insertBefore() {} } }],
    querySelectorAll: () => [],
    addEventListener: () => {},
    readyState: 'complete',
  };
  const location = { search, href: 'https://truequotehomes.com/' + search, assign() {} };

  const sandbox = { URL, URLSearchParams, Date, console, setTimeout: () => 0 };
  vm.createContext(sandbox);
  sandbox.window = sandbox;        // window === global object (browser semantics)
  sandbox.document = document;
  sandbox.location = location;
  for (const c of cookies) document.cookie = c;

  vm.runInContext(SCRIPT_SOURCE, sandbox);
  return sandbox;
}

const paramsOf = (url) => new URL(url).searchParams;

test('1. TikTok base Pixel ID present (PageView base code)', () => {
  assert.match(HTML, new RegExp(`ttq\\.load\\('${PIXEL_ID}'\\)`));
  assert.match(HTML, /ttq\.page\(\)/); // PageView / identity only
});

test('2. no browser-side Lead / conversion event fired', () => {
  assert.doesNotMatch(HTML, /ttq\.track\s*\(/i);            // no TikTok event tracking at all
  assert.doesNotMatch(HTML, /SubmitForm|CompleteRegistration/i);
  assert.doesNotMatch(HTML, /ttq[^\n]*['"]Lead['"]/i);      // no TikTok Lead
});

test('3. landing-URL ttclid is preserved to Beacon', () => {
  const p = paramsOf(makeEnv({ search: '?ttclid=TTCLID_123' }).tqBeaconUrl('roofing'));
  assert.equal(p.get('ttclid'), 'TTCLID_123');
});

test('4. _ttp cookie is forwarded as ttp when present', () => {
  const p = paramsOf(makeEnv({ cookies: ['_ttp=ttp.first.party.9'] }).tqBeaconUrl('windows'));
  assert.equal(p.get('ttp'), 'ttp.first.party.9');
});

test('5. missing ttclid is NOT fabricated', () => {
  const p = paramsOf(makeEnv({}).tqBeaconUrl('bathroom'));
  assert.equal(p.get('ttclid'), null);
});

test('6. missing _ttp is NOT fabricated', () => {
  const p = paramsOf(makeEnv({}).tqBeaconUrl('other'));
  assert.equal(p.get('ttp'), null);
});

test('7. existing fbclid / _fbp / fbc / UTM forwarding still works', () => {
  const env = makeEnv({
    search: '?fbclid=FBX9&utm_source=meta&utm_medium=cpc&utm_campaign=camp42',
    cookies: ['_fbp=fb.1.100.200'],
  });
  const p = paramsOf(env.tqBeaconUrl('roofing'));
  assert.equal(p.get('fbclid'), 'FBX9');
  assert.equal(p.get('utm_source'), 'meta');
  assert.equal(p.get('utm_medium'), 'cpc');
  assert.equal(p.get('utm_campaign'), 'camp42');
  assert.equal(p.get('fbp'), 'fb.1.100.200');
  assert.ok((p.get('fbc') || '').startsWith('fb.1.'), 'fbc synthesized from fbclid');
});

test('8. windows still maps to sub2=windows', () => {
  const p = paramsOf(makeEnv({}).tqBeaconUrl('windows'));
  assert.equal(p.get('sub2'), 'windows');
});

test('9. no direct ADG routing is introduced', () => {
  assert.doesNotMatch(HTML, /adgtrax?\.com|adgtrx\.com|alpine[- ]?digital/i);
  const env = makeEnv({});
  for (const svc of SERVICES) {
    assert.equal(new URL(env.tqBeaconUrl(svc)).hostname, BEACON_HOST);
  }
});

test('10. existing service links continue through Beacon', () => {
  const staticHrefs = [...HTML.matchAll(/href="(https:\/\/track\.beaconaffiliates\.com[^"]*)"/g)];
  assert.ok(staticHrefs.length >= SERVICES.length, 'static tile hrefs point at Beacon');
  const env = makeEnv({});
  for (const svc of SERVICES) {
    const u = new URL(env.tqBeaconUrl(svc));
    assert.equal(u.origin, `https://${BEACON_HOST}`);
    assert.ok(u.pathname.includes(BEACON_PATH), 'Beacon tracking path preserved');
    assert.equal(u.searchParams.get('sub2'), svc);
  }
});
