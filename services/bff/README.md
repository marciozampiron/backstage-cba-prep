# CBA Web BFF service (#76/#68)

Provider-neutral learner API application boundary. It owns — with exactly one implementation —
the deterministic use cases behind the **implemented routes** of
`docs/product/web-bff-contracts.md`: dashboard, practice options/drills, mock exam (exam-mode
rules), results, missed review, deterministic coach. Contract areas not implemented yet have
tracked owners: Progress -> **#44**, `/api/me` -> **#69**, Preferences -> **#79**.

- **Transport-neutral**: `handleApiRequest({ method, path, query, headers, body })` returns
  `{ status, body }`. No Next.js, Lambda, AWS SDK, network, or model imports — runtimes adapt to
  it (`web/` Next routes today; the Lambda/API Gateway adapter is #78).
- **Ports**: exam content (`src/bank.js`, reads `spec/blueprint.json` + `questions/*.json`;
  override the content root with `CBA_CONTENT_DIR`), identity (`src/identity.js`,
  `CBA_WEB_AUTH=dev|cognito` — Cognito adapter is #69), simulation repository
  (`src/repository.js`, `CBA_WEB_STORE=memory|file`, `CBA_WEB_DATA_DIR`; the managed DynamoDB
  adapter is #77).
- **Contract harness**: `npm test` runs the offline suite in `test/` — success, ownership,
  idempotency, and pre-submit exam-mode leak rules — with the in-memory adapter and zero
  network/credentials.

Layout:

```text
src/app.js         transport-neutral dispatcher (routes -> use cases, error envelope)
src/store.js       application layer: scoring, ownership, mock finalization, exam-mode rules
src/views.js       dashboard + practice-options read models
src/bank.js        exam-content port (blueprint + question bank)
src/identity.js    learner identity port (dev provider; #69 Cognito seam)
src/repository.js  simulation repository port (memory/file adapters; #77 DynamoDB seam)
test/              offline contract harness
```
