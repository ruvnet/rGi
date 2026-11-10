import { loadRuntime, type DenseModel } from 'ruv-fann';
import { createHash } from 'node:crypto';
import type { Action } from '../contracts.ts';
import type { DynamicsModel } from '../planning.ts';
import { validateAction } from '../policy.ts';

export interface FannDynamics extends DynamicsModel {
  readonly backend: 'wasm';
  readonly modelSha256: string;
  readonly eligibleForPromotion: false;
  dispose(): void;
}
function vector(raw: unknown, size: number): number[] {
  if (!Array.isArray(raw) || raw.length !== size ||
      !Array.from(raw).every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6))
    throw new Error('invalid_fann_vector');
  return [...raw];
}
/**
 * Explicit opt-in, inference-only DynamicsModel. Features are state followed by
 * action.payload.features. Output is the complete next state, not a delta.
 * Models are trusted host-supplied artifacts, not candidate execution authority.
 * Uncertainty stays 1 (uncalibrated); no training or promotion is performed.
 * Model bytes and parameter count are bounded before WASM allocation.
 */
export async function createFannDynamics(model: DenseModel, stateSize: number, actionSize: number): Promise<FannDynamics> {
  if (![stateSize, actionSize].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 64))
    throw new Error('invalid_fann_dimensions');
  if (!model || !Array.isArray(model.layers) || model.layers.length < 1 || model.layers.length > 8)
    throw new Error('invalid_fann_layers');
  let parameters = 0;
  for (const layer of model.layers) {
    if (!layer || !Number.isSafeInteger(layer.inputs) || !Number.isSafeInteger(layer.outputs) ||
        layer.inputs < 1 || layer.outputs < 1 || layer.inputs > 128 || layer.outputs > 128 ||
        !Array.isArray(layer.weights)) throw new Error('invalid_fann_layer');
    parameters += layer.weights.length + (layer.bias?.length ?? 0);
    if (!Number.isSafeInteger(parameters) || parameters > 65536) throw new Error('fann_parameter_budget');
  }
  // Snapshot before the first await; caller mutation cannot change prepared code.
  const snapshot = structuredClone(model);
  const json = JSON.stringify(snapshot);
  if (Buffer.byteLength(json) > 1048576) throw new Error('fann_model_budget');
  if (snapshot.layers[0]!.inputs !== stateSize + actionSize ||
      snapshot.layers.at(-1)!.outputs !== stateSize) throw new Error('fann_model_shape');
  const modelSha256 = createHash('sha256').update(json).digest('hex');
  const runtime = await loadRuntime({ simd: false });
  const prepared = runtime.prepare(snapshot, { maxRows: 1 });
  let disposed = false;
  return Object.freeze({
    backend: 'wasm' as const, modelSha256, eligibleForPromotion: false as const,
    predict(state: readonly number[], action: Action) {
      if (disposed) throw new Error('fann_disposed');
      validateAction(action);
      const current = vector(state, stateSize);
      const features = vector((action.payload as { features?: unknown })?.features, actionSize);
      const output = prepared.predict(new Float64Array([...current, ...features]), 1);
      return { state: vector(Array.from(output), stateSize), uncertainty: 1 };
    },
    dispose() { if (!disposed) { disposed = true; prepared.dispose(); } },
  });
}
