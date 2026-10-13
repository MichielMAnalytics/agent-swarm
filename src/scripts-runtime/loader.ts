import { getApiKey } from "../utils/api-key";
import { scrubObject, scrubSecrets } from "../utils/secret-scrubber";
import type { ScriptApiConnectionDescriptor, ScriptMcpConnectionDescriptor } from "./api-types";
import type { FailedCredentialBinding } from "./credential-broker";
import { buildEgressSecrets } from "./egress-secrets";
import {
  clampToParentExecutor,
  executorFor,
  getScriptExecutor,
  type ScriptEntrypoint,
} from "./executors/registry";
import {
  DEFAULT_SCRIPT_RESOURCES,
  type EgressSecretEntry,
  type ExecutorOutput,
  type ScriptFsMode,
  type ScriptResourcePolicy,
  type SwarmConfigPayload,
} from "./executors/types";
import { validateScriptImports } from "./import-allowlist";

/**
 * `capacity_exceeded` (see `ScriptExecutorError`) means the sandboxed process
 * aborted because a host-wide, shared RLIMIT_NPROC budget was momentarily
 * exhausted — not because the script failed. The executor (`native.ts`'s
 * `classifyExit`) only assigns this classification when the abort happened
 * BEFORE user-authored code got control, using a sentinel file the harness
 * writes right before it — see `eval-harness.ts`'s `startedFile`. That
 * guarantees a retry here can never replay a side effect the script already
 * caused. Retry transparently here, once, for every caller (HTTP script
 * runs, workflow script/swarm-script nodes, scheduled scripts), independent
 * of whatever concurrency limiter or retry policy an individual caller does
 * or doesn't configure. Short and bounded: this is a blip mitigation, not a
 * substitute for the caller's own retry policy if the underlying contention
 * is sustained.
 */
const CAPACITY_EXCEEDED_RETRY_DELAYS_MS = [200, 750];

/**
 * Persisted identity of a run, logged on the executor line so an operator can
 * tell which executor ran a given record.
 */
export type ScriptRunCorrelation = {
  /** `script_runs.id` the caller records; allocate it before the run. */
  runId?: string;
  scriptId?: string;
  scriptName?: string;
  workflowRunId?: string;
  /** `workflow_run_steps.id` of the swarm-script node. */
  workflowStepId?: string;
  scheduleId?: string;
  appId?: string;
  /** `action:<name>` for an app action, `sync:<model>/<source>` for a sync pass. */
  appTarget?: string;
};

export type RunScriptInput = {
  source: string;
  /** Where the run came from; selects the executor (see `executorFor`). */
  entrypoint: ScriptEntrypoint;
  /**
   * Executor of the script that started this run, when it is a nested
   * `script_run`. A quickjs parent pins its child to quickjs.
   */
  parentExecutor?: string;
  correlation?: ScriptRunCorrelation;
  args?: unknown;
  fsMode?: ScriptFsMode;
  agentId: string;
  /** Per-boot runtime identity of the invoking worker; system context, never script input. */
  runtimeInstanceId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  mcpBaseUrl?: string;
  resources?: Partial<ScriptResourcePolicy>;
  userConfig?: Record<string, { value: string; isSecret: boolean }>;
  egressSecrets?: EgressSecretEntry[];
  failedBindings?: FailedCredentialBinding[];
  apiConnections?: ScriptApiConnectionDescriptor[];
  mcpConnections?: ScriptMcpConnectionDescriptor[];
};

export type RunScriptOutput = Omit<ExecutorOutput, "result" | "stdout" | "stderr"> & {
  result: unknown | undefined;
  stdout: string;
  stderr: string;
  /** Executor the run resolved to; absent when the run was refused before one was chosen. */
  executor?: string;
};

/** Executor name for a run: the entrypoint's policy, clamped to a nested run's parent. */
function resolveRunExecutor(input: Pick<RunScriptInput, "entrypoint" | "parentExecutor">): string {
  return clampToParentExecutor(executorFor(input.entrypoint), input.parentExecutor);
}

/** ` key=value` pairs for the run log; values with spaces, quotes or `=` are JSON-quoted. */
function formatRunLogFields(fields: Record<string, string | undefined>): string {
  return Object.entries(fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "")
    .map(([key, value]) => ` ${key}=${/[\s"=]/.test(value) ? JSON.stringify(value) : value}`)
    .join("");
}

export type { ScriptRuntimeError, ScriptStackFrame } from "./executors/types";

async function buildConfigPayload(
  input: RunScriptInput,
  executor: string,
): Promise<SwarmConfigPayload> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Swarm API key is required to run scripts");

  return {
    system: {
      apiKey: { value: apiKey, isSecret: true },
      agentId: { value: input.agentId, isSecret: false },
      mcpBaseUrl: {
        value: input.mcpBaseUrl ?? process.env.MCP_BASE_URL ?? "http://localhost:3013",
        isSecret: false,
      },
      ...(input.runtimeInstanceId
        ? { runtimeInstanceId: { value: input.runtimeInstanceId, isSecret: false as const } }
        : {}),
      executor: { value: executor, isSecret: false },
    },
    user: input.userConfig ?? {},
    egressSecrets: input.egressSecrets ?? (await buildEgressSecrets()),
    failedBindings: input.failedBindings ?? [],
    apiConnections: input.apiConnections ?? [],
    mcpConnections: input.mcpConnections ?? [],
  };
}

/** The fields of a run its executor log line needs. */
type RunLogInput = Pick<
  RunScriptInput,
  "entrypoint" | "parentExecutor" | "correlation" | "agentId"
>;

/**
 * The one terminal log line of an admitted run: returned failures and thrown
 * exceptions log here too. Identity only: never args, bearer or credentials.
 */
function logScriptRun(
  input: RunLogInput,
  executorName: string | undefined,
  outcome: { exit: string; error?: string; durationMs: number },
): void {
  console.info(
    `[scripts-runtime] run${formatRunLogFields({
      entrypoint: input.entrypoint,
      executor: executorName,
      parent: input.parentExecutor,
      ...input.correlation,
      agentId: input.agentId,
      exit: outcome.exit,
      error: outcome.error,
      durationMs: String(outcome.durationMs),
    })}`,
  );
}

function logThrownScriptRun(
  input: RunLogInput,
  executorName: string | undefined,
  startedAtMs: number,
): void {
  logScriptRun(input, executorName, {
    exit: "thrown",
    error: "executor_error",
    durationMs: Math.round(performance.now() - startedAtMs),
  });
}

/**
 * `runScript` behind caller setup (credential bindings, connection
 * descriptors) that runs once the caller has admitted the run. A setup throw
 * logs the executor line like a run throw, so every admitted run logs once.
 */
export async function runScriptAfterSetup(
  run: RunLogInput,
  setup: () => Promise<Omit<RunScriptInput, keyof RunLogInput>>,
): Promise<RunScriptOutput> {
  const startedAtMs = performance.now();
  let input: RunScriptInput;
  try {
    input = { ...run, ...(await setup()) };
  } catch (err) {
    let executorName: string | undefined;
    try {
      executorName = resolveRunExecutor(run);
    } catch {
      // Log the run without an executor rather than mask the setup error.
    }
    logThrownScriptRun(run, executorName, startedAtMs);
    throw err;
  }
  return runScript(input);
}

export async function runScript(input: RunScriptInput): Promise<RunScriptOutput> {
  const startedAtMs = performance.now();
  let executorName: string | undefined;
  let output: ExecutorOutput;
  try {
    // Resolve once: capacity retries reuse the same executor even if the
    // config reloads mid-run.
    executorName = resolveRunExecutor(input);
    output = await executeRun(input, executorName);
  } catch (err) {
    logThrownScriptRun(input, executorName, startedAtMs);
    throw err;
  }
  logScriptRun(input, executorName, {
    exit: String(output.exitCode),
    error: output.error,
    durationMs: output.durationMs,
  });

  return {
    ...output,
    result: scrubObject(output.result),
    stdout: scrubSecrets(output.stdout),
    stderr: scrubSecrets(output.stderr),
    ...(output.runtimeError ? { runtimeError: scrubObject(output.runtimeError) } : {}),
    executor: executorName,
  };
}

async function executeRun(input: RunScriptInput, executorName: string): Promise<ExecutorOutput> {
  if (input.fsMode === "workspace-rw") {
    return {
      result: undefined,
      stdout: "",
      stderr: "workspace-rw not supported in scripts-runtime v1",
      truncated: { stdout: false, stderr: false },
      durationMs: 0,
      exitCode: 1,
      error: "executor_error",
    };
  }

  const imports = validateScriptImports(input.source);
  if (!imports.ok) {
    return {
      result: undefined,
      stdout: "",
      stderr: imports.diagnostic,
      truncated: { stdout: false, stderr: false },
      durationMs: 0,
      exitCode: 1,
      error: "import_violation",
    };
  }

  const resources = {
    ...DEFAULT_SCRIPT_RESOURCES,
    ...input.resources,
    ...(input.timeoutMs ? { wallClockMs: input.timeoutMs } : {}),
  };

  const executor = getScriptExecutor(executorName);
  const configPayload = await buildConfigPayload(input, executorName);
  const executorInput = {
    source: input.source,
    args: input.args ?? null,
    configPayload,
    resources,
    fsMode: input.fsMode ?? "none",
    network: "open" as const,
    signal: input.signal,
  };

  let output = await executor.run(executorInput);
  for (const delayMs of CAPACITY_EXCEEDED_RETRY_DELAYS_MS) {
    if (output.error !== "capacity_exceeded" || input.signal?.aborted) break;
    await Bun.sleep(delayMs);
    output = await executor.run(executorInput);
  }
  return output;
}
