#!/usr/bin/env tsx
/**
 * Local submission validator. It never performs a network request.
 *
 *   npm run submission:check                  # reads submission/payload.json
 *   npm run submission:check -- path/to.json
 *
 * Prints the exact JSON the human would send, its byte size, and every error.
 * The submission window opens 2026-11-01T00:00:00Z; nothing here bypasses that.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED_FIELDS = new Set([
  'requestId',
  'projectName',
  'leadName',
  'email',
  'size',
  'tracks',
  'nearAddress',
  'projectUrl',
  'demoUrl',
  'idea',
  'consent',
]);

const SIZES = new Set(['1', '2 - 4', '4 - 6', '6 - 8', '8+']);
const TRACKS = new Set([
  'defi',
  'thesis',
  'privacy',
  'business',
  'swarms',
  'security',
  'agents',
  'realworld',
  'games',
  'nfts',
  'memecoins',
  'social',
  'open',
]);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NEAR_ADDRESS = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const MAX_BODY_BYTES = 12_000;

function pickPath(): string {
  const explicit = process.argv[2];
  const root = process.cwd();
  return explicit ? explicit : join(root, 'submission', 'payload.json');
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function main(): number {
  const path = pickPath();
  if (!existsSync(path)) {
    console.log('[submission] no payload file yet');
    console.log(`[submission] copy submission/payload.template.json to ${path} and fill it`);
    console.log('[submission] nothing was sent; the window opens 2026-11-01T00:00:00Z');
    return 0;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    console.error(`[submission] FAILED cannot parse ${path}: ${String(error)}`);
    return 1;
  }

  const errors: string[] = [];
  const add = (field: string, message: string): void => {
    errors.push(`${field}: ${message}`);
  };

  for (const field of Object.keys(payload)) {
    if (!ALLOWED_FIELDS.has(field)) add(field, 'is not an allowed field');
  }
  if ('website' in payload) add('website', 'is a spam trap and must never be sent');

  const stringField = (field: string, min: number, max: number): string => {
    const value = payload[field];
    if (typeof value !== 'string') {
      add(field, 'must be a string');
      return '';
    }
    if (value.length < min) add(field, `must be at least ${min} characters`);
    if (value.length > max) add(field, `must be at most ${max} characters`);
    return value;
  };

  const requestId = stringField('requestId', 36, 36);
  if (requestId !== '' && !UUID_V4.test(requestId)) add('requestId', 'must be a UUID v4');
  stringField('projectName', 2, 80);
  stringField('leadName', 2, 80);

  const email = stringField('email', 3, 160);
  if (email !== '' && !EMAIL.test(email)) add('email', 'must be a valid e-mail address');

  const size = payload.size;
  if (typeof size !== 'string' || !SIZES.has(size)) {
    add('size', 'must be exactly one of: 1, 2 - 4, 4 - 6, 6 - 8, 8+');
  }

  const tracks = payload.tracks;
  if (!Array.isArray(tracks) || tracks.length === 0) {
    add('tracks', 'must be a non-empty array');
  } else {
    const seen = new Set<string>();
    for (const track of tracks) {
      if (typeof track !== 'string' || !TRACKS.has(track)) {
        add('tracks', `contains an unknown track: ${String(track)}`);
        continue;
      }
      if (seen.has(track)) add('tracks', `contains a duplicate: ${track}`);
      seen.add(track);
    }
  }

  const nearAddress = stringField('nearAddress', 2, 64);
  if (nearAddress !== '' && !NEAR_ADDRESS.test(nearAddress)) {
    add('nearAddress', 'does not match the organiser account regex');
  }
  if (nearAddress !== nearAddress.toLowerCase()) add('nearAddress', 'must be lowercase');

  for (const field of ['projectUrl', 'demoUrl'] as const) {
    const value = payload[field];
    if (!isHttpUrl(value)) {
      add(field, 'must be an http(s) URL');
    } else if (value.length > 300) {
      add(field, 'must be at most 300 characters');
    }
  }

  const idea = stringField('idea', 20, 2000);
  if (idea !== '' && idea.includes('website')) {
    // Not an error by itself, but a nudge to keep the payload clean.
    console.log('[submission] note: idea mentions "website"; that is only a trap as a top-level field');
  }

  if (payload.consent !== true) add('consent', 'must be true after the human agreed verbatim');

  const body = JSON.stringify(payload);
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_BODY_BYTES) add('body', `is ${bytes} bytes; the limit is ${MAX_BODY_BYTES}`);

  console.log(`[submission] file=${path}`);
  console.log(`[submission] bytes=${bytes} / ${MAX_BODY_BYTES}`);

  if (errors.length > 0) {
    console.error(`[submission] FAILED ${errors.length} error(s); nothing was sent`);
    for (const error of errors) console.error(`[submission] - ${error}`);
    return 1;
  }

  console.log('[submission] OK all fields validated');
  console.log('[submission] reuse this requestId on every retry:');
  console.log(body);
  console.log('[submission] NOT SENT. Print this to the human, wait for a yes, and only');
  console.log('[submission] POST inside 2026-11-01T00:00:00Z .. 2026-11-14T23:59:00Z.');
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
