#!/usr/bin/env node
import { readFileSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Runtime } from './runtime.ts';
import { Store } from './store.ts';
import { DEFAULT_CONFIG } from './contracts.ts';
import type { RuntimeConfig, Executor, Planner } from './contracts.ts';
import { validateConfig } from './policy.ts';
import { nativePolicy } from './bindings.ts';

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : process.argv[index+1];
  if (!value || value.startsWith('--')) throw new Error(`missing_argument:${name}`);
  return value;
}
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'help';
  if (command === 'help' || command === '--help') {
    console.log('rGi: demo [--cycles 5] [--db path] | run --config path | status|stop --db path');
    return;
  }
  process.umask(0o077);
  let dbPath = resolve(argument('--db','.rgi/runtime.db'));
  let config: Partial<RuntimeConfig> = {};
  let executor: Executor;
  let planner: Planner | undefined;
  let nativePath: string | undefined;
  let maxSteps: number | undefined;
  if (command === 'demo') {
    maxSteps = Number(argument('--cycles','5'));
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100000) throw new Error('invalid_cycles');
    config = { allowedCapabilities:['simulation.step'],budgetMicros:1000000,idleMs:1 };
    planner = { async plan({sequence}) { return [{ id:`demo:${sequence}`,capability:'simulation.step',
      payload:{sequence},estimatedCostMicros:1,confidence:1 }]; } };
    executor = { async execute(action) { return {output:{sequence:action.payload.sequence,simulated:true},actualCostMicros:1}; } };
  } else if (command === 'run') {
    const configPath = resolve(argument('--config'));
    const raw = readFileSync(configPath,'utf8');
    if (Buffer.byteLength(raw) > 65536) throw new Error('config_too_large');
    const document = JSON.parse(raw) as { dbPath:string;runtime:Partial<RuntimeConfig>;plugin:string;nativeBinding?:string };
    if (typeof document.plugin !== 'string' || !document.plugin.startsWith('./') || typeof document.dbPath !== 'string')
      throw new Error('invalid_plugin_config');
    dbPath = resolve(dirname(configPath),document.dbPath); config = document.runtime;
    // Config is an operator-controlled trust boundary; never accept plugin paths from observations.
    const plugin = await import(pathToFileURL(resolve(dirname(configPath),document.plugin)).href) as { executor:Executor;planner?:Planner };
    if (typeof plugin.executor?.execute !== 'function' || (plugin.planner && typeof plugin.planner.plan !== 'function'))
      throw new Error('invalid_plugin');
    executor = plugin.executor; planner = plugin.planner;
    nativePath = document.nativeBinding ? resolve(dirname(configPath),document.nativeBinding) : undefined;
  } else if (command === 'status' || command === 'stop') {
    // Existing database only; never read an entire long-lived journal into memory.
    if (!statSync(dbPath).isFile()) throw new Error('invalid_database');
    const store = new Store(dbPath,DEFAULT_CONFIG,false);
    try { if (command === 'stop') store.stop(); console.log(JSON.stringify(store.status(),null,2)); }
    finally { store.close(); }
    return;
  } else throw new Error('unknown_command');
  validateConfig({...DEFAULT_CONFIG,...config});
  mkdirSync(dirname(dbPath),{recursive:true,mode:0o700});
  const runtime = new Runtime({dbPath,config,executor,planner,policy:nativePath ? nativePolicy(nativePath) : undefined});
  chmodSync(dbPath,0o600);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  try {
    await runtime.run({signal:controller.signal,maxSteps});
    console.log(JSON.stringify(runtime.status(),null,2));
  } finally { process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);runtime.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'runtime_failed');process.exitCode=1; });
