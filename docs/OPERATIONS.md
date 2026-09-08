# Operations

## Start and stop

Run `npm start -- --config examples/rgi.json` under a dedicated user or supervisor. No daemon or scheduled job is installed by the implementation process. The CLI sets an owner-only umask and database permissions. Library callers must provide equivalent permissions themselves.

SIGINT/SIGTERM stops the process cooperatively. `node src/cli.ts stop --db .rgi/runtime.db` sets a durable stop flag, checked between cycles and during asynchronous action execution. A blocked in-process extension cannot be forcibly preempted by a JavaScript timer. Isolate such extensions externally.

## Recovery

A crashed owner holds its lease until expiry (60 seconds by default). Do not delete locks or rewrite the database while another process may still be acting. A recovered in-flight job becomes `uncertain`; the runtime retains its estimated cost and durably stops.

Using an authorized host program, open the Runtime after ownership becomes available. Verify the external action with its idempotency key. Call `runtime.reconcile(id, actualCostMicros, verifiedOutcome)` and then `runtime.resume()`. Reconciliation marks a verified completed result. Failed external actions may be recorded with an explicit failure outcome and their actual charge; they are not automatically retried. A new attempt requires a new action ID and a separate operational decision.

If the journal is corrupted, do not infer that an unrecorded external action failed. Restore from a consistent SQLite backup and reconcile external IDs. Regularly test restoration.

## Budgets and quotas

Costs are nonnegative safe integer micros. Reserve an upper bound when possible. Actual cost exceeding the configured budget is recorded and stops further dispatch, but already billed provider spend cannot be undone. Apply provider billing limits independently. `maxQueue` bounds unresolved jobs; `maxObservations` bounds retained observations; `maxRecordBytes` bounds serialized rows.

`maxDatabaseBytes` defaults to 256MiB for the main SQLite file. Admission stops above 80 percent; existing work retains room to finish. SQLite WAL, temporary files and plugins need host filesystem quotas. Monitor disk space and plan a consistent archive preserving completed-ID tombstones. This release deliberately does not delete historical identities automatically. A full disk can interrupt outcome recording and must be reconciled as unknown, never assumed safe to replay.

## Trust and privacy

The config file, plugin module, native addon, SQLite path and dependency installation are operator authority. Observations cannot choose any of them. No public listener is started. Do not put credentials, raw private CSI or unnecessary personal data in observations. RuField expiry/privacy are preserved by the adapter but downstream planners must recheck them before use; generic observation storage is not a policy engine for every upstream schema.

An injected Executor can access the host process because this is not an OS sandbox. Use separate containers/processes with restricted filesystem, networking, CPU and memory. Physical action requires independent hardware interlocks. A confidence value is not source authentication or a guarantee of correctness.

## Verification and release

Run `npm run harness` with Rust, wasm-bindgen and cargo-audit installed as documented. Inspect every failed or blocked result. Any unresolved high/critical reachable finding blocks production use. Review upstream integration provenance and perform real service/hardware tests in the intended environment before enabling those capabilities.

Source publication does not authorize package publication or production actuation. npm is private and Cargo package publication is disabled until licensing and release policy are selected.
