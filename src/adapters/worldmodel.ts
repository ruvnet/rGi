/** Source-derived TypeScript baseline, NOT an upstream Rust/native binding.
 * RuVector edaffffb3b85768eb1f3ec1f683b7f46f0506af4:
 * crates/ruvector-robotics/src/cognitive/world_model.rs.
 */
export interface TrackedObject {
  /** Safe-integer subset of upstream u64; wider IDs need a lossless native bridge. */
  id: number;
  position: [number, number, number];
  velocity: [number, number, number];
  /** Upstream microsecond observation clock, not automatically UTC. */
  last_seen: number;
  confidence: number;
  label: string;
}

export interface PredictedState {
  position: [number, number, number];
  confidence: number;
  time_horizon: number;
}

/** Discriminated prediction envelope deliberately is NOT an Observation. */
export interface PredictedBelief {
  kind: 'prediction';
  objectId: number;
  basedOnLastSeenMicros: number;
  model: 'ruvector-constant-velocity-ts-baseline';
  sourceCommit: 'edaffffb3b85768eb1f3ec1f683b7f46f0506af4';
  state: PredictedState;
  assumption: 'constant-velocity';
}

/** Matches upstream arithmetic; additional input/output bounds are rGi controls.
 * No learned dynamics, action conditioning, collision checking or calibrated uncertainty.
 */
export function predictConstantVelocity(object: TrackedObject, horizonSeconds: number): PredictedBelief {
  if (!object || !Number.isSafeInteger(object.id) || object.id < 0 || !Number.isSafeInteger(object.last_seen) || object.last_seen < 0) throw new Error('Invalid tracked identity or timestamp');
  for (const vector of [object.position, object.velocity]) {
    if (!Array.isArray(vector) || vector.length !== 3 || !vector.every(v => typeof v === 'number' && Number.isFinite(v))) throw new Error('Invalid tracked vector');
  }
  if (typeof object.label !== 'string' || object.label.length > 256 || !Number.isFinite(object.confidence) || object.confidence < 0 || object.confidence > 1) throw new Error('Invalid tracked metadata');
  if (!Number.isFinite(horizonSeconds) || horizonSeconds < 0 || horizonSeconds > 60) throw new Error('Invalid prediction horizon');
  const position = object.position.map((p, i) => p + object.velocity[i]! * horizonSeconds) as [number, number, number];
  if (!position.every(Number.isFinite)) throw new Error('Prediction overflow');
  return {
    kind: 'prediction', objectId: object.id, basedOnLastSeenMicros: object.last_seen,
    model: 'ruvector-constant-velocity-ts-baseline', sourceCommit: 'edaffffb3b85768eb1f3ec1f683b7f46f0506af4',
    state: { position, confidence: object.confidence / (1 + horizonSeconds / 5), time_horizon: horizonSeconds },
    assumption: 'constant-velocity',
  };
}
