import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import {
  closeDb,
  createWorkflow,
  deleteSwarmConfig,
  deleteWorkflow,
  getWorkflowRunStepsByRunId,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { __resetInjectedEnvTracking, loadGlobalConfigsIntoEnv } from "../http/core";
import type { WorkflowDefinition } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import {
  getSecretInputKeys,
  REDACTED_SECRET_VALUE,
  resolveInputs,
  resolveInputValue,
} from "../workflows/input";

const TEST_DB_PATH = "./test-workflow-input-default.sqlite";

// Builds `${NAME}` or `${NAME:-fallback}` without tripping the
// noTemplateCurlyInString lint on every literal.
const ref = (name: string, fallback?: string): string =>
  fallback === undefined ? `\${${name}}` : `\${${name}:-${fallback}}`;

// Env names used by this file. Saved and restored so the suite cannot leak
// into (or be skewed by) the surrounding process env.
const ENV_KEYS = [
  "WF_DEFAULT_TEST_VAR",
  "WF_DEFAULT_TEST_UNSET",
  "WF_DEFAULT_TEST_GITHUB_TOKEN",
  "DREAMING_ENABLED",
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("resolveInputValue — env reference with a default", () => {
  test("returns the env value when set", async () => {
    process.env.WF_DEFAULT_TEST_VAR = "from-env";
    expect(await resolveInputValue(ref("WF_DEFAULT_TEST_VAR", "fallback"))).toBe("from-env");
  });

  test("returns the default when unset", async () => {
    expect(await resolveInputValue(ref("WF_DEFAULT_TEST_UNSET", "fallback"))).toBe("fallback");
  });

  test("returns the default when set to the empty string", async () => {
    process.env.WF_DEFAULT_TEST_VAR = "";
    expect(await resolveInputValue(ref("WF_DEFAULT_TEST_VAR", "fallback"))).toBe("fallback");
  });

  test("an empty default resolves to the empty string", async () => {
    expect(await resolveInputValue(ref("WF_DEFAULT_TEST_UNSET", ""))).toBe("");
  });

  test("an empty default still yields the env value when set", async () => {
    process.env.WF_DEFAULT_TEST_VAR = "x";
    expect(await resolveInputValue(ref("WF_DEFAULT_TEST_VAR", ""))).toBe("x");
  });

  test("the default is taken literally (may contain spaces, colons, dashes)", async () => {
    expect(await resolveInputValue(ref("WF_DEFAULT_TEST_UNSET", "a b:-c"))).toBe("a b:-c");
  });

  test("a plain env reference still throws when unset", async () => {
    await expect(resolveInputValue(ref("WF_DEFAULT_TEST_UNSET"))).rejects.toThrow(
      'Environment variable "WF_DEFAULT_TEST_UNSET" is not set',
    );
  });

  test("a plain env reference still resolves when set", async () => {
    process.env.WF_DEFAULT_TEST_VAR = "plain";
    expect(await resolveInputValue(ref("WF_DEFAULT_TEST_VAR"))).toBe("plain");
  });

  test("resolveInputs mixes default, plain and literal values", async () => {
    process.env.WF_DEFAULT_TEST_VAR = "set";
    const resolved = await resolveInputs({
      a: ref("WF_DEFAULT_TEST_VAR", "nope"),
      b: ref("WF_DEFAULT_TEST_UNSET", "25"),
      c: "literal",
    });
    expect(resolved).toEqual({ a: "set", b: "25", c: "literal" });
  });
});

describe("getSecretInputKeys — env reference with a default", () => {
  test("flags a secret-named key with a default (name part only)", () => {
    const keys = getSecretInputKeys({
      token: ref("WF_DEFAULT_TEST_GITHUB_TOKEN", "none"),
      flag: ref("DREAMING_ENABLED", "false"),
    });
    expect(keys.has("token")).toBe(true);
    expect(keys.has("flag")).toBe(false);
    expect(keys.size).toBe(1);
  });

  test("a sensitive-looking default does not flag a non-sensitive name", () => {
    const keys = getSecretInputKeys({ v: ref("WF_DEFAULT_TEST_VAR", "MY_TOKEN") });
    expect(keys.size).toBe(0);
  });
});

// Captures what the executor receives so we can compare it against the
// persisted (redacted) step input.
class CaptureExecutor extends BaseExecutor<
  typeof CaptureExecutor.schema,
  typeof CaptureExecutor.outSchema
> {
  static readonly schema = z.object({ seen: z.string().optional() });
  static readonly outSchema = z.object({ ok: z.boolean() });

  readonly type = "capture-default";
  readonly mode = "instant" as const;
  readonly configSchema = CaptureExecutor.schema;
  readonly outputSchema = CaptureExecutor.outSchema;

  static lastSeen: string | undefined = undefined;

  protected async execute(
    config: z.infer<typeof CaptureExecutor.schema>,
  ): Promise<ExecutorResult<z.infer<typeof CaptureExecutor.outSchema>>> {
    CaptureExecutor.lastSeen = config.seen;
    return { status: "success", output: { ok: true } };
  }
}

describe("with a database", () => {
  beforeAll(() => {
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {
        // ignore
      }
    }
  });

  let workflowId: string | null = null;

  afterEach(async () => {
    if (workflowId) {
      try {
        await deleteWorkflow(workflowId);
      } catch {
        // ignore
      }
      workflowId = null;
    }
  });

  test("a secret-named env reference with a default is redacted in persisted steps", async () => {
    const SECRET_VALUE = "ghp_default_syntax_secret_value_123";
    process.env.WF_DEFAULT_TEST_GITHUB_TOKEN = SECRET_VALUE;
    CaptureExecutor.lastSeen = undefined;

    const def: WorkflowDefinition = {
      nodes: [{ id: "capture", type: "capture-default", config: { seen: "{{input.token}}" } }],
    };
    const workflow = await createWorkflow({
      name: `input-default-redaction-${Date.now()}`,
      definition: def,
      triggers: [],
      input: {
        token: ref("WF_DEFAULT_TEST_GITHUB_TOKEN", "none"),
        plain: ref("WF_DEFAULT_TEST_UNSET", "p"),
      },
    });
    workflowId = workflow.id;

    const registry = new ExecutorRegistry();
    const deps: ExecutorDependencies = {
      db: {} as typeof import("../be/db"),
      eventBus: { emit: () => {}, on: () => {}, off: () => {} },
      interpolate: (t: string) => t,
    };
    registry.register(new CaptureExecutor(deps));

    const runId = await startWorkflowExecution(workflow, {}, registry);
    expect(CaptureExecutor.lastSeen).toBe(SECRET_VALUE);

    const steps = await getWorkflowRunStepsByRunId(runId);
    expect(steps.length).toBe(1);
    const persisted = (steps[0]!.input as Record<string, unknown>).input as Record<string, unknown>;
    expect(persisted.token).toBe(REDACTED_SECRET_VALUE);
    expect(persisted.plain).toBe("p");
    expect(JSON.stringify(steps[0]).includes(SECRET_VALUE)).toBe(false);
  });

  // The config reload path (`reloadGlobalConfigsAndIntegrations`, the
  // `set-config` auto-reload and POST /internal/reload-config) injects global
  // swarm_config rows into process.env through `loadGlobalConfigsIntoEnv`.
  // We drive that seam directly rather than the full reload, which also
  // re-initializes integrations.
  test("a global config write plus env injection changes what the DREAMING_ENABLED reference resolves to", async () => {
    __resetInjectedEnvTracking();
    const flagRef = ref("DREAMING_ENABLED", "false");
    expect(await resolveInputValue(flagRef)).toBe("false");

    const row = await upsertSwarmConfig({
      scope: "global",
      key: "DREAMING_ENABLED",
      value: "true",
    });
    try {
      await loadGlobalConfigsIntoEnv(true);
      expect(await resolveInputValue(flagRef)).toBe("true");
    } finally {
      await deleteSwarmConfig(row.id);
    }

    // Deleting the row and reloading reverts the injected value.
    await loadGlobalConfigsIntoEnv(true);
    expect(await resolveInputValue(flagRef)).toBe("false");
    __resetInjectedEnvTracking();
  });
});
