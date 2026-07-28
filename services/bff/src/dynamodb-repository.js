// DynamoDB SimulationRepository adapter (#77 Stage B) — INFRASTRUCTURE. The AWS SDK never leaks
// above this file: the adapter speaks to a minimal document-client facade (get/put/update/query/
// delete returning plain JS), which tests replace with an in-memory fake and #78 wires to the
// real @aws-sdk DocumentClient via `createDynamoDbClient` below.
//
// ACCESS PATTERNS (documented before coding; NO Scan anywhere):
//   Record items  pk = '<TYPE>#<id>' (TYPE in SESSION|ATTEMPT|MOCK|PROFILE), sk = 'REC'
//                 attrs: record (the plain JSON doc), learnerId, rev (optimistic counter),
//                        gsi1pk = 'LEARNER#<learnerId>', gsi1sk = '<TYPE>#<id>'
//     - get-by-id            -> GetItem(pk, 'REC')
//     - list-by-learner      -> Query GSI1: gsi1pk = LEARNER#<id> AND begins_with(gsi1sk, TYPE#)
//   Counter       pk = 'COUNTER', sk = 'REC', attr n -> UpdateItem ADD n 1 (atomic id source)
//   Active mock   pk = 'LEARNER#<id>', sk = 'ACTIVE_MOCK', attr mockExamId
//     - claim   -> PutItem with ConditionExpression attribute_not_exists(pk)  (ATOMIC)
//     - get     -> GetItem
//     - release -> DeleteItem with ConditionExpression mockExamId = :id (only your own claim)
//
// CONCURRENCY: every record save is a conditional write — create requires the item to be absent,
// update requires the stored rev to equal the rev this adapter instance last read. A lost update
// therefore fails with RepositoryConflictError (mapped to 409 CONFLICT by the dispatcher) instead
// of silently overwriting answers. Application-level idempotency (identical practice retry OK,
// different selection 409 ALREADY_ANSWERED, mock replace pre-submit only) lives in the store and
// is unchanged by this adapter.
import { RepositoryConflictError } from './repository.js';

const REC = 'REC';

/** Count the answers a record carries, whatever shape holds them. */
function countAnswers(record) {
  const answers = record?.answers;
  if (Array.isArray(answers)) return answers.filter((a) => a != null).length;
  if (answers && typeof answers === 'object') return Object.keys(answers).length;
  return 0;
}

/**
 * Did the RUN's condition check fail, as opposed to anything else in the transaction?
 *
 * `CancellationReasons` is positional: index 0 is the run's ConditionCheck. Treating every
 * `TransactionCanceledException` as a closed run misclassified transaction conflicts and capacity
 * failures, which are faults that must surface rather than be reported as run state.
 */
function runConditionFailed(err) {
  if (err?.name !== 'TransactionCanceledException') return false;
  const reasons = err.CancellationReasons;
  if (!Array.isArray(reasons)) return false;
  return reasons[0]?.Code === 'ConditionalCheckFailed';
}

/** Did the RECORD's own condition fail? `CancellationReasons` index 1 is the record's Put. */
function recordConditionFailed(err) {
  if (err?.name !== 'TransactionCanceledException') return false;
  const reasons = err.CancellationReasons;
  return Array.isArray(reasons) && reasons[1]?.Code === 'ConditionalCheckFailed';
}

function recordKey(type, id) {
  return { pk: `${type}#${id}`, sk: REC };
}

export class DynamoDbSimulationRepository {
  /**
   * @param {{ tableName: string, client: {get:Function,put:Function,update:Function,query:Function,delete:Function} }} opts
   */
  constructor({ tableName, client }) {
    if (!tableName) throw new Error('DynamoDbSimulationRepository requires a tableName.');
    if (!client) throw new Error('DynamoDbSimulationRepository requires a document client.');
    this.tableName = tableName;
    this.client = client;
    // Optimistic token per READ OBJECT (WeakMap): every read carries its own rev, so two reads
    // of the same record in the SAME instance still conflict when the second save is stale.
    this.revs = new WeakMap();
  }

  isConditionalFailure(err) {
    return err?.name === 'ConditionalCheckFailedException' || err?.name === 'RepositoryConflictError';
  }

  async #getRecord(type, id) {
    const res = await this.client.get({ TableName: this.tableName, Key: recordKey(type, id) });
    if (!res.Item) return null;
    const record = res.Item.record;
    this.revs.set(record, res.Item.rev);
    return record;
  }

  async #saveRecord(type, id, learnerId, record, extra = {}) {
    const key = `${type}#${id}`;
    const expected = this.revs.get(record);
    const item = {
      ...recordKey(type, id),
      record,
      learnerId,
      rev: (expected ?? 0) + 1,
      gsi1pk: `LEARNER#${learnerId}`,
      gsi1sk: key,
      ...extra,
    };
    const params = {
      TableName: this.tableName,
      Item: item,
      ...(expected === undefined
        ? { ConditionExpression: 'attribute_not_exists(pk)' }
        : {
            ConditionExpression: 'rev = :expected',
            ExpressionAttributeValues: { ':expected': expected },
          }),
    };
    // A record carrying a run id is fenced on that run being ACTIVE — for UPDATES as much as for
    // creation. Fencing creation alone closed instances rather than the class: an answer written
    // after cleanup could reinsert an attempt the cleanup had already verified gone.
    const fenced = Boolean(record?.runId) && ['SESSION', 'MOCK', 'ATTEMPT'].includes(type);
    try {
      if (fenced) {
        await this.client.transactWrite({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: recordKey('SMOKERUN', record.runId),
                ConditionExpression: 'record.#s = :active',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: { ':active': 'active' },
              },
            },
            { Put: { ...params } },
          ],
        });
      } else {
        await this.client.put(params);
      }
    } catch (err) {
      if (runConditionFailed(err)) {
        throw new RepositoryConflictError('This smoke run stopped accepting records.');
      }
      // Only the RECORD's own condition — its rev, or attribute_not_exists on create — is a lost
      // update. A generic TransactionCanceledException is NOT: mapping it here turned transaction
      // conflicts and capacity failures into a conflict the caller then swallowed as "run closed".
      if (this.isConditionalFailure(err) || recordConditionFailed(err)) {
        throw new RepositoryConflictError(`Lost update on ${type.toLowerCase()} record.`);
      }
      throw err;
    }
    this.revs.set(record, item.rev);
  }

  async #listRecords(learnerId, type) {
    // DynamoDB Query pages at 1 MB: ALWAYS follow LastEvaluatedKey so learner history,
    // readiness rollups, and onlyMissed pools are complete.
    const records = [];
    let ExclusiveStartKey;
    do {
      const res = await this.client.query({
        TableName: this.tableName,
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :pk AND begins_with(gsi1sk, :prefix)',
        ExpressionAttributeValues: { ':pk': `LEARNER#${learnerId}`, ':prefix': `${type}#` },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      });
      for (const item of res.Items ?? []) {
        this.revs.set(item.record, item.rev);
        records.push(item.record);
      }
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return records;
  }

  async nextId(prefix) {
    const res = await this.client.update({
      TableName: this.tableName,
      Key: { pk: 'COUNTER', sk: REC },
      UpdateExpression: 'ADD n :one',
      ExpressionAttributeValues: { ':one': 1 },
      ReturnValues: 'UPDATED_NEW',
    });
    return `${prefix}_${Number(res.Attributes.n).toString(36)}`;
  }

  async getSession(id) {
    return this.#getRecord('SESSION', id);
  }

  async saveSession(session) {
    await this.#saveRecord('SESSION', session.practiceSessionId, session.learnerId, session);
  }

  async getAttempt(id) {
    return this.#getRecord('ATTEMPT', id);
  }

  async saveAttempt(attempt) {
    await this.#saveRecord('ATTEMPT', attempt.attemptId, attempt.learnerId, attempt);
  }

  async listAttempts(learnerId) {
    return this.#listRecords(learnerId, 'ATTEMPT');
  }

  async getMock(id) {
    return this.#getRecord('MOCK', id);
  }

  async saveMock(mock) {
    await this.#saveRecord('MOCK', mock.mockExamId, mock.learnerId, mock);
  }

  async listMocks(learnerId) {
    return this.#listRecords(learnerId, 'MOCK');
  }

  async getProfile(learnerId) {
    return this.#getRecord('PROFILE', learnerId);
  }

  async saveProfile(profile) {
    await this.#saveRecord('PROFILE', profile.learnerId, profile.learnerId, profile);
  }

  /** The unfenced claim, for ordinary learners with no run. */
  async #claimWithoutRun(learnerId, mockExamId) {
    try {
      await this.client.put({
        TableName: this.tableName,
        Item: { pk: `LEARNER#${learnerId}`, sk: 'ACTIVE_MOCK', mockExamId },
        ConditionExpression: 'attribute_not_exists(pk)',
      });
      return true;
    } catch (err) {
      if (this.isConditionalFailure(err)) return false;
      throw err;
    }
  }

  async getActiveMock(learnerId) {
    const res = await this.client.get({
      TableName: this.tableName,
      Key: { pk: `LEARNER#${learnerId}`, sk: 'ACTIVE_MOCK' },
    });
    return res.Item?.mockExamId ?? null;
  }

  async releaseActiveMock(learnerId, mockExamId) {
    try {
      await this.client.delete({
        TableName: this.tableName,
        Key: { pk: `LEARNER#${learnerId}`, sk: 'ACTIVE_MOCK' },
        ConditionExpression: 'mockExamId = :id',
        ExpressionAttributeValues: { ':id': mockExamId },
      });
    } catch (err) {
      if (!this.isConditionalFailure(err)) throw err; // releasing someone else's claim is a no-op
    }
  }

  /* Logical readiness only: adapter kind + reachability — never table names/ARNs/account ids. */
  /* Smoke-run records (#75): a RUN item keyed like any other record, owned by its learner. */
  async saveSmokeRun(run) {
    // Even an ACTIVE run carries a TTL: a run abandoned before cleanup would otherwise keep learner
    // ownership forever.
    const ttl = run.expiresAt ? { ttl: Math.floor(Date.parse(run.expiresAt) / 1000) } : {};
    await this.#saveRecord('SMOKERUN', run.runId, run.learnerId, run, ttl);
  }

  async getSmokeRun(runId) {
    return this.#getRecord('SMOKERUN', runId);
  }

  /**
   * Write a smoke-scoped record ONLY while its run is still active.
   *
   * A TRANSACTION, because the alternative is a time-of-check/time-of-use gap: the dispatcher's
   * check ran before this handler, so a plain conditional put would still let a write commit after
   * cleanup reported success. The condition check on the run item and the record write either both
   * apply or neither does.
   */
  async saveSmokeScopedRecord({ runId, kind, record }) {
    const save = { session: 'saveSession', mock: 'saveMock', attempt: 'saveAttempt' }[kind];
    if (!save) throw new Error(`unknown smoke-scoped record kind "${kind}"`);
    try {
      await this[save]({ ...record, runId });
      return true;
    } catch (err) {
      if (err instanceof RepositoryConflictError) return false;
      throw err;
    }
  }

  /** The claim is a projection and needs the same fence, conditioned on the run in one transaction. */
  async claimActiveMock(learnerId, mockExamId, { runId = null } = {}) {
    if (!runId) return this.#claimWithoutRun(learnerId, mockExamId);
    try {
      await this.client.transactWrite({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: this.tableName,
              Key: recordKey('SMOKERUN', runId),
              ConditionExpression: 'record.#s = :active',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: { ':active': 'active' },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: { pk: `LEARNER#${learnerId}`, sk: 'ACTIVE_MOCK', mockExamId },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        ],
      });
      return true;
    } catch (err) {
      if (runConditionFailed(err)) throw new RepositoryConflictError('This smoke run stopped accepting records.');
      // `false` means EXACTLY one thing: somebody else already holds the claim. Resolving every
      // other cancellation to `false` turned a transaction conflict or a capacity failure into
      // MOCK_EXAM_IN_PROGRESS, telling the caller a story about state while hiding a fault.
      if (recordConditionFailed(err)) return false;
      throw err;
    }
  }

  /** Move a run to `closing` so in-flight writes can no longer commit into it. */
  async closeSmokeRun(runId) {
    const run = await this.getSmokeRun(runId);
    if (!run) return null;
    if (run.status === 'active') {
      run.status = 'closing';
      await this.#saveRecord('SMOKERUN', runId, run.learnerId, run);
    }
    return run;
  }

  /**
   * Mark a run completed — a tombstone, never a deletion. Called only after verification.
   *
   * The item also carries `ttl`, the epoch-seconds attribute the table's TTL is configured on, so
   * the tombstone's retention is bounded (SEC-DATA-01). TTL is cleanup, not authorization: the
   * application refuses a completed run immediately, so nothing waits on the row disappearing.
   */
  async completeSmokeRun({ runId, completedAt, expiresAt }) {
    const run = await this.getSmokeRun(runId);
    if (!run) return null;
    // FIRST completion wins: recomputing the expiry on every replay slid the tombstone forward, so
    // repeated replays could retain it indefinitely. Retention runs from when the run finished.
    run.completedAt = run.completedAt ?? completedAt;
    run.expiresAt = run.expiresAt ?? expiresAt;
    run.status = 'completed';
    await this.#saveRecord('SMOKERUN', runId, run.learnerId, run, {
      ttl: Math.floor(Date.parse(run.expiresAt) / 1000),
    });
    return run;
  }

  /**
   * How many records still match learner + run, per class.
   *
   * Zero everywhere is the only proof of a COMPLETE cleanup. Counting deletions cannot distinguish
   * "nothing existed" from "a record survived contention" — both report zero — so the use case
   * verifies with this instead of inferring completeness from what it removed.
   */
  async countSmokeRunRecords({ learnerId, runId }) {
    const counts = { practiceSessions: 0, mockExams: 0, attempts: 0 };
    const byType = { SESSION: 'practiceSessions', MOCK: 'mockExams', ATTEMPT: 'attempts' };
    for (const [type, key] of Object.entries(byType)) {
      for (const { record } of await this.#listItems(learnerId, type)) {
        if (record?.learnerId === learnerId && record?.runId === runId) counts[key] += 1;
      }
    }
    return counts;
  }

  /**
   * Delete everything a smoke RUN created for a smoke LEARNER (#75).
   *
   * The learner GSI is the only access path used: the query is `gsi1pk = LEARNER#<id>`, so the scan
   * surface is one learner's partition and nothing else — no table scan, no cross-learner read, and
   * no wildcard. Records are then filtered by `runId` IN THE ADAPTER, and a record that matches the
   * learner but not the run is left untouched.
   *
   * Deletes are conditional on the record still being the one that was read: a concurrent write
   * bumps `rev`, the delete fails its condition, and the record is skipped rather than removed
   * blind. That keeps the operation safe to repeat, which is what #70's `always()` job needs.
   */
  async deleteSmokeRunData({ learnerId, runId }) {
    const deleted = { practiceSessions: 0, mockExams: 0, attempts: 0, answers: 0, projections: 0 };
    const counters = { SESSION: 'practiceSessions', MOCK: 'mockExams', ATTEMPT: 'attempts' };

    for (const [type, counter] of Object.entries(counters)) {
      for (const { record, item } of await this.#listItems(learnerId, type)) {
        // BOTH bounds, in the adapter as well as in the port: the query already scoped the learner,
        // and this scopes the run. A record missing either is not this run's to delete.
        if (record?.learnerId !== learnerId || record?.runId !== runId) continue;
        const removed = await this.#deleteIfUnchanged(item);
        if (!removed) continue;
        deleted[counter] += 1;
        deleted.answers += countAnswers(record);
      }
    }

    // The one-active-mock claim is keyed by learner alone. It is released only when the mock it
    // points at is gone — left behind, it would block every future mock for this learner, and a
    // smoke that cleans up and can never run again is not a cleanup.
    const active = await this.getActiveMock(learnerId);
    if (active) {
      const stillThere = await this.getMock(active);
      if (!stillThere) {
        await this.releaseActiveMock(learnerId, active);
        deleted.projections += 1;
      }
    }

    // The profile cache carries no run id, so it goes only when this learner has no records left.
    // Removing it while another run's data survives would damage a run this call never scoped.
    const remaining = await this.#anyRecordsRemain(learnerId);
    if (!remaining) {
      const profile = await this.getProfile(learnerId);
      if (profile) {
        await this.client.delete({ TableName: this.tableName, Key: recordKey('PROFILE', learnerId) });
        deleted.projections += 1;
      }
    }

    return deleted;
  }

  /** Like #listRecords, but keeps the item so a delete can be made conditional on its rev. */
  async #listItems(learnerId, type) {
    const out = [];
    let ExclusiveStartKey;
    do {
      const res = await this.client.query({
        TableName: this.tableName,
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :pk AND begins_with(gsi1sk, :prefix)',
        ExpressionAttributeValues: { ':pk': `LEARNER#${learnerId}`, ':prefix': `${type}#` },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      });
      for (const item of res.Items ?? []) out.push({ record: item.record, item });
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }

  /** Delete only if nobody wrote the record since it was read. Returns whether it was removed. */
  async #deleteIfUnchanged(item) {
    try {
      await this.client.delete({
        TableName: this.tableName,
        Key: { pk: item.pk, sk: item.sk },
        ConditionExpression: 'rev = :expected',
        ExpressionAttributeValues: { ':expected': item.rev },
      });
      return true;
    } catch (err) {
      if (this.isConditionalFailure(err)) return false;
      throw err;
    }
  }

  async #anyRecordsRemain(learnerId) {
    for (const type of ['SESSION', 'MOCK', 'ATTEMPT']) {
      const items = await this.#listItems(learnerId, type);
      if (items.length > 0) return true;
    }
    return false;
  }

  async readiness() {
    try {
      await this.client.get({ TableName: this.tableName, Key: { pk: 'COUNTER', sk: REC } });
      return { adapter: 'dynamodb', ready: true };
    } catch {
      return { adapter: 'dynamodb', ready: false };
    }
  }
}

/**
 * Real-client factory (#78 wires/bundles this): dynamic import keeps the AWS SDK out of every
 * local/memory/file path and out of test runs. The SDK modules are optional peer dependencies —
 * the deployed runtime bundle provides them.
 */
export async function createDynamoDbClient() {
  let DynamoDBClient, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand, DeleteCommand,
    TransactWriteCommand;
  try {
    ({ DynamoDBClient } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ '@aws-sdk/client-dynamodb'));
    ({ DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand, DeleteCommand,
      TransactWriteCommand } =
      await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ '@aws-sdk/lib-dynamodb'));
  } catch {
    throw new Error(
      'CBA_WEB_STORE=dynamodb needs @aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb in the ' +
        'runtime bundle (#78). They are optional peers of this package on purpose.',
    );
  }
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return {
    get: (p) => doc.send(new GetCommand(p)),
    put: (p) => doc.send(new PutCommand(p)),
    update: (p) => doc.send(new UpdateCommand(p)),
    query: (p) => doc.send(new QueryCommand(p)),
    delete: (p) => doc.send(new DeleteCommand(p)),
    // #75: a smoke-scoped write pairs a condition check on the run with the record put, so the
    // run's state and the record either both apply or neither does. Without this command wired
    // here, the first deployed smoke-scoped creation would fail at runtime.
    transactWrite: (p) => doc.send(new TransactWriteCommand(p)),
  };
}
