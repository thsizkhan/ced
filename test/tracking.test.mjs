// TrueQuote Homes tracking tests (dependency-free).
// Executes the page's real inline <script> logic in a Node vm sandbox with a
// minimal window/document mock, then asserts on the Beacon click URL it builds.
//
// Run:  node --test test/tracking.test.mjs
//
// These tests protect native service-link navigation and the tracking wiring:
//  - Service clicks keep native anchor navigation; analytics failures cannot block it.
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
function makeEnv({ search = '', cookies = [], readyState = 'complete', links = [] } = {}) {
  let jar = '';
  const listeners = {};
  const activity = { assigned: [], timers: [] };
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
    querySelectorAll: (selector) => selector === '.tile[data-service]' ? links : [],
    addEventListener: (name, handler) => { listeners[name] = handler; },
    readyState,
  };
  const location = {
    search,
    href: 'https://truequotehomes.com/' + search,
    assign(url) { activity.assigned.push(url); },
  };

  const sandbox = {
    URL,
    URLSearchParams,
    Date,
    console,
    setTimeout(handler, delay) {
      activity.timers.push({ handler, delay });
      return activity.timers.length;
    },
  };
  vm.createContext(sandbox);
  sandbox.window = sandbox;        // window === global object (browser semantics)
  sandbox.document = document;
  sandbox.location = location;
  sandbox.__activity = activity;
  sandbox.__listeners = listeners;
  for (const c of cookies) document.cookie = c;

  vm.runInContext(SCRIPT_SOURCE, sandbox);
  return sandbox;
}

const paramsOf = (url) => new URL(url).searchParams;

function staticServiceLinks() {
  const links = new Map();
  const re = /<a class="tile" data-service="([^"]+)" href="([^"]+)"/g;
  let match;
  while ((match = re.exec(HTML)) !== null) {
    links.set(match[1], match[2].replaceAll('&amp;', '&'));
  }
  return links;
}

function tqGoSource() {
  const match = HTML.match(/function tqGo\([^)]*\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'tqGo function is present');
  return match[0];
}

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
    search: '?sub1=paid-source&sub3=adset7&sub4=ad9&sub5=feed&fbclid=FBX9&utm_source=meta&utm_medium=cpc&utm_campaign=camp42&utm_content=creative5&utm_term=roofing&ttclid=TTX7',
    cookies: ['_fbp=fb.1.100.200'],
  });
  const p = paramsOf(env.tqBeaconUrl('roofing'));
  assert.equal(p.get('sub1'), 'paid-source');
  assert.equal(p.get('sub2'), 'roofing');
  assert.equal(p.get('sub3'), 'adset7');
  assert.equal(p.get('sub4'), 'ad9');
  assert.equal(p.get('sub5'), 'feed');
  assert.equal(p.get('fbclid'), 'FBX9');
  assert.equal(p.get('utm_source'), 'meta');
  assert.equal(p.get('utm_medium'), 'cpc');
  assert.equal(p.get('utm_campaign'), 'camp42');
  assert.equal(p.get('utm_content'), 'creative5');
  assert.equal(p.get('utm_term'), 'roofing');
  assert.equal(p.get('fbp'), 'fb.1.100.200');
  assert.ok((p.get('fbc') || '').startsWith('fb.1.'), 'fbc synthesized from fbclid');
  assert.equal(p.get('ttclid'), 'TTX7');
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

test('11. every service click uses native navigation with a valid Beacon href', () => {
  const env = makeEnv({
    search: '?utm_source=meta&utm_medium=paid&fbclid=FBCLICK&ttclid=TTCLICK',
    cookies: ['_fbp=fb.1.100.200', '_fbc=fb.1.100.FBCLICK', '_ttp=ttp.first.party.9'],
  });

  for (const service of SERVICES) {
    const link = { href: staticServiceLinks().get(service) };
    let prevented = false;
    const result = env.tqGo({ preventDefault() { prevented = true; } }, link, service);
    const url = new URL(link.href);

    assert.equal(result, true, `${service} allows native anchor navigation`);
    assert.equal(prevented, false, `${service} does not cancel the click`);
    assert.equal(url.hostname, BEACON_HOST);
    assert.equal(url.pathname, BEACON_PATH);
    assert.equal(url.searchParams.get('sub1'), 'meta');
    assert.equal(url.searchParams.get('sub2'), service);
    assert.equal(url.searchParams.get('utm_medium'), 'paid');
    assert.equal(url.searchParams.get('fbclid'), 'FBCLICK');
    assert.equal(url.searchParams.get('fbp'), 'fb.1.100.200');
    assert.equal(url.searchParams.get('fbc'), 'fb.1.100.FBCLICK');
    assert.equal(url.searchParams.get('ttclid'), 'TTCLICK');
    assert.equal(url.searchParams.get('ttp'), 'ttp.first.party.9');
  }

  assert.deepEqual(env.__activity.timers, [], 'no delayed navigation timer');
  assert.deepEqual(env.__activity.assigned, [], 'no scripted location assignment');
});

test('12. tqGo has no cancel-and-delay navigation dependency', () => {
  const source = tqGoSource();
  assert.doesNotMatch(source, /preventDefault/);
  assert.doesNotMatch(source, /setTimeout/);
  assert.doesNotMatch(source, /location\.assign/);
  assert.match(source, /return true;/);
  assert.doesNotMatch(HTML, /OFFER_CLICK_DELAY_MS/);
});

test('13. missing or throwing fbq cannot block native navigation', () => {
  for (const mode of ['undefined', 'throwing']) {
    const env = makeEnv({ search: '?sub1=paid' });
    if (mode === 'undefined') {
      delete env.fbq;
    } else {
      env.fbq = () => { throw new Error('simulated Meta failure'); };
    }

    const link = { href: staticServiceLinks().get('roofing') };
    assert.equal(env.tqGo({}, link, 'roofing'), true, `${mode} fbq allows native navigation`);
    assert.equal(new URL(link.href).searchParams.get('sub2'), 'roofing');
    assert.deepEqual(env.__activity.timers, []);
    assert.deepEqual(env.__activity.assigned, []);
  }
});

test('14. clicks before DOMContentLoaded retain a safe static href and work natively', () => {
  const staticLinks = staticServiceLinks();
  assert.deepEqual([...staticLinks.keys()], SERVICES);

  for (const service of SERVICES) {
    const staticUrl = new URL(staticLinks.get(service));
    assert.equal(staticUrl.hostname, BEACON_HOST);
    assert.equal(staticUrl.pathname, BEACON_PATH);
    assert.equal(staticUrl.searchParams.get('sub1'), 'organic');
    assert.equal(staticUrl.searchParams.get('sub2'), service);
  }

  const env = makeEnv({ readyState: 'loading', search: '?utm_source=early' });
  assert.equal(typeof env.__listeners.DOMContentLoaded, 'function');
  const link = { href: staticLinks.get('windows') };
  assert.equal(env.tqGo({}, link, 'windows'), true);
  assert.equal(new URL(link.href).searchParams.get('sub1'), 'early');
  assert.equal(new URL(link.href).searchParams.get('sub2'), 'windows');
});

test('15. Meta and TikTok PageView plus Meta OfferClick remain present', () => {
  assert.match(HTML, /fbq\('track','PageView'\)/);
  assert.match(HTML, /fbq\('trackCustom','OfferClick',\{content_name:service\}\)/);
  assert.match(HTML, /fbq\('init','1704418213974680'\)/);
  assert.match(HTML, /ttq\.load\('DAIN273C77UES975010G'\)/);
  assert.match(HTML, /ttq\.page\(\)/);
});

test('16. sub1 precedence and ttp URL fallback remain unchanged', () => {
  const explicit = paramsOf(makeEnv({
    search: '?sub1=campaign&utm_source=meta&ttp=url-ttp',
  }).tqBeaconUrl('other'));
  assert.equal(explicit.get('sub1'), 'campaign');
  assert.equal(explicit.get('ttp'), 'url-ttp');

  const utm = paramsOf(makeEnv({ search: '?utm_source=meta' }).tqBeaconUrl('other'));
  assert.equal(utm.get('sub1'), 'meta');

  const organic = paramsOf(makeEnv({}).tqBeaconUrl('other'));
  assert.equal(organic.get('sub1'), 'organic');
});
