# rGi threat model

Scope: the local experimental runtime, SQLite persistence, policy kernel, native and WASM bindings, injected planning and execution interfaces, and verification harness. This is not an assertion that rGi is AGI or an independently certified security product.

## Assets and boundaries

Assets include job integrity, budget reservations, capability permissions, experience provenance, persisted runtime state and host credentials. Input observations, planner proposals, executor receipts, integration metadata and stored rows are potentially hostile. A planner's proposal is not authority to act. Model predictions are not observations. A native extension shares the host process and is not a sandbox. SQLite supplies local durability, not tenant isolation.

## Abuse cases and controls

| Threat | Required control | Residual exposure |
| --- | --- | --- |
| Planner invents a capability | Exact allowlist check immediately before dispatch | Executor implementation must enforce its own downstream authority |
| Repeated jobs overspend | Reserve before execution; validate nonnegative bounded integer costs | External billing may exceed declared cost; hard provider limits remain necessary |
| Prompt injection requests arbitrary commands | No generic shell executor; treat observations as data | An installed custom executor can still misuse its authority |
| Infinite planning or retry loop | Finite per-tick work, queue limit, cancellation and explicit stop | An uncooperative in-process extension can block the event loop |
| Crash between external action and receipt | Durable transitions and explicit recovery policy | Exactly-once external effects require executor idempotency, not SQLite alone |
| Counterfeit observation or imagined outcome | Source, timestamp and observation type preserved | Signature validation and source authentication depend on integrations |
| Poisoned online adaptation | Versioned candidates, independent evaluation, rollback | No claim of safe unrestricted online weight mutation |
| Corrupt database values bypass policy | Revalidate persisted values at policy boundary | Local filesystem owner can alter the program and database |
| Native/WASM policy disagreement | Shared Rust policy and parity tests | Build success alone does not validate binding execution |
| Dependency compromise | Lockfiles, npm audit, cargo audit, restricted CI permissions | Advisory databases cannot detect unknown malicious packages |

## Deployment rules

Run under a dedicated low privilege account. Keep the SQLite database in an owner-only directory; do not place credentials in observations or receipts. Use isolated processes or containers for untrusted executors with network and resource restrictions. A JavaScript capability string is not an operating system security boundary. Keep physical actuation disabled until independent interlocks and operator authorization are implemented. Do not enable public remote APIs without separate authentication, authorization, quotas and tenant isolation.

## Evidence and release gate

`node scripts/harness.ts` records command names, exit statuses, durations, runtime versions, source and lockfile hashes in `artifacts/harness.json`. Any unavailable mandatory check blocks a release. `--local` permits an incomplete local run only; the report continues to mark the release unapproved. Advisory-feed freshness is explicitly unknown unless independently established. Security regression tests establish only the cases they exercise.

The Ruflo security skill prescribes version 3.25.6 for optional read-only deep, dependency and secrets scans. Do not infer scanner coverage from the presence of that integration or this document. Only executed scans with recorded evidence count. No confirmed critical or high severity issue may be waived without an authorized owner, compensating control and deadline.

## Coverage limitations

This initial threat model is design review guidance. It does not constitute a completed penetration test, live dependency audit, credential scan or external integration audit. Remote APIs, real physical hardware, multi-process races and hostile plugin containment require additional deployment-specific validation.

## Initial review evidence

On 2026-09-08 at approximately 12:29 UTC, `npx --yes @claude-flow/cli@3.25.6 security scan --target . --depth deep --type all` exited 0 and reported zero findings across severity levels. This is a tool-only signal, not proof of absence of vulnerabilities. Its advisory-feed timestamp was not supplied and is unknown. It does not replace lockfile-aware npm and Cargo advisory checks or a dedicated secrets scan.

The independent runtime review reproduced an executor mutation defect: an executor could change the action cost after reservation and drive accounting negative. The host now isolates the executor action from its accounting record. The exact regression in `tests/security.test.ts` passed on rerun; all nine security cases passed. Other cases cover invalid numbers, exact capability checks, stop persistence, confidence bounds, oversized payloads and extension-policy authority narrowing.

Lockfile hashes at that review point:

* `package-lock.json`: `9a5599b31e7a46b7baf8867a51393b3e74080977aa489b24f95740e1801d94d1`
* `Cargo.lock`: `e8e8ce164ce759e1a8ff481ef3e61ec796b670fc0e8687af3e2d1d3806c0a1ab`

Re-run the harness for the current source hashes and current check statuses. No unresolved critical or high finding was confirmed in the inspected local control and accounting paths; this conclusion excludes remote integrations and untrusted in-process plugin containment. A main-database page cap and 80 percent admission high-water mark now bound admission growth; WAL and host disk quotas plus an archival plan remain required.

Final boundary review also found that rvCSI punctuation-containing source names produced IDs incompatible with the runtime validator. The adapter now uses stable namespaced SHA256 identifiers, retains original source metadata and validates complete observations before returning. Tests pass those mapped records through the actual runtime, rather than stopping at an adapter fixture.

The additional command `npx --yes @claude-flow/cli@3.25.6 security secrets --action scan --path src` exited 0 and reported no secrets across 12 source files. Its scan does not cover the complete repository or unknown secret formats. The strict harness separately passed npm and Cargo advisory checks during this session. Consult the published evidence snapshot for exact final source hashes and rerun against current advisory data before release.
# Adaptation boundaries

Execution feedback records transport completion, denial and uncertainty, not verified task success. Model predictions remain separate from observations. Freshness checks reject future or expired sensor observations at consumption; historical outcomes remain bounded evidence whose relevance the planner must assess.

Predictive search limits dimensions, branches, depth, expansions, cumulative cost and uncertainty. Injected synchronous model code remains trusted and needs process isolation for adversarial execution. A planner failure requires instance replacement to prevent uncommitted learned state from surviving a failed transaction.

Paired evaluation rejects overlap, missing evidence, retention regression, cost regression and capability violations. The durable ledger prevents exact audit reuse and bounds statistical spending. Scores and task identity are still host trust boundaries; neither hashes nor significance prove their truth. The legacy `promotionGate` is a deprecated simulation helper.
