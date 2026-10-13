import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { __resetEncryptionKeyForTests } from "../be/crypto";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import { createScriptApi, insertScript } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { validateConfigValue } from "../be/swarm-config-guard";
import { handleCore } from "../http/core";
import { handleScripts } from "../http/scripts";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { handleX } from "../http/x";
import { executorFor, type ScriptEntrypoint } from "../scripts-runtime/executors/registry";
import { runScript } from "../scripts-runtime/loader";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";

const skip = test.skipIf(SKIP_SANDBOX_SPAWN_TESTS);

const TEST_DB_PATH = "./test-script-executor-entrypoint-policy.sqlite";
const API_KEY = "example-test-entrypoint-policy-key-1234567890";

const EXTERNAL: ScriptEntrypoint[] = ["script-api", "app-action", "app-sync"];
const INTERNAL: ScriptEntrypoint[] = ["agent", "workflow", "schedule", "heartbeat"];

/** Spawns a process: works under native, throws under quickjs (no `Bun`). */
const SPAWN_SOURCE = `export default async function run() {
  const proc = Bun.spawn([process.execPath, "--version"], { stdout: "pipe" });
  await proc.exited;
  return { spawned: proc.exitCode === 0 };
}`;

/** Reports which runtime it ran in without touching anything. */
const PROBE_SOURCE = `export default async function run() { return { bun: typeof Bun }; }`;

describe("executorFor: entrypoint x config", () => {
  const cases: Array<{
    env: Record<string, string | undefined>;
    external: string;
    internal: string;
  }> = [
    { env: {}, external: "native", internal: "native" },
    { env: { SCRIPT_EXECUTOR: "quickjs" }, external: "quickjs", internal: "quickjs" },
    { env: { SCRIPT_EXECUTOR_EXTERNAL: "quickjs" }, external: "quickjs", internal: "native" },
    { env: { SCRIPT_EXECUTOR_EXTERNAL: "native" }, external: "native", internal: "native" },
    {
      env: { SCRIPT_EXECUTOR: "quickjs", SCRIPT_EXECUTOR_EXTERNAL: "native" },
      external: "native",
      internal: "quickjs",
    },
    {
      env: { SCRIPT_EXECUTOR: "native", SCRIPT_EXECUTOR_EXTERNAL: "quickjs" },
      external: "quickjs",
      internal: "native",
    },
    // Blank values fall through, like an unset key.
    {
      env: { SCRIPT_EXECUTOR: " ", SCRIPT_EXECUTOR_EXTERNAL: "" },
      external: "native",
      internal: "native",
    },
    { env: { SCRIPT_EXECUTOR_EXTERNAL: " quickjs " }, external: "quickjs", internal: "native" },
  ];

  for (const { env, external, internal } of cases) {
    test(`${JSON.stringify(env)} -> external ${external}, internal ${internal}`, () => {
      for (const entrypoint of EXTERNAL) {
        expect(executorFor(entrypoint, env)).toBe(external);
      }
      for (const entrypoint of INTERNAL) {
        expect(executorFor(entrypoint, env)).toBe(internal);
      }
    });
  }
});

describe("SCRIPT_EXECUTOR_EXTERNAL configuration", () => {
  test("accepts native and quickjs only", () => {
    for (const value of ["native", "quickjs", " quickjs "]) {
      expect(validateConfigValue("SCRIPT_EXECUTOR_EXTERNAL", value)).toBeNull();
    }
    for (const value of ["e2b", "QuickJS", "", " ", null, 1]) {
      expect(validateConfigValue("SCRIPT_EXECUTOR_EXTERNAL", value)).toBe(
        "Invalid SCRIPT_EXECUTOR_EXTERNAL value (must be one of: native, quickjs)",
      );
    }
  });
});

// ─── runtime + HTTP ──────────────────────────────────────────────────────────

const noOpEmbeddingProvider = {
  name: "test/noop-script-embedding",
  dimensions: 1,
  async embed() {
    return null;
  },
  async embedBatch(texts: string[]) {
    return texts.map(() => null);
  },
};

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

let workerId: string;
let savedEnv: NodeJS.ProcessEnv;

/** Headers the SDK sent on nested script_run calls, captured by a stub API. */
const nestedHeaders: Array<string | null> = [];
const stubApi = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/scripts/run") {
      nestedHeaders.push(req.headers.get("x-script-executor"));
      return Response.json({
        result: { nested: true },
        truncated: { stdout: false, stderr: false },
        durationMs: 0,
        stdout: "",
        stderr: "",
        exitCode: 0,
      });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});

beforeAll(async () => {
  savedEnv = { ...process.env };
  process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  delete process.env.API_KEY;
  delete process.env.SCRIPT_EXECUTOR;
  delete process.env.SCRIPT_EXECUTOR_EXTERNAL;
  __resetEncryptionKeyForTests();
  await removeDbFiles(TEST_DB_PATH);
  closeDb();
  initDb(TEST_DB_PATH);
  refreshSecretScrubberCache();
  setScriptEmbeddingProviderForTests(noOpEmbeddingProvider);
  const worker = await createAgent({ name: "entrypoint-worker", isLead: false, status: "idle" });
  workerId = worker.id;
});

afterAll(async () => {
  stubApi.stop(true);
  closeDb();
  setScriptEmbeddingProviderForTests(null);
  __resetEncryptionKeyForTests();
  await removeDbFiles(TEST_DB_PATH);
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  refreshSecretScrubberCache();
});

beforeEach(async () => {
  delete process.env.SCRIPT_EXECUTOR;
  delete process.env.SCRIPT_EXECUTOR_EXTERNAL;
  nestedHeaders.length = 0;
  await getDbClient().run("DELETE FROM script_apis");
  await getDbClient().run("DELETE FROM script_runs");
  await getDbClient().run("DELETE FROM scripts");
});

type TestResponse = { status: number; json: () => Promise<unknown> };

/** Same pipeline as the server: handleCore → handleScripts → handleX. */
async function dispatch(
  path: string,
  init: {
    method?: string;
    body?: string;
    agentId?: string;
    auth?: string | null;
    headers?: Record<string, string>;
  } = {},
): Promise<TestResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...init.headers,
  };
  const auth = init.auth === undefined ? API_KEY : init.auth;
  if (auth !== null) headers.authorization = `Bearer ${auth}`;
  if (init.agentId !== undefined) headers["x-agent-id"] = init.agentId;
  if (init.body !== undefined) headers["content-length"] = String(Buffer.byteLength(init.body));

  const req = Readable.from(init.body ? [Buffer.from(init.body)] : []) as IncomingMessage;
  req.method = init.method ?? "GET";
  req.url = path;
  req.headers = headers;

  let status = 200;
  let text = "";
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) text += String(chunk);
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;

  const agentId = req.headers["x-agent-id"] as string | undefined;
  if (!(await handleCore(req, res, agentId, API_KEY))) {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    if (
      !(await handleScripts(req, res, pathSegments, queryParams, agentId)) &&
      !(await handleX(req, res, pathSegments))
    ) {
      res.writeHead(404);
      res.end("Not Found");
    }
  }
  return { status, json: async () => JSON.parse(text) };
}

async function insertSaved(source: string) {
  return insertScript({
    name: `entrypoint-${crypto.randomUUID().slice(0, 8)}`,
    scope: "agent",
    scopeId: workerId,
    source,
    description: "entrypoint policy fixture",
    intent: "test fixture",
    signatureJson: "{}",
    argsJsonSchema: null,
    agentId: workerId,
    typeChecked: true,
  });
}

async function callScriptApi(scriptId: string) {
  const endpoint = await createScriptApi({ scriptId, agentId: workerId, authMode: "none" });
  const res = await dispatch(`/api/x/script/${endpoint.id}`, {
    method: "POST",
    body: JSON.stringify({}),
    auth: null,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { ok: boolean; result: unknown; error: { type: string } | null };
}

async function agentRun(body: Record<string, unknown>, headers?: Record<string, string>) {
  const res = await dispatch("/api/scripts/run", {
    method: "POST",
    body: JSON.stringify(body),
    agentId: workerId,
    headers,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { result: unknown; exitCode: number; error?: string };
}

describe("script API vs agent script-run under SCRIPT_EXECUTOR_EXTERNAL=quickjs", () => {
  skip("a script that spawns a process fails as a script API and runs as an agent", async () => {
    process.env.SCRIPT_EXECUTOR_EXTERNAL = "quickjs";
    const script = await insertSaved(SPAWN_SOURCE);

    const api = await callScriptApi(script.id);
    expect(api.ok).toBe(false);
    expect(api.result).toBeNull();
    expect(api.error?.message).toContain("'Bun' is not defined");

    const run = await agentRun({ name: script.name });
    expect(run.exitCode).toBe(0);
    expect(run.result).toEqual({ spawned: true });
  });

  skip("the default keeps script APIs on native", async () => {
    const script = await insertSaved(SPAWN_SOURCE);
    const api = await callScriptApi(script.id);
    expect(api.ok).toBe(true);
    expect(api.result).toEqual({ spawned: true });
  });
});

describe("nested script_run clamp", () => {
  skip("POST /api/scripts/run from a quickjs parent runs the child under quickjs", async () => {
    const clamped = await agentRun({ source: PROBE_SOURCE }, { "x-script-executor": "quickjs" });
    expect(clamped.result).toEqual({ bun: "undefined" });

    const unclamped = await agentRun({ source: PROBE_SOURCE });
    expect(unclamped.result).toEqual({ bun: "object" });
  });

  skip("a native parent header cannot lift a quickjs agent default", async () => {
    process.env.SCRIPT_EXECUTOR = "quickjs";
    const run = await agentRun({ source: PROBE_SOURCE }, { "x-script-executor": "native" });
    expect(run.result).toEqual({ bun: "undefined" });
  });

  const NESTED_SOURCE = `export default async function run(_args, ctx) {
    return await ctx.swarm.script_run({ source: "export default async () => 1" });
  }`;

  test("a quickjs run forwards its executor on ctx.swarm.script_run", async () => {
    process.env.SCRIPT_EXECUTOR_EXTERNAL = "quickjs";
    const output = await runScript({
      source: NESTED_SOURCE,
      entrypoint: "script-api",
      agentId: workerId,
      mcpBaseUrl: stubApi.url.origin,
    });
    expect(output.executor).toBe("quickjs");
    expect(output.exitCode).toBe(0);
    expect(nestedHeaders).toEqual(["quickjs"]);
  });

  skip("a native run forwards native", async () => {
    const output = await runScript({
      source: NESTED_SOURCE,
      entrypoint: "agent",
      agentId: workerId,
      mcpBaseUrl: stubApi.url.origin,
    });
    expect(output.executor).toBe("native");
    expect(output.exitCode).toBe(0);
    expect(nestedHeaders).toEqual(["native"]);
  });
});

// ─── executor log ↔ persisted run ────────────────────────────────────────────

/** Busy for ~150 ms so two runs overlap, then reports its runtime. */
const SLOW_PROBE_SOURCE = `export default async function run() {
  const end = Date.now() + 150;
  while (Date.now() < end) {}
  return { bun: typeof Bun };
}`;

/** Captures `[scripts-runtime] run` lines, parsed into key/value fields. */
async function captureRunLogs<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; lines: Array<Record<string, string>> }> {
  const lines: Array<Record<string, string>> = [];
  const original = console.info;
  console.info = (...parts: unknown[]) => {
    const line = parts.map(String).join(" ");
    if (!line.startsWith("[scripts-runtime] run ")) return original(...parts);
    const fields: Record<string, string> = {};
    for (const match of line.matchAll(/ (\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)) {
      const [, key, raw] = match as unknown as [string, string, string];
      fields[key] = raw.startsWith('"') ? JSON.parse(raw) : raw;
    }
    lines.push(fields);
  };
  try {
    return { value: await fn(), lines };
  } finally {
    console.info = original;
  }
}

describe("executor log correlates with the persisted run", () => {
  skip("two overlapping runs on different executors each log their own script_runs id", async () => {
    process.env.SCRIPT_EXECUTOR_EXTERNAL = "quickjs";
    const script = await insertSaved(SLOW_PROBE_SOURCE);

    const { value, lines } = await captureRunLogs(() =>
      Promise.all([callScriptApi(script.id), agentRun({ source: SLOW_PROBE_SOURCE })]),
    );
    const [api, inline] = value;
    expect(api.result).toEqual({ bun: "undefined" });
    expect(inline.result).toEqual({ bun: "object" });

    const rows = await getDbClient().query<{
      id: string;
      scriptName: string;
      output: string;
      startedAt: string;
      finishedAt: string;
    }>("SELECT id, scriptName, output, startedAt, finishedAt FROM script_runs");
    expect(rows).toHaveLength(2);
    const apiRow = rows.find((row) => row.scriptName === script.name);
    const inlineRow = rows.find((row) => row.scriptName === "(inline source)");
    if (!apiRow || !inlineRow) throw new Error(`unexpected rows: ${JSON.stringify(rows)}`);

    // The runs overlapped: each started before the other finished.
    expect(apiRow.startedAt < inlineRow.finishedAt).toBe(true);
    expect(inlineRow.startedAt < apiRow.finishedAt).toBe(true);

    expect(lines).toHaveLength(2);
    const apiLog = lines.find((line) => line.runId === apiRow.id);
    const inlineLog = lines.find((line) => line.runId === inlineRow.id);
    expect(apiLog).toMatchObject({
      entrypoint: "script-api",
      executor: "quickjs",
      scriptId: script.id,
      scriptName: script.name,
      agentId: workerId,
      exit: "0",
    });
    expect(inlineLog).toMatchObject({
      entrypoint: "agent",
      executor: "native",
      scriptName: "(inline source)",
      agentId: workerId,
      exit: "0",
    });
    // Each record's output is the one its own executor produced.
    expect(JSON.parse(apiRow.output)).toEqual({ bun: "undefined" });
    expect(JSON.parse(inlineRow.output)).toEqual({ bun: "object" });
  });

  test("workflow, schedule and app identities reach the log line", async () => {
    process.env.SCRIPT_EXECUTOR = "quickjs";
    process.env.SCRIPT_EXECUTOR_EXTERNAL = "quickjs";
    const workflowRunId = crypto.randomUUID();
    const workflowStepId = crypto.randomUUID();
    const scheduleId = crypto.randomUUID();
    const { lines } = await captureRunLogs(async () => {
      await runScript({
        source: PROBE_SOURCE,
        entrypoint: "workflow",
        agentId: workerId,
        correlation: { scriptName: "nightly report", workflowRunId, workflowStepId },
      });
      await runScript({
        source: PROBE_SOURCE,
        entrypoint: "schedule",
        agentId: workerId,
        correlation: { runId: "run-1", scheduleId },
      });
      await runScript({
        source: PROBE_SOURCE,
        entrypoint: "app-sync",
        agentId: workerId,
        correlation: { appId: "app-1", appTarget: "sync:deals/crm" },
      });
    });
    expect(lines).toEqual([
      expect.objectContaining({
        entrypoint: "workflow",
        executor: "quickjs",
        scriptName: "nightly report",
        workflowRunId,
        workflowStepId,
      }),
      expect.objectContaining({ entrypoint: "schedule", runId: "run-1", scheduleId }),
      expect.objectContaining({
        entrypoint: "app-sync",
        appId: "app-1",
        appTarget: "sync:deals/crm",
      }),
    ]);
  });
});
