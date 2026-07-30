// DynamoDB adapter tests (#77 Stage B) — mock-first: an in-memory fake document client honors
// exactly the operations and condition expressions the adapter is allowed to use, and THROWS on
// anything else (any Scan, unknown expression, unknown index) — so a regression toward Scan or a
// widened expression surface fails here, offline, with no AWS SDK involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DynamoDbSimulationRepository } from '../src/dynamodb-repository.js';
import { RepositoryConflictError } from '../src/repository.js';
import { runRepositorySuite } from './repository-behavior.test.js';

/* ---------------- fake document client ---------------- */

function conditionalError() {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

export function createFakeDynamoStore() {
  // `reads` records every GetItem with its consistency flag, so a test can assert which reads were
  // strong — an eventually consistent authority read is invisible in results and only shows here.
  return { items: new Map(), reads: [] };
}

/**
 * The exact conditions the adapter must send. Hard-coded HERE on purpose: importing them from
 * production would make the fake follow production wherever it went, which is not a guard.
 */
const RUN_PIN_CONDITION = 'record.#s = :active AND record.#d = :deadline AND record.#d > :now';
const CLAIM_REPLACE_CONDITION = 'attribute_not_exists(pk) OR (attribute_exists(#wd) AND #wd <= :now)';
const LEASE_PIN_CONDITION = 'rev = :leaserev AND record.#ru = :ru';

export function createFakeDynamoClient(store, { failNextPutWith, queryPageSize } = {}) {
  const keyOf = (k) => `${k.pk}|${k.sk}`;
  return {
    async get({ Key, ConsistentRead }) {
      store.reads.push({ key: keyOf(Key), consistent: ConsistentRead === true });
      const item = store.items.get(keyOf(Key));
      return item ? { Item: structuredClone(item) } : {};
    },
    async put({ Item, ConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues }) {
      if (failNextPutWith?.length) throw failNextPutWith.shift();
      const key = keyOf(Item);
      const existing = store.items.get(key);
      if (ConditionExpression === 'attribute_not_exists(pk)') {
        if (existing) throw conditionalError();
      } else if (ConditionExpression === 'rev = :expected') {
        if (!existing || existing.rev !== ExpressionAttributeValues[':expected']) throw conditionalError();
      } else if (ConditionExpression !== undefined) {
        throw new Error(`fake client: unsupported put condition "${ConditionExpression}"`);
      }
      store.items.set(key, structuredClone(Item));
    },
    async update({ Key, UpdateExpression, ExpressionAttributeValues }) {
      if (UpdateExpression !== 'ADD n :one') {
        throw new Error(`fake client: unsupported update "${UpdateExpression}"`);
      }
      const key = keyOf(Key);
      const item = store.items.get(key) ?? { ...Key, n: 0 };
      item.n += ExpressionAttributeValues[':one'];
      store.items.set(key, item);
      return { Attributes: { n: item.n } };
    },
    async query({ IndexName, KeyConditionExpression, ExpressionAttributeValues, ExclusiveStartKey }) {
      if (IndexName !== 'gsi1' || KeyConditionExpression !== 'gsi1pk = :pk AND begins_with(gsi1sk, :prefix)') {
        throw new Error(`fake client: unsupported query "${IndexName}/${KeyConditionExpression}"`);
      }
      const all = [...store.items.values()]
        .filter(
          (i) => i.gsi1pk === ExpressionAttributeValues[':pk'] && String(i.gsi1sk ?? '').startsWith(ExpressionAttributeValues[':prefix']),
        )
        .sort((a, b) => (a.gsi1sk < b.gsi1sk ? -1 : 1));
      // Paginates like the real service: honoring ExclusiveStartKey/LastEvaluatedKey is part of
      // the adapter contract under test.
      const start = ExclusiveStartKey
        ? all.findIndex((i) => i.gsi1sk === ExclusiveStartKey.gsi1sk) + 1
        : 0;
      const size = queryPageSize ?? (all.length || 1);
      const page = all.slice(start, start + size);
      const last = start + size < all.length ? { gsi1sk: page[page.length - 1].gsi1sk } : undefined;
      return { Items: structuredClone(page), ...(last ? { LastEvaluatedKey: last } : {}) };
    },
    async delete({ Key, ConditionExpression, ExpressionAttributeValues }) {
      const key = keyOf(Key);
      const existing = store.items.get(key);
      if (ConditionExpression === 'mockExamId = :id') {
        if (!existing || existing.mockExamId !== ExpressionAttributeValues[':id']) throw conditionalError();
      } else if (ConditionExpression === 'rev = :expected') {
        // #75 cleanup deletes conditionally on the rev it read, so a record written since the read
        // is skipped rather than removed blind. The fake enforces the same rule as the real table.
        if (!existing || existing.rev !== ExpressionAttributeValues[':expected']) throw conditionalError();
      } else if (ConditionExpression !== undefined) {
        throw new Error(`fake client: unsupported delete condition "${ConditionExpression}"`);
      }
      store.items.delete(key);
    },
    // #75: the conditional write is a TRANSACTION — a condition check on the run item plus the
    // record put, applied together or not at all. The fake enforces the same rule as the real
    // table, so the TOCTOU regression exercises the real code path.
    async transactWrite({ TransactItems }) {
      // `CancellationReasons` is POSITIONAL in the real API, and the adapter classifies on index 0.
      // The fake reproduces that faithfully — without it, a transaction conflict and a closed run
      // would be indistinguishable here, which is the bug the classification exists to prevent.
      const reasons = TransactItems.map((item) => {
        if (item.ConditionCheck) {
          const existing = store.items.get(keyOf(item.ConditionCheck.Key));
          const v = item.ConditionCheck.ExpressionAttributeValues ?? {};
          const expr = item.ConditionCheck.ConditionExpression;
          // Lease-family checks (#75 profile linearization): absence, or the exact pinned
          // revision+horizon the stamp was taken from. Dispatched BEFORE the run-fence family,
          // which requires :active.
          if (expr === 'attribute_not_exists(pk)') {
            return existing ? { Code: 'ConditionalCheckFailed' } : { Code: 'None' };
          }
          if (expr === LEASE_PIN_CONDITION) {
            if ((item.ConditionCheck.ExpressionAttributeNames ?? {})['#ru'] !== 'retainUntil') {
              throw new Error('fake client: the lease pin must bind #ru=retainUntil');
            }
            if (!existing || existing.rev !== v[':leaserev'] || existing.record?.retainUntil !== v[':ru']) {
              return { Code: 'ConditionalCheckFailed' };
            }
            return { Code: 'None' };
          }
          // EXACT canonical shape, not substrings. `includes` accepted an INVERTED expression —
          // `... AND NOT (record.#d = :deadline) AND ...` contains every required fragment while
          // meaning the opposite, and the fake would have gone on simulating the rule production
          // had stopped applying. The names are pinned too: rebinding `#d` to another attribute
          // would keep the text identical and change what is compared.
          // Keyed on the TARGET, not on which values production happened to send. Demanding the
          // canonical shape only when `:deadline` was present made the guard bypassable by the one
          // change it existed to catch: omit the deadline pin entirely and the check fell away with
          // it. Every SMOKERUN condition must carry the full fence.
          if (item.ConditionCheck.Key?.pk?.startsWith('SMOKERUN#')) {
            if (expr !== RUN_PIN_CONDITION) {
              throw new Error(`fake client: the run condition must be exactly "${RUN_PIN_CONDITION}"`);
            }
            const names = item.ConditionCheck.ExpressionAttributeNames ?? {};
            if (names['#s'] !== 'status' || names['#d'] !== 'writeDeadlineAt') {
              throw new Error('fake client: the run condition must bind #s=status and #d=writeDeadlineAt');
            }
            if (v[':deadline'] === undefined || v[':now'] === undefined) {
              throw new Error('fake client: the run condition must supply :deadline and :now');
            }
          }
          const record = existing?.record;
          if (!record || record.status !== v[':active']) return { Code: 'ConditionalCheckFailed' };
          // The claim's condition also PINS the deadline and requires it to be in the future, so
          // the fake must evaluate those too — otherwise the pinning is untested.
          if (v[':deadline'] !== undefined && record.writeDeadlineAt !== v[':deadline']) {
            return { Code: 'ConditionalCheckFailed' };
          }
          if (v[':now'] !== undefined && !(record.writeDeadlineAt > v[':now'])) {
            return { Code: 'ConditionalCheckFailed' };
          }
        }
        if (item.Put?.ConditionExpression === CLAIM_REPLACE_CONDITION) {
          // The BINDING is pinned too, like the run condition's: rebinding #wd to another
          // attribute keeps the expression text identical while DynamoDB compares a different
          // field — and the fake, reading writeDeadlineAt by hand, would keep simulating the rule
          // production had stopped applying.
          const putNames = item.Put.ExpressionAttributeNames ?? {};
          if (putNames['#wd'] !== 'writeDeadlineAt') {
            throw new Error('fake client: the replacement condition must bind #wd=writeDeadlineAt');
          }
          // Replaceable only when the stored claim is provably expired.
          const existing = store.items.get(keyOf(item.Put.Item));
          if (existing) {
            const held = existing.writeDeadlineAt;
            // `<=`, matching the logical read: at exact equality the claim is already absent.
            if (!(typeof held === 'string' && held <= item.Put.ExpressionAttributeValues[':now'])) {
              return { Code: 'ConditionalCheckFailed' };
            }
          }
        } else if (item.Put?.ConditionExpression) {
          // Every supported Put condition, not just one: ignoring `rev = :expected` inside a
          // transaction let a stale smoke-scoped update overwrite the winner, while the
          // non-transactional path enforced it — the fence was weaker exactly where it was newest.
          const existing = store.items.get(keyOf(item.Put.Item));
          const cond = item.Put.ConditionExpression;
          if (cond === 'attribute_not_exists(pk)') {
            if (existing) return { Code: 'ConditionalCheckFailed' };
          } else if (cond === 'rev = :expected') {
            const expected = item.Put.ExpressionAttributeValues?.[':expected'];
            if (!existing || existing.rev !== expected) return { Code: 'ConditionalCheckFailed' };
          } else {
            throw new Error(`fake client: unsupported transactional Put condition "${cond}"`);
          }
        }
        return { Code: 'None' };
      });
      if (reasons.some((r) => r.Code !== 'None')) {
        const err = new Error('TransactionCanceledException');
        err.name = 'TransactionCanceledException';
        err.CancellationReasons = reasons;
        throw err;
      }
      for (const item of TransactItems) {
        if (item.Put) store.items.set(keyOf(item.Put.Item), item.Put.Item);
      }
    },
    // Deliberately NO scan method: any attempt to Scan explodes loudly.
  };
}

function makeRepoWith(store) {
  const repo = new DynamoDbSimulationRepository({ tableName: 'fake-table', client: createFakeDynamoClient(store) });
  repo._fakeStore = store; // test-only handle so `reopen` can share the same fake table
  return repo;
}

/* ---------------- the shared behavioral suite (same as memory/file) ---------------- */

/** Physical corruption seam for the managed adapter: mutate the stored ITEM, not a read clone. */
const corruptDynamoAnchor = async (repo, type, id, value) => {
  for (const [, item] of repo._fakeStore.items) {
    if (item.pk !== `${type}#${id}`) continue;
    if (value === undefined) delete item.record.retainUntil;
    else item.record.retainUntil = value;
  }
};

runRepositorySuite('dynamodb', async () => makeRepoWith(createFakeDynamoStore()), {
  corruptAnchor: corruptDynamoAnchor,
  // Re-instantiation shares the fake table (a new adapter instance over the same store) — this is
  // exactly the Lambda-restart shape the durability guarantee covers.
  reopen: async (repo) => makeRepoWith(repo._fakeStore),
});

/* ---------------- adapter-specific guarantees ---------------- */

test('dynamodb: state survives adapter re-instantiation over the same table', async () => {
  const store = createFakeDynamoStore();
  const first = makeRepoWith(store);
  await first.saveAttempt({ attemptId: 'att_d1', learnerId: 'l1', status: 'submitted' });
  const second = makeRepoWith(store);
  assert.equal((await second.getAttempt('att_d1')).status, 'submitted');
});

test('dynamodb: stale-rev save is a RepositoryConflictError (lost update prevented)', async () => {
  const store = createFakeDynamoStore();
  const a = makeRepoWith(store);
  const b = makeRepoWith(store);
  await a.saveAttempt({ attemptId: 'att_c', learnerId: 'l1', status: 'in_progress', answers: {} });
  const viaB = await b.getAttempt('att_c'); // b reads rev 1
  const viaA = await a.getAttempt('att_c'); // a reads rev 1
  viaA.answers[1] = { selectedOption: 'A' };
  await a.saveAttempt(viaA); // rev -> 2
  viaB.answers[1] = { selectedOption: 'D' }; // concurrent stale write must NOT clobber A's answer
  await assert.rejects(() => b.saveAttempt(viaB), RepositoryConflictError);
  const final = await a.getAttempt('att_c');
  assert.equal(final.answers[1].selectedOption, 'A', 'the first write wins; nothing was lost');
});

test('dynamodb: SAME-INSTANCE double read — the second stale save must conflict (per-read token)', async () => {
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  await repo.saveAttempt({ attemptId: 'att_same', learnerId: 'l1', status: 'in_progress', answers: {} });
  // Two concurrent reads THROUGH THE SAME adapter instance (one warm Lambda, two requests).
  const readA = await repo.getAttempt('att_same');
  const readB = await repo.getAttempt('att_same');
  readA.answers[1] = { selectedOption: 'A' };
  await repo.saveAttempt(readA); // wins
  readB.answers[1] = { selectedOption: 'D' }; // stale — must NOT silently overwrite A
  await assert.rejects(() => repo.saveAttempt(readB), RepositoryConflictError);
  const final = await repo.getAttempt('att_same');
  assert.equal(final.answers[1].selectedOption, 'A', 'the first same-instance write is preserved');
});

test('dynamodb: learner listing follows LastEvaluatedKey across pages (no truncated history)', async () => {
  const store = createFakeDynamoStore();
  const writer = makeRepoWith(store);
  for (let i = 1; i <= 5; i++) {
    await writer.saveAttempt({ attemptId: `att_p${i}`, learnerId: 'l1', status: 'submitted' });
  }
  await writer.saveAttempt({ attemptId: 'att_other', learnerId: 'l2', status: 'submitted' });
  // Reader whose client returns 2 items per page: 5 attempts => 3 pages.
  const reader = new DynamoDbSimulationRepository({
    tableName: 'fake-table',
    client: createFakeDynamoClient(store, { queryPageSize: 2 }),
  });
  const listed = await reader.listAttempts('l1');
  assert.equal(listed.length, 5, 'every page must be read');
  assert.deepEqual(
    listed.map((a) => a.attemptId).sort(),
    ['att_p1', 'att_p2', 'att_p3', 'att_p4', 'att_p5'],
  );
});

test('dynamodb: create collision (same id, different instances) conflicts instead of overwriting', async () => {
  const store = createFakeDynamoStore();
  const a = makeRepoWith(store);
  const b = makeRepoWith(store);
  await a.saveSession({ practiceSessionId: 'ps_x', attemptId: 'att_1', learnerId: 'l1' });
  await assert.rejects(
    () => b.saveSession({ practiceSessionId: 'ps_x', attemptId: 'att_2', learnerId: 'l2' }),
    RepositoryConflictError,
  );
});

test('dynamodb: claim race — exactly one concurrent claimant wins', async () => {
  const store = createFakeDynamoStore();
  const a = makeRepoWith(store);
  const b = makeRepoWith(store);
  const [ra, rb] = await Promise.all([a.claimActiveMock('l1', 'mock_a'), b.claimActiveMock('l1', 'mock_b')]);
  assert.notEqual(ra, rb, 'one wins, one loses');
  const active = await a.getActiveMock('l1');
  assert.ok(active === 'mock_a' || active === 'mock_b');
});

test('dynamodb: ids come from the atomic counter and are prefix-scoped', async () => {
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  const a = await repo.nextId('att');
  const b = await repo.nextId('mock');
  assert.match(a, /^att_/);
  assert.match(b, /^mock_/);
  assert.notEqual(a.split('_')[1], b.split('_')[1]);
});

test('dynamodb: readiness is logical-only and reflects reachability', async () => {
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  assert.deepEqual(await repo.readiness(), { adapter: 'dynamodb', ready: true });
  const broken = new DynamoDbSimulationRepository({
    tableName: 'fake-table',
    client: { ...createFakeDynamoClient(store), get: async () => { throw new Error('down'); } },
  });
  assert.deepEqual(await broken.readiness(), { adapter: 'dynamodb', ready: false });
});

test('dynamodb: adapter source uses no Scan and no wildcard expressions (static guard)', () => {
  const raw = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'dynamodb-repository.js'),
    'utf8',
  );
  // Judge the CODE, not the documentation: strip comments before matching.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\bScan\w*\b|\.scan\(/.test(code), 'Scan must never appear in the adapter code');
  assert.ok(!code.includes("'*'"), 'no wildcard expressions in the adapter code');
});

/* ---------------- first-profile bootstrap race (#69 Slice B review fix) ---------------- */

test('profile bootstrap race: the losing instance re-reads and returns the winner (no 409)', async () => {
  const { getMe } = await import('../src/profile.js');
  const { configureRuntime, resetRuntime } = await import('../src/runtime.js');
  const store = createFakeDynamoStore();
  const repoA = new DynamoDbSimulationRepository({ tableName: 't', client: createFakeDynamoClient(store) });
  const repoB = new DynamoDbSimulationRepository({ tableName: 't', client: createFakeDynamoClient(store) });

  try {
    // Instance A bootstraps first and wins the conditional create.
    configureRuntime({ repository: repoA });
    const winner = await getMe('cognito-race-sub', {
      loadProfile: async () => ({ email: 'winner@example.test', displayName: 'Winner' }),
    });
    assert.equal(winner.email, 'winner@example.test');

    // Instance B raced: its read happened BEFORE A's write (simulated by nulling the first
    // read), so its conditional create fails — the fix re-reads and returns A's profile.
    let firstRead = true;
    configureRuntime({
      repository: new Proxy(repoB, {
        get(target, prop) {
          if (prop === 'getProfile') {
            return async (learnerId) => {
              if (firstRead) {
                firstRead = false;
                return null;
              }
              return target.getProfile(learnerId);
            };
          }
          const value = target[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    });
    const loser = await getMe('cognito-race-sub', {
      loadProfile: async () => ({ email: 'loser@example.test', displayName: 'Loser' }),
    });
    assert.equal(loser.email, 'winner@example.test', 'the winning profile is returned, never a 409');
    assert.equal(loser.displayName, 'Winner');
  } finally {
    resetRuntime();
  }
});

test('cleanup skips a record written since it was read, instead of deleting it blind', async () => {
  // A record changed between the query and the delete is not this run's to remove on the strength
  // of a stale read. The conditional delete fails and the record is skipped, which keeps the
  // operation safe to repeat — #70 runs it with always(), including after a partial failure.
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  await repo.saveSmokeRun({ runId: 'run-race-000001', learnerId: 'l-race', status: 'active', writeDeadlineAt: new Date(Date.now() + 864e5).toISOString(), ownershipExpiresAt: new Date(Date.now() + 6912e5).toISOString() });
  await repo.saveSession({ practiceSessionId: 'ps_race', attemptId: 'att_race', learnerId: 'l-race', runId: 'run-race-000001' });

  const originalDelete = repo.client.delete;
  repo.client.delete = async (params) => {
    // Simulate a concurrent write landing between the read and the delete.
    const item = store.items.get(`${params.Key.pk}|${params.Key.sk}`);
    if (item) item.rev += 1;
    return originalDelete(params);
  };

  const deleted = await repo.deleteSmokeRunData({ learnerId: 'l-race', runId: 'run-race-000001' });
  assert.equal(deleted.practiceSessions, 0, 'the stale delete must be skipped, not forced');
  assert.notEqual(await repo.getSession('ps_race'), null, 'the record must survive');

  // And a later, uncontended run removes it — the skip is a deferral, not a leak.
  repo.client.delete = originalDelete;
  const second = await repo.deleteSmokeRunData({ learnerId: 'l-race', runId: 'run-race-000001' });
  assert.equal(second.practiceSessions, 1);
});

test('cleanup never scans: the fake client has no scan method at all', async () => {
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  assert.equal(repo.client.scan, undefined, 'a scan would read every learner in the table');
  await repo.saveSmokeRun({ runId: 'run-noscan-0001', learnerId: 'l-ns', status: 'active', writeDeadlineAt: new Date(Date.now() + 864e5).toISOString(), ownershipExpiresAt: new Date(Date.now() + 6912e5).toISOString() });
  await repo.saveSession({ practiceSessionId: 'ps_ns', attemptId: 'a', learnerId: 'l-ns', runId: 'run-noscan-0001' });
  await repo.deleteSmokeRunData({ learnerId: 'l-ns', runId: 'run-noscan-0001' });
});

test('a cancellation that is NOT the run condition is not reported as a closed run', async () => {
  // Reporting every TransactionCanceledException as RUN_CLOSED told the caller something false
  // about the run's state and hid a fault — a transaction conflict or a capacity failure — that
  // deserves to surface.
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  await repo.saveSmokeRun({ runId: 'run-classify0000000000', learnerId: 'l-classify', status: 'active', writeDeadlineAt: new Date(Date.now() + 864e5).toISOString(), ownershipExpiresAt: new Date(Date.now() + 6912e5).toISOString() });

  repo.client.transactWrite = async () => {
    const err = new Error('TransactionCanceledException');
    err.name = 'TransactionCanceledException';
    // Index 0 is the RUN's condition check, and it passed. The failure is elsewhere.
    err.CancellationReasons = [{ Code: 'None' }, { Code: 'TransactionConflict' }];
    throw err;
  };

  await assert.rejects(
    () => repo.saveSmokeScopedRecord({
      runId: 'run-classify0000000000',
      kind: 'attempt',
      record: { attemptId: 'att_x', learnerId: 'l-classify', answers: {} },
    }),
    (err) => err.name === 'TransactionCanceledException',
  );
});

test('a stale smoke-scoped update loses to the winner inside the transaction too', async () => {
  // The transactional path is the newest and was the weakest: the fake ignored `rev = :expected`
  // inside TransactWrite, so a stale update overwrote the winner where the plain Put path would
  // have refused it.
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  await repo.saveSmokeRun({ runId: 'run-stale00000000000000', learnerId: 'l-stale', status: 'active', writeDeadlineAt: new Date(Date.now() + 864e5).toISOString(), ownershipExpiresAt: new Date(Date.now() + 6912e5).toISOString() });
  await repo.saveAttempt({ attemptId: 'att_stale', learnerId: 'l-stale', runId: 'run-stale00000000000000', answers: {} });

  const a = await repo.getAttempt('att_stale');
  const b = await repo.getAttempt('att_stale');
  a.answers = { 1: { selectedOption: 'A' } };
  b.answers = { 1: { selectedOption: 'B' } };

  await repo.saveAttempt(a);
  await assert.rejects(() => repo.saveAttempt(b), (err) => err.name === 'RepositoryConflictError');
  assert.deepEqual((await repo.getAttempt('att_stale')).answers, { 1: { selectedOption: 'A' } });
});

test('a claim collision returns false, but an infrastructure cancellation does not', async () => {
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  await repo.saveSmokeRun({ runId: 'run-claimcollision0000', learnerId: 'l-cc', status: 'active', writeDeadlineAt: new Date(Date.now() + 864e5).toISOString(), ownershipExpiresAt: new Date(Date.now() + 6912e5).toISOString() });

  // A genuine collision: somebody already holds the claim.
  assert.equal(await repo.claimActiveMock('l-cc', 'mock_1', { runId: 'run-claimcollision0000' }), true);
  assert.equal(await repo.claimActiveMock('l-cc', 'mock_2', { runId: 'run-claimcollision0000' }), false);

  // An unrelated cancellation must NOT resolve to false: that became MOCK_EXAM_IN_PROGRESS and
  // hid the fault behind a story about state.
  repo.client.transactWrite = async () => {
    const err = new Error('TransactionCanceledException');
    err.name = 'TransactionCanceledException';
    err.CancellationReasons = [{ Code: 'None' }, { Code: 'TransactionConflict' }];
    throw err;
  };
  await assert.rejects(
    () => repo.claimActiveMock('l-cc2', 'mock_3', { runId: 'run-claimcollision0000' }),
    (err) => err.name === 'TransactionCanceledException',
  );

  // Missing reasons entirely is also not a collision.
  repo.client.transactWrite = async () => {
    const err = new Error('TransactionCanceledException');
    err.name = 'TransactionCanceledException';
    throw err;
  };
  await assert.rejects(
    () => repo.claimActiveMock('l-cc3', 'mock_4', { runId: 'run-claimcollision0000' }),
    (err) => err.name === 'TransactionCanceledException',
  );
});

test('the physical ttl equals the retention anchor and does not move across updates', async () => {
  // The top-level ttl is what DynamoDB actually acts on. Deriving it from a re-read anchor on every
  // save would slide retention forward with every answer, and nothing in the record would show it.
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  await repo.saveSmokeRun({
    runId: 'run-ttlanchor00000000',
    learnerId: 'l-ttl',
    status: 'active',
    writeDeadlineAt: new Date(Date.now() + 864e5).toISOString(),
    ownershipExpiresAt: new Date(Date.now() + 6912e5).toISOString(),
  });
  await repo.saveAttempt({ attemptId: 'att_ttl', learnerId: 'l-ttl', runId: 'run-ttlanchor00000000', answers: {} });

  const item = () => [...store.items.values()].find((i) => i.pk === 'ATTEMPT#att_ttl');
  const anchor = item().record.retainUntil;
  const expected = Math.floor(Date.parse(anchor) / 1000);
  assert.equal(item().ttl, expected, 'the ttl must be the anchor, in epoch seconds');

  for (let i = 0; i < 3; i++) {
    const current = await repo.getAttempt('att_ttl');
    current.answers = { ...current.answers, [i + 1]: { selectedOption: 'A' } };
    await repo.saveAttempt(current);
    assert.equal(item().record.retainUntil, anchor, `update ${i}: the anchor must not move`);
    assert.equal(item().ttl, expected, `update ${i}: the ttl must not move`);
  }
});

test('a deadline that changes BETWEEN the read and the transaction refuses the claim', async () => {
  // This is the window the transaction exists to close. Changing the run before claimActiveMock
  // tests the application's own check; changing it after getSmokeRun and before transactWrite is
  // what proves the condition pins the exact value the read saw.
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  const runId = 'run-pinwindow00000000';
  await repo.saveSmokeRun({
    runId,
    learnerId: 'l-pin',
    status: 'active',
    writeDeadlineAt: new Date(Date.now() + 864e5).toISOString(),
    ownershipExpiresAt: new Date(Date.now() + 6912e5).toISOString(),
  });

  const realTransact = repo.client.transactWrite;
  repo.client.transactWrite = async (params) => {
    // A concurrent mint or close moves the horizon after the read.
    for (const [, item] of store.items) {
      if (item.pk === `SMOKERUN#${runId}`) item.record.writeDeadlineAt = new Date(Date.now() + 999e5).toISOString();
    }
    return realTransact(params);
  };

  // A REJECTION, not `false`. `false` means somebody already holds the claim; here the run's own
  // condition failed, which is a different answer and must not be reported as a collision.
  await assert.rejects(
    () => repo.claimActiveMock('l-pin', 'mock_pin', { runId }),
    (err) => err.name === 'RepositoryConflictError',
    'the pinned deadline no longer matches, so the claim must not be written',
  );
  assert.equal(await repo.getActiveMock('l-pin'), null, 'and nothing was written');
});

test('the fake refuses a run condition that stops pinning the deadline', async () => {
  // Guards the guard: evaluating values alone would let production drop a relation from the
  // expression while still passing `:deadline`, and the fake would keep enforcing a rule the real
  // table no longer would.
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  await assert.rejects(
    () => repo.client.transactWrite({
      TransactItems: [{
        ConditionCheck: {
          TableName: 'fake-table',
          Key: { pk: 'SMOKERUN#x', sk: 'REC' },
          ConditionExpression: 'record.#s = :active',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':active': 'active', ':deadline': 'x', ':now': 'y' },
        },
      }],
    }),
    /must be exactly/,
  );
});

test('the fake refuses an INVERTED or weakened run condition', async () => {
  // The earlier guard used substring matching, so `NOT (record.#d = :deadline)` contained every
  // required fragment while meaning the opposite — the fake would have kept simulating a rule
  // production had inverted. Rebinding an attribute name is the same class of change with no text
  // difference at all.
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  const send = (ConditionExpression, ExpressionAttributeNames) => repo.client.transactWrite({
    TransactItems: [{
      ConditionCheck: {
        TableName: 'fake-table',
        Key: { pk: 'SMOKERUN#x', sk: 'REC' },
        ConditionExpression,
        ExpressionAttributeNames,
        ExpressionAttributeValues: { ':active': 'active', ':deadline': 'x', ':now': 'y' },
      },
    }],
  });
  const NAMES = { '#s': 'status', '#d': 'writeDeadlineAt' };

  // Inverted: contains every fragment, means the opposite.
  await assert.rejects(
    () => send('record.#s = :active AND NOT (record.#d = :deadline) AND record.#d > :now', NAMES),
    /must be exactly/,
  );
  // Weakened: the future check becomes a tautology.
  await assert.rejects(
    () => send('record.#s = :active AND record.#d = :deadline AND record.#d > :now OR attribute_exists(pk)', NAMES),
    /must be exactly/,
  );
  // Rebound: identical text, comparing a different attribute.
  await assert.rejects(
    () => send(RUN_PIN_CONDITION_FOR_TEST, { '#s': 'status', '#d': 'ownershipExpiresAt' }),
    /must bind #s=status and #d=writeDeadlineAt/,
  );
});

const RUN_PIN_CONDITION_FOR_TEST = 'record.#s = :active AND record.#d = :deadline AND record.#d > :now';

test('a seconds-only run deadline still hands over at the exact boundary', async () => {
  // parseInstant accepts milliseconds as OPTIONAL, but the replacement condition compares
  // lexically against a full-millisecond :now — and "...56Z" <= "...56.000Z" is FALSE as a string
  // at the same instant. Without canonical re-rendering, the read said absent while the write said
  // occupied: the null-winner state again, reached through a perfectly valid timestamp format.
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  const base = Date.parse('2026-07-28T12:00:00Z');
  let clock = base;
  repo.now = () => clock;

  const secondsOnly = '2026-07-29T12:34:56Z'; // valid, canonical, no milliseconds
  await repo.saveSmokeRun({
    runId: 'run-secondsonly000000',
    learnerId: 'l-secs',
    status: 'active',
    writeDeadlineAt: secondsOnly,
    ownershipExpiresAt: new Date(base + 6912e5).toISOString(),
  });
  assert.equal(await repo.claimActiveMock('l-secs', 'mock_old', { runId: 'run-secondsonly000000' }), true);

  clock = Date.parse(secondsOnly); // EXACTLY the boundary
  assert.equal(await repo.getActiveMock('l-secs'), null, 'the old claim must read as absent');

  await repo.saveSmokeRun({
    runId: 'run-secondsnext000000',
    learnerId: 'l-secs',
    status: 'active',
    writeDeadlineAt: new Date(clock + 864e5).toISOString(),
    ownershipExpiresAt: new Date(clock + 6912e5).toISOString(),
  });
  assert.equal(await repo.claimActiveMock('l-secs', 'mock_new', { runId: 'run-secondsnext000000' }), true,
    'the new claim must succeed at that same instant');
  assert.equal(await repo.getActiveMock('l-secs'), 'mock_new');
});

test('the fake refuses a replacement condition with #wd rebound to another attribute', async () => {
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  await assert.rejects(
    () => repo.client.transactWrite({
      TransactItems: [{
        Put: {
          TableName: 'fake-table',
          Item: { pk: 'LEARNER#x', sk: 'ACTIVE_MOCK', mockExamId: 'm' },
          ConditionExpression: 'attribute_not_exists(pk) OR (attribute_exists(#wd) AND #wd <= :now)',
          // Identical text, different attribute: DynamoDB would compare ownershipExpiresAt while
          // the fake read writeDeadlineAt by hand.
          ExpressionAttributeNames: { '#wd': 'ownershipExpiresAt' },
          ExpressionAttributeValues: { ':now': new Date().toISOString() },
        },
      }],
    }),
    /must bind #wd=writeDeadlineAt/,
  );
});

test('a stale profile reclaim loses to a concurrent fresh write', async () => {
  // The reclaim is conditional on the PHYSICAL revision the raw read saw. A concurrent refresh
  // bumps it, the stale reclaim fails its condition, and the fresh profile survives — the loser
  // re-reads, exactly like the first-bootstrap race.
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  const later = Date.now() + 2 * 864e5;

  await repo.extendSmokeLease({ learnerId: 'l-race-reclaim', retainUntil: new Date(Date.now() + 864e5).toISOString() });
  await repo.saveProfile({ learnerId: 'l-race-reclaim', email: 'x@local.invalid', displayName: 'OLD' });
  repo.now = () => later; // the stamped profile is now expired-but-present

  await repo.extendSmokeLease({ learnerId: 'l-race-reclaim', retainUntil: new Date(later + 8 * 864e5).toISOString() });

  // The reclaim is a TRANSACTION now (linearized against the lease), so the race seam sits on
  // transactWrite: the concurrent fresh write lands between the raw read and the transaction.
  const realTransact = repo.client.transactWrite;
  repo.client.transactWrite = async (params) => {
    const put = params.TransactItems?.find((t) => t.Put?.Item?.pk === 'PROFILE#l-race-reclaim');
    if (put) {
      for (const [, item] of store.items) {
        if (item.pk === 'PROFILE#l-race-reclaim') item.rev += 1;
      }
      repo.client.transactWrite = realTransact;
    }
    return realTransact(params);
  };

  await assert.rejects(
    () => repo.saveProfile({ learnerId: 'l-race-reclaim', email: 'x@local.invalid', displayName: 'STALE' }),
    (err) => err.name === 'RepositoryConflictError',
    'the stale reclaim must lose, never overwrite',
  );
  const survivor = [...store.items.values()].find((i) => i.pk === 'PROFILE#l-race-reclaim');
  assert.equal(survivor.record.displayName, 'OLD', 'the concurrently-refreshed row survived');
});


test('two writers from the same revision cannot both commit a lease', async () => {
  // The horizon-only condition let both land; the rev condition makes exactly one win, and the
  // loser re-reads and retries against the revision the winner committed.
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  const h1 = new Date(Date.now() + 864e5).toISOString();
  await repo.extendSmokeLease({ learnerId: 'l-dup-rev', retainUntil: h1 });

  const h2 = new Date(Date.now() + 2 * 864e5).toISOString();
  const h3 = new Date(Date.now() + 3 * 864e5).toISOString();
  const realPut = repo.client.put;
  let raced = false;
  repo.client.put = async (params) => {
    if (!raced && params.Item?.pk === 'LEASE#l-dup-rev') {
      raced = true;
      // The competing writer lands first, from the same starting revision.
      for (const [, item] of store.items) {
        if (item.pk === 'LEASE#l-dup-rev') {
          item.rev = 2;
          item.record = { learnerId: 'l-dup-rev', retainUntil: h2, rev: 2 };
        }
      }
    }
    return realPut(params);
  };

  const result = await repo.extendSmokeLease({ learnerId: 'l-dup-rev', retainUntil: h3 });
  assert.equal(result.rev, 3, 'the loser retried on top of the winner, never alongside it');
  assert.equal(result.retainUntil, h3);
  const stored = [...store.items.values()].find((i) => i.pk === 'LEASE#l-dup-rev');
  assert.equal(stored.rev, 3, 'one revision per commit — no duplicates');
});

test('mint authorization and lease CAS read strongly', async () => {
  // An eventually consistent authority read let a just-written run appear absent during mint and a
  // stale lease pose as the winner. Invisible in results — only the recorded flags show it.
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  await repo.saveSmokeRun({
    runId: 'run-strongread0000000',
    learnerId: 'l-strong',
    status: 'active',
    writeDeadlineAt: new Date(Date.now() + 864e5).toISOString(),
    ownershipExpiresAt: new Date(Date.now() + 6912e5).toISOString(),
  });
  store.reads.length = 0;

  await repo.getSmokeRun('run-strongread0000000');
  await repo.extendSmokeLease({ learnerId: 'l-strong', retainUntil: new Date(Date.now() + 6912e5).toISOString() });
  await repo.getSmokeLease('l-strong');

  const authority = store.reads.filter((r) => r.key.startsWith('SMOKERUN#') || r.key.startsWith('LEASE#'));
  assert.ok(authority.length >= 3, 'the authority reads must have happened');
  for (const read of authority) {
    assert.equal(read.consistent, true, `${read.key} must be a strong read`);
  }
});

test('reverse-order stamping reaches the winning horizon and its physical ttl', async () => {
  // The lease returns the winning value, and the stamp must use it: stamping the losing run's own
  // horizon left the profile's anchor and ttl short of the effective lease horizon.
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  const h2 = new Date(Date.now() + 16 * 864e5).toISOString();
  const h1 = new Date(Date.now() + 8 * 864e5).toISOString();

  await repo.extendSmokeLease({ learnerId: 'l-winning', retainUntil: h2 });
  await repo.saveProfile({ learnerId: 'l-winning', email: 'x@local.invalid', displayName: 'W' });

  // The OLDER mint completes last: its extension loses, and the winning horizon is what it stamps.
  const winner = await repo.extendSmokeLease({ learnerId: 'l-winning', retainUntil: h1 });
  assert.equal(winner.retainUntil, h2, 'the lease answers with the winning horizon');
  await repo.stampProfileRetention({ learnerId: 'l-winning', retainUntil: winner.retainUntil });

  const item = [...store.items.values()].find((i) => i.pk === 'PROFILE#l-winning');
  assert.equal(item.record.retainUntil, h2, 'the profile anchor is the winning horizon');
  assert.equal(item.ttl, Math.floor(Date.parse(h2) / 1000), 'and so is the physical ttl');
});

test('a profile create that crosses a lease creation loses, retries and lands stamped', async () => {
  // The managed side of the same window: the bootstrap's transaction conditions on the lease key
  // staying ABSENT. A mint's lease landing in between fails that check (reasons[0]), the adapter
  // re-reads, and the retry creates the profile stamped from the lease it now sees.
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  const horizon = new Date(Date.now() + 8 * 864e5).toISOString();

  const realTransact = repo.client.transactWrite;
  let crossed = false;
  repo.client.transactWrite = async (params) => {
    const put = params.TransactItems?.find((t) => t.Put?.Item?.pk === 'PROFILE#l-cross-dyn');
    if (put && !crossed) {
      crossed = true;
      // The mint's lease lands between the bootstrap's read and its transaction.
      store.items.set('LEASE#l-cross-dyn|REC', {
        pk: 'LEASE#l-cross-dyn', sk: 'REC', rev: 1, learnerId: 'l-cross-dyn',
        record: { learnerId: 'l-cross-dyn', retainUntil: horizon, rev: 1 },
      });
    }
    return realTransact(params);
  };

  await repo.saveProfile({ learnerId: 'l-cross-dyn', email: 'x@local.invalid', displayName: 'X' });
  assert.equal(crossed, true, 'the race must actually have happened');

  const item = [...store.items.values()].find((i) => i.pk === 'PROFILE#l-cross-dyn');
  assert.equal(item.record.retainUntil, horizon, 'the retry landed stamped from the lease');
  assert.equal(item.ttl, Math.floor(Date.parse(horizon) / 1000), 'with the matching physical ttl');
});

test('an expired physical lease does not deadlock profile creation or reclaim', async () => {
  // Translating "logically absent" into attribute_not_exists did: the expired row lingers for days,
  // the condition failed every retry, and the learner was stuck until TTL — while the memory
  // adapter sailed through. The expired-valid lease is PINNED instead, and not stamped from.
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  const past = new Date(Date.now() - 864e5).toISOString();
  store.items.set('LEASE#l-expired-lease|REC', {
    pk: 'LEASE#l-expired-lease', sk: 'REC', rev: 1, learnerId: 'l-expired-lease',
    record: { learnerId: 'l-expired-lease', retainUntil: past, rev: 1 },
  });

  // CREATE with the expired row present: no deadlock, and no stamp from a dead horizon.
  await repo.saveProfile({ learnerId: 'l-expired-lease', email: 'x@local.invalid', displayName: 'C' });
  const created = [...store.items.values()].find((i) => i.pk === 'PROFILE#l-expired-lease');
  assert.ok(created, 'the create must succeed before TTL removes the lease');
  assert.equal(created.record.retainUntil, undefined, 'an expired lease stamps nothing');

  // RECLAIM under the same expired row: seed an expired-anchored profile, then reclaim it.
  created.record.retainUntil = past;
  const reread = await repo.getProfile('l-expired-lease');
  assert.equal(reread, null, 'the profile reads as expired');
  await repo.saveProfile({ learnerId: 'l-expired-lease', email: 'x@local.invalid', displayName: 'R' });
  const reclaimed = [...store.items.values()].find((i) => i.pk === 'PROFILE#l-expired-lease');
  assert.equal(reclaimed.record.displayName, 'R', 'the reclaim must succeed too');
});

test('a renewal concurrent with an expired-lease write fails the pin and stamps the renewed horizon', async () => {
  // The pin on the EXPIRED lease is what makes this safe: a mint renewing the lease between the
  // read and the transaction bumps the revision, the pin fails, and the retry stamps from the
  // renewed lease instead of committing unanchored beside it.
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  const past = new Date(Date.now() - 864e5).toISOString();
  const renewed = new Date(Date.now() + 8 * 864e5).toISOString();
  store.items.set('LEASE#l-renewal|REC', {
    pk: 'LEASE#l-renewal', sk: 'REC', rev: 1, learnerId: 'l-renewal',
    record: { learnerId: 'l-renewal', retainUntil: past, rev: 1 },
  });

  const realTransact = repo.client.transactWrite;
  let crossed = false;
  repo.client.transactWrite = async (params) => {
    if (!crossed && params.TransactItems?.some((t) => t.Put?.Item?.pk === 'PROFILE#l-renewal')) {
      crossed = true;
      // The concurrent mint renews the lease between the raw read and the transaction.
      store.items.set('LEASE#l-renewal|REC', {
        pk: 'LEASE#l-renewal', sk: 'REC', rev: 2, learnerId: 'l-renewal',
        record: { learnerId: 'l-renewal', retainUntil: renewed, rev: 2 },
      });
    }
    return realTransact(params);
  };

  await repo.saveProfile({ learnerId: 'l-renewal', email: 'x@local.invalid', displayName: 'N' });
  assert.equal(crossed, true, 'the renewal must actually have crossed');
  const item = [...store.items.values()].find((i) => i.pk === 'PROFILE#l-renewal');
  assert.equal(item.record.retainUntil, renewed, 'the retry stamped from the RENEWED lease');
  assert.equal(item.ttl, Math.floor(Date.parse(renewed) / 1000));
});

/* ============================ R6: the run's physical ttl per state =========================== */

function runItem(store, runId) {
  return [...store.items.values()].find((i) => i.pk === `SMOKERUN#${runId}`);
}

test('the run ttl mirrors ownership in active and closing, and the tombstone at completion', async () => {
  // `ttl` was read from run.expiresAt unconditionally — a field that only exists AFTER completion —
  // so an ACTIVE or abandoned run was written with no ttl at all, while a comment claimed otherwise.
  // And closing rewrote the row without restating it, dropping the attribute: a cleanup failing
  // midway left a `closing` run with no physical bound.
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  const base = Date.parse('2026-07-29T00:00:00Z');
  let clock = base;
  repo.now = () => clock;

  const ownership = new Date(base + 8 * 864e5).toISOString();
  await repo.saveSmokeRun({
    runId: 'run-ttlstates00000000',
    learnerId: 'l-ttlstates',
    status: 'active',
    writeDeadlineAt: new Date(base + 864e5).toISOString(),
    ownershipExpiresAt: ownership,
  });
  const ownershipTtl = Math.floor(Date.parse(ownership) / 1000);
  assert.equal(runItem(store, 'run-ttlstates00000000').ttl, ownershipTtl, 'active mirrors ownership');

  await repo.closeSmokeRun('run-ttlstates00000000');
  assert.equal(runItem(store, 'run-ttlstates00000000').record.status, 'closing');
  assert.equal(runItem(store, 'run-ttlstates00000000').ttl, ownershipTtl, 'closing does not slide or drop it');

  // Completion re-anchors ONCE, to the tombstone horizon.
  clock = base + 6 * 864e5;
  const expiresAt = new Date(clock + 7 * 864e5).toISOString();
  await repo.completeSmokeRun({ runId: 'run-ttlstates00000000', completedAt: new Date(clock).toISOString(), expiresAt });
  assert.equal(runItem(store, 'run-ttlstates00000000').ttl, Math.floor(Date.parse(expiresAt) / 1000));

  // A REPLAY must not move it: first completion wins for the horizon, and the ttl follows it.
  clock = base + 10 * 864e5;
  await repo.completeSmokeRun({
    runId: 'run-ttlstates00000000',
    completedAt: new Date(clock).toISOString(),
    expiresAt: new Date(clock + 7 * 864e5).toISOString(),
  });
  assert.equal(runItem(store, 'run-ttlstates00000000').ttl, Math.floor(Date.parse(expiresAt) / 1000),
    'the replay must not slide the physical ttl');
});

test('a run with a missing or malformed horizon is refused, not written unbounded', async () => {
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  for (const horizon of [undefined, null, '', 'tomorrow', '2099', 42]) {
    const run = { runId: 'run-nohorizon00000000', learnerId: 'l-nh', status: 'active' };
    if (horizon !== undefined) run.ownershipExpiresAt = horizon;
    await assert.rejects(
      () => repo.saveSmokeRun(run),
      (err) => err.reason === 'RUN_HORIZON_UNREADABLE',
      JSON.stringify(horizon),
    );
    assert.equal(runItem(store, 'run-nohorizon00000000'), undefined, 'nothing unbounded was written');
  }
});

test('the claim snapshot is taken AFTER the run read, so a crossing there is caught', async () => {
  // R6 13, managed side — and stated honestly. DynamoDB exposes no server clock in a
  // ConditionExpression, so `:now` is this process's reading and a clock advancing between the
  // snapshot and the commit is NOT detectable by the table. What the transaction does guarantee is
  // the PIN: a run that closed or moved its horizon in that window fails the condition regardless
  // of skew (covered separately).
  //
  // What IS this adapter's responsibility is taking the snapshot late enough. Capturing it before
  // the run read would miss a crossing that happens during the read; taken after, the crossing is
  // caught by the adapter's own check.
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  const base = Date.parse('2026-07-29T00:00:00Z');
  let clock = base;
  repo.now = () => clock;
  await repo.saveSmokeRun({
    runId: 'run-crossclaim0000000',
    learnerId: 'l-crossclaim',
    status: 'active',
    writeDeadlineAt: new Date(base + 60_000).toISOString(),
    ownershipExpiresAt: new Date(base + 8 * 864e5).toISOString(),
  });

  const realGet = repo.client.get;
  repo.client.get = async (params) => {
    const res = await realGet(params);
    // The clock crosses the deadline DURING the run read — before the snapshot is taken.
    if (params.Key?.pk === 'SMOKERUN#run-crossclaim0000000') clock = base + 120_000;
    return res;
  };

  await assert.rejects(
    () => repo.claimActiveMock('l-crossclaim', 'mock_cross', { runId: 'run-crossclaim0000000' }),
    (err) => err.name === 'RepositoryConflictError',
    'a crossing before the snapshot must be caught',
  );
  assert.equal(await repo.getActiveMock('l-crossclaim'), null, 'and nothing was written');
});

test('a smoke-scoped WRITE crossing the deadline during the run read creates nothing', async () => {
  // R6 13, the write half — which the previous parcel left uncovered while the inventory claimed
  // "write/claim". The child transaction only checked `status = active`, and the deadline can pass
  // during the adapter's awaits while the run is still active, because nothing has closed it yet.
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  const base = Date.parse('2026-07-29T00:00:00Z');
  let clock = base;
  repo.now = () => clock;
  await repo.saveSmokeRun({
    runId: 'run-crosswrite000000',
    learnerId: 'l-crosswrite',
    status: 'active',
    writeDeadlineAt: new Date(base + 60_000).toISOString(),
    ownershipExpiresAt: new Date(base + 8 * 864e5).toISOString(),
  });

  const realGet = repo.client.get;
  repo.client.get = async (params) => {
    const res = await realGet(params);
    // The clock crosses the deadline DURING the run read that precedes the transaction.
    if (params.Key?.pk === 'SMOKERUN#run-crosswrite000000') clock = base + 120_000;
    return res;
  };

  const attempt = { attemptId: 'att_cross', learnerId: 'l-crosswrite', runId: 'run-crosswrite000000', answers: {} };
  await assert.rejects(
    () => repo.saveAttempt(attempt),
    (err) => err.name === 'RepositoryConflictError',
    'the write must be refused after the crossing',
  );
  assert.equal([...store.items.values()].some((i) => i.pk === 'ATTEMPT#att_cross'), false,
    'and no row may have been created');

  // The same holds for an UPDATE, not only a create: fencing creation alone closed instances.
  clock = base;
  repo.client.get = realGet;
  await repo.saveAttempt(attempt);
  const stored = await repo.getAttempt('att_cross');
  stored.answers = { 1: { selectedOption: 'A' } };

  repo.client.get = async (params) => {
    const res = await realGet(params);
    if (params.Key?.pk === 'SMOKERUN#run-crosswrite000000') clock = base + 120_000;
    return res;
  };
  await assert.rejects(() => repo.saveAttempt(stored), (err) => err.name === 'RepositoryConflictError');
  clock = base;
  repo.client.get = realGet;
  assert.deepEqual((await repo.getAttempt('att_cross')).answers, {}, 'the update must not have landed');
});

test('the fake refuses a SMOKERUN condition that drops the deadline fence entirely', async () => {
  // Guards the guard, keyed on the TARGET rather than on which values production sent. The previous
  // version demanded the canonical shape only when `:deadline` was present, so omitting the fence —
  // the one change it existed to catch — took the check away with it.
  const store = createFakeDynamoStore();
  const repo = makeRepoWith(store);
  await assert.rejects(
    () => repo.client.transactWrite({
      TransactItems: [{
        ConditionCheck: {
          TableName: 'fake-table',
          Key: { pk: 'SMOKERUN#x', sk: 'REC' },
          ConditionExpression: 'record.#s = :active',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':active': 'active' },
        },
      }],
    }),
    /must be exactly/,
  );
});
