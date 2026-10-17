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
import heartbeatDefault, { checkDraft } from "../be/seed-scripts/catalog/dream-heartbeat";
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

/** The spawned server's URL; `base` is shadowed inside the closed-pin describe. */
const serverUrl = () => base;
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

describe("dream-heartbeat closed-pin drain", () => {
  const CLOSED_PIN = "📌 **Old migration GONE: retired 10-01** keep the rollback notes for audits";
  const OPEN_PIN = "📌 Keep the release checklist current";
  const PIN_HB = [
    "# Lead heartbeat",
    "",
    "## Standing Orders",
    "- Check the task queue every heartbeat.",
    "- 📌 Never skip the morning sweep",
    "",
    "## Tracked Items",
    `- ${CLOSED_PIN}`,
    `- ${OPEN_PIN}`,
    "- **Docs refresh:** refresh the operator docs for the new flags. DELETE 12-30",
    "",
  ].join("\n");
  const DRAINED_HB = PIN_HB.replace(`- ${CLOSED_PIN}\n`, "");
  const pinRemoved = (memory?: string) => [
    {
      probe: CLOSED_PIN.slice(0, 80),
      reason: "closed",
      movedTo: "memory",
      ...(memory ? { memory } : {}),
    },
  ];
  const base = (extra: { pinMemories?: string[]; lockedPins?: string[] } = {}) => ({
    live: PIN_HB,
    deferred: [],
    mustKeep: [],
    maxChars: 60000,
    ...extra,
  });

  test("selftest is ok, including the pin drain controls", async () => {
    const r = await run("dream-heartbeat", { mode: "selftest" });
    expect(r.pinChecks?.length).toBeGreaterThan(0);
    expect(r.pinChecks.filter((x: any) => !x.pass)).toEqual([]);
    expect(r.pinParse.every((x: any) => x.pass)).toBe(true);
    expect(r.ok).toBe(true);
  }, 60_000);

  test("checkDraft lets a Tracked Items pin leave only unlocked, with a known memory", () => {
    const known = { pinMemories: ["hb-pin-old-migration"] };
    expect(
      checkDraft({
        ...base(known),
        next: DRAINED_HB,
        removed: pinRemoved("hb-pin-old-migration"),
      }),
    ).toEqual([]);
    // Unknown memory, no memory at all, or a plan lock: refused.
    expect(
      checkDraft({ ...base({ pinMemories: [] }), next: DRAINED_HB, removed: pinRemoved("x-y-z") }),
    ).not.toEqual([]);
    expect(checkDraft({ ...base(known), next: DRAINED_HB, removed: pinRemoved() })).not.toEqual([]);
    expect(
      checkDraft({
        ...base({ ...known, lockedPins: [CLOSED_PIN.slice(0, 40)] }),
        next: DRAINED_HB,
        removed: pinRemoved("hb-pin-old-migration"),
      }),
    ).not.toEqual([]);
    // A 📌 outside Tracked Items stays locked even with a known memory.
    const soDropped = PIN_HB.replace("- 📌 Never skip the morning sweep\n", "");
    const reasons = checkDraft({
      ...base({ pinMemories: ["hb-pin-sweep"] }),
      next: soDropped,
      removed: [
        { probe: "📌 Never skip the morning sweep", reason: "closed", memory: "hb-pin-sweep" },
      ],
    });
    expect(reasons.some((r) => r.startsWith("📌 lines changed or dropped"))).toBe(true);
  });

  test("plan lists drain candidates; apply stores the pin memory before the DB write", async () => {
    const before = await leadHeartbeat();
    await setLeadHeartbeat(PIN_HB);
    try {
      const runId = "hb-pin-live";
      const plan = await run("dream-heartbeat", { mode: "plan", runId, leadId, dryRun: false });
      expect(plan.pinDrain).toMatchObject({ cap: 12, candidates: 2, unlocked: 2, closedHead: 1 });
      expect(plan.pinDrain.drainable).toBe(1);
      expect(plan.lockedPins).toEqual([]);
      // Closed heads sort first.
      expect(plan.candidates.pins[0].probe).toBe(CLOSED_PIN.slice(0, 80));
      expect(plan.candidates.pins[0].closedHead).toBe(true);

      const memName = `hb-pin-old-migration-${Date.now()}`;
      const hd = {
        draft: DRAINED_HB,
        removed: pinRemoved(memName),
        movedToMemory: [
          { name: memName, content: `Drained from Lead HEARTBEAT Tracked Items.\n${CLOSED_PIN}` },
        ],
        keptPins: [OPEN_PIN],
      };
      // Without the harvested memory the drained pin is refused.
      const refusedCheck = await run("dream-heartbeat", {
        mode: "check",
        runId: "hb-pin-dry",
        leadId,
        dryRun: true,
        plan,
        hd: { ...hd, movedToMemory: [] },
      });
      expect(refusedCheck.ready).toBe(false);
      expect(refusedCheck.reasons.join(" ")).toContain("📌 lines changed or dropped");

      const check = await run("dream-heartbeat", {
        mode: "check",
        runId,
        leadId,
        dryRun: false,
        waitMs: 0,
        plan,
        hd,
      });
      expect(check.reasons).toEqual([]);
      expect(check.stats).toMatchObject({ pinsDrained: 1, pinMemories: 1 });
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
      const applyArgs = { mode: "apply", runId, leadId, dryRun: false, plan, check, disk };

      // A removed[] entry naming a memory that neither exists nor gets stored: refused, DB untouched.
      const missing = await run("dream-heartbeat", {
        ...applyArgs,
        draft: { removed: pinRemoved("hb-pin-never-stored"), movedToMemory: [] },
      });
      expect(missing.status).toBe("refused: pin-memory-missing");
      expect(missing.missingPin).toEqual(["hb-pin-never-stored"]);
      expect(await leadHeartbeat()).toBe(PIN_HB);

      const applied = await run("dream-heartbeat", { ...applyArgs, draft: hd });
      expect(applied.errors).toEqual([]);
      expect(applied.status).toBe("applied");
      expect(applied.memories).toEqual([
        { name: memName, id: expect.any(String), status: "stored" },
      ]);
      expect(await leadHeartbeat()).toBe(DRAINED_HB);
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try {
        const row = db
          .query("SELECT content, tags FROM agent_memory WHERE name = ? LIMIT 1")
          .get(memName) as any;
        expect(String(row?.content ?? "")).toContain(CLOSED_PIN);
        expect(String(row?.tags ?? "")).toContain("heartbeat-pin");
      } finally {
        db.close();
      }
      expect((await kvGet("hb-state:lead")).keptPins).toEqual([OPEN_PIN]);

      // The kept pin sits out: it no longer counts, and the drained pin is gone.
      const next = await run("dream-heartbeat", { mode: "plan", runId: "hb-pin-next", leadId });
      expect(next.pinDrain).toMatchObject({ candidates: 1, drainable: 0 });
      expect(next.candidates.pins[0].kept).toBe(true);
    } finally {
      await setLeadHeartbeat(before);
    }
  }, 180_000);

  const REFUSED = {
    success: true,
    status: 200,
    data: { success: false, message: "injected refusal" },
  };

  /** dream-heartbeat in-process on the real SDK; each listed memory tool returns a tool refusal. */
  function runRefusing(tools: Array<"memory_edit" | "memory_store">, args: unknown): Promise<any> {
    const swarm: any = createSwarmSdk(
      new SwarmConfig({
        system: {
          apiKey: { value: API_KEY, isSecret: true },
          agentId: { value: leadId, isSecret: false },
          mcpBaseUrl: { value: serverUrl(), isSecret: false },
        },
        user: {},
      }),
    );
    const faulty = new Proxy(swarm, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        return (tools as string[]).includes(String(prop)) ? async () => REFUSED : v;
      },
    });
    return heartbeatDefault(args, { swarm: faulty } as any);
  }

  /** Index a swarm memory straight through the API and return its id. */
  async function seedMemory(name: string, content: string, source = "manual"): Promise<string> {
    const res = await fetch(`${serverUrl()}/api/memory/index`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name, content, scope: "swarm", source }),
    });
    expect(res.status).toBe(202);
    const body: any = await res.json();
    expect(body.memoryIds?.length).toBe(1);
    return String(body.memoryIds[0]);
  }

  function memoryRows(where: string, param: string): any[] {
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      return db
        .query(`SELECT id, name, content, expiresAt FROM agent_memory WHERE ${where}`)
        .all(param) as any[];
    } finally {
      db.close();
    }
  }

  /** Live plan + check for PIN_HB with draft `hd`; returns the apply args. */
  async function liveApplyArgs(runId: string, hd: Record<string, unknown>) {
    const plan = await run("dream-heartbeat", { mode: "plan", runId, leadId, dryRun: false });
    const check = await run("dream-heartbeat", {
      mode: "check",
      runId,
      leadId,
      dryRun: false,
      waitMs: 0,
      plan,
      hd,
    });
    expect(check.reasons).toEqual([]);
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
    return { mode: "apply", runId, leadId, dryRun: false, plan, check, disk, draft: hd };
  }

  test("a refused memory_edit or sibling memory_store keeps the pin", async () => {
    const before = await leadHeartbeat();
    await setLeadHeartbeat(PIN_HB);
    try {
      const target = `hb-pin-refusal-${Date.now()}`;
      const targetId = await seedMemory(target, "Old migration notes.");
      const text = `Drained from Lead HEARTBEAT Tracked Items.\n${CLOSED_PIN}`;
      const hd = {
        draft: DRAINED_HB,
        removed: pinRemoved(target),
        movedToMemory: [{ name: target, content: text }],
      };

      // Edit and sibling store both refused: nothing holds the text, so the pin stays.
      const both = await runRefusing(
        ["memory_edit", "memory_store"],
        await liveApplyArgs("hb-pin-refuse-both", hd),
      );
      expect(both.status).toBe("refused: pin-memory-missing");
      expect(both.missingPin).toEqual([target]);
      expect(both.memories).toEqual([{ name: target, status: "failed" }]);
      expect(await leadHeartbeat()).toBe(PIN_HB);
      expect(memoryRows("id = ?", targetId)[0].content).toBe("Old migration notes.");

      // Edit refused: the sibling store carries the text, and only then the pin leaves.
      const editOnly = await runRefusing(
        ["memory_edit"],
        await liveApplyArgs("hb-pin-refuse-edit", hd),
      );
      expect(editOnly.status).toBe("applied");
      expect(editOnly.memories[0]).toMatchObject({ status: "stored-sibling", target: targetId });
      expect(editOnly.errors.join(" ")).toContain("injected refusal");
      const sibling = memoryRows("id = ?", editOnly.memories[0].id)[0];
      expect(String(sibling.content)).toContain(CLOSED_PIN);
      expect(await leadHeartbeat()).toBe(DRAINED_HB);
    } finally {
      await setLeadHeartbeat(before);
    }
  }, 180_000);

  test("updateOf a differently named memory appends there and applies", async () => {
    const before = await leadHeartbeat();
    await setLeadHeartbeat(PIN_HB);
    try {
      const anchor = `hb-pin-anchor-${Date.now()}`;
      const anchorId = await seedMemory(anchor, "Migration runbook.");
      const entry = `hb-pin-new-name-${Date.now()}`;
      const hd = {
        draft: DRAINED_HB,
        removed: pinRemoved(entry),
        movedToMemory: [{ name: entry, updateOf: anchor, content: `Closed pin.\n${CLOSED_PIN}` }],
      };
      const applied = await run("dream-heartbeat", await liveApplyArgs("hb-pin-update-of", hd));
      expect(applied.errors).toEqual([]);
      expect(applied.status).toBe("applied");
      expect(applied.memories).toEqual([{ name: entry, id: anchorId, status: "updated" }]);
      expect(String(memoryRows("id = ?", anchorId)[0].content)).toContain(CLOSED_PIN);
      expect(memoryRows("name = ?", entry)).toEqual([]);
      expect(await leadHeartbeat()).toBe(DRAINED_HB);
    } finally {
      await setLeadHeartbeat(before);
    }
  }, 180_000);

  test("a reused expiring memory gets a durable copy before the pin leaves", async () => {
    const before = await leadHeartbeat();
    await setLeadHeartbeat(PIN_HB);
    try {
      const reused = `hb-pin-expiring-${Date.now()}`;
      const reusedId = await seedMemory(reused, `Task result.\n${CLOSED_PIN}`, "task_completion");
      expect(memoryRows("id = ?", reusedId)[0].expiresAt).not.toBeNull();
      const hd = { draft: DRAINED_HB, removed: pinRemoved(reused), movedToMemory: [] };
      const applied = await run("dream-heartbeat", await liveApplyArgs("hb-pin-expiring", hd));
      expect(applied.errors).toEqual([]);
      expect(applied.status).toBe("applied");
      const copy = applied.memories.find((m: any) => m.status === "stored-durable-copy");
      expect(copy).toMatchObject({ name: reused, from: reusedId });
      const row = memoryRows("id = ?", copy.id)[0];
      expect(row.expiresAt).toBeNull();
      expect(String(row.content)).toContain(CLOSED_PIN);
      expect(await leadHeartbeat()).toBe(DRAINED_HB);
    } finally {
      await setLeadHeartbeat(before);
    }
  }, 180_000);

  test("a memory sharing only the first 200 characters is not proof: the tail lands before the pin leaves", async () => {
    const before = await leadHeartbeat();
    await setLeadHeartbeat(PIN_HB);
    try {
      const name = `hb-pin-prefix-${Date.now()}`;
      const prefix = `Drained from Lead HEARTBEAT Tracked Items. ${"The rollback notes for the old migration live in the ops runbook. ".repeat(4)}`;
      expect(prefix.length).toBeGreaterThan(200);
      const id = await seedMemory(name, `${prefix}\nDecision: keep the 10-01 snapshot.`);
      const tail = "Decision: drop the 10-01 snapshot after the 12-01 audit.";
      const hd = {
        draft: DRAINED_HB,
        removed: pinRemoved(name),
        movedToMemory: [{ name, content: `${prefix}\n${CLOSED_PIN}\n${tail}` }],
      };

      // Nothing can write the tail: the shared prefix does not count, so the pin stays.
      const refused = await runRefusing(
        ["memory_edit", "memory_store"],
        await liveApplyArgs("hb-pin-prefix-refused", hd),
      );
      expect(refused.status).toBe("refused: pin-memory-missing");
      expect(refused.missingPin).toEqual([name]);
      expect(await leadHeartbeat()).toBe(PIN_HB);

      const applied = await run("dream-heartbeat", await liveApplyArgs("hb-pin-prefix", hd));
      expect(applied.errors).toEqual([]);
      expect(applied.status).toBe("applied");
      expect(applied.memories).toEqual([{ name, id, status: "updated" }]);
      const content = String(memoryRows("id = ?", id)[0].content);
      expect(content).toContain(tail);
      expect(content).toContain(CLOSED_PIN);
      expect(await leadHeartbeat()).toBe(DRAINED_HB);
    } finally {
      await setLeadHeartbeat(before);
    }
  }, 180_000);

  test("a memory differing only in a sign is not proof: the changed fact lands or the pin stays", async () => {
    const before = await leadHeartbeat();
    await setLeadHeartbeat(PIN_HB);
    try {
      const name = `hb-pin-sign-${Date.now()}`;
      // Every harvested line is already there except for the sign.
      const id = await seedMemory(
        name,
        `Rollback notes for the old migration.\n${CLOSED_PIN}\nUse offset +1 for the rollback.`,
      );
      const changed = "Use offset -1 for the rollback.";
      const hd = {
        draft: DRAINED_HB,
        removed: pinRemoved(name),
        movedToMemory: [
          { name, content: `Rollback notes for the old migration.\n${CLOSED_PIN}\n${changed}` },
        ],
      };

      // Nothing can write the changed fact: "+1" does not hold "-1", so the pin stays.
      const refused = await runRefusing(
        ["memory_edit", "memory_store"],
        await liveApplyArgs("hb-pin-sign-refused", hd),
      );
      expect(refused.status).toBe("refused: pin-memory-missing");
      expect(refused.missingPin).toEqual([name]);
      expect(await leadHeartbeat()).toBe(PIN_HB);

      const applied = await run("dream-heartbeat", await liveApplyArgs("hb-pin-sign", hd));
      expect(applied.errors).toEqual([]);
      expect(applied.status).toBe("applied");
      expect(applied.memories).toEqual([{ name, id, status: "updated" }]);
      expect(String(memoryRows("id = ?", id)[0].content)).toContain(changed);
      expect(await leadHeartbeat()).toBe(DRAINED_HB);
    } finally {
      await setLeadHeartbeat(before);
    }
  }, 180_000);

  test("a negated line is not proof of the affirmative fact: the fact lands or the pin stays", async () => {
    const before = await leadHeartbeat();
    await setLeadHeartbeat(PIN_HB);
    try {
      const name = `hb-pin-negation-${Date.now()}`;
      // The affirmative fact is a substring of the negated line, but not a line of its own.
      const seeded = `Rollback notes for the old migration.\n${CLOSED_PIN}\nNever use offset -1 for the rollback.`;
      const id = await seedMemory(name, seeded);
      const affirmative = "Use offset -1 for the rollback.";
      const hd = {
        draft: DRAINED_HB,
        removed: pinRemoved(name),
        movedToMemory: [
          { name, content: `Rollback notes for the old migration.\n${CLOSED_PIN}\n${affirmative}` },
        ],
      };

      const refused = await runRefusing(
        ["memory_edit", "memory_store"],
        await liveApplyArgs("hb-pin-negation-refused", hd),
      );
      expect(refused.status).toBe("refused: pin-memory-missing");
      expect(refused.missingPin).toEqual([name]);
      expect(refused.memories.map((m: any) => m.status)).not.toContain("exists: already holds it");
      expect(String(memoryRows("id = ?", id)[0].content)).toBe(seeded);
      expect(await leadHeartbeat()).toBe(PIN_HB);

      const applied = await run("dream-heartbeat", await liveApplyArgs("hb-pin-negation", hd));
      expect(applied.errors).toEqual([]);
      expect(applied.status).toBe("applied");
      expect(applied.memories).toEqual([{ name, id, status: "updated" }]);
      expect(String(memoryRows("id = ?", id)[0].content).split("\n")).toContain(affirmative);
      expect(await leadHeartbeat()).toBe(DRAINED_HB);
    } finally {
      await setLeadHeartbeat(before);
    }
  }, 180_000);

  test("a reused auto-key multi-chunk expiring memory is copied whole, including chunk 2", async () => {
    const before = await leadHeartbeat();
    await setLeadHeartbeat(PIN_HB);
    try {
      const reused = `hb-pin-chunks-${Date.now()}`;
      const content = [
        "## Background",
        "The old migration moved the task tables to the new layout. ".repeat(20).trim(),
        "",
        "## Outcome",
        "The rollout finished and the dashboards stayed green for a week. ".repeat(14).trim(),
        CLOSED_PIN,
      ].join("\n");
      const res = await fetch(`${serverUrl()}/api/memory/index`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ name: reused, content, scope: "swarm", source: "task_completion" }),
      });
      expect(res.status).toBe(202);
      // Two chunks, each with its own auto key; only chunk 2 holds the pin, and chunk 1 alone fits one row.
      const chunks = memoryRows("name = ? ORDER BY chunkIndex", reused);
      expect(chunks.length).toBe(2);
      expect(String(chunks[0].content)).not.toContain(CLOSED_PIN);
      expect(String(chunks[0].content).length).toBeLessThan(1800);
      expect(String(chunks[1].content)).toContain(CLOSED_PIN);
      expect(chunks.every((c) => c.expiresAt != null)).toBe(true);
      const keys = new Database(TEST_DB_PATH, { readonly: true });
      try {
        const k = keys.query("SELECT DISTINCT key FROM agent_memory WHERE name = ?").all(reused);
        expect(k.length).toBe(2);
      } finally {
        keys.close();
      }

      const hd = { draft: DRAINED_HB, removed: pinRemoved(reused), movedToMemory: [] };
      const applied = await run("dream-heartbeat", await liveApplyArgs("hb-pin-chunks", hd));
      expect(applied.errors).toEqual([]);
      expect(applied.status).toBe("applied");
      const copy = applied.memories.find((m: any) => m.status === "stored-durable-copy");
      expect(copy).toMatchObject({ name: reused, from: String(chunks[0].id) });
      const copyRows = memoryRows("name = ? ORDER BY chunkIndex", `${reused}-durable`);
      expect(copyRows.length).toBeGreaterThan(0);
      expect(copyRows.every((r) => r.expiresAt == null)).toBe(true);
      expect(copyRows.map((r) => String(r.content)).join("\n")).toContain(CLOSED_PIN);
      expect(await leadHeartbeat()).toBe(DRAINED_HB);
    } finally {
      await setLeadHeartbeat(before);
    }
  }, 180_000);

  test("a long harvested line that the chunker splits across chunks still re-reads", async () => {
    const before = await leadHeartbeat();
    await setLeadHeartbeat(PIN_HB);
    try {
      const name = `hb-pin-long-${Date.now()}`;
      const long =
        "The rollback of the old migration needs the snapshot and the audit trail. ".repeat(40);
      const hd = {
        draft: DRAINED_HB,
        removed: pinRemoved(name),
        movedToMemory: [{ name, content: `Closed pin.\n${long}\n${CLOSED_PIN}` }],
      };
      const applied = await run("dream-heartbeat", await liveApplyArgs("hb-pin-long", hd));
      expect(applied.errors).toEqual([]);
      expect(applied.status).toBe("applied");
      expect(memoryRows("name = ?", name).length).toBeGreaterThan(1);
      expect(await leadHeartbeat()).toBe(DRAINED_HB);
    } finally {
      await setLeadHeartbeat(before);
    }
  }, 180_000);
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
