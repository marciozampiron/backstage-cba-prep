#!/usr/bin/env node
// Artifact leak scan (#67) — deny-by-default inspection of everything the BROWSER can download.
//
// Method mirrors the #56 exam-mode allowlist philosophy (`additionalProperties: false`): instead
// of hunting a fixed list of bad strings, it asserts that the artifact contains NONE of the
// server-only material, and it derives the question-bank probes FROM THE REAL BANK so a future
// rename of a correction field cannot silently pass a stale denylist.
//
// Usage:
//   node scripts/leak-scan.mjs                 browser assets only, whichever exist
//                                              (.open-next/assets, .next/static)
//   node scripts/leak-scan.mjs --cloudflare    REQUIRES the critical artifacts (assets,
//                                              worker.js, server-functions) and scans them plus
//                                              the prerendered cache and middleware,
//                                              additionally proving the in-process BFF and AWS
//                                              internals are absent
//   node scripts/leak-scan.mjs <dir ...>       explicit targets (used by the positive controls)
//   ... --root <dir>                           resolve targets under <dir> instead of web/
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.dirname(WEB);
const DEFAULT_TARGETS = ['.open-next/assets', '.next/static'];
// The Cloudflare artifact: what the browser downloads PLUS what the Worker executes PLUS the
// prerendered cache (which can hold rendered page payloads).
const CLOUDFLARE_REQUIRED = ['.open-next/assets', '.open-next/worker.js', '.open-next/server-functions'];
const CLOUDFLARE_OPTIONAL = ['.open-next/cache', '.open-next/middleware'];
const CLOUDFLARE_TARGETS = [...CLOUDFLARE_REQUIRED, ...CLOUDFLARE_OPTIONAL];

/* ---------------- probes ---------------- */

// Server-side material that must never ship inside the Cloudflare Worker: the learner API runs on
// AWS (ADR-0002), so the in-process BFF, its persistence adapter and the AWS SDK must all be
// aliased out by the CBA_BUILD_TARGET=cloudflare build. Only checked in --cloudflare mode, where
// the Worker bundle is in scope.
const WORKER_FORBIDDEN_PATTERNS = [
  { label: 'in-process BFF DynamoDB adapter', re: /DynamoDbSimulationRepository|dynamodb-repository/ },
  { label: 'AWS SDK DynamoDB client', re: /DynamoDBDocumentClient|@aws-sdk\/(?:client|lib)-dynamodb/ },
  { label: 'in-process BFF simulation store', re: /claimActiveMock|releaseActiveMock/ },
  { label: 'in-process BFF Cognito adapter', re: /principalFromJwtClaims|createProfileLoader/ },
];

// Structural secrets/infra that must never reach a browser bundle.
const FORBIDDEN_PATTERNS = [
  { label: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/ },
  { label: 'AWS account id in an ARN', re: /arn:aws:[a-z0-9-]*:[a-z0-9-]*:\d{12}:/ },
  { label: 'private key block', re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
  { label: 'Cloudflare API token assignment', re: /CLOUDFLARE_API_TOKEN\s*[:=]\s*["'][^"']+["']/ },
  { label: 'AWS secret access key assignment', re: /aws_secret_access_key\s*[:=]\s*["'][^"']+["']/i },
  { label: 'Bedrock model configuration', re: /bedrock[:.-][a-z0-9-]*(?:invoke|runtime|model)/i },
  { label: 'DynamoDB table handle', re: /dynamodb:(?:GetItem|PutItem|Query|Scan|UpdateItem)/ },
  // The BFF base URL must arrive as Worker RUNTIME config; a NEXT_PUBLIC_* copy would mean it was
  // frozen into the bundle at build time, breaking build-once/promote-the-same-artifact (#56 §1).
  { label: 'NEXT_PUBLIC_ BFF base URL (build-time frozen config)', re: /NEXT_PUBLIC_[A-Z0-9_]*BFF[A-Z0-9_]*/ },
];

// Correction/answer fields from the question bank. Derived from the real schema + bank so the
// probe cannot go stale.
function bankProbes() {
  const bankDir = path.join(REPO, 'questions');
  const files = readdirSync(bankDir).filter((f) => f.endsWith('.json') && f !== 'schema.json');
  const fieldNames = new Set(['correctOption', 'explanation', 'source']);
  const stems = [];
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(path.join(bankDir, file), 'utf8'));
    const questions = Array.isArray(parsed) ? parsed : (parsed.questions ?? []);
    for (const q of questions) {
      for (const key of Object.keys(q)) fieldNames.add(key);
      // A verbatim question text in a browser asset means the bank itself was bundled. The bank
      // stores it under `question`; `stem`/`prompt` are accepted as aliases so a schema rename
      // does not silently disable this probe.
      const text = q.question ?? q.stem ?? q.prompt;
      if (typeof text === 'string' && text.length > 40) stems.push(text);
    }
  }
  // Only the answer-bearing subset is forbidden: ids/domain metadata legitimately reach the UI.
  const forbiddenFields = [...fieldNames].filter((f) =>
    /^(correctOption|correctAnswer|answer|solution|explanation|rationale|isCorrect|grading)$/i.test(f),
  );
  if (forbiddenFields.length === 0 || stems.length === 0) {
    // A probe set that silently emptied out (schema rename, unreadable bank) would make the scan
    // pass vacuously. Fail loudly instead.
    throw new Error(
      `leak-scan: probe derivation produced ${forbiddenFields.length} field and ${stems.length} text probes — ` +
        'the question bank shape changed; update bankProbes() before trusting this scan.',
    );
  }
  return { forbiddenFields, stems };
}

/* ---------------- scan ---------------- */

function* files(entry) {
  if (statSync(entry).isDirectory()) {
    for (const child of readdirSync(entry)) yield* files(path.join(entry, child));
  } else {
    yield entry;
  }
}

function scan(targets, { worker = false, root = WEB } = {}) {
  const { forbiddenFields, stems } = bankProbes();
  const patterns = worker ? [...FORBIDDEN_PATTERNS, ...WORKER_FORBIDDEN_PATTERNS] : FORBIDDEN_PATTERNS;
  const findings = [];
  let scanned = 0;
  const scannedTargets = [];

  for (const target of targets) {
    const dir = path.isAbsolute(target) ? target : path.join(root, target);
    if (!existsSync(dir)) continue;
    scannedTargets.push(path.relative(root, dir));
    for (const file of files(dir)) {
      // Binary assets (fonts/images) cannot carry readable leaks; skip to keep the scan fast.
      if (/\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp4|webm)$/i.test(file)) continue;
      const content = readFileSync(file, 'utf8');
      scanned += 1;
      const rel = path.relative(root, file);

      for (const { label, re } of patterns) {
        if (re.test(content)) findings.push(`${rel}: ${label}`);
      }
      for (const field of forbiddenFields) {
        // Match the JSON/property shape, not the bare word, so unrelated identifiers do not trip.
        if (new RegExp(`["']${field}["']\\s*:`).test(content)) {
          findings.push(`${rel}: question-bank correction field "${field}"`);
        }
      }
      for (const stem of stems) {
        if (content.includes(stem)) {
          findings.push(`${rel}: verbatim question stem from the bank`);
          break;
        }
      }
    }
  }
  return {
    findings,
    scanned,
    scannedTargets,
    probeCount: forbiddenFields.length + stems.length,
    patternCount: patterns.length,
  };
}

const args = process.argv.slice(2);
const cloudflare = args.includes('--cloudflare');
const rootFlag = args.findIndex((a) => a === '--root');
// `--root <dir>` scans an artifact tree somewhere else. Used by the automated self-test to prove
// the positive controls against synthetic artifacts; production runs use the default (web/).
const root = rootFlag >= 0 ? path.resolve(args[rootFlag + 1]) : WEB;
const explicit = args.filter((a, i) => !a.startsWith('--') && i !== rootFlag + 1);

if (cloudflare && explicit.length === 0) {
  // Never pass by scanning nothing, and never pass on a partial artifact: each critical piece of
  // the Cloudflare output must be present or the gate is meaningless.
  const missing = CLOUDFLARE_REQUIRED.filter((t) => !existsSync(path.join(root, t)));
  if (missing.length > 0) {
    console.error(
      `leak-scan --cloudflare: required artifact(s) missing: ${missing.join(', ')}. ` +
        'Run `npm run cf:build` first.',
    );
    process.exit(1);
  }
}

const targets = explicit.length > 0 ? explicit : cloudflare ? CLOUDFLARE_TARGETS : DEFAULT_TARGETS;
const { findings, scanned, scannedTargets, probeCount, patternCount } = scan(targets, {
  worker: cloudflare,
  root,
});

if (scannedTargets.length === 0) {
  console.error(`leak-scan: none of the targets exist (${targets.join(', ')}). Build first.`);
  process.exit(1);
}

const surface = cloudflare ? 'browser assets + Worker bundle' : 'browser-reachable';
console.log(`leak-scan${cloudflare ? ' --cloudflare' : ''}: ${scanned} ${surface} files in ${scannedTargets.join(', ')}`);
console.log(`leak-scan: ${patternCount} structural probes + ${probeCount} bank probes`);

if (findings.length > 0) {
  console.error(`\nLEAK SCAN FAILED — ${findings.length} finding(s):`);
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exit(1);
}
console.log('leak-scan: PASS — no credentials, ARNs, Bedrock/DynamoDB handles, build-frozen BFF config, question-bank answers, or (in --cloudflare mode) in-process BFF/AWS internals.');
