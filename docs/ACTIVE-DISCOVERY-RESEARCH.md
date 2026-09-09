# Research informing active discovery

Sources checked on 9 September 2026. This review selects relevant primary research and maps it to engineering work. It is not an exhaustive state of the art ranking. The finite hypothesis selector is a classical, inspectable mechanism inspired by the acquisition problems below; it is not a reproduction of the cited neural agents.

## Primary evidence

| Source and date | Relevant finding | Consequence for rGi |
| --- | --- | --- |
| [ARC AGI 3 official benchmark description](https://arcprize.org/arc-agi/3), accessed 9 September 2026 | Interactive environments require exploration, inferred goals, updated models and efficient skill acquisition. Replay exposes behavior over time. | Record selected experiments, their costs and belief changes. A final answer score alone misses acquisition behavior. |
| [ARC Prize analysis of Astra](https://arcprize.org/blog/astra), 3 September 2026 | The authors distinguish a Standard harness from a Provider Adapter that preserves opaque reasoning state and manages long contexts. They explicitly state that benchmark saturation does not prove AGI. | Keep harness and memory conditions visible in comparisons. Do not translate results from a bounded benchmark into a general intelligence claim. |
| [Remember to be Curious, v1](https://arxiv.org/abs/2605.22814v1), 21 May 2026 | The authors combine a continuously updated 3D reconstruction with episodic sequence context to reduce exploration loops caused by forgotten states. Their experiments evaluate exploration and transfer in 3D worlds. | Persistent world state and trajectory memory are distinct requirements. The present selector prevents repeated probes within a run; it does not supply either learned spatial reconstruction or the paper's policy. |
| [Agent World, v1](https://arxiv.org/abs/2604.18292v1), 20 April 2026 | The authors describe executable environment and verifiable task synthesis, followed by training that targets identified capability gaps. The submission is labeled work in progress. | Environment diversity and verified task generation need their own implementation and evaluation. Adding more instances of one public rule class is insufficient. |
| [ASIA, v1](https://arxiv.org/abs/2605.10480v1), 11 May 2026 | An autonomous coding agent searches system identification models and training methods. The study discusses implicit test leakage, methodological transparency and reproducibility concerns. | Freeze evaluation code, separate model selection from final audit, and preserve experiment provenance. A signed result still depends on an honest producer. |
| [ASID, v2](https://arxiv.org/abs/2404.12308v2), 27 June 2024; first submitted 18 April 2024 | An initially imperfect simulator helps choose exploration that gathers useful physical data before refining the simulator and planning control. | Choose observations for their ability to distinguish explanations. The current entropy per cost rule is our finite deterministic implementation choice, not ASID's robotics method. |

The design implications in the right column are engineering inferences. The cited authors do not validate rGi or its benchmark. No published performance numbers are imported into this implementation's results.

## Scope of this increment

Active discovery adds a bounded question selection mechanism: maintain the explanations still consistent with observations, spend an explicit allowance on informative probes, and abstain when surviving explanations disagree. Fixed and seeded random controls use the same prior knowledge. Replay checks the recorded selection logic and accounting from a signed declaration.

The available hypotheses and their predictions are supplied by the developer. This substantially simplifies discovery. A good result establishes that the selector used that table effectively under the declared rules. It cannot establish discovery of a novel representation, competence outside the table, or independent domain generalization. A contradiction exposes a missing or incorrect explanation but does not automatically create a better one.

## Remaining research and implementation work

| Gap | Concrete next implementation | Evidence needed before claiming the gap is addressed |
| --- | --- | --- |
| Persistent world model and memory | Store versioned environment state and episodic observations through the ruvstack adapter boundary, with explicit update, forgetting and restart semantics. Connect WorldGraph or LatentMesh only after validating their actual APIs and artifact formats. | Compare retained state with reset state on sequential environments; measure prediction error, exploration revisits, storage cost and interference with earlier skills. |
| Environment diversity | Add separately maintained executable families with different observations, transitions, goals and failure modes. Reserve audit families with an independent task owner. | Report results by family and cost under frozen artifacts. Document provenance and excluded development exposure; seeded variations alone do not meet this requirement. |
| Verified automatic curricula | Generate candidate tasks from observed development failures and accept them only after an independent executable checker verifies solvability, intended constraints and scoring. | Reject broken or leaking generated tasks; show improvement on untouched audit families without adapting the curriculum to audit feedback. |
| New explanatory structures | Add a bounded proposal interface for models or programs, followed by validation on development observations before they join the hypothesis pool. | Charge proposal and validation costs, reject invalid proposals, and test whether newly proposed structures transfer beyond the examples used to select them. |
| Real process and provider integration | Route experiments through killable execution sessions or a trusted remote environment service. Meter provider tokens, tool costs, deadlines and external effects before dispatch. | Verify cancellation behavior, cost reservation after failures, scorer separation and complete provider receipts. Existing restricted Node sessions do not establish an operating system or network sandbox. |
| Continual adaptation | Connect an actual adaptive model with explicit checkpoint, update and rollback contracts through the runtime. | Measure acquisition gains and retention losses under changing streams, compare with frozen and reset controls, and preserve every attempted update in replay evidence. |

Ruflo can coordinate these workstreams and preserve validated project memory. It is not the scorer or independent verifier. RVF carries bounded evidence, and compatible RVM segments permit structural parsing; those file formats do not by themselves execute experiments or establish truthful measurements.

## Reading results correctly

Report completion, abstention, wrong answers, observation cost and elapsed time together. State the hypothesis class and what the agent already knows. Any reported efficiency gain applies to the named fixture and workload until independently reproduced on external environments. The current public benchmark must never be presented as a state of the art result, proof of AGI or evidence that the cited systems have been reproduced.

