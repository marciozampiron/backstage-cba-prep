// OpenNext Cloudflare adapter config (#67 Stage A).
//
// The file name is the one the `opennextjs-cloudflare` CLI looks for; the contents are plain
// JavaScript (esbuild compiles this file, so the JS-only web project needs no TypeScript
// toolchain and no type annotations are used).
//
// Deliberately EMPTY overrides: every `defineCloudflareConfig` override is optional, and each one
// we could set (R2 incremental cache, KV/D1 tag cache, Durable Object queue, cache purge) would
// require provisioning a Cloudflare resource. #67 Stage A forbids any account mutation, so the
// pilot builds against the adapter defaults. Choosing a cache backend is a #70 decision with its
// own human gate.
import { defineCloudflareConfig } from '@opennextjs/cloudflare';

export default defineCloudflareConfig({});
