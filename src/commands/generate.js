import fs from 'node:fs';
import path from 'node:path';
import { resolveDomain } from '../lib/blueprint.js';
import { validateQuestion, appendQuestions, loadBank } from '../lib/bank.js';
import { SPEC_DIR } from '../lib/paths.js';
import { c } from '../lib/ui.js';
import { createModelProvider } from '../infrastructure/ai/index.js';

const PROVIDERS = {
  anthropic: { env: ['ANTHROPIC_API_KEY'], model: 'claude-sonnet-5', call: callAnthropic },
  openai: { env: ['OPENAI_API_KEY'], model: 'gpt-4o', call: callOpenAI },
  google: { env: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'], model: 'gemini-2.0-flash', call: callGoogle },
};

function readSpec(name) {
  try {
    return fs.readFileSync(path.join(SPEC_DIR, name), 'utf8');
  } catch {
    return '';
  }
}

function buildPrompt(domain, count) {
  const { byDomain } = loadBank();
  const existing = (byDomain[domain.key] || []).map((q) => `- ${q.question}`).join('\n');
  return `You are an expert item-writer for the Certified Backstage Associate (CBA) exam. Using ONLY facts verifiable in the official Backstage documentation, write ${count} NEW multiple-choice questions for the domain "${domain.name}".

# Item-writing rules
${readSpec('item-writing-rules.md')}

# Exam blueprint (choose one competency of this domain per question)
${readSpec('exam-blueprint.md')}

# Grounding sources (put the specific proving URL in "source")
${readSpec('backstage-docs-map.md')}

# Do NOT duplicate these existing questions
${existing || '(none yet)'}

Return ONLY a JSON object: {"questions": [ ... ]}. Each item must be:
{"competency": "...", "difficulty": "easy|medium|hard", "question": "...", "options": {"A":"...","B":"...","C":"...","D":"..."}, "answer": "A|B|C|D", "explanation": "...", "source": "https://backstage.io/docs/...", "tags": ["..."]}
Use the exact competency strings from the blueprint for domain "${domain.name}". Do NOT include "id" or "domain". Output JSON only, no prose or code fences.`;
}

async function callAnthropic(key, model, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).map((b) => b.text || '').join('');
}

async function callOpenAI(key, model, prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callGoogle(key, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } }),
  });
  if (!res.ok) throw new Error(`Google ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}

function extractQuestions(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!m) throw new Error('model did not return JSON');
    parsed = JSON.parse(m[0]);
  }
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.questions)) return parsed.questions;
  throw new Error('JSON did not contain a "questions" array');
}

function firstKey(names) {
  for (const n of names) if (process.env[n]) return process.env[n];
  return null;
}

export async function runGenerate(opts) {
  const providerName = (opts.provider || 'anthropic').toLowerCase();
  const provider = PROVIDERS[providerName];
  if (!provider) {
    console.log(c.red(`  Unknown provider "${providerName}". Use anthropic | openai | google.`));
    return 1;
  }
  const domain = resolveDomain(opts.domain);
  if (!domain) {
    console.log(c.red('  Specify --domain development-workflow|infrastructure|catalog|customizing'));
    return 1;
  }
  const count = opts.count ?? 5;
  const model = opts.model || provider.model;
  const prompt = buildPrompt(domain, count);

  if (opts.dryRun) {
    console.log(prompt);
    return 0;
  }

  const key = firstKey(provider.env);
  if (!key) {
    console.log(c.red(`  Missing API key. Set ${provider.env.join(' or ')} in your environment.`));
    console.log(c.gray('  Tip: use --dry-run to print the prompt without calling any API.'));
    return 1;
  }

  console.log(c.gray(`  Generating ${count} question(s) for "${domain.name}" via ${providerName}/${model}...`));
  let text;
  let usage = null;
  try {
    if (providerName === 'anthropic') {
      // Route Anthropic through the ModelProvider port. --model is passed as a
      // transient MODEL_STANDARD override so the port stays tier-based and no
      // concrete model id leaks into the port contract.
      const modelProvider =
        opts.modelProvider ||
        createModelProvider({ env: { ...process.env, LLM_BACKEND: 'anthropic', MODEL_STANDARD: model, ANTHROPIC_API_KEY: key } });
      const out = await modelProvider.invoke({ prompt, tier: 'standard', options: { maxTokens: 4096 } });
      text = out.text;
      usage = out.usage;
    } else {
      text = await provider.call(key, model, prompt);
    }
  } catch (err) {
    console.log(c.red(`  API error: ${err.message}`));
    return 1;
  }

  let candidates;
  try {
    candidates = extractQuestions(text);
  } catch (err) {
    console.log(c.red(`  Could not parse questions: ${err.message}`));
    return 1;
  }

  const good = [];
  const bad = [];
  for (const q of candidates) {
    const probe = { ...q, id: `${domain.prefix}-000`, domain: domain.name };
    const errs = validateQuestion(probe, domain.key, null).filter((e) => !/duplicate|id prefix|id must/.test(e));
    if (errs.length) bad.push({ q, errs });
    else good.push(q);
  }
  if (bad.length) {
    console.log(c.yellow(`  Skipped ${bad.length} invalid question(s):`));
    for (const b of bad) console.log(c.gray(`    - ${(b.q.question || '(no stem)').slice(0, 60)} :: ${b.errs.join('; ')}`));
  }
  if (good.length === 0) {
    console.log(c.red('  No valid questions to add.'));
    return 1;
  }

  const append = opts.appendImpl || appendQuestions;
  const added = append(domain.key, good);
  console.log(c.green(`  ✓ Added ${added.length} question(s) to questions/${domain.key}.json`));
  console.log(c.gray(`    ${added.map((a) => a.id).join(', ')}`));
  if (usage) console.log(c.gray(`  ~${usage.inputTokens} in / ${usage.outputTokens} out tokens (${usage.provider}/${usage.model})`));
  console.log(c.gray('  Run `node bin/cli.js validate` to double-check.'));
  return 0;
}
