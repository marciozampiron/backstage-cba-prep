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
  return { items: new Map() }; // key: `${pk}|${sk}` -> item
}

export function createFakeDynamoClient(store, { failNextPutWith, queryPageSize } = {}) {
  const keyOf = (k) => `${k.pk}|${k.sk}`;
  return {
    async get({ Key }) {
      const item = store.items.get(keyOf(Key));
      return item ? { Item: structuredClone(item) } : {};
    },
    async put({ Item, ConditionExpression, ExpressionAttributeValues }) {
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
          const expected = item.ConditionCheck.ExpressionAttributeValues[':active'];
          if (!existing || existing.record?.status !== expected) return { Code: 'ConditionalCheckFailed' };
        }
        if (item.Put?.ConditionExpression) {
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

runRepositorySuite('dynamodb', async () => makeRepoWith(createFakeDynamoStore()), {
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
