# RSI evidence bridge

The `inspectRSIEvidence` adapter reads a host-selected experiment receipt and returns advisory status. The caller supplies an expected run ID, source SHA256, receipt SHA256, clock and maximum age. It rejects missing bindings, changed bytes, stale evidence, invalid costs, false local acceptance and embedded promotion eligibility.

A valid locally accepted result always returns `eligibleForPromotion: false`. Existing paired audits in evaluation.ts and the persistent promotion ledger remain required. Hashes bind content; they do not authenticate the evaluator or establish truth. The trusted host must obtain pins independently of retrieved receipts.

Unknown billing remains null. Partial billing is not complete billing. Unknown input fields never grant capabilities or dispatch work. This adapter does not start the supervisor or install an experiment.

The source is compatible with the bounded experiment receipt schema version1 from the RuV Stack experiment foundation. Recovery drill results and retrieval reports use their own schemas and must not be submitted as experiment receipts.

Run `npm run typecheck` and `npm test`. The tests cover digest/source/run mismatches, freshness, malformed receipts, acceptance boundaries and authority injection. Operational validation on a Node24 ruOS desktop passed all72 tests and type checking; full native/WASM/advisory verification remains the repository CI gate.

Local acceptance also requires all five journal gates (correctness, security, reliability, holdout and rollback), a matching journal decision, and arithmetic consistent with baseline, candidate and declared gain.
