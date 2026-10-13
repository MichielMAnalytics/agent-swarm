import { NativeScriptExecutor } from "./native";
import { QuickJSScriptExecutor } from "./quickjs";
import type { ScriptExecutor } from "./types";

const EXECUTORS: Record<string, () => ScriptExecutor> = {
  native: () => new NativeScriptExecutor(),
  quickjs: () => new QuickJSScriptExecutor(),
};

export function getScriptExecutor(name = process.env.SCRIPT_EXECUTOR ?? "native"): ScriptExecutor {
  const factory = EXECUTORS[name.trim()];
  if (!factory) {
    throw new Error(
      `Unknown SCRIPT_EXECUTOR: ${name}. Available: ${Object.keys(EXECUTORS).join(", ")}`,
    );
  }
  return factory();
}

/**
 * Where a script run came from. The entrypoint, not the script, is the trust
 * boundary: the same saved script runs under a different executor when an
 * external caller or app viewer triggers it than when an agent does.
 */
export type ScriptEntrypoint =
  | "script-api"
  | "app-action"
  | "app-sync"
  | "agent"
  | "workflow"
  | "schedule"
  | "heartbeat";

/** Entrypoints that users, page viewers or external callers can trigger. */
const EXTERNAL_ENTRYPOINTS: ReadonlySet<ScriptEntrypoint> = new Set([
  "script-api",
  "app-action",
  "app-sync",
]);

function configured(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Executor name for a run. External entrypoints read
 * `SCRIPT_EXECUTOR_EXTERNAL`, falling back to `SCRIPT_EXECUTOR`; the rest read
 * `SCRIPT_EXECUTOR`. Both default to `native`.
 */
export function executorFor(
  entrypoint: ScriptEntrypoint,
  env: Record<string, string | undefined> = process.env,
): string {
  const agentDefault = configured(env.SCRIPT_EXECUTOR) ?? "native";
  if (!EXTERNAL_ENTRYPOINTS.has(entrypoint)) return agentDefault;
  return configured(env.SCRIPT_EXECUTOR_EXTERNAL) ?? agentDefault;
}

/**
 * A nested run never escalates: a run started from a quickjs script runs under
 * quickjs, whatever its own entrypoint would pick.
 */
export function clampToParentExecutor(executor: string, parentExecutor?: string): string {
  return parentExecutor?.trim() === "quickjs" ? "quickjs" : executor;
}
