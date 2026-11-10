# Optional ruv-fann dynamics adapter

This opt-in adapter connects real scalar WASM inference to rGi's existing
`DynamicsModel` contract. It does not change the default runtime or planner.
The model predicts the complete next state from state followed by
`action.payload.features`. Output is a prediction, not an observation.

```ts
import { createFannDynamics } from '../src/adapters/fann.ts';
const model = await createFannDynamics({
  schema: 'ruv-fann.dense-layers/1',
  layers: [{ inputs: 2, outputs: 1, weights: [1, 2], bias: [0],
    activation: 'Linear', steepness: 1 }],
}, 1, 1);
try {
  // Pass model to planPredictively with explicit existing host budgets.
  const prediction = model.predict([3], {
    id: 'step', capability: 'move', payload: { features: [0.5] },
    estimatedCostMicros: 1, confidence: 1,
  });
  // prediction.state == [4]; prediction.uncertainty == 1
} finally { model.dispose(); }
```

## Boundaries

Models must be trusted host-provided data. Model dimensions are capped at 128,
layers at 8, parameters at 65,536, serialized bytes at 1 MiB and inference at one
row per call. State/action vectors each have at most 64 elements bounded to 1e6.
These are allocation/work caps, not sandboxing or a wall-clock timeout.
Run untrusted candidate evaluation only through the existing isolated evaluator.

Uncertainty is always 1 because this integration has no calibrated uncertainty
evidence. Planners with maxUncertainty below 1 reject its predictions.
eligibleForPromotion is always false. Training, online adaptation, promotion,
provider calls and automatic activation are deliberately absent.

## Reproduction and rollback

Use Node 24 and `npm ci --ignore-scripts`, then `npm run typecheck` and
`npm test`. The exact package and transitive WASM dependency are both 0.1.2;
package-lock.json binds registry integrity. Scalar WASM SHA256:
a46f30ba9f7abafa7e77fbd8b686ab8b4785dd325f3e792b5a0fb39628a894f9.

Independent affine expectations, invalid input/model cases, resource limits,
snapshot isolation, disposal and planner gates exercise real WASM.
All 77 Node tests and typecheck passed on 2026-11-10. npm audit reported zero
vulnerabilities in this dependency tree. Rust/native/full strict CI was not
run locally. No performance, learning, cloud savings or delivered-value gain
is claimed. Provider/cloud/ChatGPT billing remains unknown.

Rollback requires removing the opt-in constructor call and using the existing
model. No persistent journal, evaluator, schedule or default policy is changed.
