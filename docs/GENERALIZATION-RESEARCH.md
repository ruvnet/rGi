# Generalization research and implementation scope

Research verified 8 September 2026. This framework operationalizes selected evaluation principles from current primary research. It does not reproduce these papers or establish a state of the art score.

## Evidence informing the design

| Primary source | Finding relevant to rGi | Design consequence |
| --- | --- | --- |
| [ARC AGI3 official description](https://arcprize.org/arc-agi/3) and [technical paper, revision 2](https://arxiv.org/abs/2603.24621v2), 17 April 2026 | Agents must explore unfamiliar interactive environments and learn goals and dynamics. Scoring measures efficiency against human action baselines. | Measure acquisition cost as well as completion. Keep success without examples separate from success after a fixed support allowance. |
| [Agent World Model, revision 3](https://arxiv.org/abs/2602.10090v3), 22 May 2026 | The authors construct 1,000 synthetic executable environments backed by databases and evaluate trained agents on separate benchmarks. | Prefer checkable environment state and explicit task provenance. Synthetic training diversity alone cannot certify independent transfer. |
| [Benchmark Test Time Scaling of General LLM Agents](https://arxiv.org/abs/2602.18998v1), 22 February 2026 | General AgentBench exposes search, coding, reasoning and tool use through a common interface. Its experiments identify context limits and a gap between generating a correct solution and selecting it. | Keep the agent interface constant, charge learning and inference, and score returned answers independently of the agent's confidence. |

These are selected relevant sources, not an exhaustive literature survey or a ranking of current models. In particular, the ARC paper's reported model scores refer to its study date, not today's leaderboard.

## What this implementation measures

The host declares development, selection, transfer and retention families. Transfer family identifiers must be disjoint from development and selection. Tasks carry identifiers, seeds, support examples and query examples. The agent receives permitted support and query inputs; the host retains query answers for scoring.

Each baseline and candidate starts from its declared frozen artifact in a fresh instance for every task and mode. One mode has no support examples. Another permits only the protocol's fixed support allowance. Both face the same resource limits. Learning expenditure counts against the allowance; an adaptation advantage cannot hide free extra inference. Report completion and observed cost for each mode and family rather than blending them into one score.

The durable ledger consumes audit task identities and content hashes before execution. An error or interrupted run does not make the same audit available for another optimization attempt. This is an engineering control against repeated selection on audit data, not a proof that every attempted experiment has been disclosed.

Retention is evaluated separately on declared prior families. Passing transfer while losing an existing skill is not an acceptable release outcome. The existing statistical promotion machinery remains distinct: the generalization report alone does not authorize deployment or establish statistical significance.

## Boundaries and deployment implications

The supplied demonstration uses synthetic tasks with known algorithmic priors. Separate generator families demonstrate that the protocol distinguishes families; they do not establish semantic novelty to the developer or a pretrained model. Random seeds create new instances, not necessarily new reasoning capabilities.

The support/query contract is not an interactive environment API. It does not yet reproduce ARC exploration, AWM reinforcement learning, or General AgentBench's tool servers. An interactive adapter needs explicit observations, actions, terminal states and trusted reward computation before those comparisons become meaningful.

Callbacks execute in the host process and are trusted. Fresh instances do not prevent a malicious factory from sharing global state. Artifact hashes identify declared bytes; they cannot attest that a callback executes those bytes. Cost and intervention counts require trusted host instrumentation. Promise timeouts can stop awaiting cooperative asynchronous work, but cannot terminate synchronous CPU loops or guarantee cancellation of external effects.

For external evaluations, place the scorer and audit data in a separate service, execute agents in killable workers, collect provider and tool billing at the host boundary, and have an independent owner select and reserve the audit families. These additions have operational cost but address the main remaining evidence and isolation risks.

## Acceptance evidence

| Requirement | Check the test suite must exercise |
| --- | --- |
| Genuine declared family separation | Reject transfer families appearing in development or selection, before agent construction. |
| No answer leakage through the interface | Record callback arguments and verify query outputs never appear. |
| Distinct acquisition conditions | Verify no learning callback in zero support mode and exact bounded support in adaptation mode. |
| Fresh task and mode state | Count factory creations and ensure state from earlier tasks cannot enter through runner arguments. |
| Complete resource accounting | Reject invalid counters, excess learning or prediction cost, excess model calls and prohibited human intervention. |
| Durable audit consumption | Reopen SQLite and reject reused task identifiers or content, including after execution failure. |
| Conservative failure handling | Record asynchronous timeout and callback failure without converting them into successful tasks. |
| Retention visibility | A candidate failing a retention family must appear as a regression even if transfer improves. |

Acceptance of the framework means these controls work. Acceptance of a generalization claim additionally requires independently selected unseen families, an adequate paired sample, frozen artifacts, complete costs and no unacceptable retention loss.
