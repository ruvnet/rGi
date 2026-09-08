# rGi v0.1 specification and acceptance gates

## Scope

Input: host configuration, authenticated upstream observations supplied through injected adapters, proposed actions, execution outcomes and operator control.

Output: durable jobs, bounded active queues and observation windows, policy decisions, accounted reservations, receipts, model snapshots and reproducible verification evidence.

Assumptions: one authorized local operator, trusted Node/native extensions, a local filesystem supporting SQLite locks, stable enough wall clock for leases, and independently idempotent external services. Secrets remain outside observations and repositories. A general intelligence claim, an unrestricted autonomous agent, live robot actuation, a cloud deployment and package registry releases are non-goals for v0.1.

## Requirements and executable evidence

| Requirement | Evidence |
| --- | --- |
| Stop and completed actions survive restart | runtime restart test; CLI restart/stop test |
| Conflicting IDs never overwrite work | idempotency conflict test |
| No default action authority | unauthorized action security test; Rust deny tests |
| Reserve before acting, count concurrent reservations | budget tests in Rust and TS |
| Uncertain outcomes never automatically replay | timeout, recovery and reconciliation tests |
| Account actual costs without releasing unknown spend | cost overrun and unknown outcome tests |
| One supervisor owns a journal | ownership test |
| Untrusted payloads cannot mutate accounting | independent mutation regression |
| Bounded planner output and observations | atomic invalid batch, queue and observation tests |
| Snapshots survive restart | learned state checkpoint test |
| Native and WASM decisions match host guard | check-bindings.ts executable parity cases |
| Integration signatures are grounded in source | adapters.test.ts and INTEGRATIONS.md pins |
| Verification cannot silently treat missing tools as success | harness strict status logic and CI |

## Failure walkthrough

Success: a goal produces a bounded action; the journal stores it; the host validates permission and budget inside a transaction; the executor runs with a stable idempotency key; the outcome releases its reservation, records actual cost and persists a receipt.

Failure: a process crashes after external execution but before the success receipt. Once the lease expires, the next owner marks the running job uncertain, preserves its reservation and stops. An operator queries the service using the same idempotency key, reconciles the outcome and explicitly resumes. No assumption of exactly-once remote effects is made.

## Research acceptance separate from runtime acceptance

Future generalization experiments must compare matched foundation models and compute budgets, sealed task families, human interventions, costs, confidence intervals, retention and permission violations. Runtime unit tests and scalar adaptation do not establish AGI, arbitrary zero-shot transfer or useful latent communication. Do not promote candidates from model-written self-evaluations alone.
