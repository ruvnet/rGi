# Active discovery in rGi

rGi can choose a bounded experiment to distinguish the world models still consistent with its observations. It chooses the greatest expected information per unit of declared cost, updates its hypothesis set from the result, and answers only when all surviving hypotheses agree. The supplied hypotheses are deterministic prediction tables, with a uniform prior. This increment does not train a neural world model or invent a new hypothesis class.

## Run and replay

Requires Node 24 and the existing project dependencies.

```bash
node scripts/benchmark-discovery.ts
node scripts/replay-discovery.ts artifacts/discovery.rvf artifacts/discovery.public.pem
node scripts/replay-discovery.ts artifacts/discovery.rvm.rvf artifacts/discovery.public.pem --rvm
node scripts/harness.ts
```

The benchmark exhaustively enumerates 187 targets across threshold, modular affine and Boolean composition priors. Each target runs with information selection, fixed order and seeded random controls, for 561 trials. Each arm sees the same public declaration, budgets and consensus rule. Every target in a family has the same probe order and policy seed, preventing acquisition metadata from encoding the target. Query inputs are separate from probe inputs. Modular query inputs repeat known residue classes at new integers, so this is coefficient acquisition, not novel arithmetic.

Every episode also runs again without pauses. The benchmark requires that uninterrupted execution and checkpoint restoration produce exactly the same event chain. The resulting RVF stores three shared model tables, all declarations and all receipts. Its separately supplied Ed25519 public key verifies the signature. Replay reconstructs every choice, cost, observation update and query score. It imports no code from the container. The `.rvm.rvf` file remains RVF and supports the pinned structural RVM parser; it is not an executable guest or a new `.rvm` format.

Report correct answers, wrong answers, abstentions, completed tasks, probes and acquisition cost together. The paired results are descriptive counts over correlated public targets. This benchmark does not invoke the promotion gate, consume independent audit data or establish an external ranking.

The random control uses one fixed seed across all targets. Treat it as a particular schedule diagnostic, not an estimate averaged over random seeds. The fixed order control is the primary comparison. Future robustness studies should cross independent order and policy seeds with every target, rather than assigning a target its own identifying permutation.

## Runtime integration

`DiscoveryEngine(problem, policy)` owns an immutable compact copy of the table and belief state. `reserve()` charges cost and one probe before returning a decision. The host must complete it with `observe(output)` or `fail()`. No parallel reservation is permitted. Contradictory observations stop the run; uncertain predictions return `null`. Unanimity is conditional on the declared prior and can be wrong if the actual rule is absent.

`advanceDiscovery(spec, database, oracle, maxAdditionalProbes)` integrates the engine with a host owned SQLite database. The spec includes a unique run ID, problem and policy. The oracle receives only the selected input index and returns an integer observation. Call with a small `maxAdditionalProbes`, such as one, to checkpoint after each experiment. Reuse the same spec and database to resume. Rehydration checks the specification, event hashes and each recorded choice before taking another step. Completed runs return their recorded result without repeating the oracle call.

Ruflo can schedule these bounded steps as workflow tasks while the rGi host controls experiment execution. Ruflo's coordination record is not execution evidence. Any LLM generated candidate table must pass the same bounds before use, and proposal generation costs need separate accounting. The existing supervisor policy and restricted worker transport remain separate components; this increment does not automatically wire arbitrary providers into the experiment callback.

Reservations commit before callbacks. A failed callback stays charged and the run terminates. A crash during execution leaves a record marked running with an uncertain outcome. It is refused on automatic retry, even if its last stored event appears complete. Only a clean paused checkpoint resumes. Preserve the database for explicit host reconciliation of uncertain external effects.

The callback is synchronous trusted host code. It can block or cause external effects; this runner supplies no callback deadline, process isolation, asynchronous provider adapter or network sandbox. Use an independently enforced execution boundary before connecting untrusted or remote experiments. Synthetic acquisition costs do not measure actual provider charges.

## Performance and evidence limits

The kernel benchmark compares a single information selection against an independent Map based reference on a 256 by 64 table. It validates equal choices, entropy and tie behavior first. Both sides use fresh instances prepared before timing, the same warmup count and alternating measurement batches. Initialization costs are reported separately and can be higher for the optimized implementation. Selection speedup excludes validation, initialization, SQLite, proof generation, transport and model inference. No timing threshold is used as a CI correctness gate.

The signature establishes artifact integrity relative to a trusted key. The demonstration key is generated during the run, with its private half retained only in memory. A valid artifact does not independently establish an honest oracle, actual external execution, state of the art performance or AGI.

Design and research rationale: [ADR 011](ADR-011-active-discovery.md) and [primary research review](ACTIVE-DISCOVERY-RESEARCH.md).
