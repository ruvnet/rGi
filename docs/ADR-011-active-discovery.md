# ADR 011: Bounded active experimental discovery

Status: accepted for the research runtime, 9 September 2026.

## Problem

The sequential mission demonstrates learning from support examples supplied by the host. It does not test whether an agent can choose an informative experiment. Repeated interactions may add cost without separating plausible explanations. A useful next mechanism must select experiments, charge for them and expose when the available explanations fail.

Recent interactive evaluations emphasize acquisition efficiency and the effect of preserving context. These motivate measuring the complete learning procedure under explicit harness conditions. They do not make a small demonstration comparable to a frontier benchmark. [ARC Prize evaluation analysis, 3 September 2026](https://arcprize.org/blog/astra).

## Decision

Add an experimental selector over a declared finite set of deterministic hypotheses and an explicit pool of probes with positive costs. All comparison strategies receive the same hypotheses, prediction table, probes, initial state and budget. The active strategy chooses an affordable unused probe that maximizes observation entropy divided by cost. Fixed order and seeded random selection provide controls for the value of the selection rule.

For the surviving set of hypotheses, group each probe's predicted outputs and let each group's probability be its fraction of survivors. The entropy is `-sum(p * log2(p))`. Under the declared uniform prior and deterministic observations, this equals the expected reduction in hypothesis entropy. Dividing by probe cost is a greedy choice. It is not a guarantee of globally optimal experimental design, minimum acquisition cost or calibrated real world uncertainty.

The host reserves a probe's cost before calling the trusted observation callback. A callback failure must not refund a possibly executed experiment. Contradictory observations that eliminate every hypothesis stop discovery. A prediction is returned only when the remaining hypotheses unanimously agree on its output; otherwise the selector abstains. Agreement is conditional on the supplied hypothesis class. All hypotheses can agree and still be wrong when the true mechanism is missing.

The implementation validates the full declaration before any observation callback. Limits are 256 hypotheses, 128 inputs, 32,768 prediction cells and 128 probes. Output symbols are integers from 0 to 255. Each probe costs an integer from 1 to 1,000,000; the total budget is at most 128,000,000. The random seed is an unsigned 32 bit integer. Encoded evidence also obeys the container and canonical document size limits. Deterministic tie breaking, fixed ordering and a declared random seed make strategy decisions reproducible.

Use an indexed `Uint8Array` prediction table, a compact survivor set, a preallocated histogram of 256 output counts and cached `count * log2(count)` terms. For `H` hypotheses, `I` declared inputs and `P` available probes, table storage is `O(H * I)` bytes; scoring all probes at a selection step is `O(H * P)` in the worst case. Filtering survivors after an observation is `O(H)`. An episode with `S` selections is therefore `O(S * H * P)`, plus bounded canonical encoding and evidence storage. Caching declared predictions avoids repeated model evaluation during selection. This trades memory for predictable selection work and must not be described as accelerated neural inference.

The host runner uses a synchronous, trusted observation callback and SQLite to persist reservations before invoking it. Completed observations and state transitions permit pausing between probes and reconstructing state on resume. A pending reservation after a crash represents an uncertain outcome and must never be retried automatically. This preserves cost accounting without pretending to provide exactly once external execution.

## Comparison and evidence protocol

The public mechanism benchmark compares active, fixed and seeded random strategies on the same task instances, priors and resource ceilings. Account for probe cost, number of observations, correct predictions, wrong predictions and abstentions separately. A strategy that abstains more must not gain an accuracy advantage by silently removing unanswered cases. Record random seeds and include failures and budget exhaustion.

Freeze the task declaration, strategies and scoring rule before running a comparison. The observation boundary receives the selected probe; the selector does not receive a hidden truth index or audit answers. Public probe ordering, policy seeds and other acquisition metadata must be independent of the target. The fixture tests require identical public problem declarations across every target in a family; the benchmark uses one constant policy seed. Retrospective replay artifacts can disclose answers after trial execution. Public fixtures remain development evidence. New random seeds within those fixtures do not establish unseen domains.

Signed study evidence binds model tables, trial declarations, strategies, seeds, observations, selections, charges and reported outcomes. Shared tables are stored once. Replay recomputes the legal strategy choices, survivor updates, costs and final predictions for every trial from its declared table and recorded observations. RVF packaging and the RVM compatible segment stream reuse ADR 008. Signature verification requires an externally pinned public key. Neither a valid signature nor a replayed entropy calculation establishes that the recorded oracle was truthful or that an external action occurred.

The independent task owner must keep final audit families separate from development and model selection. Repeated audit attempts require the existing consumption and promotion controls; the active selector alone is not an audit ledger. The need for this separation is supported by the test leakage and reproducibility issues discussed in [ASIA, 11 May 2026](https://arxiv.org/abs/2605.10480v1).

## Trust boundaries and limitations

Hypothesis predictions and the observation callback are reviewed inputs. A bounded data structure does not make arbitrary callbacks safe. The synchronous callback runs in the host process and can block or perform external effects. This component provides no callback deadline, asynchronous provider execution or hostile code or network sandbox. Real provider and environment integration must enforce deadlines and resource reservations at the execution boundary and collect actual billing independently.

This decision implements finite hypothesis elimination and experimental selection. It does not implement a learned multimodal world model, online neural parameter adaptation, autonomous discovery of new hypothesis classes, a generated curriculum or open ended generalization. The method is research informed and intentionally inspectable. Any state of the art claim requires a separately specified external benchmark and a fair measured comparison.

## Acceptance gates

Tests must reject malformed declarations, invalid costs, oversized tables, duplicate identifiers, forged choices, overspending and contradictory observations. They must show that reservation precedes the callback, that a failed observation remains charged, and that unresolved predictions abstain. Comparison tests must preserve identical priors and budgets across strategies.

Replay must reject tampering with observations, selections, resource totals and signatures, while recovering the original result for an unchanged artifact. Performance measurements must record table size, episode size, execution environment and workload. Correctness and bounded work are acceptance requirements; a speedup is reported only when measured against a named equivalent workload.
