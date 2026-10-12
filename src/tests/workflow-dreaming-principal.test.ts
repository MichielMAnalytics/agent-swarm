/**
 * Seeded dreaming: the principal its script nodes run as.
 *
 * A seeded workflow row has no `createdByAgentId` and a scheduled trigger carries no agent, so
 * the swarm-script executor used to run every dream-* script as the literal `workflow`, which
 * profile and other privileged writes refuse. The template opts in with `runAs: "lead"`.
 *
 * The run tests use the real executor registry (real SwarmScriptExecutor, sandboxed script
 * subprocess) against an in-process API on an isolated file-backed DB. Never the live DB.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import * as db from "../be/db";
import {
  closeDb,
  completeTask,
  createAgent,
  createWorkflow,
  getDbClient,
  getTaskByWorkflowRunStepId,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
  listWorkflows,
  updateAgentProfile,
  updateWorkflow,
  upsertKv,
} from "../be/db";
import { deleteScript, getScript, upsertScriptByName } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { runAllSeeders } from "../be/seed/registry";
import { recordSeedState } from "../be/seed/state-db";
import {
  resolveSeededWorkflowPrincipal,
  seededLeadPrincipalWorkflowNames,
} from "../be/seed/workflows-seeder";
import { SEED_SCRIPTS } from "../be/seed-scripts";
import { resolveHttpRequestAuth } from "../http/auth";
import { handleDbQuery } from "../http/db-query";
import { handleKv } from "../http/kv";
import { handleMcpBridge } from "../http/mcp-bridge";
import { handleMemory } from "../http/memory";
import { getPathSegments, parseQueryParams } from "../http/utils";
import type { Workflow } from "../types";
import { setRequestAuth } from "../utils/request-auth-context";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";
import { startWorkflowExecution } from "../workflows/engine";
import { InProcessEventBus } from "../workflows/event-bus";
import type { ExecutorDependencies } from "../workflows/executors/base";
import { createExecutorRegistry } from "../workflows/executors/registry";
import { setupWorkflowResumeListener } from "../workflows/resume";
import { interpolate } from "../workflows/template";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";

const TEST_DB_PATH = `/tmp/test-workflow-dreaming-principal-${process.pid}.sqlite`;
const API_KEY = "example-test-workflow-dreaming-principal-key-0123456789";
const LEAD_ID = crypto.randomUUID();
const WORKER_ID = crypto.randomUUID();
const CLAUDE_MD = "# Worker\n\n## Rules\n- keep this rule\n\n## Stale\n- old host foo\n";
const DREAMING_ENV = ["DREAMING_ENABLED", "DREAMING_LANE_HEARTBEAT", "DREAMING_LANE_TRIM"];

const savedEnv = { ...process.env };
let server: Server;
let base = "";
// db_query runs bounded in a child process that opens the DB file, so this suite needs a
// file-backed DB, not the in-memory migration template the test preload installs.
const templateGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
  __savedPrincipalTemplate?: Uint8Array;
};

async function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
}

async function waitFor(predicate: () => Promise<boolean>, label: string, ms = 90_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const isTerminal = (status: string | undefined) =>
  status === "completed" || status === "failed" || status === "cancelled";

async function workerClaude(): Promise<string> {
  const r = await getDbClient().get<{ v: string | null }>(
    "SELECT claudeMd AS v FROM agents WHERE id = ?",
    [WORKER_ID],
  );
  return r?.v ?? "";
}

async function seededDreaming(): Promise<Workflow> {
  const wf = (await listWorkflows()).find((w) => w.name === "dreaming");
  if (!wf) throw new Error("dreaming was not seeded");
  return wf;
}

function realRegistry() {
  const bus = new InProcessEventBus();
  const deps: ExecutorDependencies = {
    db,
    eventBus: bus,
    interpolate: (template, ctx) => interpolate(template, ctx).result,
  };
  const registry = createExecutorRegistry(deps);
  setupWorkflowResumeListener(bus, registry);
  return { bus, registry };
}

// The same auto identity action in both runs: drop the worker's stale CLAUDE section.
const REMOVE_STALE = {
  id: "A1",
  lane: "identity",
  tier: "auto",
  owner: LEAD_ID,
  op: "remove-section",
  target: { agentId: WORKER_ID, file: "CLAUDE", anchor: "## Stale" },
  content: "",
  reason: "dead host",
  evidence: ["t1"],
};

/** A lone live dream-apply node that applies REMOVE_STALE, with no gather or synthesis. */
function applyNode(runId: string) {
  return {
    id: "apply",
    type: "swarm-script",
    config: {
      scriptName: "dream-apply",
      scope: "global",
      timeoutMs: 120_000,
      args: {
        runId,
        dryRun: false,
        synth: { actions: [REMOVE_STALE] },
        lanes: { identity: true, memory: true, trim: false, heartbeat: false },
      },
    },
  };
}

/** Earlier runs in this file would trip the dreaming workflow's 60-minute cooldown. */
async function ageRuns(workflowId: string) {
  const aged = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  await getDbClient().run(
    `UPDATE workflow_runs SET startedAt = ?, finishedAt = CASE WHEN finishedAt IS NULL THEN NULL ELSE ? END
     WHERE workflowId = ?`,
    [aged, aged, workflowId],
  );
}

beforeAll(async () => {
  templateGlobals.__savedPrincipalTemplate = templateGlobals.__testMigrationTemplate;
  templateGlobals.__testMigrationTemplate = undefined;
  closeDb();
  await removeDbFiles();
  for (const key of DREAMING_ENV) delete process.env[key];
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  delete process.env.API_KEY;
  refreshSecretScrubberCache();
  initDb(TEST_DB_PATH);
  setScriptEmbeddingProviderForTests({
    name: "test/noop-dreaming-principal-embedding",
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
    expect(results.find((r) => r.kind === kind)?.failed ?? ["missing"]).toEqual([]);
  }
  await createAgent({ id: LEAD_ID, name: "principal-lead", isLead: true, status: "idle" } as any);
  await createAgent({
    id: WORKER_ID,
    name: "principal-worker",
    isLead: false,
    status: "idle",
  } as any);

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
}, 180_000);

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  setScriptEmbeddingProviderForTests(null);
  closeDb();
  templateGlobals.__testMigrationTemplate = templateGlobals.__savedPrincipalTemplate;
  templateGlobals.__savedPrincipalTemplate = undefined;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  refreshSecretScrubberCache();
  await removeDbFiles();
});

describe("resolveSeededWorkflowPrincipal", () => {
  const source = (name: string, runAs?: "lead") => ({
    config: JSON.stringify({ name, description: name, runAllSeedersCandidate: true, runAs }),
    content: '```json\n{"nodes": []}\n```',
  });
  /** A workflow row with exactly the template's content, as the seeder writes it. */
  const rowFor = async (name: string) =>
    createWorkflow({ name, description: name, definition: { nodes: [], onNodeFailure: "fail" } });

  test("only an opted-in, seeder-recorded, unedited row resolves to the Lead", async () => {
    const sources = [source("principal-optin", "lead"), source("principal-plain")];
    expect([...seededLeadPrincipalWorkflowNames(sources)]).toEqual(["principal-optin"]);
    expect(seededLeadPrincipalWorkflowNames().has("dreaming")).toBe(true);
    const optin = await rowFor("principal-optin");
    const plain = await rowFor("principal-plain");

    // No seed_state row: a same-name workflow the seeder never wrote gets no principal.
    expect(await resolveSeededWorkflowPrincipal(optin, sources)).toBe(undefined);
    await recordSeedState("workflow", "principal-optin", "h");
    await recordSeedState("workflow", "principal-plain", "h");
    expect(await resolveSeededWorkflowPrincipal(optin, sources)).toBe(LEAD_ID);
    // Seeded but not opted in: unchanged behaviour.
    expect(await resolveSeededWorkflowPrincipal(plain, sources)).toBe(undefined);
    // Edited after seeding: an extra node means the row no longer is the shipped template.
    const edited = await updateWorkflow(optin.id, {
      definition: {
        nodes: [{ id: "x", type: "swarm-script", config: { scriptName: "dream-apply" } }],
        onNodeFailure: "fail",
      },
    });
    expect(await resolveSeededWorkflowPrincipal(edited!, sources)).toBe(undefined);
  });

  test("the seeded dreaming row resolves to the Lead until someone edits it", async () => {
    const wf = await seededDreaming();
    expect(wf.createdByAgentId ?? null).toBeNull();
    expect(await resolveSeededWorkflowPrincipal(wf)).toBe(LEAD_ID);
    const edited = await updateWorkflow(wf.id, {
      definition: { ...wf.definition, nodes: [...wf.definition.nodes].slice(0, -1) },
    });
    try {
      expect(await resolveSeededWorkflowPrincipal(edited!)).toBe(undefined);
    } finally {
      await updateWorkflow(wf.id, { definition: wf.definition });
    }
    expect(await resolveSeededWorkflowPrincipal(await seededDreaming())).toBe(LEAD_ID);
  });
});

describe("seeded dreaming on the real script runtime", () => {
  const spawnTest = test.skipIf(SKIP_SANDBOX_SPAWN_TESTS);

  spawnTest(
    "negative control: a creator-less, non-seeded workflow runs dream-apply as `workflow` and the write is refused",
    async () => {
      await updateAgentProfile(WORKER_ID, { claudeMd: CLAUDE_MD });
      const wf = await createWorkflow({
        name: `principal-control-${crypto.randomUUID()}`,
        definition: {
          nodes: [applyNode("principal-control")],
          onNodeFailure: "continue",
        },
      });
      expect(wf.createdByAgentId ?? null).toBeNull();
      const { registry } = realRegistry();
      const runId = await startWorkflowExecution(wf, {}, registry, { triggerType: "schedule" });
      await waitFor(async () => isTerminal((await getWorkflowRun(runId))?.status), "run end");

      const step = (await getWorkflowRunStepsByRunId(runId)).find((s) => s.nodeId === "apply");
      const result = (step?.output as { result?: any } | undefined)?.result;
      expect(result?.applied ?? []).toEqual([]);
      expect(await workerClaude()).toBe(CLAUDE_MD);
    },
    180_000,
  );

  /**
   * One enabled live dreaming run on a scheduled trigger (no creator, no trigger agent),
   * with the agent steps completed by hand. Returns the gather and apply results.
   */
  async function runLiveDreaming(): Promise<{ gather: any; apply: any }> {
    await updateAgentProfile(WORKER_ID, { claudeMd: CLAUDE_MD });
    const now = new Date().toISOString();
    await getDbClient().run(
      `INSERT INTO agent_tasks (id, agentId, task, status, source, createdAt, lastUpdatedAt, finishedAt, key)
         VALUES (?, ?, 'tidy the release board', 'completed', 'mcp', ?, ?, ?, 'shared/')`,
      [crypto.randomUUID(), LEAD_ID, now, now, now],
    );
    // A prior green dry run admits live mode.
    await upsertKv({
      namespace: "dreaming",
      key: "state:last-green-dry-run",
      value: { runId: "earlier-dry-run", at: now },
      valueType: "json",
    });
    process.env.DREAMING_ENABLED = "true";
    process.env.DREAMING_LANE_HEARTBEAT = "false";
    process.env.DREAMING_LANE_TRIM = "false";
    try {
      const { bus, registry } = realRegistry();
      const complete = async (runId: string, stepId: string, output: unknown) => {
        const task = await getTaskByWorkflowRunStepId(stepId);
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
        const stepOf = async () =>
          (await getWorkflowRunStepsByRunId(runId)).find((s) => s.nodeId === nodeId);
        await waitFor(async () => {
          const step = await stepOf();
          return !!step && (await getTaskByWorkflowRunStepId(step.id)) !== null;
        }, `task for ${nodeId}`);
        return (await stepOf())!;
      };

      const workflow = await seededDreaming();
      await ageRuns(workflow.id);
      // Scheduled-trigger shape: no agentId in the trigger, no creator on the row.
      const runId = await startWorkflowExecution(workflow, {}, registry, {
        triggerType: "schedule",
      });
      const report = await waitStep(runId, `reports#${LEAD_ID}`);
      await complete(runId, report.id, {
        agentId: LEAD_ID,
        summary: "Tidied the release board.",
        repeatedProcedures: [],
        skillFriction: [],
        scriptCandidates: [],
        identityOps: [],
        memoryOps: [],
      });
      const synth = await waitStep(runId, "synthesize");
      await complete(runId, synth.id, {
        headline: "drop a stale section",
        actions: [REMOVE_STALE],
        rejected: [],
        restores: [],
        missingReports: [],
        notes: "",
        changelogComment: "",
      });
      const publish = await waitStep(runId, "publish");
      await complete(runId, publish.id, { slackText: "dreaming: one edit", trimsLine: "" });
      await waitFor(async () => isTerminal((await getWorkflowRun(runId))?.status), "run end");

      const steps = await getWorkflowRunStepsByRunId(runId);
      const out = (id: string) =>
        (steps.find((s) => s.nodeId === id)?.output as { result: any } | undefined)?.result;
      return { gather: out("gather"), apply: out("apply") };
    } finally {
      for (const key of DREAMING_ENV) delete process.env[key];
    }
  }

  /** Who wrote the latest claudeMd version of the worker. */
  async function lastClaudeWriter(): Promise<string | null | undefined> {
    const version = await getDbClient().get<{ changedByAgentId: string | null }>(
      `SELECT changedByAgentId FROM context_versions WHERE agentId = ? AND field = 'claudeMd'
       ORDER BY version DESC LIMIT 1`,
      [WORKER_ID],
    );
    return version?.changedByAgentId;
  }

  async function writeGlobalDreamApply(source: string) {
    const current = await getScript({ name: "dream-apply", scope: "global" });
    const shipped = SEED_SCRIPTS.find((s) => s.name === "dream-apply")!;
    return upsertScriptByName({
      name: "dream-apply",
      scope: "global",
      scopeId: null,
      source,
      description: shipped.description,
      intent: shipped.intent,
      signatureJson: current?.signatureJson ?? "{}",
      argsJsonSchema: current?.argsJsonSchema ?? null,
      typeChecked: true,
      embeddingMode: "skip",
    });
  }

  const pristineDreamApply = () => SEED_SCRIPTS.find((s) => s.name === "dream-apply")!.source;

  /** An auto identity edit the shipped dream-apply makes as Lead; any other principal is refused. */
  async function expectNotLead(run: { gather: any; apply: any }) {
    // The other dreaming nodes are pristine and still run as the Lead.
    expect(run.gather).toMatchObject({ mode: "live", dryRun: false, leadId: LEAD_ID });
    expect(run.apply?.applied ?? []).toEqual([]);
    expect(await workerClaude()).toBe(CLAUDE_MD);
    expect(await lastClaudeWriter()).not.toBe(LEAD_ID);
  }

  spawnTest(
    "enabled live run on a scheduled trigger applies the identity edit as the Lead",
    async () => {
      const { gather, apply } = await runLiveDreaming();
      expect(gather).toMatchObject({ mode: "live", dryRun: false, leadId: LEAD_ID });
      expect({ refused: apply?.refused, silently: apply?.refusedSilently }).toEqual({
        refused: [],
        silently: [],
      });
      expect(apply?.applied?.map((a: any) => a.actionId)).toEqual(["A1"]);

      // Re-read: the section is gone, and the version row names the Lead as the writer.
      const claude = await workerClaude();
      expect(claude).toContain("## Rules");
      expect(claude).not.toContain("## Stale");
      expect(await lastClaudeWriter()).toBe(LEAD_ID);
    },
    240_000,
  );

  spawnTest(
    "an edited global dream-apply runs as a non-Lead principal and the write is refused",
    async () => {
      const pristine = await getScript({ name: "dream-apply", scope: "global" });
      const edited = await writeGlobalDreamApply(
        `${pristineDreamApply()}\nexport const userEdited = true;\n`,
      );
      expect(edited.script.id).toBe(pristine!.id);
      expect(edited.script.contentHash).not.toBe(pristine!.contentHash);
      try {
        await expectNotLead(await runLiveDreaming());
      } finally {
        await writeGlobalDreamApply(pristineDreamApply());
      }
    },
    240_000,
  );

  spawnTest(
    "a same-name replacement of dream-apply runs as a non-Lead principal and the write is refused",
    async () => {
      const pristine = await getScript({ name: "dream-apply", scope: "global" });
      expect(await deleteScript({ name: "dream-apply", scope: "global" })).toBe(true);
      const replaced = await writeGlobalDreamApply(
        `${pristineDreamApply()}\n// replaced under the same name\n`,
      );
      expect(replaced.isNew).toBe(true);
      expect(replaced.script.id).not.toBe(pristine!.id);
      try {
        await expectNotLead(await runLiveDreaming());
      } finally {
        await deleteScript({ name: "dream-apply", scope: "global" });
        await writeGlobalDreamApply(pristineDreamApply());
      }
      // The restored row is the shipped source again, for the tests after this one.
      const restored = await getScript({ name: "dream-apply", scope: "global" });
      expect(restored?.contentHash).toBe(pristine!.contentHash);
    },
    240_000,
  );

  spawnTest(
    "a run that captured an edited definition gets no Lead after the stored row is restored",
    async () => {
      await updateAgentProfile(WORKER_ID, { claudeMd: CLAUDE_MD });
      const stored = await seededDreaming();
      await ageRuns(stored.id);
      // The stored row is the shipped template and resolves to the Lead; the run
      // walks an edited copy, as if the row was restored after the run started.
      expect(await resolveSeededWorkflowPrincipal(stored)).toBe(LEAD_ID);
      const captured = {
        ...stored,
        definition: { nodes: [applyNode("principal-toctou")], onNodeFailure: "continue" as const },
      };
      const { registry } = realRegistry();
      const runId = await startWorkflowExecution(captured, {}, registry, {
        triggerType: "schedule",
      });
      await waitFor(async () => isTerminal((await getWorkflowRun(runId))?.status), "run end");

      const step = (await getWorkflowRunStepsByRunId(runId)).find((s) => s.nodeId === "apply");
      const result = (step?.output as { result?: any } | undefined)?.result;
      expect(step?.status).toBe("completed");
      expect(result?.applied ?? []).toEqual([]);
      expect(await workerClaude()).toBe(CLAUDE_MD);
      expect(await lastClaudeWriter()).not.toBe(LEAD_ID);
    },
    180_000,
  );
});
