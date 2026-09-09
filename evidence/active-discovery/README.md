# Active discovery evidence

This public mechanism study compares information per cost selection with fixed and seeded random probing over the same finite priors. It contains 187 targets and 561 trials. It is not an independent generalization audit or a state of the art result.

| Measure | Information | Fixed order | One random seed |
| --- | ---: | ---: | ---: |
| Correct query answers | 2,394 | 2,318 | 868 |
| Wrong query answers | 0 | 0 | 0 |
| Abstentions | 238 | 314 | 1,764 |
| Fully solved targets | 149 | 147 | 5 |
| Synthetic acquisition cost | 444 | 731 | 731 |
| Probes | 444 | 443 | 443 |

Each arm has 2,632 query opportunities. Against fixed order, acquisition cost fell 39.3 percent, while correct answers increased by 76. Paired full target outcomes are three wins, one loss and 183 ties. The improvement is modest in completion rate and does not establish statistical promotion. The random comparison is one fixed schedule, not a seed averaged estimate. Boolean composition remains difficult and the threshold budget leaves unresolved hypotheses. All abstentions remain in the denominator.

The 256 by 64 selection microbenchmark measured 239.676 ms for the independent reference and 46.690 ms for the compact implementation across 256 reservations, a 5.13 times selection speedup. Setup took 3,407.563 ms for the reference and 4,342.107 ms for the compact implementation. Setup, persistence, replay, transport and inference are excluded from the selection comparison. Initialization is slower in this measurement, so no overall speedup is claimed. The complete study execution and checkpoint comparison took 28,483.672 ms on the recorded shared host.

All 769 checkpoint resumes matched their uninterrupted execution trace. The signed study hash is `ce31382f00165af457e25779bbe0305b495330ca61b83aa5be70a136f1fc834a`. The RVF is 819,072 bytes. The strict harness completed all 21 checks, including the complete TypeScript suite, Rust tests and checks, native and WASM builds, actual binding parity, benchmarks, both discovery replay commands and dependency advisory checks.

## Replay

From the repository root:

```bash
node scripts/replay-discovery.ts evidence/active-discovery/discovery.rvf evidence/active-discovery/discovery.public.pem
node scripts/replay-discovery.ts evidence/active-discovery/discovery.rvm.rvf evidence/active-discovery/discovery.public.pem --rvm
```

RVF stores shared model tables and all trial receipts. Replay verifies the external key, every selection, every charge, each observation update and all query scores. It executes no embedded program. The RVM transport file contains RVF segments, not a new executable format. The public key was generated for this demonstration and does not represent independent evaluator identity. Signature integrity cannot establish honest external execution.

`harness.json` records commands, statuses, source hashes and tool versions. Those source hashes were rechecked against the working tree after the run. These evidence files were copied afterward and are deliberately not self included in that hash set. `digests.json` identifies the copied files; it does not authenticate itself. The reviewed repository commit anchors the published files.

## Review and provenance

Review found that the first fixture draft encoded the target in its public probe permutation. Before accepting any benchmark result, ordering was changed to a single fixed permutation per family and the policy seed was made constant across targets. Tests now require identical public problems throughout each family. No budget, target count or rule prior changed. An interrupted earlier benchmark produced no accepted artifact.

Review also found that a helper accepted transcript IDs incompatible with subsequent replay. It now rejects the mismatch before changing a study. Tests cover malformed declarations, budget exhaustion, ambiguity, contradictions, failed callbacks, interrupted persistence, ownership and checkpoint validation, forged but rehashed selections, missing controls, changed models, incorrect target labels and untrusted signing keys.

Ruflo task `task-1788918025584-28pjue` recorded the objective in swarm `swarm-1788916040208-iirdz0`. Platform workers owned the kernel, fixtures and research review; the coordinator owned persistence, evidence, integration and acceptance. Ruflo's task creation record is coordination metadata, not a claim that its CLI status tracks these platform agents. Completion authority is the executed harness and committed evidence.

Read [implementation and integration](../../docs/ACTIVE-DISCOVERY.md), [ADR 011](../../docs/ADR-011-active-discovery.md) and [primary research review](../../docs/ACTIVE-DISCOVERY-RESEARCH.md) for scope and remaining research gaps.
