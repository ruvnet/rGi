# Architecture decisions

## ADR 001: Persistent TypeScript supervisor with portable Rust policy

Status: implemented for v0.1.

Use a pure Rust guard behind napi-rs and wasm-bindgen, with a matching TypeScript admission guard. The host guard always applies even when a plugin policy is supplied. SQLite persistence and timers stay in Node 24. This permits a working durable runtime without requiring an LLM vendor or an installed native dependency. Native and WASM artifacts share the exact Rust logic.

Rejected: duplicate full schedulers in three languages would increase correctness drift. A Rust-only daemon would make initial integration with the existing TypeScript SDKs more costly. Entirely JS authority would omit a reusable portable kernel. Later migration of the supervisor to Rust requires preserving replay and parity tests.

## ADR 002: Reserve, execute, reconcile

Status: implemented.

Record intent and reserve accounting micros transactionally before execution. Finish with actual cost. Unknown execution results preserve reservations, stop the loop and require operator reconciliation. A unique action ID is also the external idempotency key. Exact duplicate JSON is deduplicated; reordered object keys currently count as different content.

Rejected: automatic retry after a timeout can duplicate real effects; claiming exactly-once execution from a local SQLite transaction is false. The latency cost is multiple durable transactions per action, measured separately from policy evaluation.

## ADR 003: Trusted adapter seams, not imaginary integrations

Status: implemented as source-grounded fixture-tested contracts.

AgenticOW is branchable memory, MetaHarness exposes tool definitions, Autogenous/RuField supplies admission-oriented observations, and rvCSI supplies typed sensor events. Inject owned clients, use explicit capabilities and retain source pins. A TS constant-velocity world model is labeled as a baseline derived from inspected upstream arithmetic, not a foundation model or native binding.

Rejected: automatically executing arbitrary package commands or guessing API endpoints creates authority and compatibility failures. Live upstream package installation, authentication, hardware calibration and external outcome reconciliation remain distinct release milestones.

## ADR 004: Bounded plasticity and independent promotion

Status: experimental primitive, not automatic deployment.

Provide a small scalar online dynamics predictor, serializable snapshots and a conservative evidence predicate. Prediction and observation types are distinct. The predicate needs host-owned evaluation evidence; it does not authenticate evidence itself or automatically replace a running model. Learned topology updates, broad continual weight training and latent-agent state fusion remain research work.

Rejected: promoting models using self-reported scores would optimize the evaluator rather than the task. Permission grants never come from learned state.

## ADR 005: Local durability with explicit storage limits

Status: implemented baseline.

Use SQLite WAL with FULL synchronous durability and a single owner lease. Active queues and observation windows are bounded. Configure the main database page cap and stop admission at 80 percent of that cap, leaving outcome headroom. Completed IDs and receipts are retained for deduplication and auditing. WAL files and plugins additionally need filesystem quotas and OS resource controls.

Rejected: silently deleting completed IDs breaks durable deduplication. Automatic archival is deferred until a versioned tombstone strategy and restore tests exist. Perpetual operation requires monitored archival/maintenance, not unbounded disk growth.
