import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  closeDb,
  createAgent,
  getDbClient,
  getKv,
  initDb,
  updateAgentProfile,
  upsertKv,
} from "../be/db";
import { typecheckScript } from "../be/scripts/typecheck";
import applySrc from "../be/seed-scripts/catalog/dream-apply.ts" with { type: "text" };
import rollbackSrc from "../be/seed-scripts/catalog/dream-rollback.ts" with { type: "text" };
import trimSrc from "../be/seed-scripts/catalog/dream-trim.ts" with { type: "text" };
import { resolveHttpRequestAuth } from "../http/auth";
import { handleDbQuery } from "../http/db-query";
import { handleKv } from "../http/kv";
import { handleMcpBridge } from "../http/mcp-bridge";
import { handleMemory } from "../http/memory";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { validateScriptImports } from "../scripts-runtime/import-allowlist";
import { runScript } from "../scripts-runtime/loader";
import { setRequestAuth } from "../utils/request-auth-context";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";

// dream-apply / dream-trim / dream-rollback run through the real script runtime (sandbox subprocess, ctx.swarm over
// HTTP) against an isolated file-backed test DB. Never the live DB.

const TEST_DB_PATH = `/tmp/test-dream-scripts-apply-${process.pid}.sqlite`;
const API_KEY = "example-test-dream-scripts-apply-key-0123456789";
const NS = "dreaming";
const SOURCES = {
  "dream-apply": applySrc,
  "dream-trim": trimSrc,
  "dream-rollback": rollbackSrc,
} as Record<string, string>;

const LEAD_ID = crypto.randomUUID();
const W1 = crypto.randomUUID();
const W2 = crypto.randomUUID();
const W3 = crypto.randomUUID();
const W4 = crypto.randomUUID();

const savedEnv = { ...process.env };
let server: Server;
let base = "";

const spawnTest = test.skipIf(SKIP_SANDBOX_SPAWN_TESTS);
// db_query runs bounded in a child process that opens the DB file, so this suite needs a file-backed DB, not the
// in-memory migration template the test preload installs.
const templateGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
  __savedDreamScriptsTemplate?: Uint8Array;
};

// ~8k chars: under the claudeMd budget, over the 6000-char rotation floor, so the trim plan picks it.
const bigClaude = (tag: string) =>
  `## Rules\n${Array.from({ length: 160 }, (_, i) => `- ${tag} rule line ${i} with padding text to make it long`).join("\n")}\n`;
const trimmedClaude = (tag: string) =>
  `## Rules\n- ${tag} keeps only the rules that change behaviour. ${"Short and clear. ".repeat(14)}\n`;
const CLAUDE_SMALL = "# Worker\n\n## Rules\n- rule one\n- rule two\n";

async function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
}

async function field(agentId: string, name: "claudeMd" | "toolsMd" | "soulMd"): Promise<string> {
  const r = await getDbClient().get<{ v: string | null }>(
    `SELECT ${name} AS v FROM agents WHERE id = ?`,
    [agentId],
  );
  return r?.v ?? "";
}

async function sha(s: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function countKv(prefix: string): Promise<number> {
  const r = await getDbClient().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM kv_entries WHERE namespace = ? AND substr(key, 1, length(?)) = ?",
    [NS, prefix, prefix],
  );
  return Number(r?.n ?? 0);
}

async function run(name: string, args: unknown): Promise<any> {
  const out = await runScript({
    source: SOURCES[name]!,
    args,
    agentId: LEAD_ID,
    mcpBaseUrl: base,
    timeoutMs: 60_000,
  });
  if (out.error)
    throw new Error(`${name}: ${JSON.stringify(out.error)} ${out.stderr.slice(0, 2000)}`);
  return out.result;
}

beforeAll(async () => {
  templateGlobals.__savedDreamScriptsTemplate = templateGlobals.__testMigrationTemplate;
  templateGlobals.__testMigrationTemplate = undefined;
  closeDb();
  await removeDbFiles();
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  delete process.env.API_KEY;
  refreshSecretScrubberCache();
  initDb(TEST_DB_PATH);
  await createAgent({ id: LEAD_ID, name: "dream-lead", isLead: true, status: "idle" } as any);
  for (const [id, name] of [
    [W1, "dream-w1"],
    [W2, "dream-w2"],
    [W3, "dream-w3"],
    [W4, "dream-w4"],
  ] as const)
    await createAgent({ id, name, isLead: false, status: "idle" } as any);
  await updateAgentProfile(W1, {
    claudeMd: bigClaude("w1"),
    toolsMd: "## Tools\n".concat("- tool line with padding text to fill it\n".repeat(400)),
  });
  await updateAgentProfile(W2, { claudeMd: bigClaude("w2") });
  await updateAgentProfile(W3, { claudeMd: bigClaude("w3") });
  await updateAgentProfile(W4, { claudeMd: CLAUDE_SMALL });

  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    setRequestAuth(req, await resolveHttpRequestAuth(req, API_KEY));
    res.setHeader("Content-Type", "application/json");
    const segs = getPathSegments(req.url || "");
    const qp = parseQueryParams(req.url || "");
    const agentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleKv(req, res, segs, qp)) return;
    if (await handleDbQuery(req, res, segs, qp)) return;
    if (await handleMemory(req, res, segs, agentId)) return;
    if (await handleMcpBridge(req, res, segs, qp, agentId)) return;
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a port");
  base = `http://127.0.0.1:${address.port}`;
  process.env.MCP_BASE_URL = base;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  closeDb();
  templateGlobals.__testMigrationTemplate = templateGlobals.__savedDreamScriptsTemplate;
  templateGlobals.__savedDreamScriptsTemplate = undefined;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  refreshSecretScrubberCache();
  await removeDbFiles();
});

describe("dream-* scripts pass the seeder gates", () => {
  test("import allowlist and script_upsert typecheck", async () => {
    const failures: string[] = [];
    for (const [name, src] of Object.entries(SOURCES)) {
      const imports = validateScriptImports(src);
      if (!imports.ok) failures.push(`${name}: import ${imports.diagnostic}`);
      const tc = await typecheckScript(src);
      if (!tc.ok) failures.push(`${name}: typecheck ${tc.diagnostics.join(" | ")}`);
    }
    expect(failures).toEqual([]);
  }, 60_000);
});

describe("dream-apply", () => {
  const actions = (memName: string) => ({
    actions: [
      {
        id: "A1",
        lane: "identity",
        tier: "auto",
        op: "append-under",
        target: { file: "CLAUDE", agentId: W4, anchor: "## Rules" },
        content: "- rule three",
      },
      {
        id: "A2",
        lane: "memory",
        tier: "auto",
        op: "memory-store",
        target: { name: memName },
        content: "A durable lesson from the dreaming test.",
      },
    ],
  });
  const memCount = async (name: string) =>
    Number(
      (
        await getDbClient().get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM agent_memory WHERE name = ?",
          [name],
        )
      )?.n ?? 0,
    );

  spawnTest(
    "dryRun writes nothing",
    async () => {
      const runId = "apply-dry";
      const r = await run("dream-apply", {
        runId,
        dryRun: true,
        synth: actions("dream-test-dry"),
        lanes: { identity: true, memory: true, trim: true, heartbeat: true },
      });
      expect(r.mode).toBe("dry-run");
      expect(r.errors).toEqual([]);
      expect(r.wouldApply.map((x: any) => x.actionId).sort()).toEqual(["A1", "A2"]);
      expect(r.applied).toEqual([]);
      expect(await field(W4, "claudeMd")).toBe(CLAUDE_SMALL);
      expect(await memCount("dream-test-dry")).toBe(0);
      expect(await countKv(`preimage:${runId}:`)).toBe(0);
      expect(await countKv(`applied:${runId}:`)).toBe(0);
    },
    60_000,
  );

  spawnTest(
    "identity lane off refuses identity actions and still applies memory",
    async () => {
      const r = await run("dream-apply", {
        runId: "apply-id-off",
        synth: actions("dream-test-id-off"),
        lanes: { identity: false, memory: true },
      });
      expect(r.mode).toBe("live");
      expect(r.refused).toEqual([{ actionId: "A1", reason: "lane off" }]);
      expect(r.applied.map((x: any) => x.actionId)).toEqual(["A2"]);
      expect(await field(W4, "claudeMd")).toBe(CLAUDE_SMALL);
      expect(await memCount("dream-test-id-off")).toBe(1);
    },
    60_000,
  );

  spawnTest(
    "memory lane off refuses memory actions and still applies identity",
    async () => {
      const r = await run("dream-apply", {
        runId: "apply-mem-off",
        synth: JSON.stringify(actions("dream-test-mem-off")),
        lanes: JSON.stringify({ identity: true, memory: false }),
      });
      expect(r.refused).toEqual([{ actionId: "A2", reason: "lane off" }]);
      expect(r.applied.map((x: any) => x.actionId)).toEqual(["A1"]);
      expect(await field(W4, "claudeMd")).toContain("- rule three");
      expect(await memCount("dream-test-mem-off")).toBe(0);
      expect(await getKv(NS, "preimage:apply-mem-off:A1")).not.toBeNull();
      await updateAgentProfile(W4, { claudeMd: CLAUDE_SMALL });
    },
    60_000,
  );
});

describe("dream-trim", () => {
  spawnTest(
    "plan with lanes.trim=false returns no targets and writes no pre-image",
    async () => {
      const r = await run("dream-trim", {
        mode: "plan",
        runId: "trim-off",
        lanes: { trim: false },
      });
      expect(r.ok).toBe(true);
      expect(r.targets).toEqual([]);
      expect(r.skipReason).toBe("lane off");
      expect(await countKv("preimage:trim-off:")).toBe(0);
    },
    60_000,
  );

  spawnTest(
    "plan honours caps.trims, writes a pre-image per target, never targets toolsMd",
    async () => {
      const one = await run("dream-trim", { mode: "plan", runId: "trim-cap1", caps: { trims: 1 } });
      expect(one.maxTrims).toBe(1);
      expect(one.targets).toHaveLength(1);
      const zero = await run("dream-trim", {
        mode: "plan",
        runId: "trim-cap0",
        caps: JSON.stringify({ trims: 0 }),
      });
      expect(zero.targets).toEqual([]);
      expect(await countKv("preimage:trim-cap0:")).toBe(0);

      const r = await run("dream-trim", { mode: "plan", runId: "trim-plan", caps: { trims: 3 } });
      expect(r.maxTrims).toBe(3);
      expect(r.targets).toHaveLength(3);
      expect(r.targets.every((t: any) => t.field !== "toolsMd")).toBe(true);
      expect(r.targets.every((t: any) => !("backupPath" in t) && !("body" in t))).toBe(true);
      expect(await countKv("preimage:trim-plan:")).toBe(3);
      for (const t of r.targets) {
        const pre = (await getKv(NS, `preimage:trim-plan:${t.agentId}:${t.field}`))?.value as any;
        expect(pre.content).toBe(await field(t.agentId, t.field));
        expect(pre.sha).toBe(t.sha256);
        expect(typeof pre.at).toBe("string");
      }
      expect(await countKv(`preimage:trim-plan:${W1}:toolsMd`)).toBe(0);
    },
    60_000,
  );

  const draftFor = (t: any, trimmed: string) => ({
    itemKey: t.slot,
    status: "completed",
    taskOutput: JSON.stringify({ agentId: t.agentId, field: t.field, trimmed }),
  });

  spawnTest(
    "apply refuses a slot with no pre-image and a slot whose live sha changed",
    async () => {
      const live2 = await field(W2, "claudeMd");
      const live3 = await field(W3, "claudeMd");
      const target = (agentId: string, live: string, s: string) => ({
        slot: `${agentId}-claudeMd`,
        agentId,
        agentName: agentId,
        field: "claudeMd",
        sha256: s,
        targetChars: 20000,
        chars: live.length,
      });
      const t2 = target(W2, live2, await sha(live2));
      const t3 = target(W3, live3, await sha(live3));
      // W2: no pre-image under this runId. W3: a pre-image for different bytes (the field changed after it).
      await upsertKv({
        namespace: NS,
        key: `preimage:trim-guard:${W3}:claudeMd`,
        value: {
          content: "older text",
          sha: await sha("older text"),
          at: new Date().toISOString(),
        },
        valueType: "json",
      });
      const r = await run("dream-trim", {
        mode: "apply",
        runId: "trim-guard",
        plan: { targets: [t2, t3] },
        drafts: [draftFor(t2, trimmedClaude("w2")), draftFor(t3, trimmedClaude("w3"))],
      });
      const reasons = Object.fromEntries(r.refused.map((x: any) => [x.agentId, x.reason]));
      expect(reasons[W2]).toBe("no pre-image for this slot");
      expect(reasons[W3]).toMatch(/^live sha differs from pre-image/);
      expect(r.applied).toEqual([]);
      expect(await field(W2, "claudeMd")).toBe(live2);
      expect(await field(W3, "claudeMd")).toBe(live3);

      // A field edited after plan mode is refused too.
      const plan = await run("dream-trim", {
        mode: "plan",
        runId: "trim-drift",
        caps: { trims: 3 },
      });
      const tw2 = plan.targets.find((t: any) => t.agentId === W2);
      await updateAgentProfile(W2, { claudeMd: `${live2}- edited after plan\n` });
      const r2 = await run("dream-trim", {
        mode: "apply",
        runId: "trim-drift",
        plan: { targets: [tw2] },
        drafts: [draftFor(tw2, trimmedClaude("w2"))],
      });
      expect(r2.applied).toEqual([]);
      expect(r2.refused[0].reason).toMatch(/changed since plan|differs from pre-image/);
      await updateAgentProfile(W2, { claudeMd: live2 });
    },
    90_000,
  );
});

describe("dream-rollback", () => {
  spawnTest(
    "restores a trimmed profile field from its KV pre-image",
    async () => {
      const before = await field(W1, "claudeMd");
      const plan = await run("dream-trim", {
        mode: "plan",
        runId: "trim-live",
        caps: { trims: 3 },
      });
      const t = plan.targets.find((x: any) => x.agentId === W1);
      expect(t).toBeDefined();
      const applied = await run("dream-trim", {
        mode: "apply",
        runId: "trim-live",
        plan: { targets: [t] },
        drafts: [draftFor(t, trimmedClaude("w1"))],
      });
      expect(applied.refused).toEqual([]);
      expect(applied.applied).toHaveLength(1);
      expect(await field(W1, "claudeMd")).toBe(trimmedClaude("w1"));

      const dry = await run("dream-rollback", { runId: "trim-live", dryRun: true });
      expect(dry.planned.map((x: any) => [x.agentId, x.field])).toEqual([[W1, "claudeMd"]]);
      expect(await field(W1, "claudeMd")).toBe(trimmedClaude("w1"));

      const rb = await run("dream-rollback", { runId: "trim-live" });
      expect(rb.failed).toEqual([]);
      expect(rb.restored.map((x: any) => [x.agentId, x.field])).toEqual([[W1, "claudeMd"]]);
      expect(await field(W1, "claudeMd")).toBe(before);
      expect(((await getKv(NS, `trim-state:${W1}:claudeMd`))?.value as any)?.revertedRunId).toBe(
        "trim-live",
      );
    },
    120_000,
  );

  function draftFor(t: any, trimmed: string) {
    return {
      itemKey: t.slot,
      status: "completed",
      taskOutput: JSON.stringify({ agentId: t.agentId, field: t.field, trimmed }),
    };
  }
});
