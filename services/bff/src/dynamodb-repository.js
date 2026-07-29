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
import { RepositoryConflictError, profileVisible, resolveChildAnchor, smokeChildVisible } from './repository.js';
import { parseInstant, toInstant } from './instant.js';

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
  constructor({ tableName, client, now }) {
    if (!tableName) throw new Error('DynamoDbSimulationRepository requires a tableName.');
    if (!client) throw new Error('DynamoDbSimulationRepository requires a document client.');
    this.tableName = tableName;
    this.client = client;
    // Same contract as the local adapters (#75): composition owns the clock, and an adapter that
    // cannot be bound is refused rather than silently left on wall time.
    this.hasExplicitClock = now !== undefined;
    this.now = now ?? (() => Date.now());
    // Optimistic token per READ OBJECT (WeakMap): every read carries its own rev, so two reads
    // of the same record in the SAME instance still conflict when the second save is stale.
    this.revs = new WeakMap();
  }

  bindClock(now) {
    if (typeof now !== 'function') throw new Error('bindClock requires a clock function.');
    if (this.hasExplicitClock) return false;
    this.now = now;
    return true;
  }

  isConditionalFailure(err) {
    return err?.name === 'ConditionalCheckFailedException' || err?.name === 'RepositoryConflictError';
  }

  /**
   * RAW single read — no expiry filter, and STRONGLY CONSISTENT. Every caller of this path is
   * either a compare-and-set (which must see the revision it will condition on) or a physical
   * inspection (cleanup, which must see the row ordinary reads hide). An eventually consistent
   * read here let a just-written run appear absent during mint authorization, and a stale lease
   * pose as the winning value.
   */
  async #getRecordRaw(type, id) {
    const res = await this.client.get({
      TableName: this.tableName,
      Key: recordKey(type, id),
      ConsistentRead: true,
    });
    if (!res.Item) return null;
    this.revs.set(res.Item.record, res.Item.rev);
    return res.Item.record;
  }

  async #getRecord(type, id) {
    const res = await this.client.get({ TableName: this.tableName, Key: recordKey(type, id) });
    if (!res.Item) return null;
    const record = res.Item.record;
    this.revs.set(record, res.Item.rev);
    return record;
  }

  async #saveRecord(type, id, learnerId, incoming, extra = {}) {
    const key = `${type}#${id}`;
    // Write-once anchor, owned here (#75 R6). On update the STORED value is rewritten verbatim; the
    // incoming one is ignored rather than trusted, because a caller that can extend its own
    // retention has no retention.
    let record = incoming;
    if (incoming?.runId && ['SESSION', 'MOCK', 'ATTEMPT'].includes(type)) {
      // `exists` is the PHYSICAL item, not the presence of a field: `stored ?? fresh` treated a
      // corrupted existing row as new and restarted its retention.
      const existing = await this.#getRecordRaw(type, id);
      const retainUntil = resolveChildAnchor({ exists: existing !== null, existing, nowMs: this.now() });
      record = { ...incoming, retainUntil };
      this.revs.set(record, this.revs.get(incoming));
      // ttl derives from the VALIDATED anchor only.
      extra = { ...extra, ttl: Math.floor(Date.parse(retainUntil) / 1000) };
    }
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

  /* ORDINARY reads are filtered; cleanup uses the RAW path. */
  async getSession(id) {
    const found = await this.#getRecord('SESSION', id);
    return smokeChildVisible(found, this.now()) ? found : null;
  }

  async saveSession(session) {
    await this.#saveRecord('SESSION', session.practiceSessionId, session.learnerId, session);
  }

  async getAttempt(id) {
    const found = await this.#getRecord('ATTEMPT', id);
    return smokeChildVisible(found, this.now()) ? found : null;
  }

  async saveAttempt(attempt) {
    await this.#saveRecord('ATTEMPT', attempt.attemptId, attempt.learnerId, attempt);
  }

  async listAttempts(learnerId) {
    const at = this.now();
    return (await this.#listRecords(learnerId, 'ATTEMPT')).filter((a) => smokeChildVisible(a, at));
  }

  async getMock(id) {
    const found = await this.#getRecord('MOCK', id);
    return smokeChildVisible(found, this.now()) ? found : null;
  }

  async saveMock(mock) {
    await this.#saveRecord('MOCK', mock.mockExamId, mock.learnerId, mock);
  }

  async listMocks(learnerId) {
    const at = this.now();
    return (await this.#listRecords(learnerId, 'MOCK')).filter((m) => smokeChildVisible(m, at));
  }

  /* Profile retention lease (#75 R6) — the same read/CAS contract as the local adapters. */

  /** Logical read: a clone; expired hidden before TTL; unreadable control data reads as absent. */
  async getSmokeLease(learnerId) {
    const lease = await this.#getRecordRaw('LEASE', learnerId);
    if (!lease) return null;
    const horizon = parseInstant(lease.retainUntil);
    if (horizon === null || this.now() >= horizon) return null;
    return structuredClone(lease);
  }

  /**
   * Monotonic extension by compare-and-set on the revision, with bounded retry.
   *
   * The previous version conditioned on the horizon comparison alone and read every lost condition
   * as "already satisfied" — so a malformed stored value that happened to sort above an ISO
   * timestamp was returned as if it were a valid retention bound, and two writers from the same
   * revision could both commit. Now: unreadable control data is a CONFLICT; a valid stored horizon
   * >= the request returns the stored (winning) lease; anything else writes conditionally on the
   * exact revision the strong read saw, and a lost race re-reads and tries again, bounded.
   */
  async extendSmokeLease({ learnerId, retainUntil }) {
    const requested = parseInstant(retainUntil);
    if (requested === null) {
      throw new RepositoryConflictError('The lease horizon is unreadable and will not be written.');
    }
    const canonical = toInstant(requested);
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.#getRecordRaw('LEASE', learnerId);
      if (current) {
        const stored = parseInstant(current.retainUntil);
        const rev = Number.isInteger(current.rev) && current.rev > 0 ? current.rev : null;
        if (stored === null || rev === null) {
          const err = new RepositoryConflictError('This lease has no readable control data; it cannot satisfy or be extended.');
          err.reason = 'LEASE_UNREADABLE';
          throw err;
        }
        if (stored >= requested) return structuredClone(current);
        const record = { learnerId, retainUntil: canonical, rev: rev + 1 };
        try {
          await this.client.put({
            TableName: this.tableName,
            Item: {
              ...recordKey('LEASE', learnerId),
              record,
              learnerId,
              rev: record.rev,
              gsi1pk: `LEARNER#${learnerId}`,
              gsi1sk: `LEASE#${learnerId}`,
              ttl: Math.floor(requested / 1000),
            },
            ConditionExpression: 'rev = :expected',
            ExpressionAttributeValues: { ':expected': rev },
          });
          return record;
        } catch (err) {
          if (this.isConditionalFailure(err)) continue; // somebody committed first: re-read, retry
          throw err;
        }
      }
      const record = { learnerId, retainUntil: canonical, rev: 1 };
      try {
        await this.client.put({
          TableName: this.tableName,
          Item: {
            ...recordKey('LEASE', learnerId),
            record,
            learnerId,
            rev: 1,
            gsi1pk: `LEARNER#${learnerId}`,
            gsi1sk: `LEASE#${learnerId}`,
            ttl: Math.floor(requested / 1000),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        });
        return record;
      } catch (err) {
        if (this.isConditionalFailure(err)) continue;
        throw err;
      }
    }
    throw new RepositoryConflictError('The lease could not be extended after repeated contention.');
  }

  /** Stamp an EXISTING profile's retention, monotonically and revision-conditionally. */
  async stampProfileRetention({ learnerId, retainUntil }) {
    const requested = parseInstant(retainUntil);
    if (requested === null) {
      throw new RepositoryConflictError('The retention horizon is unreadable and will not be written.');
    }
    const profile = await this.#getRecordRaw('PROFILE', learnerId);
    if (!profile) return false; // bootstrap consumes the lease at creation instead
    if (profile.retainUntil !== undefined && parseInstant(profile.retainUntil) === null) {
      const err = new RepositoryConflictError('This profile has no readable retention anchor; only cleanup may touch it.');
      err.reason = 'RETENTION_ANCHOR_UNREADABLE';
      throw err;
    }
    const stored = parseInstant(profile.retainUntil);
    if (stored !== null && stored >= requested) return true;
    profile.retainUntil = toInstant(requested);
    await this.#saveRecord('PROFILE', learnerId, learnerId, profile, {
      ttl: Math.floor(requested / 1000),
    });
    return true;
  }

  async getProfile(learnerId) {
    const profile = await this.#getRecordRaw('PROFILE', learnerId);
    const lease = await this.getSmokeLease(learnerId);
    return profileVisible(profile, lease, this.now()) ? profile : null;
  }

  /**
   * Write a profile CREATE or RECLAIM linearized against the lease, in one transaction.
   *
   * A strong read followed by a plain conditional put still left the window the reviewer
   * reproduced: the bootstrap reads "no lease", a whole mint lands in the gap — lease written,
   * stamp finding no profile, success reported — and the delayed put commits an UNANCHORED profile
   * that outlives the lease forever, because an unanchored profile is classified ordinary and
   * never filtered. A post-write repair is not enough either: a crash between the put and the
   * repair leaves the same state. So the write CONDITIONS on the lease itself — absent stays
   * absent, or present at the exact revision and horizon the stamp was taken from — and a lease
   * that moved makes the write lose, re-read and retry with the new truth.
   *
   * `expectedRev` is the profile's own physical revision for a reclaim, or undefined for a create.
   */
  async #linearizedProfileWrite(next, { expectedRev }) {
    const learnerId = next.learnerId;
    for (let attempt = 0; attempt < 3; attempt++) {
      // The PHYSICAL lease, classified — not the logical read. Translating "logically absent" into
      // attribute_not_exists deadlocked this write whenever an EXPIRED lease row lingered: the row
      // can outlive its horizon by days, the condition failed every retry, and the learner was
      // stuck until TTL — while the memory adapter sailed through. Four states, four answers:
      //   absent         -> condition on the key staying absent;
      //   active         -> pin rev+horizon AND stamp from it;
      //   expired-valid  -> pin rev+horizon, do NOT stamp — the pin still matters, because a
      //                     concurrent renewal must fail it, forcing a retry that stamps from the
      //                     renewed lease instead of committing unanchored beside it;
      //   unreadable     -> fail closed.
      const rawLease = await this.#getRecordRaw('LEASE', learnerId);
      let leaseCheck;
      let stampFrom = null;
      if (!rawLease) {
        leaseCheck = {
          ConditionCheck: {
            TableName: this.tableName,
            Key: recordKey('LEASE', learnerId),
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        };
      } else {
        const horizon = parseInstant(rawLease.retainUntil);
        const rev = Number.isInteger(rawLease.rev) && rawLease.rev > 0 ? rawLease.rev : null;
        if (horizon === null || rev === null) {
          const err = new RepositoryConflictError('This lease has no readable control data; it cannot satisfy or be extended.');
          err.reason = 'LEASE_UNREADABLE';
          throw err;
        }
        leaseCheck = {
          ConditionCheck: {
            TableName: this.tableName,
            Key: recordKey('LEASE', learnerId),
            ConditionExpression: 'rev = :leaserev AND record.#ru = :ru',
            ExpressionAttributeNames: { '#ru': 'retainUntil' },
            ExpressionAttributeValues: { ':leaserev': rev, ':ru': rawLease.retainUntil },
          },
        };
        if (this.now() < horizon) stampFrom = rawLease.retainUntil;
      }
      const record = { ...next };
      let ttlExtra = {};
      if (stampFrom) {
        record.retainUntil = stampFrom;
        ttlExtra = { ttl: Math.floor(Date.parse(stampFrom) / 1000) };
      }
      const item = {
        ...recordKey('PROFILE', learnerId),
        record,
        learnerId,
        rev: (expectedRev ?? 0) + 1,
        gsi1pk: `LEARNER#${learnerId}`,
        gsi1sk: `PROFILE#${learnerId}`,
        ...ttlExtra,
      };
      const putCondition = expectedRev === undefined
        ? { ConditionExpression: 'attribute_not_exists(pk)' }
        : { ConditionExpression: 'rev = :expected', ExpressionAttributeValues: { ':expected': expectedRev } };
      try {
        await this.client.transactWrite({
          TransactItems: [leaseCheck, { Put: { TableName: this.tableName, Item: item, ...putCondition } }],
        });
        this.revs.set(record, item.rev);
        return;
      } catch (err) {
        if (err?.name === 'TransactionCanceledException' && Array.isArray(err.CancellationReasons)) {
          // Index 1 is the profile's own condition: a genuine race loser, same as before.
          if (err.CancellationReasons[1]?.Code === 'ConditionalCheckFailed') {
            throw new RepositoryConflictError('Lost update on profile record.');
          }
          // Index 0 is the lease: it moved under us — re-read and retry with the new truth.
          if (err.CancellationReasons[0]?.Code === 'ConditionalCheckFailed') continue;
        }
        throw err;
      }
    }
    throw new RepositoryConflictError('The profile write could not be linearized against the lease.');
  }

  async saveProfile(profile) {
    const learnerId = profile.learnerId;
    // The anchor is repository-owned: whatever the caller sent is discarded, and the rev the caller's
    // object carried (from a filtered read) is transferred to the rebuilt record.
    const next = { ...profile };
    delete next.retainUntil;
    this.revs.set(next, this.revs.get(profile));

    const existing = await this.#getRecordRaw('PROFILE', learnerId);
    if (!existing) {
      // CREATE: linearized against the lease.
      return this.#linearizedProfileWrite(next, { expectedRev: undefined });
    }
    if (existing.retainUntil !== undefined) {
      const stored = parseInstant(existing.retainUntil);
      if (stored === null) {
        const err = new RepositoryConflictError('This profile has no readable retention anchor; only cleanup may touch it.');
        err.reason = 'RETENTION_ANCHOR_UNREADABLE';
        throw err;
      }
      if (this.now() < stored) {
        // LIVE: preserved verbatim — an ordinary update never extends retention.
        next.retainUntil = existing.retainUntil;
        return this.#saveRecord('PROFILE', learnerId, learnerId, next, {
          ttl: Math.floor(stored / 1000),
        });
      }
      // EXPIRED-but-present: RECLAIM — linearized like a create, conditional on the physical
      // revision the raw read saw, so a stale reclaim loses to a concurrent fresh write.
      return this.#linearizedProfileWrite(next, { expectedRev: this.revs.get(existing) });
    }
    // Ordinary existing profile: a plain update, rev riding the caller's object.
    return this.#saveRecord('PROFILE', learnerId, learnerId, next);
  }

  /** The unfenced claim, for ordinary learners with no run. */
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

  /** Logically reclaimed: a claim past its run's write deadline reads as absent, TTL or not. */
  async getActiveMock(learnerId) {
    const res = await this.client.get({
      TableName: this.tableName,
      Key: { pk: `LEARNER#${learnerId}`, sk: 'ACTIVE_MOCK' },
    });
    const item = res.Item;
    if (!item) return null;
    if (!item.runId) return item.mockExamId ?? null;
    const deadline = parseInstant(item.writeDeadlineAt);
    if (deadline === null || this.now() >= deadline) return null;
    return item.mockExamId ?? null;
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
    // RAW, therefore strong: this read AUTHORIZES — mint binding, ownership checks, claim deadline
    // pinning all hang off it, and an eventually consistent read let a just-written run appear
    // absent to the very mint that had just written it.
    return this.#getRecordRaw('SMOKERUN', runId);
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
    // The deadline comes from the STORED run — never the caller — and the condition below PINS it:
    // the claim can only be written while the run still holds exactly that horizon, and only while
    // the horizon is in the future.
    const run = await this.getSmokeRun(runId);
    // VALIDATED with the strict parser against ONE clock snapshot, before the transaction. Comparing
    // strings alone let `writeDeadlineAt: "tomorrow"` satisfy the condition and write a claim the
    // read path then had to hide — an unreadable bound must be refused, not written and papered over.
    const nowMs = this.now();
    const deadline = run?.writeDeadlineAt ?? null;
    const parsed = parseInstant(deadline);
    if (parsed === null || nowMs >= parsed) {
      const err = new RepositoryConflictError('This smoke run stopped accepting records.');
      err.reason = 'RUN_WINDOW_CLOSED';
      throw err;
    }
    const nowIso = new Date(nowMs).toISOString();
    // The deadline PERSISTED IN THE CLAIM is re-rendered canonically. The parser accepts
    // milliseconds as optional, but the replacement condition compares lexically against a
    // full-millisecond `:now` — and at the same instant `...56Z <= ...56.000Z` is FALSE as a
    // string. A seconds-only run deadline therefore recreated the null-winner state at the exact
    // boundary. Rendering through toInstant pins one format, so lexical and temporal order agree.
    // `:deadline` in the run pin stays the RAW stored string: it must equal what the run holds.
    const canonicalDeadline = toInstant(parsed);
    try {
      await this.client.transactWrite({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: this.tableName,
              Key: recordKey('SMOKERUN', runId),
              ConditionExpression: 'record.#s = :active AND record.#d = :deadline AND record.#d > :now',
              ExpressionAttributeNames: { '#s': 'status', '#d': 'writeDeadlineAt' },
              ExpressionAttributeValues: { ':active': 'active', ':deadline': deadline, ':now': nowIso },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              // The claim carries the run and its deadline, so `getActiveMock` can reclaim it
              // logically instead of waiting for TTL.
              Item: {
                pk: `LEARNER#${learnerId}`,
                sk: 'ACTIVE_MOCK',
                mockExamId,
                runId,
                writeDeadlineAt: canonicalDeadline,
              },
              // An EXPIRED physical claim may be replaced — atomically, and only when provably
              // expired. Requiring absence alone left a dead row blocking every future mock for
              // that learner, which is the failure this whole parcel exists to prevent. Mutual
              // exclusion between LIVE claims is untouched: a claim still inside its window fails
              // both branches.
              // `<=`, matching `getActiveMock`'s `now >= deadline`. At exact equality the read
              // said absent while the write said occupied, so the use case reported
              // MOCK_EXAM_IN_PROGRESS with a null winner — a state the caller cannot act on.
              ConditionExpression:
                'attribute_not_exists(pk) OR (attribute_exists(#wd) AND #wd <= :now)',
              ExpressionAttributeNames: { '#wd': 'writeDeadlineAt' },
              ExpressionAttributeValues: { ':now': nowIso },
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
  /** RAW children matching learner + run — expired included, by design. Cleanup only. */
  async rawSmokeChildren({ learnerId, runId }) {
    const owns = (r) => r?.learnerId === learnerId && r?.runId === runId;
    const of = async (type) => (await this.#listItems(learnerId, type)).map((i) => i.record).filter(owns);
    return { sessions: await of('SESSION'), mocks: await of('MOCK'), attempts: await of('ATTEMPT') };
  }

  async countSmokeRunRecords({ learnerId, runId }) {
    const raw = await this.rawSmokeChildren({ learnerId, runId });
    return {
      practiceSessions: raw.sessions.length,
      mockExams: raw.mocks.length,
      attempts: raw.attempts.length,
    };
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
      // RAW, like every other cleanup read: the filtered getProfile hides an expired profile, and
      // cleanup exists precisely to delete rows the ordinary paths no longer show.
      const profile = await this.#getRecordRaw('PROFILE', learnerId);
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
      for (const item of res.Items ?? []) {
        // Track the revision like the filtered list does: a record read RAW and then written back
        // must carry its rev, or the write looks like a create and fails attribute_not_exists.
        this.revs.set(item.record, item.rev);
        out.push({ record: item.record, item });
      }
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
