# Generalization evaluation framework

This framework measures a frozen candidate against a frozen baseline with no task support and with a fixed support set. It keeps results for declared new families separate from retention results. It does not supply general intelligence or train a foundation model.

## Run the public acceptance fixture

```bash
node scripts/benchmark-generalization.ts
npm run harness
```

The fixture uses three program families and a fourth retention family. Both agents already contain all four program priors. The candidate conditions its hypotheses on identifying examples; the baseline ignores those examples. Both use the same initial decision rule. These public development fixtures test evaluation mechanics, not unfamiliar domain discovery. Their operation counters are synthetic units, not dollars, GPU compute or provider calls.

The first diagnostic used different initial decision rules and exposed a regression without support. That result is preserved in `evidence/generalization/diagnostic-v1.json`. The revised comparator removes this confound. Reusing these public fixtures during development is explicitly not sealed audit evaluation.

## Integrate a real agent

Implement `AgentFactory` from `src/generalization-contracts.ts`. Its `create` method returns a fresh agent with `predict`, optional support `learn`, and optional `close`. A Ruflo host adapter can implement this boundary; this release does not modify the upstream Ruflo repository. The host must reset conversation state, exclude audit answers and enforce its existing execution permissions.

```typescript
import { DatabaseSync } from 'node:sqlite';
import { GeneralizationHarness } from '../src/generalization.ts';

// protocol supplies independently reserved tasks and two host-owned factories.
const database = new DatabaseSync('generalization-audit.sqlite');
try {
  const report = await new GeneralizationHarness(database).run(protocol);
  console.log(report.summary);
} finally {
  database.close();
}
```

Use an actual frozen artifact hash and trusted counters. Charge support learning and inference to the same episode budget. Provider adapters must enforce request ceilings before dispatch and reconcile actual usage; this runner stops subsequent calls after reported limits are reached but cannot preauthorize an unknown provider charge.

Declare all development and selection families. Transfer families cannot overlap them; retention families must belong to development. Declare at least one task in each split. Inputs cannot repeat between support and queries within a task. Protocols are limited to 1,000 tasks, 256 queries per task and 16 MiB of example data.

Every task and mode gets fresh baseline and candidate instances. Predictors receive query inputs only; support learners receive only the fixed support examples. Query outcomes never update the agent. Results include accuracy, elapsed time, reported cost, calls, interventions and failure status for every episode. Retention here checks earlier families with the frozen artifact, not forgetting after audit training.

## Audit and trust boundaries

The SQLite journal consumes task IDs, task content fingerprints and individual scored example fingerprints before any agent runs. Task fingerprints ignore names and example ordering. Previously scored examples cannot return as queries or support in another run, even when support or task grouping changes. Repeated examples within one declared run are permitted, so the report does not claim sample independence. Failures still consume audits. Preserve this database across attempts. A new database is appropriate only for explicitly public mechanics fixtures, never to regain a sealed holdout.

Exact hashes do not detect near duplicates, alternative encodings, related tasks or pretraining exposure. The independent evaluation owner must reserve novel tasks and control data access. Artifact IDs do not attest model weights or hidden global state.

Factories run as trusted callbacks in the same process. Timeouts interrupt asynchronous waiting but cannot stop synchronous CPU loops or external effects. Untrusted agents require killable worker processes, an external scorer and provider receipts. No output from this framework expands tool authority or automatically promotes a model.

## Acceptance

The framework passes when contaminated or reused audits fail before execution, query answers stay outside predictor arguments, learning consumes budget, failed episodes cannot produce a positive verdict, and every family remains visible in the report. A real capability claim requires frozen artifacts tested on independently reserved unfamiliar tasks at equal verified cost and zero additional human intervention.
