# ADR 006: Grounded adaptation and predictive planning

Date: 8 September 2026

Status: Accepted for bounded implementation; external capability validation remains pending.

## Context

A perpetual supervisor must use experience after restart and assess consequences before acting. Increasing concurrency alone does not provide those capabilities. Unrestricted context evolution also risks negative transfer: [RSEA](https://arxiv.org/abs/2606.28374) reports that different methods win on different tasks, motivating explicit selection rather than automatic promotion.

We need mechanisms that fit the existing TypeScript supervisor and Rust policy boundary without claiming training infrastructure we do not have.

## Decision

1. Persist grounded action outcomes and make bounded history available in planning context alongside fresh observations. Historical outcomes carry timestamps but are not automatically expired; planners must assess applicability. Preserve source observations separately from predicted states. History is evidence, not authority to expand permissions.
2. Introduce a model interface for action conditioned predictions. Use a bounded beam and finite search horizon; execute only the first selected action and replan from subsequent observations. Prediction failure must not create an executable speculative action.
3. Evaluate baseline and candidate on paired heldout cases. Require explicit manifest separation, complete finite metrics, minimum evidence, meaningful improvement, retention limits and zero reported capability violations. Apply correction for declared multiple comparisons and return a reasoned decision.
4. Preserve the existing policy gate, spend limits, checkpoints and stop controls outside learned or generated components. Promotion evidence cannot authorize new capabilities.

These are engineering adaptations. They do not implement the GRPO trained policy in [MemHarness](https://arxiv.org/abs/2607.28272), the logit update in [JitRL](https://arxiv.org/html/2601.18510), or a foundation world model. [V-JEPA 2](https://arxiv.org/abs/2506.09985) motivates predictive control but provides no accuracy guarantee for an injected rGi predictor.

## Alternatives

Unbounded memory was rejected because irrelevant history increases context cost and can preserve obsolete beliefs. Greedy action selection remains a comparison baseline because it is cheaper and can outperform search with an inaccurate model. Automatic live weight or structural updates are deferred until an owned model, repeatable training pipeline and independent evaluation exist.

## Consequences

The runtime gains restart persistent planning evidence and a testable predictive control boundary. Latency depends on beam width, horizon and predictor cost; external model inference must be budgeted separately from supervisor throughput. Planning with a wrong model can still choose a poor authorized action.

The evaluator verifies supplied evidence structure, not the honesty of an evaluator process. Disjoint task identifiers do not prove distinct task semantics. A host controlled evaluator must prevent contamination, preserve artifacts and rotate selection sets across generations. Batch statistical correction is not a guarantee under unlimited adaptive reuse.

## Acceptance

The durable promotion ledger allocates a fixed total alpha across a fixed maximum number of evaluations. It rejects reused audit IDs and candidates, including evidence from rejected attempts. This limits repeated testing within the retained ledger; it cannot prove semantic independence or prevent an authorized host from replacing the database.

Planner failures invalidate the runtime instance because timed-out code may continue mutating its state. A fresh instance restores only the last committed planner checkpoint.

Tests must cover fresh versus expired experience after restart, invalid and stale observations, delayed reward choices, bounded prediction counts, invalid model results, overlapping manifests, incomplete pairs, multiple comparisons, retention regression and permission violations. A local benchmark must disclose that its dynamics and tasks are synthetic. Claims of generalization require a subsequent independent suite with fixed budgets and unseen task families.
