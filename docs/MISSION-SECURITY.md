# Mission security and evidence review

Scope: reviewed standalone agent bundles, child process transport, sequential audit ledger, RVF parsing and signed receipt replay. This is a local engineering assessment, not a certification or an adversarial RVM guest deployment.

## Confirmed findings fixed

| Finding | Consequence | Fix and regression evidence |
| --- | --- | --- |
| Audit identity originally included the answer | Changing an answer could regain an old input | Fingerprint canonical input only; also reject audit inputs previously exposed in training. Mission tests change answers and query former training inputs. |
| Individually bounded responses could accumulate excessive proof memory | Many large replies could exceed the final proof cap | Count cumulative canonical bytes before appending or persisting each event. A real child returning large replies hits the cap below 8 MiB. |
| Interrupted runs initially retained only a specification hash | Partial receipts lacked reconstructable experiment context | Persist the complete canonical specification at reservation. Failure tests inspect its presence. |
| Durable snapshot was initially trusted until final replay | Corrupted state could reach a restored agent first | Compare the stored event with its recorded original before restore. A SQLite corruption trigger is rejected before a restore receipt. |
| Asynchronous deadlines did not stop synchronous plugin loops in the earlier callback architecture | A plugin could block the supervisor | Execute reviewed plugins in child processes and enforce deadlines from the parent. Actual startup and request infinite loops are killed. |

## Enforced boundaries

Copied bundle bytes are checked against the frozen SHA256 at every process launch. Only the copied worker and bundle receive filesystem read permission. Host environment values are excluded. Responses must match an outstanding request ID and satisfy strict JSON and size rules. Errors terminate the session; temporary files are removed after process exit.

RVF readers validate bounded segment lengths, segment inventory, hashes, canonical payload, root page and padding. Tests compare against unmodified pinned upstream RVForge writer and validator code. The RVM compatibility gate executes the pinned upstream Rust structural parser and rejects corrupt streams. That gate does not perform RVM capability verification or guest execution.

Ed25519 verification requires an external public key. Signed specifications, ordered receipts, restore identity, request counts and scores are revalidated. The default replay command does not execute embedded code, and it binds embedded agent source to the signed source digest.

## Automated scan and limits

Ruflo `@claude-flow/cli@3.25.6` deep source scan reported zero findings for `src` during this mission. That automated result is supplemented by the concrete manual findings and regression tests above. The strict harness separately executes lockfile based npm and Cargo advisory checks; scan execution time does not independently establish advisory feed freshness.

Node permissions are not a hostile code sandbox and do not constrain network egress. Native memory, provider charges and real tool effects require separate enforcement. A signature cannot attest honest execution or evaluator independence. The demonstration uses a generated signing key and known rules. None of these controls establish AGI, statistically bounded retention or customer production readiness.

Deployment owner acceptance: use only reviewed bundles here; provide an isolated and metered worker service or hardened RVM guest before accepting hostile plugins, credentials or live tools. Preserve audit storage and do not retry uncertain external effects automatically.
