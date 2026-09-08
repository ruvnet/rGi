# ADR 007: Separate transfer evaluation from adaptation demonstrations

Status: Accepted for implementation, subject to the verification harness.

Date: 8 September 2026.

## Context

The scalar adaptation benchmark established a narrow result inside one known environment family. A larger score on that family would still leave the central generalization question unanswered. rGi needs a reusable way to expose candidates to declared new families and preserve evidence about how much support they needed.

The source review and its limits are recorded in [GENERALIZATION-RESEARCH.md](GENERALIZATION-RESEARCH.md).

## Decision

Implement a host owned evaluation protocol around generic agent factories. The protocol declares frozen artifact identities, development and selection families, reserved transfer and retention tasks, support limits, cost limits, model call limits and call deadlines.

1. Validate the entire protocol before creating any agent. Transfer families cannot overlap declared development or selection families.
2. Reserve audit identities and content hashes durably before invoking callbacks. Failed attempts remain consumed. Do not silently rerun an audit after tuning.
3. Create a fresh baseline and candidate for every task and mode. Compare no support against a fixed support condition separately. The host does not give query answers or family labels to the predictor through its callback interface.
4. Count learning and prediction against each task's fixed budget. Validate counters and treat failures conservatively.
5. Score query outputs at the host and expose per family results. Keep retention results visible and separate from transfer results.
6. Treat the resulting report as evidence for review. It does not automatically modify the deployed runtime or replace the existing promotion ledger's statistical controls.

The synthetic demonstration is deliberately bounded and reproducible. It validates protocol behavior using known priors; it is not an AGI benchmark claim.

## Alternatives considered

| Option | Benefit | Rejection or limitation |
| --- | --- | --- |
| Add more scalar seeds | Minimal implementation cost | Measures more instances of the same known family. |
| Let one agent learn continuously across the audit | Resembles a persistent deployment | Confounds transfer with audit order and answer leakage unless independently controlled. |
| Separate fresh agents and fixed support modes | Attributes results to the declared artifact and support budget | Chosen now; continuous streams remain a distinct future protocol. |
| Immediately integrate all external benchmarks | Greater practical coverage | Requires benchmark specific environments, credentials and isolation that this callback runner does not provide. |

## Trust boundaries

The runner accepts trusted callbacks in the same process. It cannot enforce source identity, prevent hidden global memory, attest semantic task novelty or verify self reported billing. Deadlines are cooperative and cannot interrupt synchronous code. Dataset metadata and hashes provide traceability, not secrecy or independent provenance certification.

Production evaluation of untrusted candidates requires a separate scorer, killable execution boundary, host metering and independently controlled audit data. Existing runtime permissions and budgets remain the execution authority for real tools.

## Acceptance and rollback

The test suite must reject family overlap and reused audits, verify that query answers stay outside callback arguments, count support expenditure, exercise asynchronous timeout behavior, and expose retention regressions. The full project harness must continue to pass.

The framework is additive. Rollback disables its invocation and preserves its audit database. Deleting the ledger to regain used audit tasks is not a valid rollback. A real transfer claim requires a new independently reserved audit set and a frozen protocol before execution.
