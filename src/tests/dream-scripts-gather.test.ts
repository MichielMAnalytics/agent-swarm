import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, getKv, initDb, listKv, upsertKv } from "../be/db";
import { typecheckScript } from "../be/scripts/typecheck";
import dreamGather from "../be/seed-scripts/catalog/dream-gather";
import dreamLearn from "../be/seed-scripts/catalog/dream-learn";
import dreamOwners from "../be/seed-scripts/catalog/dream-owners";
import dreamReportsCheck from "../be/seed-scripts/catalog/dream-reports-check";
import { executeReadOnlyQuery } from "../http/db-query-shared";
import { validateScriptImports } from "../scripts-runtime/import-allowlist";

// The dream-* scripts run against an isolated test DB: db_query executes real read-only SQL through the
// same executor the db-query route uses, and KV goes through the real kv_entries helpers.

const TEST_DB_PATH = join(tmpdir(), `dream-scripts-gather-${process.pid}.sqlite`);
const NS = "dreaming";
const LEAD_ID = crypto.randomUUID();
const WORKER_ID = crypto.randomUUID();
const LEAD_CLAUDE = "## Rules\nAlways re-read the PR state right before pushing a fix to it.\n";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

type Harness = {
  calls: string[];
  sent: any[];
  ctx: any;
};

function harness(opts: { taskSendResult?: unknown } = {}): Harness {
  const calls: string[] = [];
  const sent: any[] = [];
  const ctx = {
    swarm: {
      async db_query({ sql, params = [] }: { sql: string; params?: unknown[] }) {
        calls.push(`db_query ${sql.replace(/\s+/g, " ").slice(0, 80)}`);
        try {
          const r = executeReadOnlyQuery(sql, params);
          return { success: true, status: 200, data: { columns: r.columns, rows: r.rows } };
        } catch (e) {
          return { success: false, status: 400, data: { error: String((e as Error).message) } };
        }
      },
      async kv_getOrNull({ namespace, key }: { namespace: string; key: string }) {
        calls.push(`kv_getOrNull ${key}`);
        return getKv(namespace, key);
      },
      async kv_list({
        namespace,
        prefix,
        limit = 100,
      }: {
        namespace: string;
        prefix?: string;
        limit?: number;
      }) {
        calls.push(`kv_list ${prefix}`);
        const entries = await listKv(namespace, { prefix, limit, offset: 0 });
        return { success: true, status: 200, data: { entries } };
      },
      async kv_set({ namespace, key, value }: { namespace: string; key: string; value: unknown }) {
        calls.push(`kv_set ${key}`);
        const entry = await upsertKv({ namespace, key, value, valueType: "json" });
        return { success: true, status: 200, data: entry };
      },
      async task_send(args: unknown) {
        calls.push("task_send");
        sent.push(args);
        return (
          opts.taskSendResult ?? {
            success: true,
            status: 201,
            data: { task: { id: `task-${sent.length}` } },
          }
        );
      },
    },
  };
  return { calls, sent, ctx };
}

const nowIso = () => new Date().toISOString();

function insertAgent(id: string, name: string, isLead: number, claudeMd = "") {
  getDb().run(
    `INSERT INTO agents (id, name, isLead, status, claudeMd, soulMd, identityMd, toolsMd, heartbeatMd, createdAt, lastUpdatedAt)
     VALUES (?, ?, ?, 'idle', ?, '', '', '', '## Tracked Items\n- watch the deploy\n', ?, ?)`,
    [id, name, isLead, claudeMd, nowIso(), nowIso()],
  );
}

function insertTask(agentId: string, status: string) {
  const id = crypto.randomUUID();
  getDb().run(
    `INSERT INTO agent_tasks (id, agentId, task, status, source, createdAt, lastUpdatedAt, key)
     VALUES (?, ?, 'review the nightly report', ?, 'mcp', ?, ?, ?)`,
    [id, agentId, status, nowIso(), nowIso(), "shared/"],
  );
}

async function clearKv(key: string) {
  getDb().run("DELETE FROM kv_entries WHERE namespace = ? AND key = ?", [NS, key]);
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

describe("dream-gather", () => {
  test("no Lead returns ok:false with reason 'no lead'", async () => {
    const h = harness();
    const r: any = await dreamGather({ runId: "run-0", enabled: "true" }, h.ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no lead");
    expect(r.agents).toEqual([]);
    expect(r.leadId).toBeNull();

    // Seed the swarm for the remaining cases.
    insertAgent(LEAD_ID, "lead-agent", 1, LEAD_CLAUDE);
    insertAgent(WORKER_ID, "worker-agent", 0);
    insertTask(LEAD_ID, "completed");
    insertTask(LEAD_ID, "failed");
    insertTask(WORKER_ID, "completed");
  });

  test("mode off returns 0 agents before any query", async () => {
    const h = harness();
    const r: any = await dreamGather({ enabled: "false", laneTrim: "false", capTrims: "2" }, h.ctx);
    expect(r).toMatchObject({ ok: true, mode: "off", dryRun: true, agents: [], overlap: [] });
    expect(r.lanes).toEqual({ heartbeat: true, trim: false, identity: true, memory: true });
    expect(r.caps.trims).toBe(2);
    expect(r.cfg).toEqual({ slackChannel: "", reportTarget: "page", budgetUsd: 25 });
    expect(h.calls).toEqual([]);
  });

  test("an unparseable enabled value fails closed", async () => {
    const h = harness();
    const r: any = await dreamGather({ enabled: "sometimes" }, h.ctx);
    expect(r.mode).toBe("off");
    expect(h.calls).toEqual([]);
  });

  test("no green dry run in KV means mode dry-run; real SQL runs clean against the schema", async () => {
    await clearKv("state:last-green-dry-run");
    const h = harness();
    const r: any = await dreamGather(
      { runId: "run-1", enabled: "true", days: "1", minTasks: "1" },
      h.ctx,
    );
    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({
      ok: true,
      mode: "dry-run",
      dryRun: true,
      leadId: LEAD_ID,
      workerId: LEAD_ID,
    });
    expect(r.lastGreenDryRun).toBeNull();
    expect(r.agents.map((x: any) => x.id).sort()).toEqual([LEAD_ID, WORKER_ID].sort());
    const lead = r.agents.find((x: any) => x.id === LEAD_ID);
    expect(lead.evidence.tasks).toMatchObject({ total: 2, completed: 1, failed: 1 });
    expect(lead.evidence.h2Anchors.CLAUDE).toEqual(["## Rules"]);
    expect(r.swarm.audits.compoundInsights).toEqual({ source: "missing" });
    expect(r.swarm.audits.taskFailures).toEqual({ source: "missing" });
    expect(r.swarm.audits.memoryDedup).toEqual({ source: "missing" });
    expect(r.swarm.audits.opsCatalog).toEqual({ source: "missing" });
    expect(r.swarm.blockerDigest).toBeUndefined();
    expect(r.v3Writes).toBeUndefined();
    expect(r.budget).toMatchObject({ cap: 25, overBudget: false });
    expect(h.calls).toContain("kv_getOrNull state:last-green-dry-run");
  });

  test("a stored green dry run with enabled=true means live; the dryRun arg forces dry-run", async () => {
    await upsertKv({
      namespace: NS,
      key: "state:last-green-dry-run",
      value: { runId: "run-green", at: nowIso() },
      valueType: "json",
    });
    const live: any = await dreamGather({ runId: "run-2", enabled: "true" }, harness().ctx);
    expect(live).toMatchObject({ mode: "live", dryRun: false });
    expect(live.lastGreenDryRun.runId).toBe("run-green");

    for (const dryRun of [true, "true", "1"]) {
      const forced: any = await dreamGather(
        { runId: "run-3", enabled: true, dryRun },
        harness().ctx,
      );
      expect(forced).toMatchObject({ mode: "dry-run", dryRun: true });
    }
    // Absent, empty or "false" dryRun does not force anything.
    for (const dryRun of [undefined, "", "false"]) {
      const r: any = await dreamGather({ runId: "run-4", dryRun }, harness().ctx);
      expect(r.mode).toBe("live");
    }
  });

  test("lanes and caps parse string bools and clamp negatives; cfg normalizes", async () => {
    const r: any = await dreamGather(
      {
        enabled: "1",
        laneHeartbeat: "0",
        laneTrim: "false",
        laneIdentity: "1",
        laneMemory: false,
        capIdentityTotal: "-3",
        capIdentityPerAgent: "2",
        capTrims: -1,
        capMemoryStore: "4.7",
        capMemoryEdit: "abc",
        capMemoryDelete: "12",
        budgetUsd: "0",
        slackChannel: "  #nightly  ",
        reportTarget: "none",
      },
      harness().ctx,
    );
    expect(r.lanes).toEqual({ heartbeat: false, trim: false, identity: true, memory: false });
    expect(r.caps).toEqual({
      identityOpsTotal: 0,
      identityOpsPerAgent: 2,
      trims: 0,
      memoryStore: 4,
      memoryEdit: 5,
      memoryDelete: 12,
    });
    expect(r.cfg).toEqual({ slackChannel: "#nightly", reportTarget: "none", budgetUsd: 1 });

    const big: any = await dreamGather({ budgetUsd: "5000", reportTarget: "bogus" }, harness().ctx);
    expect(big.cfg.budgetUsd).toBe(1000);
    expect(big.cfg.reportTarget).toBe("page");
    expect(big.errors.some((e: string) => e.includes("reportTarget"))).toBe(true);
    expect(big.budget.cap).toBe(1000);

    // No lane args at all: every lane is on, caps at their defaults.
    const defaults: any = await dreamGather({}, harness().ctx);
    expect(defaults.lanes).toEqual({ heartbeat: true, trim: true, identity: true, memory: true });
    expect(defaults.caps).toEqual({
      identityOpsTotal: 6,
      identityOpsPerAgent: 1,
      trims: 3,
      memoryStore: 5,
      memoryEdit: 5,
      memoryDelete: 10,
    });
  });

  test("workerId falls back to leadId when empty, malformed or unknown", async () => {
    for (const workerAgentId of ["", "not-a-uuid", crypto.randomUUID()]) {
      const r: any = await dreamGather({ workerAgentId }, harness().ctx);
      expect(r.workerId).toBe(LEAD_ID);
    }
    const ok: any = await dreamGather({ workerAgentId: WORKER_ID }, harness().ctx);
    expect(ok.workerId).toBe(WORKER_ID);
    expect(ok.leadId).toBe(LEAD_ID);
  });

  test("overlap lists the enabled daily-compounding-reflection schedule", async () => {
    const before: any = await dreamGather({}, harness().ctx);
    expect(before.overlap).toEqual([]);
    getDb().run(
      `INSERT INTO scheduled_tasks (id, name, cronExpression, taskTemplate, enabled, scheduleType, targetType, createdAt, lastUpdatedAt, key)
       VALUES (?, 'daily-compounding-reflection', '0 3 * * *', 'reflect', 1, 'recurring', 'agent-task', ?, ?, 'shared/')`,
      [crypto.randomUUID(), nowIso(), nowIso()],
    );
    const after: any = await dreamGather({}, harness().ctx);
    expect(after.overlap).toEqual(["daily-compounding-reflection"]);
  });

  test("audits read the latest completed run of the seeded audit scripts", async () => {
    getDb().run(
      `INSERT INTO script_runs (id, agentId, scriptName, source, args, status, startedAt, finishedAt, output, kind)
       VALUES (?, ?, 'task-failure-audit', 'x', '{}', 'completed', ?, ?, ?, 'inline')`,
      [
        crypto.randomUUID(),
        LEAD_ID,
        nowIso(),
        nowIso(),
        JSON.stringify({ totalFailed: 3, clusterCount: 1, groups: [{ key: "timeout", count: 3 }] }),
      ],
    );
    const r: any = await dreamGather({}, harness().ctx);
    expect(r.swarm.audits.taskFailures).toMatchObject({
      source: "cached",
      totalFailed: 3,
      clusterCount: 1,
      groups: [{ key: "timeout", count: 3 }],
    });
  });
});

describe("dream-owners", () => {
  const synth = {
    actions: [
      { id: "act-1", lane: "memory", op: "delete", tier: "auto", target: {}, reason: "duplicate" },
      {
        id: "act-2",
        lane: "scriptify",
        op: "build",
        tier: "propose",
        target: {},
        reason: "repeated",
      },
      { id: "act-3", lane: "identity", op: "edit", tier: "auto", target: { agentId: WORKER_ID } },
    ],
  };

  test("a null taskId from task_send reports degraded with the unowned action ids", async () => {
    const h = harness({ taskSendResult: { success: true, status: 201, data: {} } });
    const r: any = await dreamOwners(
      {
        runId: "run-own-1",
        dryRun: false,
        synth,
        apply: { applied: [{ actionId: "act-3" }] },
        leadId: LEAD_ID,
      },
      h.ctx,
    );
    expect(r.degraded).toBe(true);
    expect(r.unownedActionIds.sort()).toEqual(["act-1", "act-2"]);
    expect(r.handled).toEqual(["act-3"]);
    expect(r.sent).toEqual([]);
    // Unowned sends are not recorded, so a re-run retries them.
    expect(await getKv(NS, `owners:run-own-1:${LEAD_ID}`)).toBeNull();
  });

  test("a sent task is owned, recorded in KV, and idempotent per run; workerId owns scriptify", async () => {
    const h = harness();
    const args = {
      runId: "run-own-2",
      dryRun: "false",
      synth,
      apply: {},
      leadId: LEAD_ID,
      workerId: WORKER_ID,
    };
    const r: any = await dreamOwners(args, h.ctx);
    expect(r).toMatchObject({
      mode: "live",
      degraded: false,
      unownedActionIds: [],
      leadId: LEAD_ID,
      workerId: WORKER_ID,
    });
    const owners = Object.fromEntries(r.sent.map((s: any) => [s.owner, s.actionIds]));
    expect(owners[LEAD_ID]).toEqual(["act-1"]);
    expect(owners[WORKER_ID]).toEqual(["act-2", "act-3"]);
    expect(h.sent.every((s: any) => s.tags.includes("dreaming"))).toBe(true);
    expect(((await getKv(NS, `owners:run-own-2:${LEAD_ID}`)) as any)?.value?.taskId).toBeTruthy();

    const again: any = await dreamOwners(args, h.ctx);
    expect(again.sent.every((s: any) => s.note === "already sent")).toBe(true);
    expect(h.sent.length).toBe(2);
  });

  test("dry run sends nothing; an absent leadId falls back to the roster Lead", async () => {
    const h = harness();
    const r: any = await dreamOwners({ runId: "run-own-3", dryRun: true, synth }, h.ctx);
    expect(r.mode).toBe("dry-run");
    expect(r.leadId).toBe(LEAD_ID);
    expect(r.workerId).toBe(LEAD_ID);
    expect(r.wouldSend.length).toBeGreaterThan(0);
    expect(h.sent).toEqual([]);
  });

  test("no synthesis output returns without throwing", async () => {
    const r: any = await dreamOwners({}, harness().ctx);
    expect(r).toMatchObject({
      degraded: false,
      unownedActionIds: [],
      errors: ["no synthesis output"],
    });
  });
});

describe("dream-learn", () => {
  test("minimal dry-run input scores, passes its controls and writes nothing", async () => {
    const h = harness();
    const r: any = await dreamLearn({ runId: "run-learn-1", dryRun: true }, h.ctx);
    expect(r.mode).toBe("dry-run");
    expect(r.controls.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.stored).toEqual([]);
    expect(h.calls.some((c) => c.startsWith("kv_set"))).toBe(false);
  });

  test("live run stores learn rows in the dreaming namespace", async () => {
    const r: any = await dreamLearn(
      { runId: "run-learn-2", dryRun: false, leadId: LEAD_ID },
      harness().ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.stored).toContain("learn:run-learn-2");
    expect(await getKv(NS, "learn:latest")).not.toBeNull();
  });
});

describe("dream-reports-check", () => {
  test("minimal input runs without throwing", async () => {
    const r: any = await dreamReportsCheck({}, harness().ctx);
    expect(r).toMatchObject({ pass: 1, validCount: 0, reports: [], retry: [], missing: [] });
  });

  test("valid slot passes, mismatched slot is queued for retry then reported missing", async () => {
    const report = (agentId: string) => ({
      agentId,
      summary: "s",
      repeatedProcedures: [],
      skillFriction: [],
      scriptCandidates: [],
      identityOps: [],
      memoryOps: [],
    });
    const agents = [
      { id: LEAD_ID, name: "lead-agent" },
      { id: WORKER_ID, name: "worker-agent" },
    ];
    const results = [
      {
        itemKey: LEAD_ID,
        status: "completed",
        output: { taskId: "t1", taskOutput: report(LEAD_ID) },
      },
      {
        itemKey: WORKER_ID,
        status: "completed",
        output: { taskId: "t2", taskOutput: report(LEAD_ID) },
      },
    ];
    const p1: any = await dreamReportsCheck({ agents, results }, harness().ctx);
    expect(p1.validCount).toBe(1);
    expect(p1.retry.map((x: any) => x.id)).toEqual([WORKER_ID]);

    const p2: any = await dreamReportsCheck(
      { agents, results, retryResults: JSON.stringify([]) },
      harness().ctx,
    );
    expect(p2.pass).toBe(2);
    expect(p2.missing.length).toBe(1);
  });
});

describe("dream-* gather-side scripts pass the seeder gates", () => {
  test("import allowlist and script typecheck", async () => {
    const dir = join(import.meta.dir, "../be/seed-scripts/catalog");
    const failures: string[] = [];
    for (const name of ["dream-gather", "dream-reports-check", "dream-owners", "dream-learn"]) {
      const source = await Bun.file(join(dir, `${name}.ts`)).text();
      const imports = validateScriptImports(source);
      if (!imports.ok) failures.push(`${name}: import ${imports.diagnostic}`);
      const tc = await typecheckScript(source);
      if (!tc.ok) failures.push(`${name}: typecheck ${tc.diagnostics.join(" | ")}`);
    }
    expect(failures).toEqual([]);
  }, 60_000);
});
