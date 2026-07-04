import fs from 'node:fs';
import path from 'node:path';
import { EXAM, DOMAINS } from '../lib/blueprint.js';
import { SPEC_DIR } from '../lib/paths.js';
import { callLLM, extractJson, stripHtml } from '../lib/llm.js';
import { c, hr } from '../lib/ui.js';
import { createModelProvider } from '../infrastructure/ai/index.js';

const BLUEPRINT_FILE = path.join(SPEC_DIR, 'blueprint.json');

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Derive a short unique id prefix from a domain name (initials, then disambiguate).
function derivePrefix(name, taken) {
  const words = String(name).toLowerCase().replace(/[^a-z0-9 ]+/g, '').split(/\s+/).filter(Boolean);
  const base = (words.map((w) => w[0]).join('') || 'dom').slice(0, 5);
  let p = base;
  let i = 1;
  while (taken.has(p)) p = `${base}${i++}`;
  taken.add(p);
  return p;
}

// Allocate `total` questions across domain weights; leftover questions go to the
// heaviest-weight domains first (stable, and matches the documented 14/13/13/20 split).
function computeTargets(domains, total) {
  const rows = domains.map((d) => {
    const exact = ((Number(d.weight) || 0) / 100) * total;
    return { d, floor: Math.floor(exact) };
  });
  let left = total - rows.reduce((s, r) => s + r.floor, 0);
  rows.sort((a, b) => (Number(b.d.weight) || 0) - (Number(a.d.weight) || 0));
  for (let i = 0; i < rows.length && left > 0; i++, left--) rows[i].floor++;
  for (const r of rows) r.d.target = r.floor;
}

function buildPrompt(pageText, examName) {
  return `You are extracting the official exam blueprint from a certification web page. Read ONLY the text below and return the domains and competencies exactly as published.

Return ONLY JSON of this shape:
{"exam":{"name":"..."},"domains":[{"name":"...","weight":<integer percent>,"competencies":["...","..."]}]}

Rules:
- Use the exact domain names and competency wording from the page.
- "weight" is the integer percentage shown for the domain (e.g., 24 for "24%").
- Include every competency listed under each domain.
- Do NOT invent domains, weights, or competencies. If the page shows none, return an empty domains array.
- Output JSON only, no prose or code fences.

Exam (for reference): ${examName}

PAGE TEXT:
${pageText.slice(0, 24000)}`;
}

// Merge extracted domains with the current blueprint: preserve key/prefix for domains
// matched by name, mint new ones otherwise, and (re)compute per-domain question targets.
function mergeBlueprint(extracted, current) {
  const currentByName = new Map(current.domains.map((d) => [d.name.toLowerCase().trim(), d]));
  const rows = (extracted.domains || []).map((ed) => {
    const match = currentByName.get(String(ed.name || '').toLowerCase().trim());
    return { ed, key: match?.key, prefix: match?.prefix };
  });
  const taken = new Set(rows.filter((r) => r.prefix).map((r) => r.prefix));
  for (const row of rows) {
    if (!row.key) row.key = slug(row.ed.name || '');
    if (!row.prefix) row.prefix = derivePrefix(row.ed.name || '', taken);
  }
  const next = {
    exam: {
      name: extracted.exam?.name || current.exam.name,
      totalQuestions: current.exam.totalQuestions,
      minutes: current.exam.minutes,
      defaultPassPct: current.exam.defaultPassPct,
      blueprintUrl: current.exam.blueprintUrl,
    },
    domains: rows.map((row) => ({
      key: row.key,
      name: row.ed.name,
      weight: Number(row.ed.weight),
      prefix: row.prefix,
      target: 0,
      competencies: Array.isArray(row.ed.competencies) ? row.ed.competencies : [],
    })),
  };
  computeTargets(next.domains, next.exam.totalQuestions);
  return next;
}

function validateBlueprint(bp) {
  const errs = [];
  if (!bp.domains || bp.domains.length === 0) {
    errs.push('no domains extracted from the page');
    return errs;
  }
  const sum = bp.domains.reduce((s, d) => s + (Number(d.weight) || 0), 0);
  if (sum < 90 || sum > 110) errs.push(`weights sum to ${sum}% (expected ~100%)`);
  const keys = new Set();
  const prefixes = new Set();
  for (const d of bp.domains) {
    if (!d.name || !String(d.name).trim()) errs.push('a domain has an empty name');
    if (!(Number(d.weight) > 0)) errs.push(`domain "${d.name}" has invalid weight ${d.weight}`);
    if (!d.competencies || d.competencies.length === 0) errs.push(`domain "${d.name}" has no competencies`);
    if (keys.has(d.key)) errs.push(`duplicate domain key "${d.key}"`);
    keys.add(d.key);
    if (prefixes.has(d.prefix)) errs.push(`duplicate prefix "${d.prefix}"`);
    prefixes.add(d.prefix);
  }
  return errs;
}

function diffBlueprint(current, next) {
  const lines = [];
  const cur = new Map(current.domains.map((d) => [d.name.toLowerCase().trim(), d]));
  const nxt = new Map(next.domains.map((d) => [d.name.toLowerCase().trim(), d]));
  if (current.exam.name !== next.exam.name) lines.push(`exam name: "${current.exam.name}" -> "${next.exam.name}"`);
  for (const [name, nd] of nxt) {
    const cd = cur.get(name);
    if (!cd) {
      lines.push(`+ domain "${nd.name}" (${nd.weight}%, ${nd.competencies.length} competencies)`);
      continue;
    }
    if (cd.weight !== nd.weight) lines.push(`~ "${nd.name}": weight ${cd.weight}% -> ${nd.weight}%`);
    const cc = new Set(cd.competencies);
    const nc = new Set(nd.competencies);
    for (const a of [...nc].filter((x) => !cc.has(x))) lines.push(`  + competency in "${nd.name}": ${a}`);
    for (const r of [...cc].filter((x) => !nc.has(x))) lines.push(`  - competency in "${nd.name}": ${r}`);
  }
  for (const [name, cd] of cur) if (!nxt.has(name)) lines.push(`- domain "${cd.name}" removed`);
  return lines;
}

// Core (injectable): fetch page -> LLM extract -> merge -> validate -> diff.
export async function generateBlueprint({ from, provider = 'anthropic', model, apiKey, fetchImpl = fetch, callImpl, modelProvider } = {}) {
  if (!from) throw new Error('missing source url');
  const current = { exam: EXAM, domains: DOMAINS };
  const res = await fetchImpl(from, { headers: { 'user-agent': 'backstage-cba-prep/blueprint' } });
  if (!res.ok) throw new Error(`fetch ${from} -> HTTP ${res.status}`);
  const pageText = stripHtml(await res.text());
  const prompt = buildPrompt(pageText, current.exam.name);
  let raw;
  let usage = null;
  if (callImpl) {
    raw = await callImpl(prompt);
  } else if (provider === 'anthropic') {
    // Same pattern as generate: route Anthropic through the ModelProvider port,
    // passing --model as a transient MODEL_STANDARD override (port stays tier-based).
    const env = { ...process.env, LLM_BACKEND: 'anthropic', ANTHROPIC_API_KEY: apiKey || process.env.ANTHROPIC_API_KEY };
    if (model) env.MODEL_STANDARD = model;
    const mp = modelProvider || createModelProvider({ env });
    const out = await mp.invoke({ prompt, tier: 'standard', options: { maxTokens: 4096 } });
    raw = out.text;
    usage = out.usage;
  } else {
    raw = await callLLM({ provider, model, prompt, apiKey, fetchImpl });
  }
  const extracted = extractJson(raw);
  const next = mergeBlueprint(extracted, current);
  const errors = validateBlueprint(next);
  const diff = diffBlueprint(current, next);
  return { current, next, errors, diff, changed: diff.length > 0, usage };
}

export async function runBlueprint(opts = {}) {
  const from = opts.from || EXAM.blueprintUrl;
  let result;
  try {
    result = await generateBlueprint({ ...opts, from });
  } catch (err) {
    console.log(c.red(`  ${err.message}`));
    if (/API[ _-]?key/i.test(err.message)) console.log(c.gray('  Set ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY, or pass --provider.'));
    return 1;
  }
  const { errors, diff, changed, next, usage } = result;

  if (opts.json) {
    console.log(JSON.stringify({ from, changed, errors, diff, next, usage }, null, 2));
    return errors.length ? 2 : changed && !opts.write ? 3 : 0;
  }

  console.log(`\n  ${c.bold('Blueprint from source')} ${c.gray(from)}`);
  console.log(hr());
  if (usage) console.log(c.gray(`  ~${usage.inputTokens} in / ${usage.outputTokens} out tokens (${usage.provider}/${usage.model})`));
  if (errors.length) {
    console.log(c.red('  ✗ Extracted blueprint failed validation:'));
    for (const e of errors) console.log(`    - ${e}`);
    console.log(c.gray('\n  Not writing. Fix the source page or extraction and retry.\n'));
    return 2;
  }
  if (!changed) {
    console.log(c.green('  ✓ Local blueprint already matches the source page.\n'));
    return 0;
  }
  console.log(c.bold(`  ${diff.length} change(s):`));
  for (const line of diff) console.log(`  ${line}`);
  console.log(hr());
  if (opts.write) {
    fs.writeFileSync(BLUEPRINT_FILE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(c.green('  ✓ Wrote spec/blueprint.json — run `node bin/cli.js validate` and review the diff.\n'));
    return 0;
  }
  console.log(c.gray('  Dry run. Re-run with --write to apply, or let CI open a PR.\n'));
  return 3;
}
