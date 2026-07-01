# Item-Writing Rules — how to author CBA questions

> **Canonical, engine-neutral spec.** Any agent (Claude/Codex/Gemini) or the `generate` CLI must
> follow these rules when creating questions. Blueprint: [`exam-blueprint.md`](exam-blueprint.md).
> Grounding: [`backstage-docs-map.md`](backstage-docs-map.md). Schema: [`../questions/schema.json`](../questions/schema.json).

## Golden rules (non-negotiable)

1. **Ground everything in official sources.** Only assert facts verifiable in the Backstage docs
   (`backstage.io/docs`) or the LF CBA blueprint. **Never invent** commands, annotation keys, ports,
   file names, package names, or APIs. If unsure, fetch the doc first — or don't write the question.
2. **Map to the blueprint.** One domain + one competency per question.
3. **Cite the proof.** Every question has a `source` URL to the specific page that proves the answer.
4. **One unambiguously correct option.** The other three are wrong to an expert but plausible to a
   casual studier.
5. **Emit valid JSON** conforming to the schema.

## Style rules

- **Self-contained stem** — answerable before reading the options.
- **Exactly 4 options** (`A`–`D`), parallel in grammar/length. The correct one must not be the
  longest or most detailed (classic give-away).
- **Principled distractors** — real Backstage concepts in the wrong context, common misconceptions,
  deprecated/renamed commands, or adjacent-tool confusion (e.g., Kubernetes/CI terms where a
  Backstage term belongs). No filler.
- **No trick phrasing** — avoid "All of the above", "None of the above", double negatives. Capitalize
  an intentional negation (e.g., "which is **NOT**…").
- **Understanding over trivia** — prefer what/why/how and scenario stems over rote version numbers.
- **Timeless** — don't hinge on a fast-changing version string unless the concept is the point.
- **One fact per question.**
- **English only** (matches the exam).

## Difficulty mix (target across the bank)

- `easy` (~40%) — a single definition or canonical command.
- `medium` (~40%) — apply a concept or distinguish two related ones.
- `hard` (~20%) — multi-step reasoning or a realistic troubleshooting scenario.

## Output object (one per question)

```json
{
  "id": "cat-012",
  "domain": "Backstage Catalog",
  "competency": "Using annotations",
  "difficulty": "medium",
  "question": "Where are catalog annotations placed in a catalog-info.yaml file?",
  "options": { "A": "Under metadata.annotations", "B": "Under spec.labels", "C": "At the document root", "D": "Under status.annotations" },
  "answer": "A",
  "explanation": "Annotations are key/value metadata under metadata.annotations; there is no top-level or status annotations block.",
  "source": "https://backstage.io/docs/features/software-catalog/well-known-annotations",
  "tags": ["annotations", "catalog-info"]
}
```

Field rules:
- `id`: `<prefix>-<3-digit-seq>` using the blueprint prefix (`dw`, `infra`, `cat`, `cust`); unique & sequential per file.
- `domain` / `competency`: exact strings from the blueprint.
- `answer`: one of `A`–`D`.
- `explanation`: 1–3 sentences — why the right answer is right and, ideally, why a tempting distractor is wrong.
- `source`: specific official URL proving the answer.

## Where questions go

Append to the matching file — do **not** create new files:
`questions/development-workflow.json`, `questions/infrastructure.json`, `questions/catalog.json`,
`questions/customizing.json` (each a JSON array).

## Self-check before saving (every batch)

1. Real competency mapping? (blueprint)
2. `source` is a real, specific page that proves the answer? (docs map)
3. Exactly one correct option; distractors plausible but wrong?
4. No "All/None of the above"; no double negatives; options parallel?
5. IDs unique & sequential; JSON valid?
6. Run **`node bin/cli.js validate`** — 0 errors required.
