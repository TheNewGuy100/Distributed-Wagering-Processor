import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootApp, type TestApp } from './helpers';

const uiDir = join(import.meta.dir, '../../src/interfaces/http/ui');
const source = (name: string) => readFileSync(join(uiDir, name), 'utf8');

let t: TestApp;
beforeAll(async () => {
  t = await bootApp();
});
afterAll(() => t.close());

const get = (path: string, app: TestApp = t) => fetch(`${app.url}${path}`, { redirect: 'manual' });

describe('the test console is served', () => {
  test('GET / redirects to /ui', async () => {
    const r = await get('/');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/ui');
  });

  test('the page and its two assets, with the right content types', async () => {
    const page = await get('/ui');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('<title>Wagering Processor');

    const js = await get('/ui/app.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(await js.text()).toContain("'use strict'");

    const css = await get('/ui/app.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  test('every response carries a strict security policy', async () => {
    for (const path of ['/ui', '/ui/app.js', '/ui/app.css']) {
      const r = await get(path);
      const csp = r.headers.get('content-security-policy') ?? '';
      expect(csp, path).toContain("default-src 'none'");
      expect(csp, path).toContain("script-src 'self'");
      expect(csp, path).toContain("connect-src 'self'");
      expect(csp, path).toContain("frame-ancestors 'none'");
      expect(csp, path).not.toContain('unsafe-inline');
      expect(csp, path).not.toContain('unsafe-eval');
      expect(csp, path).not.toMatch(/https?:\/\//); // no external origin is trusted
      expect(r.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(r.headers.get('x-frame-options'), path).toBe('DENY');
      expect(r.headers.get('referrer-policy'), path).toBe('no-referrer');
      expect(r.headers.get('cache-control'), path).toBe('no-store');
    }
  });

  test('stays reachable when authentication is on (it holds no data; its API calls still need a token)', async () => {
    const app = await bootApp({ AUTH_MODE: 'jwt', AUTH_ISSUER: 'https://idp.example.test', AUTH_AUDIENCE: 'wagering-api' });
    try {
      expect((await get('/ui', app)).status).toBe(200);
      expect((await get('/ui/app.js', app)).status).toBe(200);
      expect((await get('/', app)).status).toBe(302);
      expect((await get('/wallets/00000000-0000-0000-0000-000000000000', app)).status).toBe(401); // the API itself is protected
    } finally {
      await app.close();
    }
  });

  test('can be switched off with UI_ENABLED=false', async () => {
    const app = await bootApp({ UI_ENABLED: 'false' });
    try {
      for (const path of ['/', '/ui', '/ui/app.js', '/ui/app.css']) expect((await get(path, app)).status, path).toBe(404);
      expect((await get('/health/live', app)).status).toBe(200); // the rest of the API is unaffected
    } finally {
      delete process.env.UI_ENABLED;
      await app.close();
    }
  });
});

/**
 * The page renders values chosen by whoever called the API (player ids, provider ids, ...). It must never turn them
 * into markup, and must work under the strict CSP above (no inline script or handlers). These checks guard the source
 * so a convenient `innerHTML` cannot slip in unnoticed; the behaviour was also verified in a real browser with a
 * hostile payload (<img onerror>, <script>, <svg onload>) that is displayed as text and never executes.
 */
describe('the page cannot turn data into markup', () => {
  /** Code only: comments may (and do) mention the very APIs the page promises not to use. */
  const withoutComments = (js: string) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

  test('the comment stripper really removes comments but keeps code', () => {
    const stripped = withoutComments("const a = 1; // innerHTML in a comment\n/* innerHTML\n in a block */ el.innerHTML = x;");
    expect(stripped).not.toContain('in a comment');
    expect(stripped).not.toContain('in a block');
    expect(stripped).toContain('el.innerHTML = x;'); // real code is still caught
  });

  test('app.js never parses strings as HTML or code', () => {
    const js = withoutComments(source('app.js'));
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setTimeout("', "setTimeout('", 'srcdoc']) {
      expect(js, `app.js must not use ${forbidden}`).not.toContain(forbidden);
    }
  });

  test('index.html has no inline script, no inline handlers, no inline styles and no external resources', () => {
    const html = source('index.html');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i); // only <script src="...">
    expect(html).not.toMatch(/\son[a-z]+\s*=/i); // onclick=, onerror=, ...
    expect(html).not.toMatch(/\sstyle\s*=/i);
    // No external RESOURCE (script, stylesheet, image, frame...). Plain links to the other local systems of the compose
    // stack are navigation, not resources, and may only point at localhost.
    expect(html).not.toMatch(/\ssrc\s*=\s*["']https?:\/\//i);
    expect(html).not.toMatch(/<link[^>]+href\s*=\s*["']https?:\/\//i);
    for (const [, href] of html.matchAll(/<a\s[^>]*href\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
      expect(href).toMatch(/^http:\/\/localhost:\d+\/?$/);
    }
    for (const tag of html.matchAll(/<a\s[^>]*target\s*=\s*["']_blank["'][^>]*>/gi)) {
      expect(tag[0]).toContain('noopener'); // a link opened in a new tab must not get a handle on this window
    }
    expect(html).not.toMatch(/javascript:/i);
  });

  test('app.js only talks to its own origin (root-relative URLs)', () => {
    const js = source('app.js');
    expect(js).not.toMatch(/fetch\(\s*['"`]https?:\/\//);
    expect(js).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
  });
});
