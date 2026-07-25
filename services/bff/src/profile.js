// Learner profile use cases (#69 Slice B) — APPLICATION layer, contract §16 (/api/me).
// Receives only NEUTRAL inputs: a learnerId and an optional opaque `loadProfile()` capability
// supplied by the transport (Cognito in deployed mode; absent locally). No AWS SDK, no Cognito,
// no bearer token here — enrichment details live behind the capability.
//
// Persistence: the profile is a repository record, written on first contact (and on PUT). That
// cache keeps the identity provider's UserInfo endpoint OFF the per-request path: normal later
// requests only read the store. Concurrent FIRST requests may each call UserInfo once, but the
// conditional create guarantees a single canonical profile is persisted (losers re-read the
// winner — see loadOrBootstrap).
import { ApiError } from './store.js';
import { RepositoryConflictError } from './repository.js';
import { activeRepository, nowIso } from './runtime.js';

// Pilot: the single seeded exam (§16 — switcher disabled; generic mode validates against the
// learner's available exams).
const ACTIVE_EXAM = { examId: 'cba', name: 'Certified Backstage Associate' };
const MAX_NAME = 120;

function meView(profile) {
  return {
    displayName: profile.displayName,
    email: profile.email,
    activeExam: ACTIVE_EXAM,
    createdAt: profile.createdAt,
  };
}

async function loadOrBootstrap(learnerId, loadProfile) {
  const repo = activeRepository();
  const existing = await repo.getProfile(learnerId);
  if (existing) return existing;
  // Local/dev fallback is deterministic and provider-free; .invalid can never be a real mailbox.
  const enriched = loadProfile ? await loadProfile() : { email: `${learnerId}@local.invalid`, displayName: learnerId };
  const stamp = nowIso();
  const profile = {
    learnerId,
    email: enriched.email,
    displayName: enriched.displayName,
    activeExamId: ACTIVE_EXAM.examId,
    createdAt: stamp,
    updatedAt: stamp,
  };
  try {
    await repo.saveProfile(profile);
  } catch (err) {
    // First-profile race: two runtime instances can both read "no profile" and bootstrap
    // concurrently; the conditional create makes the loser fail. That is NOT a client error —
    // re-read and return the winner instead of surfacing 409.
    if (err instanceof RepositoryConflictError) {
      const winner = await repo.getProfile(learnerId);
      if (winner) return winner;
    }
    throw err;
  }
  return profile;
}

/** GET /api/me (§16). */
export async function getMe(learnerId, { loadProfile } = {}) {
  return meView(await loadOrBootstrap(learnerId, loadProfile));
}

/** PUT /api/me (§16): partial { displayName?, activeExamId? }; email never changes here. */
export async function updateMe(learnerId, body = {}, { loadProfile } = {}) {
  const profile = await loadOrBootstrap(learnerId, loadProfile);

  if (body.displayName !== undefined) {
    const name = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!name || name.length > MAX_NAME) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Display name must be a non-empty string.');
    }
    profile.displayName = name;
  }
  if (body.activeExamId !== undefined) {
    if (body.activeExamId !== ACTIVE_EXAM.examId) {
      throw new ApiError(400, 'VALIDATION_FAILED', `Unknown exam "${body.activeExamId}".`);
    }
    profile.activeExamId = body.activeExamId;
  }

  profile.updatedAt = nowIso();
  await activeRepository().saveProfile(profile);
  return meView(profile);
}
