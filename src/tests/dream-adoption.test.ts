import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, getKv, initDb, listKv, upsertKv } from "../be/db";
import { typecheckScript } from "../be/scripts/typecheck";
import dreamAdoption from "../be/seed-scripts/catalog/dream-adoption";
import dreamRollback from "../be/seed-scripts/catalog/dream-rollback";
import dreamVerify from "../be/seed-scripts/catalog/dream-verify";
import { executeReadOnlyQuery } from "../http/db-query-shared";
import { validateScriptImports } from "../scripts-runtime/import-allowlist";

// dream-adoption, the artifact mode of dream-rollback, and verify's artifact records, against an isolated test DB.
// db_query runs real read-only SQL through the db-query executor; KV, skill and script writes go through the
// real tables. Fixtures are backdated rows, so the clock is real.

const TEST_DB_PATH = join(tmpdir(), `dream-adoption-${process.pid}.sqlite`);
const CATALOG = join(import.meta.dir, "../be/seed-scripts/catalog");
const NS = "dreaming";
const LEAD_ID = crypto.randomUUID();
const DAY = 86400000;

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const daysAgo = (d: number) => ago(d * DAY);
const after = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

type Harness = { calls: string[]; ctx: any };

/**
 * The script SDK surface the dreaming scripts use, backed by the test DB. Every call is recorded.
 * `caller` is the agent the script runs as: like the API, agent-scope script writes resolve to it.
 */
function harness(caller: string = LEAD_ID): Harness {
  const calls: string[] = [];
  const ctx = {
    stdlib: { Redacted: { value: (r: { v: string }) => r.v } },
    swarm: {
      config: { agentId: { v: caller } },
      async task_send(a: { agentId?: string; task: string }) {
        calls.push(`task_send ${a.agentId}`);
        return { success: true };
      },
      async db_query({ sql, params = [] }: { sql: string; params?: unknown[] }) {
        try {
          const r = executeReadOnlyQuery(sql, params);
          return { success: true, status: 200, data: { columns: r.columns, rows: r.rows } };
        } catch (e) {
          return { success: false, status: 400, data: { error: String((e as Error).message) } };
        }
      },
      async kv_getOrNull({ namespace, key }: { namespace: string; key: string }) {
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
        const entries = await listKv(namespace, { prefix, limit, offset: 0 });
        return { success: true, status: 200, data: { entries } };
      },
      async kv_set(args: { namespace: string; key: string; value: unknown; ttlSeconds?: number }) {
        calls.push(`kv_set ${args.key} ttl=${args.ttlSeconds ?? "none"}`);
        const expiresAt = args.ttlSeconds ? Date.now() + args.ttlSeconds * 1000 : null;
        const entry = await upsertKv({
          namespace: args.namespace,
          key: args.key,
          value: args.value,
          valueType: "json",
          expiresAt,
        });
        return { success: true, status: 200, data: entry };
      },
      async skill_update({ skillId, isEnabled }: { skillId: string; isEnabled?: boolean }) {
        calls.push(`skill_update ${skillId} isEnabled=${isEnabled}`);
        getDb().run("UPDATE skills SET isEnabled = ? WHERE id = ?", [isEnabled ? 1 : 0, skillId]);
        return { success: true };
      },
      async script_delete({ name, scope = "agent" }: { name: string; scope?: string }) {
        calls.push(`script_delete ${name} ${scope}`);
        // Agent scope deletes only the caller's own row, as the API does.
        getDb().run(
          "DELETE FROM scripts WHERE name = ? AND scope = ? AND (scope = 'global' OR scopeId = ?)",
          [name, scope, caller],
        );
        return { success: true, data: { deleted: true } };
      },
      async script_upsert(a: {
        name: string;
        source: string;
        scope?: string;
        description?: string;
        intent?: string;
      }) {
        calls.push(`script_upsert ${a.name} ${a.scope}`);
        insertScript(a.name, a.source, {
          scope: a.scope ?? "agent",
          owner: caller,
          createdAt: new Date().toISOString(),
        });
        return { success: true };
      },
    },
  };
  return { calls, ctx };
}

const writesIn = (calls: string[]) =>
  calls.filter((c) => /^(kv_set|skill_update|script_delete|script_upsert|task_send) /.test(c));

// ---- fixtures ----

function insertSkill(name: string, createdAt: string): string {
  const id = crypto.randomUUID();
  getDb().run(
    `INSERT INTO skills (id, name, description, content, type, scope, ownerAgentId, version, isEnabled, createdAt, lastUpdatedAt)
     VALUES (?, ?, 'a procedure the swarm repeats', ?, 'personal', 'swarm', ?, 1, 1, ?, ?)`,
    [id, name, `---\nname: ${name}\n---\nsteps`, LEAD_ID, createdAt, createdAt],
  );
  return id;
}

function insertInvocation(
  skillName: string,
  skillId: string,
  createdAt: string,
  taskId: string | null,
) {
  getDb().run(
    `INSERT INTO skill_invocations (id, skillId, skillName, agentId, taskId, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), skillId, skillName, LEAD_ID, taskId, createdAt],
  );
}

function insertScript(
  name: string,
  source: string,
  o: { scope?: string; owner?: string; createdAt: string },
): { id: string; contentHash: string } {
  const id = crypto.randomUUID();
  const scope = o.scope ?? "agent";
  const contentHash = sha256(source);
  getDb().run(
    `INSERT INTO scripts (id, name, scope, scopeId, source, description, intent, signatureJson, contentHash, createdByAgentId, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, 'counts the open pull requests', 'save a manual lookup', '{}', ?, ?, ?, ?)`,
    [
      id,
      name,
      scope,
      scope === "agent" ? (o.owner ?? LEAD_ID) : null,
      source,
      contentHash,
      LEAD_ID,
      o.createdAt,
      o.createdAt,
    ],
  );
  return { id, contentHash };
}

function insertScriptRun(scriptName: string, startedAt: string) {
  getDb().run(
    `INSERT INTO script_runs (id, agentId, scriptName, source, args, status, startedAt, finishedAt, kind)
     VALUES (?, ?, ?, 'export default () => 1', '{}', 'completed', ?, ?, 'inline')`,
    [crypto.randomUUID(), LEAD_ID, scriptName, startedAt, startedAt],
  );
}

function insertWorkflow(name: string, nodes: unknown[]): string {
  const id = crypto.randomUUID();
  getDb().run(
    `INSERT INTO workflows (id, name, enabled, definition, createdAt, lastUpdatedAt) VALUES (?, ?, 1, ?, ?, ?)`,
    [id, name, JSON.stringify({ nodes }), daysAgo(30), daysAgo(30)],
  );
  return id;
}

function insertRun(workflowId: string, startedAt: string): string {
  const id = crypto.randomUUID();
  getDb().run(
    `INSERT INTO workflow_runs (id, workflowId, status, startedAt, lastUpdatedAt) VALUES (?, ?, 'completed', ?, ?)`,
    [id, workflowId, startedAt, startedAt],
  );
  return id;
}

function insertStep(runId: string, nodeId: string, nodeType: string, startedAt: string) {
  getDb().run(
    `INSERT INTO workflow_run_steps (id, runId, nodeId, nodeType, status, startedAt, finishedAt) VALUES (?, ?, ?, ?, 'completed', ?, ?)`,
    [crypto.randomUUID(), runId, nodeId, nodeType, startedAt, startedAt],
  );
}

function insertTask(workflowRunId: string | null): string {
  const id = crypto.randomUUID();
  getDb().run(
    `INSERT INTO agent_tasks (id, agentId, task, status, source, workflowRunId, createdAt, lastUpdatedAt, key)
     VALUES (?, ?, 'review the nightly report', 'completed', 'mcp', ?, ?, ?, 'shared/')`,
    [id, LEAD_ID, workflowRunId, daysAgo(1), daysAgo(1)],
  );
  return id;
}

function insertSchedule(name: string, taskTemplate: string) {
  getDb().run(
    `INSERT INTO scheduled_tasks (id, name, cronExpression, taskTemplate, enabled, scheduleType, targetType, createdAt, lastUpdatedAt)
     VALUES (?, ?, '0 3 * * *', ?, 1, 'recurring', 'agent-task', ?, ?)`,
    [crypto.randomUUID(), name, taskTemplate, daysAgo(30), daysAgo(30)],
  );
}

async function putArtifact(kind: "skill" | "script", name: string, rec: Record<string, unknown>) {
  await upsertKv({
    namespace: NS,
    key: `artifact:${kind}:${name}`,
    value: { kind, name, runId: "build-run", status: "active", ...rec },
    valueType: "json",
  });
}

async function skillArtifact(name: string, ageDays: number): Promise<string> {
  const createdAt = daysAgo(ageDays);
  const id = insertSkill(name, createdAt);
  await putArtifact("skill", name, {
    id,
    scope: "swarm",
    agentId: LEAD_ID,
    createdAt,
    contentHash: "x",
  });
  return id;
}

async function scriptArtifact(
  name: string,
  ageDays: number,
  source = `export default async () => ({ name: "${name}" });\n`,
  owner: string = LEAD_ID,
) {
  const createdAt = daysAgo(ageDays);
  const row = insertScript(name, source, { createdAt, owner });
  await putArtifact("script", name, {
    id: row.id,
    scope: "agent",
    agentId: owner,
    createdAt,
    contentHash: row.contentHash,
    source,
    description: "counts the open pull requests",
    intent: "save a manual lookup",
  });
  return { ...row, createdAt, source };
}

const record = async (kind: string, name: string) =>
  (await getKv(NS, `artifact:${kind}:${name}`))?.value as any;
const skillEnabled = (id: string) =>
  Number((getDb().query("SELECT isEnabled FROM skills WHERE id = ?").get(id) as any)?.isEnabled);
const scriptCount = (name: string) =>
  Number((getDb().query("SELECT COUNT(*) n FROM scripts WHERE name = ?").get(name) as any)?.n);
const scriptRow = (name: string, owner: string) =>
  getDb()
    .query("SELECT id, contentHash FROM scripts WHERE name = ? AND scope = 'agent' AND scopeId = ?")
    .get(name, owner) as { id: string; contentHash: string } | null;

// The current dreaming run: its workflow is excluded from every count.
let DREAMING_WF = "";
let RUN_ID = "";

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(() => {
  const db = getDb();
  for (const t of [
    "skill_invocations",
    "skills",
    "script_runs",
    "scripts",
    "workflow_run_steps",
    "agent_tasks",
    "workflow_runs",
    "workflows",
    "scheduled_tasks",
  ]) {
    db.run(`DELETE FROM ${t}`);
  }
  db.run("DELETE FROM kv_entries WHERE namespace = ?", [NS]);
  db.run("DELETE FROM agents");
  db.run(
    `INSERT INTO agents (id, name, isLead, status, claudeMd, soulMd, identityMd, toolsMd, heartbeatMd, createdAt, lastUpdatedAt)
     VALUES (?, 'lead-agent', 1, 'idle', '', '', '', '', '', ?, ?)`,
    [LEAD_ID, daysAgo(60), daysAgo(60)],
  );
  DREAMING_WF = insertWorkflow("dreaming", [
    { id: "gather", type: "swarm-script", config: { scriptName: "dream-gather" } },
  ]);
  RUN_ID = insertRun(DREAMING_WF, ago(60_000));
  insertStep(RUN_ID, "gather", "swarm-script", ago(60_000));
});

const live = (extra: Record<string, unknown> = {}) => ({
  runId: RUN_ID,
  gateDays: 14,
  dryRun: false,
  ...extra,
});

describe("dream-adoption", () => {
  test("passes the script_upsert gates (imports + typecheck)", async () => {
    for (const n of ["dream-adoption", "dream-rollback", "dream-verify"]) {
      const src = await Bun.file(join(CATALOG, `${n}.ts`)).text();
      expect(validateScriptImports(src).ok).toBe(true);
      const tc = await typecheckScript(src);
      if (!tc.ok) throw new Error(`${n}: ${tc.diagnostics.join(" | ")}`);
    }
  }, 120_000);

  test("no artifacts: controls.ok is false with reason 'no artifacts', nothing written", async () => {
    const h = harness();
    const r: any = await dreamAdoption(live(), h.ctx);
    expect(r).toMatchObject({
      ok: true,
      mode: "live",
      artifacts: 0,
      retired: [],
      adopted: [],
      pending: [],
    });
    expect(r.controls).toMatchObject({ ok: false, reason: "no artifacts" });
    // The run's own swarm-script step exists (raw 1) and is excluded (counted 0).
    expect(r.controls.negative.runScriptSteps).toEqual({ raw: 1, counted: 0 });
    expect(writesIn(h.calls)).toEqual([]);
  });

  test("15-day-old skill with 0 invocations: disabled, record retired", async () => {
    const id = await skillArtifact("triage-flaky-ci", 15);
    const h = harness();
    const r: any = await dreamAdoption(live(), h.ctx);
    expect(r.errors).toEqual([]);
    expect(r.retired).toHaveLength(1);
    expect(r.retired[0]).toMatchObject({
      kind: "skill",
      name: "triage-flaky-ci",
      uses: 0,
      reason: "0 uses in 14 days",
    });
    expect(skillEnabled(id)).toBe(0);
    expect(await record("skill", "triage-flaky-ci")).toMatchObject({
      status: "retired",
      uses: 0,
      reason: "0 uses in 14 days",
    });
    expect(r.controls.ok).toBe(true);
  });

  test("the same skill with 1 invocation from a task outside the loop: adopted, still enabled", async () => {
    const id = await skillArtifact("triage-flaky-ci", 15);
    const useAt = daysAgo(3);
    insertInvocation("triage-flaky-ci", id, useAt, insertTask(null));
    const r: any = await dreamAdoption(live(), harness().ctx);
    expect(r.retired).toEqual([]);
    expect(r.adopted).toHaveLength(1);
    expect(r.adopted[0]).toMatchObject({ status: "adopted", uses: 1, lastUseAt: useAt });
    expect(skillEnabled(id)).toBe(1);
    expect(await record("skill", "triage-flaky-ci")).toMatchObject({
      status: "adopted",
      uses: 1,
      lastUseAt: useAt,
    });
    // Positive control: the known outside invocation counts through the same query.
    expect(r.controls.positive).toMatchObject({
      skill: "triage-flaky-ci",
      source: "artifact",
      ok: true,
    });
    expect(r.controls.positive.counted).toBeGreaterThanOrEqual(1);
  });

  test("an invocation only from a dreaming-run task does not count: still retired", async () => {
    const id = await skillArtifact("triage-flaky-ci", 15);
    // One from an earlier dreaming run, one from tonight's.
    const earlier = insertRun(DREAMING_WF, daysAgo(5));
    insertInvocation("triage-flaky-ci", id, daysAgo(5), insertTask(earlier));
    insertInvocation("triage-flaky-ci", id, ago(30_000), insertTask(RUN_ID));
    const r: any = await dreamAdoption(live(), harness().ctx);
    expect(r.retired.map((x: any) => x.name)).toEqual(["triage-flaky-ci"]);
    expect(skillEnabled(id)).toBe(0);
    // Negative control: tonight's own task invocation is seen raw and excluded.
    expect(r.controls.negative.runTaskInvocations).toEqual({ raw: 1, counted: 0 });
    expect(r.controls.negative.ok).toBe(true);
  });

  test("10-day-old artifact: pending", async () => {
    const id = await skillArtifact("triage-flaky-ci", 10);
    const r: any = await dreamAdoption(live(), harness().ctx);
    expect(r.retired).toEqual([]);
    expect(r.pending).toHaveLength(1);
    expect(r.pending[0]).toMatchObject({ name: "triage-flaky-ci", uses: 0, daysLeft: 4 });
    expect(skillEnabled(id)).toBe(1);
    expect((await record("skill", "triage-flaky-ci")).status).toBe("active");
  });

  test("gateDays=0: counts but retires nothing", async () => {
    const id = await skillArtifact("triage-flaky-ci", 40);
    const s = await scriptArtifact("open-pr-count", 40);
    const h = harness();
    const r: any = await dreamAdoption(live({ gateDays: "0" }), h.ctx);
    expect(r.gateDays).toBe(0);
    expect(r.retired).toEqual([]);
    expect(r.pending.map((x: any) => x.name).sort()).toEqual(["open-pr-count", "triage-flaky-ci"]);
    expect(r.pending.every((x: any) => x.reason.startsWith("gate off"))).toBe(true);
    expect(skillEnabled(id)).toBe(1);
    expect(scriptCount("open-pr-count")).toBe(1);
    expect(s.id).toBeTruthy();
    expect(writesIn(h.calls)).toEqual([]);
  });

  test("script whose source changed after the build: adopted-edit, not deleted", async () => {
    await scriptArtifact("open-pr-count", 20);
    getDb().run("UPDATE scripts SET source = 'edited', contentHash = ? WHERE name = ?", [
      sha256("edited"),
      "open-pr-count",
    ]);
    const h = harness();
    const r: any = await dreamAdoption(live(), h.ctx);
    expect(r.adopted).toHaveLength(1);
    expect(r.adopted[0]).toMatchObject({ name: "open-pr-count", status: "adopted-edit", uses: 0 });
    expect(scriptCount("open-pr-count")).toBe(1);
    expect(h.calls.some((c) => c.startsWith("script_delete"))).toBe(false);
    expect((await record("script", "open-pr-count")).status).toBe("adopted-edit");
  });

  test("a script run 10 minutes after the build is ignored (control window); one 2 days later counts", async () => {
    const early = await scriptArtifact("open-pr-count", 20);
    insertScriptRun("open-pr-count", after(early.createdAt, 10 * 60_000));
    const used = await scriptArtifact("stale-branch-list", 20);
    insertScriptRun("stale-branch-list", after(used.createdAt, 10 * 60_000));
    insertScriptRun("stale-branch-list", after(used.createdAt, 2 * DAY));
    const r: any = await dreamAdoption(live(), harness().ctx);
    expect(r.errors).toEqual([]);
    expect(r.retired.map((x: any) => x.name)).toEqual(["open-pr-count"]);
    expect(scriptCount("open-pr-count")).toBe(0);
    expect(r.adopted).toHaveLength(1);
    expect(r.adopted[0]).toMatchObject({ name: "stale-branch-list", status: "adopted", uses: 1 });
    expect(scriptCount("stale-branch-list")).toBe(1);
  });

  test("a workflow swarm-script step that runs the script counts as adoption", async () => {
    const s = await scriptArtifact("open-pr-count", 20);
    const wf = insertWorkflow("weekly-pr-digest", [
      {
        id: "count",
        type: "swarm-script",
        config: { scriptName: "open-pr-count", scope: "agent" },
      },
    ]);
    const run = insertRun(wf, after(s.createdAt, 3 * DAY));
    insertStep(run, "count", "swarm-script", after(s.createdAt, 3 * DAY));
    const r: any = await dreamAdoption(live(), harness().ctx);
    expect(r.retired).toEqual([]);
    expect(r.adopted).toHaveLength(1);
    expect(r.adopted[0]).toMatchObject({ name: "open-pr-count", status: "adopted", uses: 1 });
    expect(scriptCount("open-pr-count")).toBe(1);
  });

  test("dreaming's own workflow runs of the script do not count: retired", async () => {
    const s = await scriptArtifact("open-pr-count", 20);
    // The dreaming workflow itself names and runs the script: neither the use nor the reference counts.
    getDb().run("UPDATE workflows SET definition = ? WHERE id = ?", [
      JSON.stringify({
        nodes: [
          { id: "gather", type: "swarm-script", config: { scriptName: "dream-gather" } },
          { id: "count", type: "swarm-script", config: { scriptName: "open-pr-count" } },
        ],
      }),
      DREAMING_WF,
    ]);
    const run = insertRun(DREAMING_WF, after(s.createdAt, 3 * DAY));
    insertStep(run, "count", "swarm-script", after(s.createdAt, 3 * DAY));
    const r: any = await dreamAdoption(live(), harness().ctx);
    expect(r.adopted).toEqual([]);
    expect(r.retired.map((x: any) => x.name)).toEqual(["open-pr-count"]);
    expect(r.retired[0].uses).toBe(0);
    expect(scriptCount("open-pr-count")).toBe(0);
  });

  test("a static reference (workflow, schedule, another script) keeps the script: adopted-ref", async () => {
    await scriptArtifact("pr-count-a", 20);
    await scriptArtifact("pr-count-b", 20);
    await scriptArtifact("pr-count-c", 20);
    insertWorkflow("release-checklist", [
      {
        id: "ask",
        type: "agent-task",
        config: { template: "Run script pr-count-a and post the number." },
      },
    ]);
    insertSchedule(
      "morning-digest",
      JSON.stringify({ task: "script-run pr-count-b, then summarize" }),
    );
    insertScript(
      "digest-builder",
      'const n = await ctx.swarm.script_run({ name: "pr-count-c" });',
      {
        scope: "global",
        createdAt: daysAgo(5),
      },
    );
    const h = harness();
    const r: any = await dreamAdoption(live(), h.ctx);
    expect(r.errors).toEqual([]);
    expect(r.retired).toEqual([]);
    const byName = Object.fromEntries(r.adopted.map((x: any) => [x.name, x]));
    expect(byName["pr-count-a"]).toMatchObject({ status: "adopted-ref", uses: 0 });
    expect(byName["pr-count-a"].refs.map((x: any) => x.kind)).toEqual(["workflow"]);
    expect(byName["pr-count-b"].refs.map((x: any) => x.kind)).toEqual(["schedule"]);
    expect(byName["pr-count-c"].refs.map((x: any) => x.kind)).toEqual(["script"]);
    for (const n of ["pr-count-a", "pr-count-b", "pr-count-c"]) {
      expect(scriptCount(n)).toBe(1);
      expect((await record("script", n)).status).toBe("adopted-ref");
    }
    expect(h.calls.some((c) => c.startsWith("script_delete"))).toBe(false);
  });

  test("dry run: wouldRetire only, no writes", async () => {
    const id = await skillArtifact("triage-flaky-ci", 20);
    await scriptArtifact("open-pr-count", 20);
    const h = harness();
    const r: any = await dreamAdoption({ runId: RUN_ID, gateDays: 14, dryRun: "true" }, h.ctx);
    expect(r.mode).toBe("dry-run");
    expect(r.retired).toEqual([]);
    expect(r.wouldRetire.map((x: any) => x.name).sort()).toEqual([
      "open-pr-count",
      "triage-flaky-ci",
    ]);
    expect(writesIn(h.calls)).toEqual([]);
    expect(skillEnabled(id)).toBe(1);
    expect(scriptCount("open-pr-count")).toBe(1);
    expect((await record("skill", "triage-flaky-ci")).status).toBe("active");
    // A missing dryRun is a dry run too (fail closed).
    const absent: any = await dreamAdoption({ runId: RUN_ID }, harness().ctx);
    expect(absent.mode).toBe("dry-run");
  });

  test("a retired artifact is not checked again", async () => {
    await skillArtifact("triage-flaky-ci", 20);
    await dreamAdoption(live(), harness().ctx);
    const h = harness();
    const r: any = await dreamAdoption(live(), h.ctx);
    expect(r).toMatchObject({ artifacts: 1, checked: 0, retired: [] });
    expect(writesIn(h.calls)).toEqual([]);
  });
});

describe("dream-rollback mode artifact", () => {
  test("re-enables a retired skill and recreates a retired script; artifact records carry no TTL", async () => {
    const skillId = await skillArtifact("triage-flaky-ci", 20);
    const s = await scriptArtifact(
      "open-pr-count",
      20,
      'export default async () => ({ note: "api_key=sk-fixture" });\n',
    );
    const retire: any = await dreamAdoption(live(), harness().ctx);
    expect(retire.retired.map((x: any) => x.name).sort()).toEqual([
      "open-pr-count",
      "triage-flaky-ci",
    ]);
    expect(skillEnabled(skillId)).toBe(0);
    expect(scriptCount("open-pr-count")).toBe(0);

    const dry: any = await dreamRollback(
      { mode: "artifact", kind: "script", name: "open-pr-count", dryRun: true },
      harness().ctx,
    );
    expect(dry.planned).toHaveLength(1);
    expect(scriptCount("open-pr-count")).toBe(0);

    const h = harness();
    const rs: any = await dreamRollback(
      { mode: "artifact", kind: "skill", name: "triage-flaky-ci" },
      h.ctx,
    );
    expect(rs.failed).toEqual([]);
    expect(rs.restored).toHaveLength(1);
    expect(skillEnabled(skillId)).toBe(1);
    const rc: any = await dreamRollback(
      { mode: "artifact", kind: "script", name: "open-pr-count" },
      h.ctx,
    );
    expect(rc.failed).toEqual([]);
    expect(rc.restored).toHaveLength(1);
    const back = getDb()
      .query("SELECT source, contentHash, scope FROM scripts WHERE name = ?")
      .get("open-pr-count") as any;
    expect(back).toMatchObject({ source: s.source, contentHash: s.contentHash, scope: "agent" });
    expect((await record("skill", "triage-flaky-ci")).status).toBe("restored");
    expect((await record("script", "open-pr-count")).status).toBe("restored");

    // A restored artifact is out of the gate.
    const again: any = await dreamAdoption(live(), harness().ctx);
    expect(again.checked).toBe(0);

    // No TTL on any artifact record, including the script source.
    const rows = getDb()
      .query("SELECT key, expires_at FROM kv_entries WHERE namespace = ? AND key GLOB 'artifact:*'")
      .all(NS) as Array<{ key: string; expires_at: number | null }>;
    expect(rows.map((r) => r.key).sort()).toEqual([
      "artifact:script:open-pr-count",
      "artifact:skill:triage-flaky-ci",
    ]);
    expect(rows.every((r) => r.expires_at === null)).toBe(true);
    expect(h.calls.filter((c) => c.startsWith("kv_set")).every((c) => c.endsWith("ttl=none"))).toBe(
      true,
    );
    // Positive control of the instrument: a write with a TTL does show an expiry.
    await harness().ctx.swarm.kv_set({
      namespace: NS,
      key: "ttl-control",
      value: 1,
      ttlSeconds: 60,
    });
    expect(
      (
        getDb()
          .query("SELECT expires_at FROM kv_entries WHERE namespace = ? AND key = 'ttl-control'")
          .get(NS) as any
      ).expires_at,
    ).not.toBeNull();
  });

  test("refuses without kind and name, or without a record", async () => {
    const a: any = await dreamRollback({ mode: "artifact", kind: "skill" }, harness().ctx);
    expect(a.failed[0].reason).toContain("kind");
    const b: any = await dreamRollback(
      { mode: "artifact", kind: "skill", name: "nope" },
      harness().ctx,
    );
    expect(b.failed[0].reason).toBe("no artifact record");
  });
});

describe("artifact owner is not the caller", () => {
  const WORKER = "00000000-0000-4000-8000-0000000000aa";
  const LEAD_SOURCE = 'export default async () => ({ lead: "unrelated" });\n';

  test("adoption never deletes the caller's same-name script; it asks the owner once", async () => {
    // A worker-owned dreaming artifact, and an unrelated Lead-owned script with the same name.
    const art = await scriptArtifact("open-pr-count", 20, undefined, WORKER);
    const leadRow = insertScript("open-pr-count", LEAD_SOURCE, { createdAt: daysAgo(90) });

    const dry: any = await dreamAdoption(live({ dryRun: true }), harness().ctx);
    expect(dry.wouldRetire).toEqual([
      expect.objectContaining({
        name: "open-pr-count",
        action: `ask owner ${WORKER} to script_delete`,
      }),
    ]);

    const h = harness();
    const r: any = await dreamAdoption(live(), h.ctx);
    expect(h.calls.some((c) => c.startsWith("script_delete"))).toBe(false);
    expect(h.calls).toContain(`task_send ${WORKER}`);
    expect(r.errors).toEqual([]);
    expect(r.retired).toEqual([]);
    expect(r.delegated).toEqual([
      expect.objectContaining({ name: "open-pr-count", owner: WORKER }),
    ]);
    // Both rows untouched.
    expect(scriptRow("open-pr-count", LEAD_ID)).toMatchObject({ id: leadRow.id });
    expect(scriptRow("open-pr-count", WORKER)).toMatchObject({ id: art.id });
    expect(await record("script", "open-pr-count")).toMatchObject({
      status: "active",
      retireRequestedFrom: WORKER,
    });

    // The next run does not ask again.
    const h2 = harness();
    const again: any = await dreamAdoption(live(), h2.ctx);
    expect(writesIn(h2.calls)).toEqual([]);
    expect(again.pending).toEqual([
      expect.objectContaining({ name: "open-pr-count", owner: WORKER }),
    ]);
  });

  test("run as the owner, adoption deletes exactly the recorded row", async () => {
    const art = await scriptArtifact("open-pr-count", 20, undefined, WORKER);
    const leadRow = insertScript("open-pr-count", LEAD_SOURCE, { createdAt: daysAgo(90) });
    const r: any = await dreamAdoption(live(), harness(WORKER).ctx);
    expect(r.retired).toEqual([expect.objectContaining({ name: "open-pr-count" })]);
    expect(scriptRow("open-pr-count", WORKER)).toBeNull();
    expect(scriptRow("open-pr-count", LEAD_ID)).toMatchObject({ id: leadRow.id });
    expect(art.id).not.toBe(leadRow.id);
  });

  test("an agent-scope record with no owner is skipped, not resolved by name", async () => {
    insertScript("open-pr-count", LEAD_SOURCE, { createdAt: daysAgo(90) });
    await putArtifact("script", "open-pr-count", {
      scope: "agent",
      createdAt: daysAgo(20),
      contentHash: sha256(LEAD_SOURCE),
      source: LEAD_SOURCE,
    });
    const h = harness();
    const r: any = await dreamAdoption(live(), h.ctx);
    expect(r.skipped).toEqual([
      expect.objectContaining({ reason: "agent-scope record has no owner (agentId)" }),
    ]);
    expect(h.calls.some((c) => c.startsWith("script_delete"))).toBe(false);
    expect(scriptCount("open-pr-count")).toBe(1);
  });

  test("artifact rollback restores an agent-scope script only as its owner", async () => {
    const art = await scriptArtifact("open-pr-count", 20, undefined, WORKER);
    await dreamAdoption(live(), harness(WORKER).ctx);
    expect(scriptRow("open-pr-count", WORKER)).toBeNull();
    // The Lead now holds its own same-name script with other content.
    const leadRow = insertScript("open-pr-count", LEAD_SOURCE, { createdAt: daysAgo(1) });

    const h = harness();
    const asLead: any = await dreamRollback(
      { mode: "artifact", kind: "script", name: "open-pr-count" },
      h.ctx,
    );
    expect(asLead.restored).toEqual([]);
    expect(asLead.failed[0].reason).toBe(
      `agent-scope script restores only when its owner ${WORKER} runs the rollback`,
    );
    expect(h.calls.some((c) => c.startsWith("script_upsert"))).toBe(false);
    expect(scriptRow("open-pr-count", LEAD_ID)).toMatchObject({
      id: leadRow.id,
      contentHash: sha256(LEAD_SOURCE),
    });

    const asOwner: any = await dreamRollback(
      { mode: "artifact", kind: "script", name: "open-pr-count" },
      harness(WORKER).ctx,
    );
    expect(asOwner.failed).toEqual([]);
    expect(scriptRow("open-pr-count", WORKER)).toMatchObject({ contentHash: art.contentHash });
    expect(scriptRow("open-pr-count", LEAD_ID)).toMatchObject({ id: leadRow.id });
  });
});

describe("dream-verify artifact records", () => {
  const since = () => ago(3600_000);

  test("a live run records each confirmed create with no TTL; scripts keep their source", async () => {
    const skillId = insertSkill("triage-flaky-ci", ago(600_000));
    const content = String(
      (getDb().query("SELECT content FROM skills WHERE id = ?").get(skillId) as any).content,
    );
    const source = "export default async () => ({ open: 3 });\n";
    const script = insertScript("open-pr-count", source, { createdAt: ago(500_000) });
    const h = harness();
    const r: any = await dreamVerify(
      {
        runId: RUN_ID,
        leadId: LEAD_ID,
        dryRun: false,
        since: since(),
        skills: {
          results: [
            {
              actionId: "A1",
              op: "create",
              status: "applied",
              skillId,
              name: "triage-flaky-ci",
              versionAfter: 1,
              contentSha256: sha256(content),
            },
          ],
        },
        scriptify: {
          built: [
            {
              actionId: "A2",
              status: "built",
              name: "open-pr-count",
              scope: "agent",
              contentHash: script.contentHash,
            },
          ],
        },
      },
      h.ctx,
    );
    expect(r.artifacts.written.sort()).toEqual([
      "artifact:script:open-pr-count",
      "artifact:skill:triage-flaky-ci",
    ]);
    expect(r.confirmed.map((c: any) => c.lane).sort()).toEqual(["scriptify", "skills"]);
    expect(await record("skill", "triage-flaky-ci")).toMatchObject({
      kind: "skill",
      id: skillId,
      status: "active",
      runId: RUN_ID,
      actionId: "A1",
    });
    expect(await record("script", "open-pr-count")).toMatchObject({
      kind: "script",
      id: script.id,
      scope: "agent",
      agentId: LEAD_ID,
      contentHash: script.contentHash,
      source,
      status: "active",
    });
    const ttl = getDb()
      .query(
        "SELECT COUNT(*) n FROM kv_entries WHERE namespace = ? AND key GLOB 'artifact:*' AND expires_at IS NOT NULL",
      )
      .get(NS) as any;
    expect(Number(ttl.n)).toBe(0);

    // A second verify of the same run keeps the records as they are.
    const again: any = await dreamVerify(
      {
        runId: RUN_ID,
        leadId: LEAD_ID,
        dryRun: false,
        since: since(),
        scriptify: {
          built: [
            {
              actionId: "A2",
              status: "built",
              name: "open-pr-count",
              scope: "agent",
              contentHash: script.contentHash,
            },
          ],
        },
      },
      harness().ctx,
    );
    expect(again.artifacts).toEqual({ written: [], kept: ["artifact:script:open-pr-count"] });
  });

  test("a skill update and a dry run record nothing; a built claim with no row is a mismatch", async () => {
    const skillId = insertSkill("triage-flaky-ci", daysAgo(30));
    getDb().run("UPDATE skills SET version = 2 WHERE id = ?", [skillId]);
    const upd: any = await dreamVerify(
      {
        runId: RUN_ID,
        leadId: LEAD_ID,
        dryRun: false,
        since: since(),
        skills: {
          results: [
            {
              actionId: "A1",
              op: "update",
              status: "applied",
              skillId,
              versionBefore: 1,
              versionAfter: 2,
            },
          ],
        },
        scriptify: {
          built: [
            {
              actionId: "A2",
              status: "built",
              name: "never-built",
              scope: "agent",
              contentHash: "abc",
            },
          ],
        },
      },
      harness().ctx,
    );
    expect(upd.artifacts.written).toEqual([]);
    expect(upd.claimMismatch.map((m: any) => m.lane)).toEqual(["scriptify"]);

    const h = harness();
    const dry: any = await dreamVerify(
      {
        runId: RUN_ID,
        leadId: LEAD_ID,
        dryRun: true,
        since: since(),
        skills: {
          results: [{ actionId: "A1", op: "create", status: "dry-run", name: "triage-flaky-ci" }],
        },
      },
      h.ctx,
    );
    expect(dry.artifacts.written).toEqual([]);
    expect(h.calls.filter((c) => c.startsWith("kv_set artifact:"))).toEqual([]);
  });
});
