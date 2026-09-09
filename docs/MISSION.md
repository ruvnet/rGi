# Replayable sequential learning mission

rGi can now compare three agent conditions across a real process restart and export the resulting evidence in RVF. Ruflo coordinates the engineering mission; rGi owns execution and scoring. No provider model or hardware experiment is implied by the bundled demonstration.

## Run and replay

Requires Node 24 or newer. The full harness also needs the Rust toolchain and targets documented in the main README.

```bash
npm ci
node scripts/benchmark-mission.ts
node scripts/replay-mission.ts artifacts/mission.rvf artifacts/mission.public.pem
node scripts/replay-mission.ts artifacts/mission.rvm.rvf artifacts/mission.public.pem --rvm
npm run harness
```

The benchmark writes an RVF container, an RVF segment stream for the pinned RVM inspector, a public verification key and a JSON measurement report. The private demonstration signing key is generated in memory and never saved. The `.rvm.rvf` suffix identifies the RVM inspection profile; it is still RVF, not a new binary format.

The replay command verifies a signature using the public key supplied separately, verifies the event chain and recomputes all scores. It does not execute the embedded code. The benchmark additionally extracts the embedded bundle, runs it again in fresh child processes and requires an identical deterministic receipt root. That execution replay is suitable for the reviewed public fixture. Do not execute arbitrary evidence bundles based only on a self supplied key.

## What runs

All three conditions use the exact same source digest, training examples, query inputs and request ceilings. The host passes only training examples or a query input to the agent. Query answers stay in the parent scorer.

1. Baseline mode receives the training data but the reviewed fixture disables learning.
2. Reset mode learns, saves a snapshot, then starts a fresh process without restoring it.
3. Retained mode learns, saves a snapshot in SQLite, starts a fresh process and restores the state read from SQLite.

Each condition then attempts transfer queries and prior skill retention queries. Each has its own processes and temporary directory. A session remains alive for consecutive requests, avoiding a process launch for every tool call. Explicit restart boundaries always create a new process.

The fixture learns an affine numeric mapping and preserves a separate square operation. These are known program rules and fresh instances, not unknown domains or neural training. The comparison establishes whether state is used after a process restart. It does not establish how much a foundation model generalizes, or a statistical retention bound.

## Evidence and trust

The signed specification binds the bundle SHA256, exact training and audit examples, request budget and message/deadline limits. Every receipt binds its sequence, condition, operation, payload and preceding hash. Replay requires the exact declared control flow and matching restore state, counts requests and scores every declared query. Partial, reordered or altered evidence fails verification.

SQLite commits audit fingerprints before starting an agent. Failed attempts remain consumed. Every completed call adds a durable receipt. A supervisor crash may leave a mission marked running with an incomplete trace; its audit remains unavailable for automatic retry. Preserve the database and inspect the partial trace. There is no implicit retry of a potentially unresolved effect.

The process transport copies only the worker and a single standalone plugin into a disposable directory. It strips inherited environment values, restricts filesystem reads and denies subprocesses, addons and filesystem writes through Node permissions. Parent deadlines kill synchronous hangs; message and output limits bound communication.

This is isolation for reviewed plugins, not an operating system security boundary. Node permissions do not block networking or attest an honest plugin. Total native memory, network egress, actual provider costs and physical effects require external enforcement. The next production adapter should use a hardened RVM guest or an independently managed worker service, a separate scorer and host recorded provider receipts.

A signature authenticates bytes relative to the verifier's chosen key. It does not prove honest execution, an independent evaluator, or AGI. Publication of the artifact digest and verification key in a reviewed commit supplies a reproducible public reference, not independent experimental oversight.

## Integration contract

Bundle the reviewed agent and its dependencies into one ESM file exporting `createAgent(mode)`. Return methods `learn(examples)`, `predict(input)`, `snapshot()` and `restore(state)`, each producing strict JSON. The caller supplies its exact SHA256 in `MissionSpec`. `runMission(spec, database)` performs the sequential protocol. Models requiring network inference need a separate, metered host integration; do not put credentials inside the evidence bundle.

Ruflo can provide that agent implementation while retaining its tool policy. RuVector can back its memory only when each condition has separate storage and restoration captures the exact memory version. Those production integrations are extension boundaries here, not falsely labeled active services.

## Performance acceptance

The benchmark compares twelve fresh sessions against one reused session while performing the same twenty four restore and predict requests. It verifies identical outputs and reports elapsed times and speedup. This measures local process overhead only. It neither discounts model inference nor assumes a speedup transfers to remote LLM calls.

Acceptance requires successful hard timeout and tamper tests, no scorer file access, no host environment inheritance, exact replay scoring, identical deterministic execution replay and a complete strict harness. Generalization acceptance additionally requires independently reserved unfamiliar tasks, verified external cost and a separate retention analysis.
