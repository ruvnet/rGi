import { createHash } from 'node:crypto';

export interface WorkloadPlan {
  workload: string;
  runId: string;
  mode: 'scheduled' | 'manual';
  startedAt: number;
  policySha256: string;
  planSha256: string;
  unit: 'requests' | 'cases' | 'actions';
  expected: number;
}

export interface WorkloadForecast extends WorkloadPlan {
  schema: 'rgi-workload-forecast-v1';
  forecastSha256: string;
}

export interface WorkloadResult {
  workload: string;
  runId: string;
  forecastSha256: string;
  finishedAt: number;
  status: 'complete' | 'failed' | 'skipped';
  actual: number | null;
  evidenceSha256: string | null;
}

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const units = (value: unknown): value is number => count(value) && value <= 1_000_000;

/** Called by the workload owner before dispatch. No capabilities are granted. */
export function recordWorkloadForecast(input: WorkloadPlan): WorkloadForecast {
  const { workload, runId, mode, startedAt, policySha256, planSha256, unit, expected } = input;
  if (!id(workload) || !id(runId) || !['scheduled', 'manual'].includes(mode) || !count(startedAt) ||
      !digest(policySha256) || !digest(planSha256) || !['requests', 'cases', 'actions'].includes(unit) || !units(expected)) {
    throw new Error('invalid_workload_forecast');
  }
  const envelope = { schema: 'rgi-workload-forecast-v1' as const, workload, runId, mode, startedAt,
    policySha256, planSha256, unit, expected };
  return { ...envelope, forecastSha256: hash(envelope) };
}

/** Compares two host-owned observations. A digest links evidence but does not verify it or grant authority. */
export function closeWorkloadForecast(forecast: WorkloadForecast, result: WorkloadResult) {
  const canonical = recordWorkloadForecast(forecast);
  const { workload, runId, forecastSha256, finishedAt, status, actual, evidenceSha256 } = result;
  if (forecast.schema !== canonical.schema || canonical.forecastSha256 !== forecast.forecastSha256 ||
      workload !== canonical.workload || runId !== canonical.runId || forecastSha256 !== canonical.forecastSha256 ||
      !count(finishedAt) || finishedAt < canonical.startedAt || !['complete', 'failed', 'skipped'].includes(status) ||
      (actual !== null && !units(actual)) || (evidenceSha256 !== null && !digest(evidenceSha256))) {
    throw new Error('workload_forecast_binding_mismatch');
  }
  const comparable = status === 'complete' && actual !== null;
  const comparison = comparable ? actual === canonical.expected ? 'matched' : 'deviated' : 'inconclusive';
  const record = { schema: 'rgi-workload-outcome-v1' as const, workload, runId, forecastSha256, finishedAt,
    status, actual, evidenceSha256, comparison, delta: comparable ? actual - canonical.expected : null,
    authority: 'observe_only' as const };
  return { ...record, outcomeSha256: hash(record) };
}
