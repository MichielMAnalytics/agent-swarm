/**
 * dream-heartbeat + dream-verify: run the seeded sources through the script runtime against a
 * spawned API server on an isolated temp DB (never the live one).
 *
 * The runtime path is `runScript` (sandboxed subprocess). When the pre-push hook marks sandbox
 * spawns unavailable (SWARM_SKIP_SANDBOX_SPAWN_TESTS=1), the same default export runs in-process
 * with the real script SDK, so every ctx.swarm call still goes over HTTP to the spawned server.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { Subprocess } from "bun";
import { closeDb, initDb } from "../be/db";
import { typecheckScript } from "../be/scripts/typecheck";
import heartbeatDefault from "../be/seed-scripts/catalog/dream-heartbeat";
import verifyDefault, {
  isGreenDryRun,
  isProfilePreimageKey,
} from "../be/seed-scripts/catalog/dream-verify";
import { validateScriptImports } from "../scripts-runtime/import-allowlist";
import { runScript } from "../scripts-runtime/loader";
import { SwarmConfig } from "../scripts-runtime/swarm-config";
import { createSwarmSdk } from "../scripts-runtime/swarm-sdk";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";
import { getFreePort, SERVER_BOOT_HOOK_TIMEOUT_MS, waitForServer } from "./test-net";

const ROOT = `${import.meta.dir}/../..`;
const CATALOG = `${ROOT}/src/be/seed-scripts/catalog`;
const TEST_DB_PATH = `/tmp/test-dream-scripts-verify-${Date.now()}-${process.pid}.sqlite`;
const API_KEY = "example-test-dream-scripts-verify-key";
const NS = "dreaming";
const leadId = crypto.randomUUID();

let base = "";
let serverProc: Subprocess | undefined;
let savedApiKey: string | undefined;
const sources: Record<string, string> = {};
const defaults: Record<string, (args: unknown, ctx: any) => Promise<any>> = {
  "dream-heartbeat": heartbeatDefault as any,
  "dream-verify": verifyDefault as any,
};

const LIVE_HB = [
  "# Lead heartbeat",
  "",
  "## Standing Orders",
  "- Check the task queue every heartbeat.",
  "",
  "## Tracked Items",
  "- 📌 Keep the release checklist current",
  "- **Old rollout:** watch the rollout dashboard and close it out. DELETE 10-01",
  "- **Docs refresh:** refresh the operator docs for the new flags. DELETE 12-30",
  "",
].join("\n");
const DRAFT_HB = LIVE_HB.replace(
  "- **Old rollout:** watch the rollout dashboard and close it out. DELETE 10-01\n",
  "",
);
const REMOVED = [
  { title: "Old rollout:", probe: "**Old rollout:**", reason: "due", movedTo: "none" },
];

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const headers = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${API_KEY}`,
  "X-Agent-ID": leadId,
});
const kvUrl = (key: string) =>
  `${base}/api/kv/_/${encodeURIComponent(NS)}/${encodeURIComponent(key)}`;

async function kvGet(key: string): Promise<any> {
  const res = await fetch(kvUrl(key), { headers: headers() });
  if (res.status === 404) return null;
  const body: any = await res.json();
  const v = body?.value;
  if (typeof v === "string" && v.trim().startsWith("{")) return JSON.parse(v);
  return v ?? null;
}
async function kvPut(key: string, value: unknown): Promise<void> {
  const res = await fetch(kvUrl(key), {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ value }),
  });
  expect(res.ok).toBe(true);
}
async function kvDelete(key: string): Promise<void> {
  await fetch(kvUrl(key), { method: "DELETE", headers: headers() });
}
async function kvKeys(prefix: string): Promise<string[]> {
  const res = await fetch(
    `${base}/api/kv/_/${encodeURIComponent(NS)}?prefix=${encodeURIComponent(prefix)}&limit=50`,
    { headers: headers() },
  );
  const body: any = await res.json();
  return (body?.entries ?? []).map((e: any) => String(e.key));
}
async function leadHeartbeat(): Promise<string> {
  const res = await fetch(`${base}/api/agents/${leadId}`, { headers: headers() });
  const body: any = await res.json();
  return String(body?.heartbeatMd ?? body?.agent?.heartbeatMd ?? "");
}
async function setLeadHeartbeat(text: string): Promise<void> {
  const res = await fetch(`${base}/api/agents/${leadId}/profile`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ heartbeatMd: text }),
  });
  expect(res.status).toBe(200);
}

/** Run a catalog script as the Lead through the script runtime. */
async function run(name: "dream-heartbeat" | "dream-verify", args: unknown): Promise<any> {
  if (SKIP_SANDBOX_SPAWN_TESTS) {
    const swarm = createSwarmSdk(
      new SwarmConfig({
        system: {
          apiKey: { value: API_KEY, isSecret: true },
          agentId: { value: leadId, isSecret: false },
          mcpBaseUrl: { value: base, isSecret: false },
        },
        user: {},
      }),
    );
    return defaults[name](args, { swarm });
  }
  const out = await runScript({
    source: sources[name],
    args,
    agentId: leadId,
    mcpBaseUrl: base,
    timeoutMs: 60_000,
  });
  if (out.error) throw new Error(`${name} ${out.error}: ${out.stderr.slice(0, 500)}`);
  return out.result;
}

/** Run dream-verify in-process on the real SDK, failing every db_query whose SQL contains `failSql`. */
async function runWithFailingQuery(failSql: string | null, args: unknown): Promise<any> {
  const swarm: any = createSwarmSdk(
    new SwarmConfig({
      system: {
        apiKey: { value: API_KEY, isSecret: true },
        agentId: { value: leadId, isSecret: false },
        mcpBaseUrl: { value: base, isSecret: false },
      },
      user: {},
    }),
  );
  const faulty = new Proxy(swarm, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop !== "db_query" || !failSql) return v;
      return async (q: { sql: string; params?: unknown[] }) => {
        if (q.sql.includes(failSql)) throw new Error("injected read failure");
        return v.call(target, q);
      };
    },
  });
  return verifyDefault(args, { swarm: faulty } as any);
}

/** Seed workflow_run_steps rows for `runId` straight into the spawned server's DB (FKs off). */
function insertSteps(runId: string, steps: Array<{ nodeId: string; status: string }>): void {
  const db = new Database(TEST_DB_PATH);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const ins = db.prepare(
      "INSERT INTO workflow_run_steps (id, runId, nodeId, nodeType, status, startedAt, finishedAt) VALUES (?, ?, ?, 'script', ?, ?, ?)",
    );
    for (const s of steps) {
      const at = new Date().toISOString();
      ins.run(crypto.randomUUID(), runId, s.nodeId, s.status, at, at);
    }
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  for (const n of ["dream-heartbeat", "dream-verify"]) {
    sources[n] = await Bun.file(`${CATALOG}/${n}.ts`).text();
  }
  // In-process DB for the typecheck path only; the scripts talk to the spawned server's DB.
  initDb(":memory:");
  savedApiKey = process.env.AGENT_SWARM_API_KEY;
  process.env.AGENT_SWARM_API_KEY = API_KEY;

  const port = await getFreePort();
  base = `http://127.0.0.1:${port}`;
  serverProc = Bun.spawn(["bun", "src/http.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: TEST_DB_PATH,
      AGENT_SWARM_API_KEY: API_KEY,
      API_KEY,
      MCP_BASE_URL: base,
      CAPABILITIES: "core,task-pool,messaging,profiles,services,scheduling,memory,kv",
      SLACK_DISABLE: "true",
      GITHUB_DISABLE: "true",
      JIRA_DISABLE: "true",
      LINEAR_DISABLE: "true",
      SLACK_BOT_TOKEN: "",
      GITHUB_WEBHOOK_SECRET: "",
      AGENTMAIL_API_KEY: "",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForServer(`${base}/health`);

  const reg = await fetch(`${base}/api/agents`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ name: "DreamLead", isLead: true, role: "lead", maxTasks: 1 }),
  });
  if (reg.status !== 200 && reg.status !== 201) {
    throw new Error(`register lead: ${reg.status} ${await reg.text()}`);
  }
  await setLeadHeartbeat(LIVE_HB);
}, SERVER_BOOT_HOOK_TIMEOUT_MS);

afterAll(async () => {
  if (serverProc) {
    serverProc.kill();
    await serverProc.exited.catch(() => {});
  }
  closeDb();
  if (savedApiKey === undefined) delete process.env.AGENT_SWARM_API_KEY;
  else process.env.AGENT_SWARM_API_KEY = savedApiKey;
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
});

describe("dream scripts pass the script_upsert gates", () => {
  test("import allowlist and typecheck", async () => {
    for (const n of ["dream-heartbeat", "dream-verify"]) {
      const imports = validateScriptImports(sources[n]);
      expect(imports.ok).toBe(true);
      const tc = await typecheckScript(sources[n]);
      if (!tc.ok) throw new Error(`${n}: ${tc.diagnostics.join(" | ")}`);
    }
  }, 120_000);
});

describe("dream-heartbeat", () => {
  test("plan with lanes.heartbeat=false returns skipReason lane off", async () => {
    const r = await run("dream-heartbeat", {
      mode: "plan",
      runId: "hb-lane-off",
      leadId,
      dryRun: true,
      lanes: { heartbeat: false, trim: true, identity: true, memory: true },
    });
    expect(r).toMatchObject({ ok: true, skipReason: "lane off" });
    expect(r.candidates.remove).toEqual([]);
  }, 60_000);

  test("check stores the draft at KV hb-draft:<runId> with its sha; dryRun writes nothing", async () => {
    const runId = "hb-dry";
    const plan = await run("dream-heartbeat", { mode: "plan", runId, leadId, dryRun: true });
    expect(plan.ok).toBe(true);
    expect(plan.planSha).toBe(sha256(LIVE_HB));
    expect(plan.preimageKey).toBeNull();

    const check = await run("dream-heartbeat", {
      mode: "check",
      runId,
      leadId,
      dryRun: true,
      plan,
      hd: { draft: DRAFT_HB, removed: REMOVED, notes: "dropped one due item" },
    });
    expect(check.reasons).toEqual([]);
    expect(check.ready).toBe(true);
    expect(check.diskMode).toBe("dry");
    expect(check.draftSha).toBe(sha256(DRAFT_HB));
    expect(check.draftKey).toBe(`hb-draft:${runId}`);
    const stored = await kvGet(`hb-draft:${runId}`);
    expect(stored.text).toBe(DRAFT_HB);
    expect(stored.sha).toBe(sha256(DRAFT_HB));
    expect(typeof stored.at).toBe("string");

    const apply = await run("dream-heartbeat", {
      mode: "apply",
      runId,
      leadId,
      dryRun: true,
      plan,
      check,
      draft: { draft: DRAFT_HB, removed: REMOVED },
      disk: {
        mode: "dry",
        fields: [{ field: "heartbeatMd", diskBeforeSha: plan.planSha, draftShaOk: true }],
      },
    });
    expect(apply.status).toBe("wouldApply");
    expect(apply.gate).toBe("dryRun");
    expect(await leadHeartbeat()).toBe(LIVE_HB);
    expect(await kvKeys(`preimage:${runId}:`)).toEqual([]);
    expect(await kvGet(`hb-state:${runId}`)).toBeNull();
    expect(await kvGet(`cuts:${runId}:C`)).toBeNull();
    expect(await kvGet("hb-state:lead")).toBeNull();
  }, 60_000);

  test("apply refuses a KV draft whose sha does not match, then a matching draft applies", async () => {
    const runId = "hb-live";
    const plan = await run("dream-heartbeat", { mode: "plan", runId, leadId, dryRun: false });
    expect(plan.preimageKey).toBe(`preimage:${runId}:${leadId}:heartbeatMd`);
    const pre = await kvGet(plan.preimageKey);
    expect(pre).toMatchObject({ content: LIVE_HB, sha: sha256(LIVE_HB) });

    const check = await run("dream-heartbeat", {
      mode: "check",
      runId,
      leadId,
      dryRun: false,
      waitMs: 0,
      plan,
      hd: { draft: DRAFT_HB, removed: REMOVED },
    });
    expect(check.reasons).toEqual([]);
    expect(check.diskMode).toBe("live");
    const disk = {
      mode: "live",
      fields: [
        {
          field: "heartbeatMd",
          diskBeforeSha: plan.planSha,
          draftShaOk: true,
          diskAfterSha: check.draftSha,
          stopReason: null,
        },
      ],
    };
    const applyArgs = {
      mode: "apply",
      runId,
      leadId,
      dryRun: false,
      plan,
      check,
      disk,
      draft: { removed: REMOVED },
    };

    // Tampered KV draft: the text no longer hashes to the stored sha.
    await kvPut(`hb-draft:${runId}`, {
      text: `${DRAFT_HB}- extra line\n`,
      sha: check.draftSha,
      at: "x",
    });
    const tampered = await run("dream-heartbeat", applyArgs);
    expect(tampered.ok).toBe(false);
    expect(tampered.status).toBe("refused: draft-sha-mismatch");
    expect(await leadHeartbeat()).toBe(LIVE_HB);

    // A consistent KV draft that is not the one hb-check validated.
    const other = DRAFT_HB.replace("Check the task queue", "Check the queue");
    await kvPut(`hb-draft:${runId}`, { text: other, sha: sha256(other), at: "x" });
    const swapped = await run("dream-heartbeat", applyArgs);
    expect(swapped.status).toBe("refused: draft-sha-mismatch");
    expect(await leadHeartbeat()).toBe(LIVE_HB);
    expect(await kvGet(`hb-state:${runId}`)).toBeNull();

    // Positive control: the validated draft applies and lands byte-exact.
    await kvPut(`hb-draft:${runId}`, { text: DRAFT_HB, sha: check.draftSha, at: "x" });
    const applied = await run("dream-heartbeat", applyArgs);
    expect(applied.errors).toEqual([]);
    expect(applied.status).toBe("applied");
    expect(await leadHeartbeat()).toBe(DRAFT_HB);
    const state = await kvGet(`hb-state:${runId}`);
    expect(state).toMatchObject({
      beforeSha: sha256(LIVE_HB),
      afterSha: sha256(DRAFT_HB),
      preimageKey: plan.preimageKey,
    });
    const cuts = await kvGet(`cuts:${runId}:C`);
    expect(cuts.cuts[0].backupRef).toBe(plan.preimageKey);
  }, 120_000);
});

describe("dream-verify green dry run", () => {
  test("helpers: profile pre-images are exempt, the green predicate needs a clean dry run", () => {
    expect(isProfilePreimageKey("preimage:r1:agent-1:claudeMd", "r1")).toBe(true);
    expect(isProfilePreimageKey("preimage:r1:agent-1:heartbeatMd", "r1")).toBe(true);
    expect(isProfilePreimageKey("preimage:r1:action-7", "r1")).toBe(false);
    expect(isProfilePreimageKey("preimage:r2:agent-1:claudeMd", "r1")).toBe(false);
    const clean = {
      dry: true,
      replay: false,
      runId: "r",
      dryRunViolations: 0,
      claimMismatch: 0,
      controlsOk: true,
      unclaimed: 0,
      missingLanes: 0,
      failedSteps: 0,
      errors: 0,
    };
    expect(isGreenDryRun(clean)).toBe(true);
    expect(isGreenDryRun({ ...clean, dry: false })).toBe(false);
    expect(isGreenDryRun({ ...clean, dryRunViolations: 1 })).toBe(false);
    expect(isGreenDryRun({ ...clean, claimMismatch: 1 })).toBe(false);
    expect(isGreenDryRun({ ...clean, controlsOk: false })).toBe(false);
    expect(isGreenDryRun({ ...clean, replay: true })).toBe(false);
    expect(isGreenDryRun({ ...clean, unclaimed: 1 })).toBe(false);
    expect(isGreenDryRun({ ...clean, missingLanes: 1 })).toBe(false);
    expect(isGreenDryRun({ ...clean, failedSteps: 1 })).toBe(false);
    expect(isGreenDryRun({ ...clean, errors: 1 })).toBe(false);
  });

  test("a failed lane, a failed step, or a read failure leaves the marker absent", async () => {
    await kvDelete("state:last-green-dry-run");
    const since = new Date().toISOString();

    // Failed synthesis (onNodeFailure: continue still routes to verify): the step row exists, its result does not.
    insertSteps("verify-failed-synth", [{ nodeId: "synthesize", status: "failed" }]);
    const failedSynth = await run("dream-verify", {
      runId: "verify-failed-synth",
      leadId,
      dryRun: true,
      since,
    });
    expect(failedSynth.ok).toBe(false);
    expect(failedSynth.missingLanes).toContainEqual(
      expect.objectContaining({ lane: "synthesize" }),
    );
    expect(failedSynth.errors.some((e: string) => e.startsWith("lane-missing: synthesize"))).toBe(
      true,
    );
    expect(failedSynth.greenDryRun.written).toBe(false);
    expect(failedSynth.greenDryRun.reason).toContain("missingLanes 1");
    expect(await kvGet("state:last-green-dry-run")).toBeNull();

    // A step that failed outside the lane gates (no missing lane, no error) still blocks.
    insertSteps("verify-failed-step", [{ nodeId: "skills", status: "failed" }]);
    const failedStep = await run("dream-verify", {
      runId: "verify-failed-step",
      leadId,
      dryRun: true,
      since,
    });
    expect(failedStep.missingLanes).toEqual([]);
    expect(failedStep.greenDryRun.written).toBe(false);
    expect(failedStep.greenDryRun.failedSteps).toEqual(["skills:failed"]);
    expect(await kvGet("state:last-green-dry-run")).toBeNull();

    // A read failure: the real SDK over HTTP, with one db_query (the metrics step read) failing.
    const readFail = await runWithFailingQuery("FROM workflow_run_steps s", {
      runId: "verify-read-fail",
      leadId,
      dryRun: true,
      since,
    });
    expect(readFail.errors.some((e: string) => e.startsWith("steps:"))).toBe(true);
    expect(readFail.greenDryRun.written).toBe(false);
    expect(readFail.greenDryRun.reason).toContain("errors");
    expect(await kvGet("state:last-green-dry-run")).toBeNull();

    // Positive control: the same path with no fault and no failed steps writes the marker.
    const control = await runWithFailingQuery(null, {
      runId: "verify-read-ok",
      leadId,
      dryRun: true,
      since,
    });
    expect(control.errors).toEqual([]);
    expect(control.greenDryRun.written).toBe(true);
    await kvDelete("state:last-green-dry-run");
  }, 120_000);

  test("writes state:last-green-dry-run only on a clean dry run", async () => {
    await kvDelete("state:last-green-dry-run");

    // Dirty dry run: a lane claims a heartbeat write during a dry run.
    const dirty = await run("dream-verify", {
      runId: "verify-dirty",
      leadId,
      dryRun: true,
      since: new Date().toISOString(),
      hb: { status: "applied", beforeSha: "b".repeat(64), afterSha: "a".repeat(64) },
    });
    expect(dirty.dryRunViolations.length).toBeGreaterThan(0);
    expect(dirty.greenDryRun.written).toBe(false);
    expect(await kvGet("state:last-green-dry-run")).toBeNull();

    // Dirty dry run: a memory pre-image (apply wrote during a dry run) is a kv-write violation.
    await kvPut("preimage:verify-kv:action-1", { rows: [] });
    const kvDirty = await run("dream-verify", {
      runId: "verify-kv",
      leadId,
      dryRun: true,
      since: new Date().toISOString(),
    });
    expect(kvDirty.dryRunViolations).toContainEqual({
      kind: "kv-write",
      key: "preimage:verify-kv:action-1",
    });
    expect(await kvGet("state:last-green-dry-run")).toBeNull();

    // Live run: never writes the green marker, even when clean.
    const live = await run("dream-verify", {
      runId: "verify-live",
      leadId,
      dryRun: false,
      since: new Date().toISOString(),
    });
    expect(live.mode).toBe("live");
    expect(live.greenDryRun.written).toBe(false);
    expect(await kvGet("state:last-green-dry-run")).toBeNull();

    // Clean dry run, with a plan-time profile pre-image that must not count as a write.
    await kvPut(`preimage:verify-clean:${leadId}:claudeMd`, {
      content: "x",
      sha: sha256("x"),
      at: "x",
    });
    const clean = await run("dream-verify", {
      runId: "verify-clean",
      leadId,
      dryRun: true,
      since: new Date().toISOString(),
    });
    expect(clean.controls.ok).toBe(true);
    expect(clean.dryRunViolations).toEqual([]);
    expect(clean.claimMismatch).toEqual([]);
    expect(clean.stagedPreimages).toBe(1);
    expect(clean.greenDryRun.written).toBe(true);
    expect(await kvGet("state:last-green-dry-run")).toMatchObject({ runId: "verify-clean" });
  }, 120_000);
});
