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
      } else if (ConditionExpression !== undefined) {
        throw new Error(`fake client: unsupported delete condition "${ConditionExpression}"`);
      }
      store.items.delete(key);
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
