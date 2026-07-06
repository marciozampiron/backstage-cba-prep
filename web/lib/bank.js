// In-memory Exam Content adapter for slice 1 (#39).
// Loads spec/blueprint.json and questions/*.json from the repo root and applies the JSON bank
// migration mapping from docs/product/saas-data-model.md: each bank item becomes one Question plus
// one published QuestionVersion (version 1, origin "manual", legacyExternalId = bank id).
// Unknown domain/competency names fail loudly instead of creating orphans.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(process.cwd(), '..');

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function loadExamContent() {
  const blueprint = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'spec', 'blueprint.json'), 'utf8'),
  );

  const exam = {
    examId: 'cba',
    name: blueprint.exam.name,
    questionCount: blueprint.exam.totalQuestions,
    timeLimitSeconds: blueprint.exam.minutes * 60,
    targetPercent: blueprint.exam.defaultPassPct,
    official: false,
  };

  const domains = blueprint.domains.map((d, order) => ({
    domainId: d.key,
    examId: exam.examId,
    name: d.name,
    weightPercent: d.weight,
    // blueprint-weighted question count for a full mock (sums to exam.questionCount)
    mockTarget: d.target,
    order,
    competencies: d.competencies.map((name) => ({
      competencyId: slugify(name),
      domainId: d.key,
      name,
    })),
  }));

  const domainByName = new Map(domains.map((d) => [d.name, d]));

  const questionsDir = path.join(REPO_ROOT, 'questions');
  const files = readdirSync(questionsDir).filter(
    (f) => f.endsWith('.json') && f !== 'schema.json',
  );

  const versions = [];
  const sources = new Map();
  for (const file of files) {
    const items = JSON.parse(readFileSync(path.join(questionsDir, file), 'utf8'));
    for (const item of items) {
      const domain = domainByName.get(item.domain);
      if (!domain) {
        throw new Error(`bank migration: unknown domain "${item.domain}" in ${file} (${item.id})`);
      }
      const competency = domain.competencies.find((c) => c.name === item.competency);
      if (!competency) {
        throw new Error(
          `bank migration: unknown competency "${item.competency}" in ${file} (${item.id})`,
        );
      }
      if (!sources.has(item.source)) {
        sources.set(item.source, {
          sourceId: `src_${sources.size + 1}`,
          url: item.source,
          title: item.source.replace(/^https?:\/\/(www\.)?/, '').split('/docs/')[1] ?? item.source,
          status: 'active',
        });
      }
      const source = sources.get(item.source);
      versions.push({
        questionVersionId: `qv_${item.id}_v1`,
        questionId: item.id,
        legacyExternalId: item.id,
        version: 1,
        status: 'published',
        origin: 'manual',
        stem: item.question,
        options: Object.entries(item.options).map(([key, text]) => ({ key, text })),
        correctOption: item.answer, // server-side only; never serialized pre-answer
        explanation: item.explanation,
        whyOthersWrong: null,
        difficulty: item.difficulty,
        domainId: domain.domainId,
        competencyId: competency.competencyId,
        sourceRefs: [{ sourceId: source.sourceId, title: `backstage.io/docs — ${source.title}`, url: source.url }],
        tags: item.tags ?? [],
      });
    }
  }

  return { exam, domains, versions };
}

// Next.js dev/HMR can re-evaluate modules; keep one instance per process.
const globalKey = Symbol.for('cba.examContent');
if (!globalThis[globalKey]) {
  globalThis[globalKey] = loadExamContent();
}
const content = globalThis[globalKey];

export const exam = content.exam;
export const domains = content.domains;

export function getDomain(domainId) {
  return domains.find((d) => d.domainId === domainId) ?? null;
}

export function getCompetency(domainId, competencyId) {
  return getDomain(domainId)?.competencies.find((c) => c.competencyId === competencyId) ?? null;
}

export function getVersion(questionVersionId) {
  return content.versions.find((v) => v.questionVersionId === questionVersionId) ?? null;
}

// Deterministic (seeded) shuffle so session assembly is reproducible in dev.
export function seededShuffle(items, seed) {
  let state = 2166136261;
  for (const ch of String(seed)) {
    state = Math.imul(state ^ ch.charCodeAt(0), 16777619) >>> 0;
  }
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Published versions honoring drill filters.
export function pickPublishedVersions({ domainId, competencyId, difficulty, excludeIds, seed }) {
  let pool = content.versions.filter((v) => v.status === 'published');
  if (domainId) pool = pool.filter((v) => v.domainId === domainId);
  if (competencyId) pool = pool.filter((v) => v.competencyId === competencyId);
  if (difficulty && difficulty !== 'mixed') pool = pool.filter((v) => v.difficulty === difficulty);
  if (excludeIds?.size) pool = pool.filter((v) => !excludeIds.has(v.questionVersionId));
  return seededShuffle(pool, seed);
}

// Public (pre-answer) projection: NO correctOption, NO explanation.
export function toQuestionPayload(version) {
  const domain = getDomain(version.domainId);
  const competency = getCompetency(version.domainId, version.competencyId);
  return {
    questionVersionId: version.questionVersionId,
    stem: version.stem,
    options: version.options,
    domain: { domainId: domain.domainId, name: domain.name },
    competency: { competencyId: competency.competencyId, name: competency.name },
  };
}
