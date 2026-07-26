import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// EXPLICIT build target (#67). `cf:build` sets CBA_BUILD_TARGET=cloudflare; nothing infers it.
//
// Local (default): the in-app `/api/**` route handlers run the REAL in-process BFF
// (`backstage-cba-prep-bff` -> ../services/bff), which lives outside web/, so tracing has to be
// anchored at the repo root for that import to resolve. `next dev`, `npm run build` and the four
// smokes all use this path and are unaffected by anything below.
//
// Cloudflare: the learner API belongs to AWS (ADR-0002) and the browser calls it directly using
// the runtime `CBA_BFF_BASE_URL`, so the in-process BFF is aliased to a fail-closed stub. That
// removes the only cross-root import, which lets tracing stay inside web/ — exactly what the
// OpenNext adapter requires: it anchors on web/ (its own lockfile), so a repo-root tracing root
// would emit `.next/standalone/web/…` where the adapter looks for `.next/standalone/…`.
const cloudflareBuild = process.env.CBA_BUILD_TARGET === 'cloudflare';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  ...(cloudflareBuild
    ? {
        turbopack: {
          resolveAlias: {
            'backstage-cba-prep-bff': './lib/bff-unavailable.js',
          },
        },
      }
    : {
        // web/ is intentionally not a root npm workspace, but it reads repo data (questions/,
        // spec/) through the linked BFF: anchor tracing/turbopack at the repo root.
        outputFileTracingRoot: repoRoot,
        turbopack: { root: repoRoot },
      }),
};

// Cloudflare bindings inside `next dev` (#67): the adapter guards this so it runs ONLY in the
// dev server, once — `next build` and production are unaffected. It uses wrangler's LOCAL
// platform proxy (miniflare); it never authenticates against or mutates a Cloudflare account.
initOpenNextCloudflareForDev();

export default nextConfig;
