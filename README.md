# rGi

A perpetual agentic runtime for Artificial General Intelligence research built on the RuV Stack in Rust, WebAssembly, TypeScript and napi-rs.

rGi keeps an agent's work alive across individual prompts and clean restarts. It records observations, asks a planner for actions, checks authority and budgets, executes approved work and retains outcomes. Ambiguous outcomes stop execution for reconciliation instead of risking duplicated effects.

**Status: experimental runtime foundation, not demonstrated AGI.** The native and WASM policy kernel is functional. The persistent supervisor runs in Node 24. Upstream adapters are source grounded and fixture tested; live services, native upstream packages and physical sensors are not certified by these tests.

## Run in one minute

Requires Node 24 or newer, npm and a local writable disk.

```sh
git clone https://github.com/ruvnet/rGi.git
cd rGi
npm ci --ignore-scripts
npm run demo -- --cycles 5
node src/cli.ts status --db .rgi/runtime.db
```

The demo runs five simulated actions, persists five receipts of success and charges five accounting micros. These micros are a configured accounting unit, not a claim of provider billing. Run the demo again to continue from the stored sequence without replaying completed action IDs.

```sh
npm start -- --config examples/rgi.json
# In another terminal:
node src/cli.ts stop --db .rgi/runtime.db
```

The second command durably stops the loop. SIGINT and SIGTERM shut down the current process; an interrupted execution becomes uncertain. Nothing is installed as a background service automatically. The example plugin is a simulation, not an LLM or a robot controller.

## Architecture

| Layer | Implementation | Responsibility |
| --- | --- | --- |
| Policy kernel | `crates/rgi-core` | Exact capability matching, stop checks, confidence threshold and checked integer budgets |
| Native boundary | `crates/rgi-napi` | `evaluateJson` using the shared Rust kernel |
| WebAssembly boundary | `crates/rgi-wasm` | `evaluate_json` using the same kernel |
| Supervisor | `src/runtime.ts` | Persistent observe, plan, admit, execute and record loop |
| Journal | `src/store.ts` | SQLite WAL, single writer lease, reservations, checkpoints and recovery |
| Integrations | `src/adapters` | AgenticOW, MetaHarness, Autogenous/RuField, rvCSI and world model baseline |
| Learning experiment | `src/learning.ts` | Bounded scalar dynamics adaptation and evidence gate; not a foundation model |
| Verification | `scripts/harness.ts` | Build, test, binding execution, benchmark and advisory evidence |

The TypeScript policy is the portable host guard. An optional native evaluator can further restrict it, never widen it. This initial release does not move the entire daemon into Rust or run persistent SQLite in a browser. WASM is a portable policy kernel, not a browser background service.

## Connect a trusted plugin

`examples/local-plugin.ts` exports a `Planner` and `Executor`. Replace them with reviewed implementations and explicitly allow each required capability in the configuration. Plugins are trusted executable code, not sandboxed model output.

```ts
import { Runtime } from './src/runtime.ts';
import { MetaHarnessExecutor } from './src/adapters/metaharness.ts';

const executor = new MetaHarnessExecutor([{
  capability: 'inventory.read',
  tool: {
    name: 'inventory', server: 'local', description: 'Read inventory',
    inputSchema: { type: 'object' },
    handler: async () => ({ available: 3 }),
  },
  validate: payload => Object.keys(payload).length === 0,
  costMicros: 1,
}]);
const runtime = new Runtime({
  dbPath: './inventory.db', executor,
  config: { allowedCapabilities: ['inventory.read'], budgetMicros: 100 },
});
runtime.enqueue({ id: 'inventory:001', capability: 'inventory.read',
  payload: {}, estimatedCostMicros: 1, confidence: 1 });
await runtime.step();
runtime.close();
```

Default authority is empty and default budget is zero. No generic shell executor, arbitrary URL executor or public HTTP API is provided. Do not register side-effecting handlers unless their service implements independent idempotency and outcome reconciliation.

See [integration provenance](docs/INTEGRATIONS.md) for exact upstream commit pins, method signatures and remaining live validation.

## Build Rust, native and WASM

Rust is pinned in `rust-toolchain.toml`. On a host with rustup:

```sh
rustup toolchain install 1.90.0 --profile minimal --target wasm32-unknown-unknown
cargo test --workspace --locked
cargo build -p rgi-napi --release --locked
cargo build -p rgi-wasm --release --target wasm32-unknown-unknown --locked
cargo install wasm-bindgen-cli --version 0.2.104 --locked
node scripts/check-bindings.ts
```

The last command creates `artifacts/rgi.node` and WASM JS glue, loads both and compares actual results with the host guard. Set `nativeBinding` to `../artifacts/rgi.node` in `examples/rgi.json` to use the native kernel in the daemon. See [Rust boundary notes](docs/RUST.md).

## Custom implementation and verification harness

```sh
npm run typecheck
npm test
cargo install cargo-audit --version 0.22.2 --locked
npm run harness
```

The strict harness fails if a mandatory test, build, binding execution or advisory check fails or is unavailable. `npm run harness -- --local` permits unavailable tools for development but still reports an incomplete release gate. Reports include source hashes, tool versions, commands, statuses and timings in `artifacts/`. CI runs the same gate with read-only repository permissions and no package publication.

`npm run benchmark` measures portable policy checks. `node scripts/benchmark-runtime.ts` measures full durable no-op dispatch. Neither measures agent intelligence, useful human work equivalence or production model throughput.

## Safety and operational boundaries

1. Actions are journaled and budget is reserved before dispatch.
2. Completed IDs deduplicate; reused IDs with different content fail.
3. Unknown outcomes keep reservations and stop execution. No automatic retry.
4. Confidence is input metadata, not independently calibrated truth.
5. Observations remain distinct from prediction envelopes and model snapshots.
6. Online adaptation is a bounded scalar experiment; unrestricted weight or permission mutation is not enabled.
7. Policy checks do not sandbox trusted native or JS code. Use OS isolation for untrusted executors.
8. Budget estimates are not an external billing firewall. Provider-side limits are still required.

Read [operations](docs/OPERATIONS.md), [threat model](docs/THREAT-MODEL.md), [architecture decisions](docs/ADRs.md) and [scope and acceptance](docs/SPECIFICATION.md) before continuous deployment.

## Publication

Source publication is separate from npm/crates.io release. Package publication remains disabled. A project license has not yet been selected; dependency licenses remain their respective authors' licenses.
# Grounded adaptation update

The [replayable mission](docs/MISSION.md) compares learning disabled, learned state reset and learned state restored across actual child process restarts. It exports signed RVF evidence, recomputes scores on replay and benchmarks session reuse. Run `node scripts/benchmark-mission.ts`. These are reviewed synthetic fixtures, not a claim of AGI or independent domain generalization.

The [generalization framework](docs/GENERALIZATION.md) adds separate evaluations with no examples and fixed support examples, declared family exclusion, retention checks, per episode budgets and durable audit consumption before execution. Run `node scripts/benchmark-generalization.ts` to validate the public fixtures. The [research review](docs/GENERALIZATION-RESEARCH.md) explains the design and limits.

The [September research review](docs/RESEARCH-2026-09.md) maps eight primary sources to implemented mechanisms and explicit limits. The runtime now supplies durable execution feedback, filters expired observations at planning time, checkpoints learned planner state with queued actions, and requires a new runtime instance after a planning failure.

`src/planning.ts` provides bounded predictive beam search through an injected dynamics model. `src/adaptive.ts` connects outcomes to a scalar online learner for simulation. `src/evaluation.ts` checks paired audit results, retention, cost and permissions; `src/promotion-ledger.ts` persists audit consumption and statistical budgets across evaluations. None automatically installs a candidate or expands execution authority.

Run `node scripts/benchmark-adaptation.ts` for the fixed synthetic comparison. With 128 equal calibration interactions per model and parameters frozen during audit, adaptation completed 120/120 cases versus 80/120 for the frozen baseline. All gains came from the negative dynamics regime; the other two regimes retained 40/40. This tests instances of one scalar family, not general intelligence or transfer to unseen domains. See [ADR 006](docs/ADR-006-grounded-adaptation.md).
