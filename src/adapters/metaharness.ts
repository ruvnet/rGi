import type { Action, ExecutionContext, ExecutionResult, Executor } from '../contracts.ts';

/** Structural subset of @metaharness/sdk ToolDef, packages/sdk/src/index.ts. */
export interface MetaHarnessTool {
  readonly name: string;
  readonly server: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly handler?: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface RegisteredTool {
  capability: string;
  tool: MetaHarnessTool;
  /** Trusted host validator: SDK ToolDef does not itself validate runtime arguments. */
  validate: (payload: Record<string, unknown>) => boolean;
  /** Explicit maximum local/provider charge in micros; reserved by runtime before dispatch. */
  costMicros: number;
}

/** Calls only pre-registered handlers. No command, URL or tool name comes from the payload. */
export class MetaHarnessExecutor implements Executor {
  readonly #tools = new Map<string, RegisteredTool>();
  constructor(entries: RegisteredTool[]) {
    for (const entry of entries) {
      if (!entry.capability || this.#tools.has(entry.capability) || typeof entry.tool.handler !== 'function' || typeof entry.validate !== 'function' || !Number.isSafeInteger(entry.costMicros) || entry.costMicros < 0) throw new Error('Invalid tool registration');
      this.#tools.set(entry.capability, { ...entry, tool: { ...entry.tool } });
    }
  }
  async execute(action: Action, context: ExecutionContext): Promise<ExecutionResult> {
    context.signal.throwIfAborted();
    const entry = this.#tools.get(action.capability);
    if (!entry) throw new Error('Unregistered capability');
    if (!Number.isSafeInteger(action.estimatedCostMicros) || action.estimatedCostMicros < entry.costMicros) throw new Error('Insufficient cost reservation');
    const payload = structuredClone(action.payload);
    if (!entry.validate(payload)) throw new Error('Invalid tool payload');
    // The upstream handler has no AbortSignal/idempotency argument. Host must choose
    // read-only or independently idempotent handlers; cancellation cannot undo a call.
    const output = await entry.tool.handler!(payload);
    return { output, actualCostMicros: entry.costMicros };
  }
}
