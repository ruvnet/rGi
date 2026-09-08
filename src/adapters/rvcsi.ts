import type { Observation } from '../contracts.ts';
import { createHash } from 'node:crypto';
import { validateObservation } from '../policy.ts';

/** Actual napi-rs RvcsiRuntime method; host opens and owns capture/device handles. */
export interface RvcsiClient { drainEventsJson(): string }
const KINDS = new Set(['PresenceStarted', 'PresenceEnded', 'MotionDetected', 'MotionSettled', 'BaselineChanged', 'SignalQualityDropped', 'DeviceDisconnected', 'BreathingCandidate', 'AnomalyDetected', 'CalibrationRequired']);

/** JSON serialization of crates/rvcsi-core/src/event.rs CsiEvent. Large u64 values remain decimal strings. */
export interface CsiEvent {
  event_id: number | string;
  kind: string;
  session_id: number | string;
  source_id: string;
  timestamp_ns: number | string;
  confidence: number;
  evidence_window_ids: (number | string)[];
  calibration_version: string | null;
  metadata_json: string;
}

function u64(value: unknown): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n) return BigInt(value);
  throw new Error('Invalid CSI u64');
}

/** Lossless u64 handling uses Node24 JSON reviver source context, not rounded JS numbers. */
function parseEvents(json: string): unknown {
  return JSON.parse(json, (_key: string, value: unknown, ...rest: unknown[]) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      const source = (rest[0] as { source?: string } | undefined)?.source;
      if (!source || !/^[0-9]+$/.test(source)) throw new Error('Lossless integer parsing unavailable');
      return source;
    }
    return value;
  });
}

/** Sensor evidence only. Clock normalization is explicitly supplied, never assumed to be wall time. */
export class RvcsiObservationAdapter {
  readonly #client: RvcsiClient;
  readonly #clock: (timestampNs: bigint) => number;
  constructor(client: RvcsiClient, toTimestampMs: (timestampNs: bigint) => number) { this.#client = client; this.#clock = toTimestampMs; }
  drain(signal: AbortSignal): Observation[] {
    signal.throwIfAborted();
    const json = this.#client.drainEventsJson();
    if (typeof json !== 'string' || json.length > 1_048_576) throw new Error('CSI event batch too large');
    const parsed = parseEvents(json);
    if (!Array.isArray(parsed) || parsed.length > 1024) throw new Error('Invalid CSI batch');
    return parsed.map((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid CSI event');
      const event = raw as CsiEvent;
      const eventId = u64(event.event_id), sessionId = u64(event.session_id), ns = u64(event.timestamp_ns);
      if (!KINDS.has(event.kind) || typeof event.source_id !== 'string' || !event.source_id || event.source_id.length > 256 || !Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1) throw new Error('Invalid CSI identity or confidence');
      if (!Array.isArray(event.evidence_window_ids) || event.evidence_window_ids.length < 1 || event.evidence_window_ids.length > 4096) throw new Error('Invalid CSI evidence');
      event.evidence_window_ids.forEach(u64);
      if (event.calibration_version !== null && (typeof event.calibration_version !== 'string' || event.calibration_version.length > 256)) throw new Error('Invalid CSI calibration');
      if (typeof event.metadata_json !== 'string' || event.metadata_json.length > 65_536) throw new Error('Invalid CSI metadata');
      JSON.parse(event.metadata_json); // Validate syntax without promoting metadata to authoritative fields.
      const timestamp = this.#clock(ns);
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('Invalid CSI clock mapping');
      const source = `rvcsi:${createHash('sha256').update(event.source_id, 'utf8').digest('hex')}`;
      const observation: Observation = { id: `${source}:${sessionId}:${eventId}`, source, timestamp, modality: 'rvcsi', confidence: event.confidence, data: event };
      validateObservation(observation);
      return observation;
    });
  }
}
