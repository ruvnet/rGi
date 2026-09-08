import type { Action, ExecutionContext, ExecutionResult, Executor } from '../contracts.ts';

/** Structural subset of agenticow/src/index.d.ts at dd4f437b92d2dbbc1f40dfa00023eed6e9c3bd84. */
export interface AgenticMemoryClient {
  readonly dimension: number;
  ingest(records: { id: number; vector: number[]; text?: string }[]): { accepted: number; rejected: number; epoch: number };
  query(vector: number[], k?: number): { id: number; distance: number; branch: string; text?: string }[];
}

/** Host supplies an already isolated branch. Opening paths and promoting edits are deliberately not exposed. */
export class AgenticowExecutor implements Executor {
  readonly #client: AgenticMemoryClient;
  constructor(client: AgenticMemoryClient) {
    if (!Number.isSafeInteger(client.dimension) || client.dimension < 1 || client.dimension > 65_536) throw new Error('Invalid dimension');
    this.#client = client;
  }
  async execute(action: Action, context: ExecutionContext): Promise<ExecutionResult> {
    context.signal.throwIfAborted();
    const p = action.payload;
    const vector = p.vector;
    if (!Array.isArray(vector) || vector.length !== this.#client.dimension || !vector.every(v => typeof v === 'number' && Number.isFinite(v))) throw new Error('Invalid vector');
    let output: unknown;
    if (action.capability === 'memory.query') {
      const k = p.k ?? 10;
      if (!Number.isSafeInteger(k) || (k as number) < 1 || (k as number) > 100) throw new Error('Invalid query limit');
      output = this.#client.query([...vector], k as number);
    } else if (action.capability === 'memory.ingest') {
      if (!Number.isSafeInteger(p.id) || (p.id as number) < 0) throw new Error('Invalid memory id');
      if (p.text !== undefined && (typeof p.text !== 'string' || p.text.length > 65_536)) throw new Error('Invalid memory text');
      output = this.#client.ingest([{ id: p.id as number, vector: [...vector], ...(p.text === undefined ? {} : { text: p.text as string }) }]);
    } else throw new Error('Unsupported memory capability');
    // Local memory operations incur no provider charge; CPU/storage cost is measured separately.
    return { output, actualCostMicros: 0 };
  }
}
