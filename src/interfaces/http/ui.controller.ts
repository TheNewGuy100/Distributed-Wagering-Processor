import { Controller, Get, NotFoundException, Res } from '@nestjs/common';
import type { Response } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Public } from './auth/auth.port';

const asset = (name: string): string => readFileSync(fileURLToPath(new URL(`./ui/${name}`, import.meta.url)), 'utf8');

/**
 * Locks the page down to what it needs: its own script and stylesheet, requests to its own origin, nothing else.
 * No inline script or style, no `eval`, no framing, no base-tag or form-submission tricks. Together with the page
 * rendering every API value as text, even a hostile string in a response cannot execute.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * A small browser console to try the API by hand (`/ui`). Static files only: it talks to the same endpoints
 * everyone else uses, so it needs no special access. Public (the page holds no data); every call it makes goes
 * through the normal authentication. Switch it off with `UI_ENABLED=false`.
 */
@Public()
@Controller()
export class UiController {
  private readonly enabled = (process.env.UI_ENABLED ?? 'true') !== 'false';
  /** In production the files are read once; elsewhere on every request, so edits show up on reload. */
  private readonly cache = process.env.NODE_ENV === 'production' ? new Map<string, string>() : null;

  private file(name: string): string {
    if (!this.cache) return asset(name);
    if (!this.cache.has(name)) this.cache.set(name, asset(name));
    return this.cache.get(name)!;
  }

  @Get()
  root(@Res() res: Response): void {
    this.assertEnabled();
    res.redirect(302, '/ui');
  }

  @Get('ui')
  index(@Res() res: Response): void {
    this.send(res, 'text/html; charset=utf-8', 'index.html');
  }

  @Get('ui/app.js')
  js(@Res() res: Response): void {
    this.send(res, 'text/javascript; charset=utf-8', 'app.js');
  }

  @Get('ui/app.css')
  css(@Res() res: Response): void {
    this.send(res, 'text/css; charset=utf-8', 'app.css');
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new NotFoundException();
  }

  private send(res: Response, type: string, name: string): void {
    this.assertEnabled();
    res
      .set({
        'Content-Type': type,
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
        'Cache-Control': 'no-store',
      })
      .send(this.file(name));
  }
}
