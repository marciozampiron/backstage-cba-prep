// Bulk-generate CBA questions with adversarial fact-checking, then append to the bank.
//
// Run from Claude Code with the Workflow tool (opt-in, billed):
//   Workflow({ scriptPath: 'workflows/generate-bank.js', args: { countPerDomain: 6 } })
//
// Pipeline: each domain's author agent writes questions -> each question is independently
// verified against the official docs -> only verified questions are appended and validated.

export const meta = {
  name: 'cba-generate-bank',
  description: 'Generate CBA questions per domain, verify each against the official Backstage docs, then append to the bank',
  phases: [
    { title: 'Generate', detail: 'one author agent per domain' },
    { title: 'Verify', detail: 'adversarially fact-check each question against backstage.io/docs' },
    { title: 'Save', detail: 'append verified questions and run validate' },
  ],
};

const DOMAINS = [
  { key: 'development-workflow', name: 'Backstage Development Workflow', prefix: 'dw' },
  { key: 'infrastructure', name: 'Backstage Infrastructure', prefix: 'infra' },
  { key: 'catalog', name: 'Backstage Catalog', prefix: 'cat' },
  { key: 'customizing', name: 'Customizing Backstage', prefix: 'cust' },
];

const QUESTIONS_SCHEMA = {
  type: 'object',
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['competency', 'difficulty', 'question', 'options', 'answer', 'explanation', 'source'],
        properties: {
          competency: { type: 'string' },
          difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
          question: { type: 'string' },
          options: {
            type: 'object',
            required: ['A', 'B', 'C', 'D'],
            properties: { A: { type: 'string' }, B: { type: 'string' }, C: { type: 'string' }, D: { type: 'string' } },
          },
          answer: { type: 'string', enum: ['A', 'B', 'C', 'D'] },
          explanation: { type: 'string' },
          source: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict'],
  properties: {
    verdict: { type: 'string', enum: ['correct', 'wrong', 'unsupported'] },
    reason: { type: 'string' },
  },
};

const countPerDomain = (args && args.countPerDomain) || 6;

phase('Generate');
const generated = await parallel(
  DOMAINS.map((d) => () =>
    agent(
      `You are an expert CBA item-writer. Read spec/item-writing-rules.md, spec/exam-blueprint.md, and spec/backstage-docs-map.md in this repo. Write ${countPerDomain} NEW multiple-choice questions for the domain "${d.name}", spread across its competencies and difficulties (aim ~40% easy, 40% medium, 20% hard). Ground every answer in an official Backstage doc — WebFetch the page if unsure — and put the specific proving URL in "source". Do NOT duplicate questions already in questions/${d.key}.json. Return {"questions":[...]} with fields competency, difficulty, question, options{A,B,C,D}, answer, explanation, source, tags. Do NOT include id or domain.`,
      { label: `author:${d.key}`, phase: 'Generate', schema: QUESTIONS_SCHEMA }
    ).then((r) => ({ domain: d, questions: (r && r.questions) || [] }))
  )
);

phase('Verify');
const verified = await parallel(
  generated.filter(Boolean).map((g) => () =>
    parallel(
      g.questions.map((q) => () =>
        agent(
          `Adversarially fact-check this CBA question against the OFFICIAL Backstage docs. WebFetch ${q.source} (and search backstage.io/docs if needed). Default to rejecting if you cannot prove it.\n\nQuestion: ${q.question}\nOptions: ${JSON.stringify(q.options)}\nClaimed correct answer: ${q.answer}\nExplanation: ${q.explanation}\n\nReturn verdict "correct" ONLY if the keyed answer is unambiguously right AND the cited source supports it; "wrong" if the keyed answer is incorrect; "unsupported" if the source does not prove it.`,
          { label: `verify:${g.domain.key}`, phase: 'Verify', schema: VERDICT_SCHEMA }
        ).then((v) => ({ q, ok: !!v && v.verdict === 'correct' }))
      )
    ).then((checks) => ({ domain: g.domain, keep: checks.filter((c) => c && c.ok).map((c) => c.q) }))
  )
);

phase('Save');
await parallel(
  verified
    .filter(Boolean)
    .filter((v) => v.keep.length)
    .map((v) => () =>
      agent(
        `Append these verified questions to questions/${v.domain.key}.json in this repo. Read the file, keep the existing array, and append each new item, assigning a unique sequential id "${v.domain.prefix}-NNN" (3-digit, continuing after the current max id) and "domain": "${v.domain.name}". Keep 2-space JSON indentation and a trailing newline. Then run \`node bin/cli.js validate\` and report the result; if it fails, fix the file. New questions (JSON):\n${JSON.stringify(v.keep, null, 2)}`,
        { label: `save:${v.domain.key}`, phase: 'Save' }
      )
    )
);

const perDomain = verified.filter(Boolean).map((v) => ({ domain: v.domain.key, kept: v.keep.length }));
const total = perDomain.reduce((s, x) => s + x.kept, 0);
log(`Verified & appended ${total} questions across ${perDomain.length} domains.`);
return { total, perDomain };
