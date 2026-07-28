// Structural guarantees for the Cloudflare Worker configuration (#67 Stage B).
//
// These assert the EFFECTIVE per-environment configuration, not the presence of a key. Both
// `workers_dev` and `preview_urls` default to TRUE in Wrangler, so an absent setting is not a
// neutral omission — it publishes preview URLs. That is the failure this file exists to catch, and
// it is invisible in a diff that simply never mentions the setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WEB = dirname(dirname(fileURLToPath(import.meta.url)));

/** Strip `//` comments so the JSONC config can be parsed without a dependency. */
function readWrangler() {
  const raw = readFileSync(join(WEB, 'wrangler.jsonc'), 'utf8');
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
}

test('every environment states workers_dev and preview_urls explicitly', () => {
  const config = readWrangler();
  assert.deepEqual(Object.keys(config.env).sort(), ['dev', 'pilot']);
  for (const [name, env] of Object.entries(config.env)) {
    // Presence is the whole point: both default to true, so "unset" means "published".
    assert.equal(typeof env.workers_dev, 'boolean', `${name}: workers_dev must be explicit`);
    assert.equal(typeof env.preview_urls, 'boolean', `${name}: preview_urls must be explicit`);
  }
});

test('pilot publishes no preview URLs and no workers.dev origin', () => {
  const { env } = readWrangler();
  // "Previews must never point at pilot" is a contract rule, not a preference.
  assert.equal(env.pilot.preview_urls, false);
  // Fail-closed while the custom-domain-versus-workers.dev decision is open: nothing is published
  // by default. Flipping this is part of that decision, alongside the CORS origin and the Cognito
  // callback URLs.
  assert.equal(env.pilot.workers_dev, false);
});

test('dev keeps UI-only previews, which are never CORS-allow-listed', () => {
  const { env } = readWrangler();
  assert.equal(env.dev.preview_urls, true);
  assert.equal(env.dev.workers_dev, true);
});

test('each environment has its own Worker name, and no routes or vars are committed', () => {
  const config = readWrangler();
  assert.equal(config.env.dev.name, 'cba-study-coach-dev-web');
  assert.equal(config.env.pilot.name, 'cba-study-coach-pilot-web');
  assert.notEqual(config.env.dev.name, config.env.pilot.name, 'a shared name lets dev overwrite pilot');

  for (const [name, env] of Object.entries(config.env)) {
    // A committed route would silently decide the open origin question; a committed var would be
    // an endpoint in a tracked file and a build-time freeze of per-request configuration.
    assert.equal(env.routes, undefined, `${name}: routes belong to the #70 deploy`);
    assert.equal(env.route, undefined, `${name}: routes belong to the #70 deploy`);
    assert.equal(env.vars, undefined, `${name}: runtime variables are supplied at deploy time`);
  }
  assert.equal(config.vars, undefined, 'no top-level vars either');
});

test('no Cloudflare account or zone identifier is committed', () => {
  const raw = readFileSync(join(WEB, 'wrangler.jsonc'), 'utf8');
  assert.equal(/account_id/.test(raw), false);
  assert.equal(/zone_id|zone_name/.test(raw), false);
  assert.equal(/\b[0-9a-f]{32}\b/.test(raw), false, 'a 32-hex id is an account or zone identifier');
});
