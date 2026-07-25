#!/usr/bin/env node
// CDK app entry for the CBA Study Coach AWS pilot (#53/#49).
// Env-agnostic on purpose: no `env` is set, so `cdk synth` needs no AWS credentials or account
// lookups; account/region stay as CloudFormation pseudo parameters until a human-gated deploy
// targets a real environment. Stack names derive from the `environment` context (#77) — see
// lib/app.js, which tests exercise directly.
const cdk = require('aws-cdk-lib');
const { buildStacks } = require('../lib/app');

const app = new cdk.App();
buildStacks(app);
app.synth();
