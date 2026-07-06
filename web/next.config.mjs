import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Slice 1 keeps the BFF stub in-app (route handlers). The real Web BFF lives on AWS per ADR-0002;
  // swapping later is a base-URL change, not a frontend rewrite.
  reactStrictMode: true,
  devIndicators: false,
  // web/ is intentionally not a root npm workspace, but it reads repo data (questions/, spec/):
  // anchor tracing/turbopack at the repo root to silence the multi-lockfile root inference warning.
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
};

export default nextConfig;
