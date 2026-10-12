import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import * as db from "../be/db";
import {
  closeDb,
  completeTask,
  createAgent,
  getDb,
  getDbClient,
  getKv,
  getTaskByWorkflowRunStepId,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
  listKv,
  listWorkflows,
  upsertKv,
} from "../be/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { runAllSeeders } from "../be/seed/registry";
import { loadSeedWorkflows } from "../be/seed/workflows-seeder";
import dreamAdoption, {
  argsSchema as adoptionArgs,
} from "../be/seed-scripts/catalog/dream-adoption";
import dreamApply, { argsSchema as applyArgs } from "../be/seed-scripts/catalog/dream-apply";
import dreamGather, { argsSchema as gatherArgs } from "../be/seed-scripts/catalog/dream-gather";
import dreamHeartbeat, {
  argsSchema as heartbeatArgs,
} from "../be/seed-scripts/catalog/dream-heartbeat";
import dreamLearn, { argsSchema as learnArgs } from "../be/seed-scripts/catalog/dream-learn";
import dreamOwners, { argsSchema as ownersArgs } from "../be/seed-scripts/catalog/dream-owners";
import dreamReportsCheck, {
  argsSchema as reportsCheckArgs,
} from "../be/seed-scripts/catalog/dream-reports-check";
import dreamTrim, { argsSchema as trimArgs } from "../be/seed-scripts/catalog/dream-trim";
import dreamVerify, { argsSchema as verifyArgs } from "../be/seed-scripts/catalog/dream-verify";
import { validateConfigValue } from "../be/swarm-config-guard";
import { executeReadOnlyQuery } from "../http/db-query-shared";
import type { Workflow, WorkflowNode } from "../types";
import { validateDefinition } from "../workflows/definition";
import { startWorkflowExecution } from "../workflows/engine";
import { InProcessEventBus } from "../workflows/event-bus";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { createExecutorRegistry } from "../workflows/executors/registry";
import { SwarmScriptConfigSchema } from "../workflows/executors/swarm-script";
import { setupWorkflowResumeListener } from "../workflows/resume";
import { interpolate } from "../workflows/template";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";

const ROOT = join(import.meta.dir, "..", "..");
const TEMPLATE_DIR = join(ROOT, "templates", "workflows", "dreaming");
const SCHEDULE_DIR = join(ROOT, "templates", "schedules", "dreaming-nightly");
const GUIDES_DIR = join(ROOT, "docs-site", "content", "docs", "(documentation)", "guides");
const CATALOG_PATH = join(ROOT, "apps", "ui", "src", "lib", "configuration-catalog.ts");
const TEST_DB_PATH = "./test-workflow-dreaming.sqlite";
const API_KEY = "example-test-workflow-dreaming-key-1234567890";
const BUILTIN_ROOTS = new Set(["trigger", "input", "workflow", "swarm", "run"]);

// Every key of the Dreaming config group. The drift test proves the template,
// the dashboard catalog and the config validators agree on this list.
const DREAMING_KEYS = [
  "DREAMING_ENABLED",
  "DREAMING_LANE_HEARTBEAT",
  "DREAMING_LANE_TRIM",
  "DREAMING_LANE_IDENTITY",
  "DREAMING_LANE_MEMORY",
  "DREAMING_LANE_SKILLIFY",
  "DREAMING_LANE_SCRIPTIFY",
  "DREAMING_ADOPTION_GATE_DAYS",
  "DREAMING_SLACK_CHANNEL",
  "DREAMING_REPORT_TARGET",
  "DREAMING_WORKER_AGENT_ID",
  "DREAMING_BUDGET_USD",
  "DREAMING_CAP_IDENTITY_TOTAL",
  "DREAMING_CAP_IDENTITY_PER_AGENT",
  "DREAMING_CAP_TRIMS",
  "DREAMING_CAP_MEMORY_STORE",
  "DREAMING_CAP_MEMORY_EDIT",
  "DREAMING_CAP_MEMORY_DELETE",
  "DREAMING_CAP_SKILL_CREATE",
  "DREAMING_CAP_SKILL_UPDATE",
  "DREAMING_CAP_SCRIPT_BUILDS",
];
// A free-form value (a Slack channel id or name) has nothing to validate.
const UNVALIDATED_KEYS = new Set(["DREAMING_SLACK_CHANNEL"]);

type ScriptModule = {
  run: (args: unknown, ctx: any) => Promise<unknown>;
  args: z.ZodObject<z.ZodRawShape>;
};
const SCRIPTS: Record<string, ScriptModule> = {
  "dream-gather": { run: dreamGather, args: gatherArgs },
  "dream-adoption": { run: dreamAdoption, args: adoptionArgs },
  "dream-reports-check": { run: dreamReportsCheck, args: reportsCheckArgs },
  "dream-apply": { run: dreamApply, args: applyArgs },
  "dream-trim": { run: dreamTrim, args: trimArgs },
  "dream-heartbeat": { run: dreamHeartbeat, args: heartbeatArgs },
  "dream-verify": { run: dreamVerify, args: verifyArgs },
  "dream-learn": { run: dreamLearn, args: learnArgs },
  "dream-owners": { run: dreamOwners, args: ownersArgs },
} as Record<string, ScriptModule>;

const ENV_KEYS = [...DREAMING_KEYS, "AGENT_SWARM_API_KEY", "API_KEY", "SEED_AUTOMATIONS_ENABLED"];
const savedEnv: Record<string, string | undefined> = {};

function dreamingTemplate() {
  const workflow = loadSeedWorkflows().find((w) => w.name === "dreaming");
  if (!workflow) throw new Error("dreaming template is not registered");
  return workflow;
}

function nodeById(id: string): WorkflowNode {
  const node = dreamingTemplate().definition.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

/** Every agent-task config in the graph, foreach bodies included. */
function agentTaskConfigs(): Array<{ id: string; config: Record<string, unknown> }> {
  const out: Array<{ id: string; config: Record<string, unknown> }> = [];
  for (const node of dreamingTemplate().definition.nodes) {
    if (node.type === "agent-task") out.push({ id: node.id, config: node.config });
    if (node.type === "foreach") {
      const body = node.config.body as { type: string; config: Record<string, unknown> };
      out.push({ id: `${node.id}#body`, config: body.config });
    }
  }
  return out;
}

function tokenRoots(value: unknown, roots: string[] = []): string[] {
  if (typeof value === "string") {
    for (const m of value.matchAll(/\{\{([^}]+)\}\}/g)) roots.push(m[1]!.trim().split(".")[0]!);
  } else if (Array.isArray(value)) {
    for (const v of value) tokenRoots(v, roots);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) tokenRoots(v, roots);
  }
  return roots;
}

function gate(id: string): (input: Record<string, unknown>) => string {
  const node = nodeById(id);
  expect(node.type).toBe("code-match");
  const fn = new Function("input", `"use strict"; return (${node.config.code as string})(input);`);
  return (input) => fn(input) as string;
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(TEST_DB_PATH + suffix).catch(() => {});
  }
}

async function waitFor(predicate: () => Promise<boolean>, label: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const isTerminal = (status: string | undefined) =>
  status === "completed" || status === "failed" || status === "cancelled";

async function stepsOf(runId: string) {
  return getWorkflowRunStepsByRunId(runId);
}

async function stepOf(runId: string, nodeId: string) {
  return (await stepsOf(runId)).find((s) => s.nodeId === nodeId);
}

async function runAgentTaskCount(runId: string): Promise<number> {
  const row = await getDbClient().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM agent_tasks WHERE workflowRunId = ?",
    [runId],
  );
  return row?.n ?? 0;
}

async function seededDreaming(): Promise<Workflow> {
  const wf = (await listWorkflows()).find((w) => w.name === "dreaming");
  if (!wf) throw new Error("dreaming was not seeded");
  return wf;
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of DREAMING_KEYS) delete process.env[key];
  delete process.env.API_KEY;
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  setScriptEmbeddingProviderForTests({
    name: "test/noop-dreaming-embedding",
    dimensions: 1,
    async embed() {
      return null;
    },
    async embedBatch(texts: string[]) {
      return texts.map(() => null);
    },
  });
  const results = await runAllSeeders({ quiet: true });
  for (const kind of ["script", "workflow"]) {
    const result = results.find((r) => r.kind === kind);
    expect(result?.failed ?? ["missing"]).toEqual([]);
  }
  // Seeding typechecks every seeded script.
}, 180_000);

afterAll(async () => {
  setScriptEmbeddingProviderForTests(null);
  closeDb();
  await removeDbFiles();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("dreaming template", () => {
  test("parses, validates, resolves every input path, and uses modelTier only", () => {
    const wf = dreamingTemplate();
    expect(validateDefinition(wf.definition)).toEqual({ valid: true, errors: [] });
    expect(wf.definition.onNodeFailure).toBe("continue");
    expect(wf.cooldown).toEqual({ minutes: 60 });
    expect(wf.triggers).toEqual([]);
    expect(wf.requires).toEqual([]);
    expect(wf.requiredParams).toEqual([]);

    const ids = new Set(wf.definition.nodes.map((n) => n.id));
    for (const gone of ["seed-gate", "seed-pr", "memtax-plan", "memtax-create-apply"]) {
      expect(ids.has(gone)).toBe(false);
    }
    for (const present of [
      "adoption-gate",
      "adoption",
      "skills-gate",
      "skills",
      "scriptify-gate",
      "scriptify",
    ]) {
      expect(ids.has(present)).toBe(true);
    }
    // The adoption gate sits between gather and proceed; the two optional lanes fan out of
    // hb-apply and rejoin at verify.
    expect(nodeById("gather").next).toBe("adoption-gate");
    expect(nodeById("adoption-gate").next).toEqual({ run: "adoption", skip: "proceed" });
    expect(nodeById("adoption").next).toBe("proceed");
    expect(nodeById("hb-apply").next).toEqual(["skills-gate", "scriptify-gate"]);
    expect(nodeById("skills-gate").next).toEqual({ run: "skills", skip: "verify" });
    expect(nodeById("scriptify-gate").next).toEqual({ run: "scriptify", skip: "verify" });
    expect(nodeById("skills").next).toBe("verify");
    expect(nodeById("scriptify").next).toBe("verify");
    expect(nodeById("verify").inputs).toMatchObject({
      sk: "skills.taskOutput",
      sc: "scriptify.taskOutput",
    });
    expect(nodeById("publish").inputs).toMatchObject({ ad: "adoption.result" });

    for (const node of wf.definition.nodes) {
      const aliases = node.inputs ?? {};
      for (const [alias, path] of Object.entries(aliases)) {
        const root = path.split(".")[0]!;
        expect({ node: node.id, alias, ok: ids.has(root) || BUILTIN_ROOTS.has(root) }).toEqual({
          node: node.id,
          alias,
          ok: true,
        });
      }
      // Every {{token}} in the config is rooted at a declared alias or a builtin
      // (foreach bodies may also use item / index).
      const allowed = new Set([...Object.keys(aliases), ...BUILTIN_ROOTS]);
      if (node.type === "foreach") {
        allowed.add("item");
        allowed.add("index");
      }
      const bad = tokenRoots(node.config).filter((root) => !allowed.has(root));
      expect({ node: node.id, bad }).toEqual({ node: node.id, bad: [] });
    }

    for (const { id, config } of agentTaskConfigs()) {
      expect({ id, model: config.model }).toEqual({ id, model: undefined });
      expect({ id, hasTier: typeof config.modelTier === "string" }).toEqual({ id, hasTier: true });
    }
    expect(JSON.stringify(wf.definition)).not.toContain('"model"');
  });

  test("agent ids and tiers follow the node table", () => {
    const table: Record<string, [string, string]> = {
      "reports#body": ["{{item.id}}", "regular"],
      "reports-retry#body": ["{{item.id}}", "regular"],
      synthesize: ["{{g.leadId}}", "smart"],
      skills: ["{{g.leadId}}", "smart"],
      scriptify: ["{{g.workerId}}", "regular"],
      "trim#body": ["{{g.workerId}}", "regular"],
      "hb-draft": ["{{g.workerId}}", "regular"],
      "lead-disk": ["{{g.leadId}}", "regular"],
      publish: ["{{g.workerId}}", "regular"],
    };
    const got = Object.fromEntries(
      agentTaskConfigs().map(({ id, config }) => [id, [config.agentId, config.modelTier]]),
    );
    expect(got).toEqual(table);
  });

  test("every swarm-script node calls a seeded dream-* script with args its schema declares", async () => {
    const seededScripts = new Set(
      (
        await getDbClient().query<{ name: string }>(
          "SELECT name FROM scripts WHERE scope = 'global'",
        )
      ).map((r) => r.name),
    );
    for (const node of dreamingTemplate().definition.nodes) {
      if (node.type !== "swarm-script") continue;
      const name = node.config.scriptName as string;
      expect({ node: node.id, scope: node.config.scope }).toEqual({
        node: node.id,
        scope: "global",
      });
      expect({ node: node.id, seeded: seededScripts.has(name) }).toEqual({
        node: node.id,
        seeded: true,
      });
      const declared = Object.keys(SCRIPTS[name]!.args.shape);
      const extra = Object.keys(node.config.args as object).filter((k) => !declared.includes(k));
      expect({ node: node.id, extra }).toEqual({ node: node.id, extra: [] });
    }
  });

  test("input defaults match the dashboard catalog and every key has a validator", async () => {
    const input = dreamingTemplate().input as Record<string, string>;
    const fromInput = new Map<string, string>();
    for (const value of Object.values(input)) {
      const m = /^\$\{(DREAMING_[A-Z0-9_]+):-(.*)\}$/.exec(value);
      if (m) fromInput.set(m[1]!, m[2]!);
    }

    // apps/ui is not importable from root tests: parse the catalog source.
    const catalog = await readFile(CATALOG_PATH, "utf8");
    const fromCatalog = new Map<string, string>();
    const chunks = catalog.split(/key:\s*"/).slice(1);
    for (const chunk of chunks) {
      const key = chunk.slice(0, chunk.indexOf('"'));
      if (!key.startsWith("DREAMING_")) continue;
      const def = /defaultValue:\s*"([^"]*)"/.exec(chunk);
      fromCatalog.set(key, def ? def[1]! : "<no defaultValue>");
    }
    // Positive control: the parser finds a known entry.
    expect(fromCatalog.get("DREAMING_ENABLED")).toBe("false");

    expect([...fromInput.keys()].sort()).toEqual([...DREAMING_KEYS].sort());
    expect([...fromCatalog.keys()].sort()).toEqual([...DREAMING_KEYS].sort());
    for (const key of DREAMING_KEYS) {
      expect({ key, def: fromInput.get(key) }).toEqual({ key, def: fromCatalog.get(key) });
      expect({ key, defaultValid: validateConfigValue(key, fromInput.get(key)) }).toEqual({
        key,
        defaultValid: null,
      });
      if (UNVALIDATED_KEYS.has(key)) continue;
      expect({ key, rejectsJunk: validateConfigValue(key, "junk value §") !== null }).toEqual({
        key,
        rejectsJunk: true,
      });
    }
  });

  test("gate truth table", () => {
    const LANES_ON = {
      heartbeat: true,
      trim: true,
      identity: true,
      memory: true,
      skillify: true,
      scriptify: true,
    };
    const g = (over: Record<string, unknown> = {}) => ({
      ok: true,
      mode: "live",
      dryRun: false,
      agents: [{ id: "a" }],
      lanes: LANES_ON,
      caps: { skillCreate: 1, skillUpdate: 3, scriptBuilds: 1 },
      cfg: { slackChannel: "dreaming-reports", reportTarget: "page", budgetUsd: 25, gateDays: 14 },
      budget: { overBudget: false },
      ...over,
    });

    const proceed = gate("proceed");
    expect(proceed({ g: g() })).toBe("go");
    expect(proceed({ g: g({ mode: "off", ok: true, agents: [] }) })).toBe("skip");
    expect(proceed({ g: g({ mode: "off" }) })).toBe("skip");
    expect(proceed({ g: g({ agents: [] }) })).toBe("skip");
    expect(proceed({ g: g({ ok: false, reason: "no lead" }) })).toBe("skip");
    expect(proceed({})).toBe("skip");

    // The adoption gate runs whenever dreaming is on with a Lead, quiet nights included.
    const adoptionGate = gate("adoption-gate");
    expect(adoptionGate({ g: g() })).toBe("run");
    expect(adoptionGate({ g: g({ agents: [] }) })).toBe("run");
    expect(adoptionGate({ g: g({ mode: "dry-run", dryRun: true }) })).toBe("run");
    expect(adoptionGate({ g: g({ mode: "off" }) })).toBe("skip");
    expect(adoptionGate({ g: g({ ok: false, reason: "no lead" }) })).toBe("skip");
    expect(adoptionGate({})).toBe("skip");

    const autoSkill = { id: "A1", lane: "skillify", tier: "auto", op: "skill-create" };
    const skillsGate = gate("skills-gate");
    expect(skillsGate({ g: g(), s: { actions: [autoSkill] } })).toBe("run");
    expect(
      skillsGate({
        g: g(),
        s: { actions: [{ ...autoSkill, lane: "skill-refactor", op: "skill-update" }] },
      }),
    ).toBe("run");
    // Lane off: skip even with auto actions.
    expect(
      skillsGate({
        g: g({ lanes: { ...LANES_ON, skillify: false } }),
        s: { actions: [autoSkill] },
      }),
    ).toBe("skip");
    expect(
      skillsGate({
        g: g({ lanes: { ...LANES_ON, skillify: undefined } }),
        s: { actions: [autoSkill] },
      }),
    ).toBe("skip");
    // Both skill caps at 0 is propose-only.
    expect(
      skillsGate({
        g: g({ caps: { skillCreate: 0, skillUpdate: 0, scriptBuilds: 1 } }),
        s: { actions: [autoSkill] },
      }),
    ).toBe("skip");
    expect(skillsGate({ g: g(), s: { actions: [{ ...autoSkill, tier: "propose" }] } })).toBe(
      "skip",
    );
    expect(skillsGate({ g: g(), s: { actions: [{ ...autoSkill, op: "skill-disable" }] } })).toBe(
      "skip",
    );
    expect(skillsGate({ g: g(), s: { actions: [{ ...autoSkill, lane: "memory" }] } })).toBe("skip");
    expect(skillsGate({ g: g(), s: "" })).toBe("skip");

    const scriptAction = { id: "A2", lane: "scriptify", tier: "propose", op: "script-build" };
    const scriptifyGate = gate("scriptify-gate");
    expect(scriptifyGate({ g: g(), s: { actions: [scriptAction] } })).toBe("run");
    expect(
      scriptifyGate({
        g: g({ lanes: { ...LANES_ON, scriptify: false } }),
        s: { actions: [scriptAction] },
      }),
    ).toBe("skip");
    expect(
      scriptifyGate({
        g: g({ caps: { skillCreate: 1, skillUpdate: 3, scriptBuilds: 0 } }),
        s: { actions: [scriptAction] },
      }),
    ).toBe("skip");
    expect(scriptifyGate({ g: g(), s: { actions: [autoSkill] } })).toBe("skip");
    expect(scriptifyGate({ g: g(), s: "" })).toBe("skip");

    const slack = gate("slack-gate");
    const p = { slackText: ":crescent_moon: Dreaming" };
    expect(slack({ g: g(), p })).toBe("post");
    expect(slack({ g: g({ dryRun: true }), p })).toBe("skip");
    expect(slack({ g: g({ cfg: { slackChannel: "" } }), p })).toBe("skip");
    expect(slack({ g: g({ cfg: { slackChannel: "   " } }), p })).toBe("skip");
    expect(slack({ g: g(), p: { slackText: "" } })).toBe("skip");
    expect(slack({ g: g(), p: "" })).toBe("skip");

    const hbDraft = gate("hb-draft-gate");
    const hp = {
      ok: true,
      chars: 9000,
      targets: { maxChars: 6000 },
      candidates: { remove: [] },
      deferredToHeartbeat: [],
      mustRestore: [],
    };
    expect(hbDraft({ g: g(), hp })).toBe("draft");
    expect(hbDraft({ g: g(), hp: { ...hp, chars: 100, candidates: { remove: [{}] } } })).toBe(
      "draft",
    );
    expect(hbDraft({ g: g(), hp: { ...hp, chars: 100 } })).toBe("skip");
    // hb-plan's lane-off shape has no sizes to compare: the gate must not throw on it.
    expect(
      hbDraft({
        g: g(),
        hp: { ok: true, skipReason: "lane off", chars: 0, candidates: { remove: [] } },
      }),
    ).toBe("skip");
    expect(hbDraft({ g: g({ budget: { overBudget: true } }), hp })).toBe("skip");
    expect(
      hbDraft({
        g: g({ lanes: { ...LANES_ON, heartbeat: false } }),
        hp,
      }),
    ).toBe("skip");
    expect(hbDraft({ g: g(), hp: "" })).toBe("skip");

    const hbGate = gate("hb-gate");
    expect(hbGate({ g: g(), c: { ready: true } })).toBe("run");
    expect(hbGate({ g: g(), c: { ready: false } })).toBe("skip");
    expect(
      hbGate({
        g: g({ lanes: { ...LANES_ON, heartbeat: false } }),
        c: { ready: true },
      }),
    ).toBe("skip");
  });

  test("leak grep: no uuid, Slack channel id or agent-fs org/drive reference", async () => {
    const leaks = [
      { name: "uuid", re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
      { name: "slack channel id", re: /\b[CG]0[A-Z0-9]{7,}\b/ },
      { name: "agent-fs org/drive", re: /agent-fs[^\n]*--(org|drive)\b|live\.agent-fs\.dev\/file/ },
      { name: "internal loop name", re: /dreaming-v2/ },
    ];
    // Positive control: each matcher fires on a known leak.
    const control = [
      "id 392816e8-a095-498f-a05f-9a1cf61db17d",
      "post to C0A4J7GB0UD",
      "agent-fs --org x cat y",
      "the dreaming-v2 loop",
    ];
    leaks.forEach((leak, i) => {
      expect(leak.re.test(control[i]!)).toBe(true);
    });

    const files: string[] = [];
    for (const dir of [TEMPLATE_DIR, SCHEDULE_DIR]) {
      const names = await readdir(dir).catch(() => [] as string[]);
      files.push(...names.map((n) => join(dir, n)));
    }
    const guides = await readdir(GUIDES_DIR).catch(() => [] as string[]);
    files.push(
      ...guides
        .filter((n) => n.startsWith("dreaming") && n.endsWith(".mdx"))
        .map((n) => join(GUIDES_DIR, n)),
    );
    expect(files).toContain(join(TEMPLATE_DIR, "content.md"));
    expect(files).toContain(join(TEMPLATE_DIR, "config.json"));

    const found: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const leak of leaks) {
        const m = leak.re.exec(text);
        if (m) found.push(`${file.slice(ROOT.length + 1)}: ${leak.name} "${m[0]}"`);
      }
    }
    expect(found).toEqual([]);
  });
});

describe("dreaming engine runs", () => {
  test.skipIf(SKIP_SANDBOX_SPAWN_TESTS)(
    "DREAMING_ENABLED unset: gather, adoption-gate, proceed, done and no agent tasks",
    async () => {
      delete process.env.DREAMING_ENABLED;
      const bus = new InProcessEventBus();
      const deps: ExecutorDependencies = {
        db,
        eventBus: bus,
        interpolate: (template, ctx) => interpolate(template, ctx).result,
      };
      const registry = createExecutorRegistry(deps);
      const wf = await seededDreaming();
      expect(wf.enabled).toBe(true);

      const runId = await startWorkflowExecution(wf, {}, registry);
      await waitFor(async () => isTerminal((await getWorkflowRun(runId))?.status), "run end");

      const run = await getWorkflowRun(runId);
      const steps = await stepsOf(runId);
      const gatherStep = steps.find((s) => s.nodeId === "gather");
      expect({ status: run?.status, error: run?.error, gather: gatherStep?.error }).toEqual({
        status: "completed",
        error: undefined,
        gather: undefined,
      });
      // The off path is only code-match gates after gather: adoption never runs.
      expect(steps.map((s) => s.nodeId).sort()).toEqual([
        "adoption-gate",
        "done",
        "gather",
        "proceed",
      ]);
      expect(
        (steps.find((s) => s.nodeId === "adoption-gate")?.output as { port: string }).port,
      ).toBe("skip");
      expect((gatherStep?.output as { result: { mode: string } }).result.mode).toBe("off");
      expect(await runAgentTaskCount(runId)).toBe(0);
    },
    60_000,
  );

  test("lanes off: no trim or heartbeat tasks, plans report lane off, verify runs", async () => {
    // The real swarm-script runtime calls the API over HTTP, which this test does not
    // boot. This executor runs the same seeded script modules in process, against the
    // test DB, with the same args the engine interpolates.
    const writes: string[] = [];
    const argErrors: string[] = [];
    const ctx = {
      swarm: new Proxy(
        {
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
          async kv_set({
            namespace,
            key,
            value,
          }: {
            namespace: string;
            key: string;
            value: unknown;
          }) {
            return {
              success: true,
              status: 200,
              data: await upsertKv({ namespace, key, value, valueType: "json" }),
            };
          },
        } as Record<string, unknown>,
        {
          get(target, prop: string) {
            if (prop in target) return target[prop];
            return async () => {
              writes.push(prop);
              return {
                success: false,
                status: 501,
                data: { error: `${prop} is not in the test harness` },
              };
            };
          },
        },
      ),
    };
    class InProcessSwarmScript extends BaseExecutor<
      typeof SwarmScriptConfigSchema,
      typeof InProcessSwarmScript.out
    > {
      static readonly out = z.object({ result: z.unknown(), scriptName: z.string() });
      readonly type = "swarm-script";
      readonly mode = "instant" as const;
      readonly configSchema = SwarmScriptConfigSchema;
      readonly outputSchema = InProcessSwarmScript.out;
      protected async execute(
        config: z.infer<typeof SwarmScriptConfigSchema>,
      ): Promise<ExecutorResult<z.infer<typeof InProcessSwarmScript.out>>> {
        const mod = SCRIPTS[config.scriptName];
        if (!mod) return { status: "failed", error: `unknown script ${config.scriptName}` };
        // The runtime hands args over stdin as JSON.
        const args = JSON.parse(JSON.stringify(config.args));
        const parsed = mod.args.safeParse(args);
        if (!parsed.success) argErrors.push(`${config.scriptName}: ${parsed.error.message}`);
        const result = JSON.parse(JSON.stringify((await mod.run(args, ctx)) ?? null));
        return { status: "success", output: { result, scriptName: config.scriptName } };
      }
    }

    const lead = await createAgent({ name: "dreaming-test-lead", isLead: true, status: "idle" });
    const now = new Date().toISOString();
    getDb().run(
      `INSERT INTO agent_tasks (id, agentId, task, status, source, createdAt, lastUpdatedAt, finishedAt, key)
       VALUES (?, ?, 'ship the release notes', 'completed', 'mcp', ?, ?, ?, 'shared/')`,
      [crypto.randomUUID(), lead.id, now, now, now],
    );

    // The 60-minute cooldown would skip a second run of the same workflow.
    await getDbClient().run("DELETE FROM workflow_run_steps");
    await getDbClient().run("DELETE FROM workflow_runs");

    process.env.DREAMING_ENABLED = "true";
    process.env.DREAMING_LANE_HEARTBEAT = "false";
    process.env.DREAMING_LANE_TRIM = "false";
    try {
      const bus = new InProcessEventBus();
      const deps: ExecutorDependencies = {
        db,
        eventBus: bus,
        interpolate: (template, c) => interpolate(template, c).result,
      };
      const registry = createExecutorRegistry(deps);
      registry.register(new InProcessSwarmScript(deps));
      setupWorkflowResumeListener(bus, registry);

      const complete = async (runId: string, stepId: string, output: unknown) => {
        const task = await getTaskByWorkflowRunStepId(stepId);
        expect(task).not.toBeNull();
        const text = JSON.stringify(output);
        await completeTask(task!.id, text);
        bus.emit("task.completed", {
          taskId: task!.id,
          output: text,
          workflowRunId: runId,
          workflowRunStepId: stepId,
        });
      };
      const waitStep = async (runId: string, nodeId: string) => {
        await waitFor(async () => {
          const step = await stepOf(runId, nodeId);
          return !!step && (await getTaskByWorkflowRunStepId(step.id)) !== null;
        }, `task for ${nodeId}`);
        return (await stepOf(runId, nodeId))!;
      };

      const runId = await startWorkflowExecution(await seededDreaming(), {}, registry);

      const report = await waitStep(runId, `reports#${lead.id}`);
      await complete(runId, report.id, {
        agentId: lead.id,
        summary: "Shipped the release notes; nothing went wrong.",
        repeatedProcedures: [],
        skillFriction: [],
        scriptCandidates: [],
        identityOps: [],
        memoryOps: [],
      });
      const synth = await waitStep(runId, "synthesize");
      await complete(runId, synth.id, {
        headline: "quiet night",
        actions: [],
        rejected: [],
        restores: [],
        missingReports: [],
        notes: "",
        changelogComment: "",
      });
      const publish = await waitStep(runId, "publish");
      await complete(runId, publish.id, {
        slackText: ":crescent_moon: Dreaming (dry run): quiet night",
        trimsLine: "",
      });
      await waitFor(async () => isTerminal((await getWorkflowRun(runId))?.status), "run end");

      const run = await getWorkflowRun(runId);
      expect(run?.status).toBe("completed");
      const steps = await stepsOf(runId);
      const nodeIds = steps.map((s) => s.nodeId);
      const result = (id: string) =>
        (steps.find((s) => s.nodeId === id)?.output as { result: any })?.result;

      expect(result("gather")).toMatchObject({
        ok: true,
        mode: "dry-run",
        dryRun: true,
        leadId: lead.id,
        workerId: lead.id,
        lanes: {
          heartbeat: false,
          trim: false,
          identity: true,
          memory: true,
          skillify: true,
          scriptify: true,
        },
      });
      // The adoption gate runs on a dry run with no artifacts: it reports "no artifacts" and writes nothing.
      expect(result("adoption")).toMatchObject({
        ok: true,
        mode: "dry-run",
        artifacts: 0,
        retired: [],
        wouldRetire: [],
        controls: { ok: false, reason: "no artifacts" },
      });
      expect(result("adoption").controls.negative.ok).toBe(true);
      for (const id of ["skills-gate", "scriptify-gate"]) {
        expect({
          id,
          port: (steps.find((s) => s.nodeId === id)?.output as { port: string })?.port,
        }).toEqual({
          id,
          port: "skip",
        });
      }
      expect(result("trim-plan")).toMatchObject({ targets: [], skipReason: "lane off" });
      expect(result("hb-plan")).toMatchObject({ skipReason: "lane off" });
      expect(nodeIds.filter((id) => id.startsWith("trim#"))).toEqual([]);
      for (const absent of [
        "hb-draft",
        "hb-check",
        "hb-gate",
        "lead-disk",
        "skills",
        "scriptify",
        "slack",
      ]) {
        expect({ absent, ran: nodeIds.includes(absent) }).toEqual({ absent, ran: false });
      }
      expect(steps.find((s) => s.nodeId === "verify")?.status).toBe("completed");
      expect(result("verify")).toBeDefined();
      expect((steps.find((s) => s.nodeId === "slack-gate")?.output as { port: string }).port).toBe(
        "skip",
      );
      expect(nodeIds).toContain("done");

      // The engine-interpolated args satisfy each script's schema, and a dry run calls no write tool.
      expect(argErrors).toEqual([]);
      expect(writes).toEqual([]);
      // Agent tasks: one report, synthesis, publish. Nothing for the lanes that are off.
      expect(await runAgentTaskCount(runId)).toBe(3);
    } finally {
      delete process.env.DREAMING_ENABLED;
      delete process.env.DREAMING_LANE_HEARTBEAT;
      delete process.env.DREAMING_LANE_TRIM;
    }
  }, 60_000);
});
