// Shared multi-provider LLM plumbing (Anthropic / OpenAI / Google).
// `fetchImpl` is injectable so callers can unit-test offline.

export const PROVIDERS = {
  anthropic: { env: ['ANTHROPIC_API_KEY'], model: 'claude-sonnet-5' },
  openai: { env: ['OPENAI_API_KEY'], model: 'gpt-4o' },
  google: { env: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'], model: 'gemini-2.0-flash' },
};

export function providerKey(name) {
  const p = PROVIDERS[name];
  if (!p) return null;
  for (const n of p.env) if (process.env[n]) return process.env[n];
  return null;
}

async function callAnthropic(key, model, prompt, fetchImpl) {
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).map((b) => b.text || '').join('');
}

async function callOpenAI(key, model, prompt, fetchImpl) {
  const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callGoogle(key, model, prompt, fetchImpl) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } }),
  });
  if (!res.ok) throw new Error(`Google ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}

// Returns the model's raw text response.
export async function callLLM({ provider, model, prompt, apiKey, fetchImpl = fetch }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider "${provider}" (use anthropic | openai | google)`);
  const key = apiKey || providerKey(provider);
  if (!key) throw new Error(`missing API key — set ${p.env.join(' or ')}`);
  const m = model || p.model;
  if (provider === 'anthropic') return callAnthropic(key, m, prompt, fetchImpl);
  if (provider === 'openai') return callOpenAI(key, m, prompt, fetchImpl);
  return callGoogle(key, m, prompt, fetchImpl);
}

export function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!m) throw new Error('model did not return JSON');
    return JSON.parse(m[0]);
  }
}

export function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
