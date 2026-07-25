// HTTP runner for the deployed-contract suite (#78, consumed by #70): runs the SAME suite over
// fetch against a live BFF when BASE_URL is set — the canonical deployed-BFF-origin variable
// from the release runbook (#55) and smoke workflow blueprint (#56). Without it (the CI default)
// it registers one skipped test and NEVER touches the network.
//
// The readiness gate uses the strict DEPLOYED expectations: adapter "dynamodb", runtimeEnv
// dev|pilot and ready:true — an unhealthy or locally-configured target fails.
//
// CBA_BFF_AUTH_MODE=dev opts into the authenticated assertions (x-cba-learner dev identity) —
// deployed runtimes reject dev identity (fail-closed until #69), so the default is the public
// subset; #69/#70 replace this seam with real sessions.
import { test } from 'node:test';
import { runDeployedContractSuite } from './deployed-contract.suite.js';

const baseUrl = process.env.BASE_URL;

if (!baseUrl) {
  test('deployed-http: BASE_URL not set — suite runs in-process only (no network in CI)', (t) =>
    t.skip());
} else {
  async function transport(method, path, { learner, body, query, headers } = {}) {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const res = await fetch(url, {
      method,
      headers: {
        ...(learner ? { 'x-cba-learner': learner } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(headers ?? {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      body: await res.json(),
      headers: Object.fromEntries(res.headers.entries()),
    };
  }

  runDeployedContractSuite(`deployed-http ${baseUrl}`, transport, {
    authenticated: process.env.CBA_BFF_AUTH_MODE === 'dev',
  });
}
