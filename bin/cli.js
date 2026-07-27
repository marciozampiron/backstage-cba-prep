#!/usr/bin/env node
import { runExam } from '../src/commands/exam.js';
import { runValidate } from '../src/commands/validate.js';
import { runStats } from '../src/commands/stats.js';
import { runGenerate } from '../src/commands/generate.js';
import { runSync } from '../src/commands/sync.js';
import { runHistory } from '../src/commands/history.js';
import { runAuditSources } from '../src/commands/audit-sources.js';
import { runBlueprint } from '../src/commands/blueprint.js';
import { runReviewBank } from '../src/commands/review-bank.js';
import { runBedrockCheck } from '../src/commands/bedrock-check.js';
import { runAgentCheck } from '../src/commands/agent-check.js';
import { runAgentRefresh } from '../src/commands/agent-refresh.js';
import { runAgentPublish } from '../src/commands/agent-publish.js';
import { runAgentHumanPublishScript } from '../src/commands/agent-human-publish-script.js';
import { assertPublishingRole } from '../src/lib/publish-gate.js';
import { resolveDomain } from '../src/lib/blueprint.js';
import { loadEnv } from '../src/lib/env.js';
import { c } from '../src/lib/ui.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        args[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) args[key] = true;
        else {
          args[key] = next;
          i++;
        }
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

const HELP = `
  ${c.bold('backstage-cba-prep')} — Certified Backstage Associate (CBA) study kit

  ${c.bold('Usage:')} backstage-cba-prep <command> [options]
         (aliases: cba-prep · node bin/cli.js)

  ${c.bold('Commands:')}
    exam        Run a timed mock exam with per-domain scoring
    generate    Author new questions with an LLM (multi-provider)
    validate    Check the question bank against the schema
    stats       Show bank coverage per domain and competency
    sync        Compare local blueprint weights with the live LF page
    blueprint   Regenerate the domain (spec/blueprint.json) from a source URL via AI
    audit-sources  Check that every question's source URL is reachable
    review-bank    Review semantic answer correctness against cited sources
    bedrock-check  Validate model-tier config (dry-run); --smoke for a paid live test
    agent-check    Check AI orchestration readiness (dry-run); --smoke for a paid live run
    agent-refresh  Check agent handoff state before edit/commit/push (no network)
    agent-publish  Validate a publish gate locally (Stage A: no push, no PR, no merge)
    agent-human-publish-script  Prepare the reviewed publication artifact (prepares only; never runs it)
    history     Show your past exam attempts and progress
    help        Show this help

  ${c.bold('general options:')}
    --json        emit machine-readable JSON where supported

  ${c.bold('review-bank options:')}
    next           show the next review item and record a human decision
    --domain KEY   limit report/next to one domain

  ${c.bold('exam options:')}
    --count N       number of questions (default 60)
    --minutes N     time limit (default 90; --no-timer to disable)
    --domain KEY    one domain: development-workflow|infrastructure|catalog|customizing
    --pass N        target score % (default 75; not an official passing score)
    --no-shuffle    keep original option order
    --no-save       don't record this attempt in local history

  ${c.bold('generate options:')}
    --provider NAME anthropic | openai | google  (default anthropic)
    --domain KEY    which domain to write for (required)
    --count N       how many questions (default 5)
    --model NAME    override the model id
    --dry-run       print the prompt and exit (no API key needed)
    ${c.gray('needs a key: ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY')}

  ${c.bold('blueprint options:')}
    --from URL      source page to extract the domain from (default: the exam URL)
    --provider NAME anthropic | openai | google  (default anthropic)
    --write         apply the regenerated domain to spec/blueprint.json
    ${c.gray('needs an API key, same as generate; or LLM_BACKEND=bedrock with AWS credentials')}

  ${c.bold('bedrock-check options:')}
    ${c.gray('(dry-run by default: validates config shape offline, no tokens spent)')}
    --smoke         do a LIVE bedrock-runtime call (COSTS TOKENS; bedrock backend)
    --tier NAME     fast | standard | critical  (smoke target; default fast)
    --yes           skip the smoke confirmation prompt

  ${c.bold('agent-publish options:')}
    ${c.gray('(validation only: no push, no PR, no merge, no credential)')}
    ${c.gray('(only a DECLARED role=executor proceeds; declaration is not authentication — Stage B)')}
    --role <role>   invoking role (or CBA_AGENT_ROLE); architect/reviewer refuse before network
    --executor <id> invoking agent identity (or CBA_AGENT_ID); must match the gate
    --gate <path>   publish-gate manifest naming the human approver and exact commits
    ${c.gray('Stage A validates only: it never pushes, opens a PR, merges or uses a credential.')}

  ${c.bold('agent-human-publish-script options:')}
    ${c.gray('(prepares only; it never runs the artifact. Opus prepares -> Codex reviews ->')}
    ${c.gray(' Zamp approves -> Opus executes -> Zamp decides/performs merge.')}
    ${c.gray(' Canonical contract: .agent-handoff/MESSAGE-PROTOCOL.md)')}
    --role <role>   invoking role (or CBA_AGENT_ROLE); only a declared executor may prepare
    --executor <id> invoking agent identity (or CBA_AGENT_ID); must match the gate
    --gate <path>   publish-gate manifest, authored by Zamp OUTSIDE the worktree, naming the
                    approving human and the exact ordered commits
    --repo <o/r>    owner/repo (must match the origin remote; derived from it by default)
    --out <path>    output path under /tmp (default: /tmp/cba-publish-<issue>-<head>.sh)
    ${c.gray('written 0600 and non-executable; no network call. Operate it only after an')}
    ${c.gray('explicit HUMAN_GATE_GRANTED, using the printed verify-and-run command.')}

  ${c.bold('agent-refresh options:')}
    ${c.gray('(no network: reads .agent-handoff and local git state)')}
    --json          emit machine-readable coordination state
    --record        append an explicit audit event to .agent-handoff/EVENTS.md

  ${c.bold('agent-check options:')}
    ${c.gray('(dry-run by default: constructs provider + orchestrator from env, no spend)')}
    --smoke         do a LIVE orchestrator run (COSTS TOKENS)
    --yes           skip the smoke confirmation prompt

  ${c.bold('Examples:')}
    npx backstage-cba-prep exam
    npx backstage-cba-prep exam --domain catalog --count 13
    npx backstage-cba-prep generate --provider openai --domain customizing --count 5
    npx backstage-cba-prep validate
`;

async function main() {
  // #91: parse ONCE, with the real parser, before anything else. A second partial parser here was
  // the bug: it only understood `--role x`, so `--role=architect` slipped past the pre-loadEnv
  // refusal and was caught later — after .env had already loaded. Both syntaxes now behave
  // identically because they go through the same code path.
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  // The declared-role refusal must happen before .env loads, before git runs and before any
  // network dependency could exist. An explicit --role always wins over CBA_AGENT_ROLE, so an
  // environment variable cannot smuggle a forbidden role past this check.
  if (cmd === 'agent-publish' || cmd === 'agent-human-publish-script') {
    // Presence, not type: `--role` with no value parses to `true`, and treating that as "absent"
    // silently fell back to CBA_AGENT_ROLE, letting an environment value decide after an explicit
    // argument was given. An explicit argument ALWAYS wins, malformed or not, and the malformed
    // value is handed to assertPublishingRole so it is refused here rather than after loadEnv().
    const declaredRole = Object.hasOwn(args, 'role') ? args.role : process.env.CBA_AGENT_ROLE;
    try {
      assertPublishingRole(declaredRole);
    } catch (err) {
      console.error(`${cmd} refused [${err.code ?? 'ROLE_REFUSED'}]`);
      console.error(err.message);
      // agent-publish keeps its #91 wording verbatim — a reviewed test pins it. The generator adds
      // the one fact that is only true of it: nothing was written to disk either.
      console.error(
        cmd === 'agent-publish'
          ? 'No .env was loaded, no gate was read and no git command ran.'
          : 'No .env was loaded, no gate was read, no git command ran and no file was written.',
      );
      process.exit(2);
    }
  }

  loadEnv(); // load .env (if present) before dispatch; real env vars always win

  switch (cmd) {
    case 'exam': {
      let domainKey = null;
      if (typeof args.domain === 'string') {
        const d = resolveDomain(args.domain);
        if (!d) {
          console.log(c.red(`  Unknown domain "${args.domain}". Use development-workflow|infrastructure|catalog|customizing.`));
          process.exit(1);
        }
        domainKey = d.key;
      }
      await runExam({
        count: args.count != null ? num(args.count) : undefined,
        minutes: args.minutes != null ? num(args.minutes) : undefined,
        pass: args.pass != null ? num(args.pass) : undefined,
        domain: domainKey,
        timer: !(args['no-timer'] || args.untimed),
        shuffleOptions: !args['no-shuffle'],
        save: !args['no-save'],
      });
      break;
    }
    case 'generate': {
      const code = await runGenerate({
        provider: args.provider,
        domain: args.domain,
        count: args.count != null ? num(args.count) : undefined,
        model: args.model,
        dryRun: !!args['dry-run'],
      });
      process.exit(code || 0);
      break;
    }
    case 'validate':
      process.exit(runValidate({ json: !!args.json }));
      break;
    case 'stats':
      runStats({ json: !!args.json });
      break;
    case 'sync':
      process.exit(await runSync({ write: !!args.write }));
      break;
    case 'blueprint':
      process.exit(
        await runBlueprint({
          from: typeof args.from === 'string' ? args.from : undefined,
          provider: args.provider,
          model: args.model,
          write: !!args.write,
          json: !!args.json,
        })
      );
      break;
    case 'review-bank':
      process.exit(await runReviewBank({ subcommand: args._[0], domain: args.domain, json: !!args.json }));
      break;
    case 'bedrock-check':
      process.exit(
        await runBedrockCheck({
          smoke: !!args.smoke,
          tier: typeof args.tier === 'string' ? args.tier : undefined,
          yes: !!args.yes,
          json: !!args.json,
        })
      );
      break;
    case 'agent-check':
      process.exit(await runAgentCheck({ smoke: !!args.smoke, yes: !!args.yes, json: !!args.json }));
      break;
    case 'agent-refresh':
      process.exit(await runAgentRefresh({ json: !!args.json, record: !!args.record }));
      break;
    case 'agent-publish':
      process.exit(
        await runAgentPublish({
          role: args.role,
          executor: args.executor,
          gate: args.gate,
        }),
      );
      break;
    case 'agent-human-publish-script':
      process.exit(
        await runAgentHumanPublishScript({
          role: args.role,
          executor: args.executor,
          gate: args.gate,
          repo: args.repo,
          out: args.out,
        }),
      );
      break;
    case 'history':
      runHistory({ json: !!args.json });
      break;
    case 'audit-sources':
      process.exit(await runAuditSources({ json: !!args.json }));
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    default:
      console.log(c.red(`  Unknown command: ${cmd}`));
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
