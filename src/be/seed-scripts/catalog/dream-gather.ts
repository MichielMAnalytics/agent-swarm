import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

// Dreaming node 1: deterministic last-N-day gather, plus the one normalized config block (`cfg`, `lanes`,
// `caps`, `mode`) every later node reads. See the dreaming design (gather node).
// Never throws: a thrown swarm-script error fails the whole run even under onNodeFailure:"continue".

const NS = "dreaming";
const OVERLAP_SCHEDULES = ["daily-compounding-reflection"];
const REPORT_TARGETS = ["page", "agent-fs", "none"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The workflow passes config values as strings resolved from `${KEY:-default}` inputs, so every scalar
// accepts string | number | boolean and is parsed below (bools from "true"/"false"/"1"/"0", clamped ints).
const scalar = z.union([z.string(), z.number(), z.boolean()]).nullable().optional();

/** Arguments for the dreaming gather node. */
export const argsSchema = z.object({
  runId: z.string().nullable().optional().describe("Workflow run id of this dreaming run (self-exclusion)"),
  days: scalar.describe("Look-back window in days (default 1)"),
  dryRun: scalar.describe("Force a dry run (no writes downstream)"),
  onlyAgentIds: z
    .union([z.array(z.string()), z.string()])
    .nullable()
    .optional()
    .describe("Restrict the roster to these agent ids (array or JSON array string)"),
  minTasks: scalar.describe("Minimum tasks in the window for an agent to be reflected on (default 1)"),
  enabled: scalar.describe("DREAMING_ENABLED; false returns mode off before any heavy query"),
  laneHeartbeat: scalar.describe("Lead HEARTBEAT prune lane (default true)"),
  laneTrim: scalar.describe("Profile trim lane (default true)"),
  laneIdentity: scalar.describe("Identity edit lane (default true)"),
  laneMemory: scalar.describe("Memory triage lane (default true)"),
  laneSkillify: scalar.describe("Skill create/update lane, adoption-gated (default true)"),
  laneScriptify: scalar.describe("Script build lane, adoption-gated (default true)"),
  gateDays: scalar.describe("Adoption gate: days an unused dreaming artifact lives; 0 never retires (default 14)"),
  slackChannel: scalar.describe("Slack channel for the nightly summary; empty means no post"),
  reportTarget: scalar.describe('Where the nightly report goes: "page" (default), "agent-fs" or "none"'),
  workerAgentId: scalar.describe("Agent that runs the worker lanes; empty or unknown means Lead"),
  budgetUsd: scalar.describe("Nightly budget in USD, 1..1000 (default 25)"),
  capIdentityTotal: scalar.describe("Max identity ops per night (default 6)"),
  capIdentityPerAgent: scalar.describe("Max identity ops per agent per night (default 1)"),
  capTrims: scalar.describe("Max profile trims per night (default 3)"),
  capMemoryStore: scalar.describe("Max memory stores per night (default 5)"),
  capMemoryEdit: scalar.describe("Max memory edits per night (default 5)"),
  capMemoryDelete: scalar.describe("Max memory deletes per night (default 10)"),
  capSkillCreate: scalar.describe("Max skills created per night (default 1)"),
  capSkillUpdate: scalar.describe("Max skills updated per night (default 3)"),
  capScriptBuilds: scalar.describe("Max scripts built per night (default 1)"),
});

// true / false for a recognizable boolean, undefined for absent, empty or anything else.
function parseBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1 ? true : v === 0 ? false : undefined;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
  }
  return undefined;
}

// Integer from a number or numeric string, clamped to [min, max]; `def` when absent or unparseable.
function parseInt0(v: unknown, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  let n = Number.NaN;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && v.trim() !== "") n = Number(v.trim());
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

const parseStr = (v: unknown): string =>
  typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";

const sha = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s ?? ""))))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const rows = (r: any): any[] => {
  const d = r?.data ?? r;
  if (d?.error) throw new Error(String(d.error));
  if (!Array.isArray(d?.rows)) throw new Error("db_query returned no rows array (throttled?)");
  const c: string[] = d?.columns ?? [];
  return d.rows.map((x: any[]) => Object.fromEntries(c.map((k, i) => [k, x[i]])));
};

// H2 lines outside fenced code.
function maskFenced(text: string): string {
  const lines = text.split(/(?<=\n)/);
  const masked = [...lines];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.replace(/\r?\n$/, "").match(/^ {0,3}(`{3,}|~{3,})/);
    if (!m) continue;
    const ch = m[1]![0]!;
    const len = m[1]!.length;
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.replace(/\r?\n$/, "").trim();
      if (t.length >= len && [...t].every((c) => c === ch)) {
        close = j;
        break;
      }
    }
    if (close === -1) continue;
    for (let k = i; k <= close; k++) masked[k] = lines[k]!.replace(/[^\r\n]/g, " ");
    i = close;
  }
  return masked.join("");
}
const h2 = (t: string) =>
  maskFenced(t ?? "")
    .split(/\r?\n/)
    .filter((l) => /^## (?!#)/.test(l));

function parseOnly(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x.length > 0);
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p.filter((x) => typeof x === "string");
    } catch {}
  }
  return [];
}

/** Gather the last N days of swarm evidence per agent and the normalized dreaming config (mode, lanes, caps, cfg). */
export default async function (args: unknown, ctx: ScriptContext) {
  const errors: string[] = [];
  const p = argsSchema.safeParse(args ?? {});
  if (!p.success) return { ok: false, errors: [p.error.message], agents: [], skippedAgents: [], swarm: {} };
  const a = p.data;
  const raw = (args ?? {}) as Record<string, unknown>;

  // Normalized config block. An absent lane is on; an explicit false is off.
  const lanes = {
    heartbeat: parseBool(a.laneHeartbeat) ?? true,
    trim: parseBool(a.laneTrim) ?? true,
    identity: parseBool(a.laneIdentity) ?? true,
    memory: parseBool(a.laneMemory) ?? true,
    skillify: parseBool(a.laneSkillify) ?? true,
    scriptify: parseBool(a.laneScriptify) ?? true,
  };
  const caps = {
    identityOpsTotal: parseInt0(a.capIdentityTotal, 6),
    identityOpsPerAgent: parseInt0(a.capIdentityPerAgent, 1),
    trims: parseInt0(a.capTrims, 3),
    memoryStore: parseInt0(a.capMemoryStore, 5),
    memoryEdit: parseInt0(a.capMemoryEdit, 5),
    memoryDelete: parseInt0(a.capMemoryDelete, 10),
    skillCreate: parseInt0(a.capSkillCreate, 1),
    skillUpdate: parseInt0(a.capSkillUpdate, 3),
    scriptBuilds: parseInt0(a.capScriptBuilds, 1),
  };
  const reportTargetRaw = parseStr(a.reportTarget);
  const reportTarget = (REPORT_TARGETS as readonly string[]).includes(reportTargetRaw)
    ? (reportTargetRaw as (typeof REPORT_TARGETS)[number])
    : "page";
  if (reportTargetRaw && reportTarget !== reportTargetRaw) errors.push(`reportTarget "${reportTargetRaw.slice(0, 40)}" unknown; using "page"`);
  const cfg = {
    slackChannel: parseStr(a.slackChannel),
    reportTarget,
    budgetUsd: parseInt0(a.budgetUsd, 25, 1, 1000),
    gateDays: parseInt0(a.gateDays, 14),
  };
  // An absent `enabled` (manual run) is on; an unparseable value fails closed.
  const enabledRaw = raw.enabled;
  const enabledParsed = parseBool(enabledRaw);
  const enabled =
    enabledParsed ?? (enabledRaw === undefined || enabledRaw === null || enabledRaw === "" ? true : false);
  if (enabledParsed === undefined && !enabled) errors.push(`enabled "${String(enabledRaw).slice(0, 40)}" unparseable; treating as off`);

  if (!enabled) {
    return { ok: true, mode: "off" as const, dryRun: true, runId: a.runId ?? null, agents: [], lanes, caps, cfg, overlap: [], errors };
  }

  const days = parseInt0(a.days, 1, 1);
  const minTasks = parseInt0(a.minTasks, 1);
  const forcedDry = parseBool(a.dryRun) === true;
  const only = parseOnly(a.onlyAgentIds);
  const win = `-${days} days`;
  const generatedAt = new Date().toISOString();
  const windowStart = new Date(Date.now() - days * 86400000).toISOString();

  const q = async (label: string, sql: string, params: unknown[] = []): Promise<any[] | null> => {
    try {
      return rows(await ctx.swarm.db_query({ sql, params }));
    } catch (e: any) {
      errors.push(`${label}: ${String(e?.message ?? e).slice(0, 200)}`);
      return null;
    }
  };

  // Lead id: online Lead first, newest activity next. No Lead means no run.
  const leads =
    (await q(
      "lead",
      `SELECT id, status FROM agents WHERE isLead = 1 AND name NOT LIKE 'ext:%'
       ORDER BY (status IN ('idle','busy')) DESC, lastActivityAt DESC LIMIT 1`,
    )) ?? [];
  const leadId: string | null = leads[0]?.id ?? null;

  // Mode: dry-run when forced or before the first green dry run; live after.
  let lastGreenDryRun: { runId: string | null; at: string | null } | null = null;
  try {
    const g: any = await ctx.swarm.kv_getOrNull({ namespace: NS, key: "state:last-green-dry-run" });
    if (g?.value) lastGreenDryRun = { runId: g.value.runId ?? null, at: g.value.at ?? null };
  } catch (e: any) {
    errors.push(`lastGreenDryRun: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  const mode: "dry-run" | "live" = forcedDry || !lastGreenDryRun ? "dry-run" : "live";
  const dryRun = mode !== "live";

  if (!leadId) {
    return {
      ok: false,
      reason: "no lead",
      mode,
      dryRun,
      runId: a.runId ?? null,
      leadId: null,
      workerId: null,
      agents: [],
      skippedAgents: [],
      lanes,
      caps,
      cfg,
      overlap: [],
      errors,
    };
  }

  // Worker: a configured uuid of an existing agent, else Lead.
  const workerRaw = parseStr(a.workerAgentId);
  let workerId: string = leadId;
  if (workerRaw) {
    const hit = UUID_RE.test(workerRaw) ? await q("worker", `SELECT id FROM agents WHERE id = ?`, [workerRaw]) : null;
    if (hit?.length) workerId = String(hit[0].id);
    else errors.push("workerAgentId is not the id of an existing agent; using Lead");
  }

  // Overlap: schedules that do the same nightly job.
  const overlapRows = await q(
    "overlap",
    `SELECT name FROM scheduled_tasks WHERE enabled = 1 AND name IN (${OVERLAP_SCHEDULES.map(() => "?").join(",")})`,
    OVERLAP_SCHEDULES,
  );
  const overlap: string[] = (overlapRows ?? []).map((r: any) => String(r.name));

  // Self-exclusion: every run of THIS workflow, by durable workflowId (survives renames).
  const SELF = `(SELECT r.id FROM workflow_runs r WHERE r.workflowId = (SELECT workflowId FROM workflow_runs WHERE id = ?))`;
  const selfP = [a.runId ?? ""];

  const roster =
    (await q(
      "roster",
      `SELECT id, name, isLead, soulMd, identityMd, claudeMd, toolsMd, heartbeatMd
       FROM agents WHERE status IN ('idle','busy') AND name NOT LIKE 'ext:%' ORDER BY isLead DESC, name`,
    )) ?? [];
  const stats =
    (await q(
      "taskStats",
      `SELECT agentId, COUNT(*) total, SUM(status='completed') completed, SUM(status='failed') failed,
         SUM(status='cancelled') cancelled, SUM(scheduleId IS NOT NULL) fromSchedules
       FROM agent_tasks WHERE julianday(createdAt) > julianday('now', ?)
         AND (workflowRunId IS NULL OR workflowRunId NOT IN ${SELF}) GROUP BY agentId`,
      [win, ...selfP],
    )) ?? [];
  const cost =
    (await q(
      "cost",
      `SELECT agentId, ROUND(SUM(totalCostUsd), 2) usd FROM session_costs
       WHERE julianday(createdAt) > julianday('now', ?) GROUP BY agentId`,
      [win],
    )) ?? [];
  const recent =
    (await q(
      "recent",
      `SELECT * FROM (SELECT t.agentId, t.id, t.status, COALESCE(t.title, substr(t.task,1,160)) title,
         s.name scheduleName, t.failureReason,
         ROW_NUMBER() OVER (PARTITION BY t.agentId ORDER BY (t.scheduleId IS NULL) DESC, t.createdAt DESC) rn
       FROM agent_tasks t LEFT JOIN scheduled_tasks s ON s.id = t.scheduleId
       WHERE julianday(t.createdAt) > julianday('now', ?)
         AND (t.workflowRunId IS NULL OR t.workflowRunId NOT IN ${SELF})) WHERE rn <= 12`,
      [win, ...selfP],
    )) ?? [];
  const invokes = await q(
    "skillInvokes",
    `SELECT agentId, json_extract(data,'$.skillName') name, COUNT(*) n FROM events
     WHERE event = 'skill.invoke' AND createdAt > strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
     GROUP BY agentId, name`,
    [win],
  );
  const installed =
    (await q(
      "installedSkills",
      `SELECT agentId, COUNT(*) n FROM agent_skills WHERE isActive = 1 GROUP BY agentId`,
    )) ?? [];
  const mems =
    (await q(
      "memoriesWritten",
      `SELECT * FROM (SELECT agentId, id, name, scope,
         ROW_NUMBER() OVER (PARTITION BY agentId ORDER BY createdAt DESC) rn
       FROM agent_memory WHERE source = 'manual' AND julianday(createdAt) > julianday('now', ?)
         AND COALESCE(chunkIndex, 0) = 0
         AND (tags IS NULL OR tags NOT GLOB '*"dreaming"*')) WHERE rn <= 10`,
      [win],
    )) ?? [];

  const agents: any[] = [];
  const skippedAgents: any[] = [];
  for (const r of roster) {
    if (only.length && !only.includes(r.id)) {
      skippedAgents.push({ id: r.id, name: r.name, reason: "not-in-onlyAgentIds" });
      continue;
    }
    const s = stats.find((x: any) => x.agentId === r.id);
    if (!s || Number(s.total) < minTasks) {
      skippedAgents.push({ id: r.id, name: r.name, reason: "no-activity" });
      continue;
    }
    const files: Record<string, string> = {
      SOUL: r.soulMd ?? "",
      IDENTITY: r.identityMd ?? "",
      CLAUDE: r.claudeMd ?? "",
      TOOLS: r.toolsMd ?? "",
      HEARTBEAT: r.isLead ? (r.heartbeatMd ?? "") : "",
    };
    const profileSha256: Record<string, string> = {};
    const h2Anchors: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(files)) {
      profileSha256[k] = await sha(v);
      h2Anchors[k] = h2(v);
    }
    agents.push({
      id: r.id,
      name: r.name,
      isLead: !!r.isLead,
      evidence: {
        tasks: {
          total: Number(s.total),
          completed: Number(s.completed ?? 0),
          failed: Number(s.failed ?? 0),
          cancelled: Number(s.cancelled ?? 0),
          fromSchedules: Number(s.fromSchedules ?? 0),
          costUsd: Number(cost.find((c: any) => c.agentId === r.id)?.usd ?? 0),
        },
        recent: recent
          .filter((x: any) => x.agentId === r.id)
          .map((x: any) => ({
            id: x.id,
            status: x.status,
            title: String(x.title ?? "").slice(0, 160),
            scheduleName: x.scheduleName ?? null,
            failureReason: x.failureReason ? String(x.failureReason).slice(0, 200) : null,
          })),
        skillInvokes: invokes
          ? invokes.filter((x: any) => x.agentId === r.id).map((x: any) => ({ name: x.name, n: Number(x.n) }))
          : null,
        installedSkillCount: Number(installed.find((x: any) => x.agentId === r.id)?.n ?? 0),
        memoriesWritten: mems
          .filter((x: any) => x.agentId === r.id)
          .map((x: any) => ({ id: x.id, name: x.name, scope: x.scope })),
        profileSizes: {
          soul: files.SOUL!.length,
          identity: files.IDENTITY!.length,
          claude: files.CLAUDE!.length,
          tools: files.TOOLS!.length,
          heartbeat: files.HEARTBEAT!.length,
        },
        profileSha256,
        h2Anchors,
      },
    });
  }

  // Night number + workflow changes since the previous scheduled run (KV snapshot, else workflow_versions).
  let night: any = { number: null, previousRunId: null };
  let workflowChanges: any = { base: "none", baseRef: null, added: [], removed: [], changed: [] };
  let workflowSnapshot: Record<string, string> = {};
  try {
    const me = await q("selfRun", `SELECT workflowId, startedAt, triggerType FROM workflow_runs WHERE id = ?`, [a.runId ?? ""]);
    const wfId = me?.[0]?.workflowId ?? null;
    if (wfId) {
      const prev = await q(
        "prevRuns",
        `SELECT id, startedAt FROM workflow_runs WHERE workflowId = ? AND triggerType = 'schedule' AND id != ?
           AND julianday(startedAt) < julianday(?) ORDER BY startedAt DESC`,
        [wfId, a.runId ?? "", me?.[0]?.startedAt],
      );
      night = { number: (prev?.length ?? 0) + 1, previousRunId: prev?.[0]?.id ?? null, previousStartedAt: prev?.[0]?.startedAt ?? null };
      const cur = await q("workflowDef", `SELECT definition FROM workflows WHERE id = ?`, [wfId]);
      const nodesOf = (d: any): any[] => (Array.isArray(d?.definition?.nodes) ? d.definition.nodes : Array.isArray(d?.nodes) ? d.nodes : []);
      const hashNodes = async (nodes: any[]) => {
        const m: Record<string, string> = {};
        for (const n of nodes) m[String(n.id)] = (await sha(JSON.stringify(n))).slice(0, 16);
        return m;
      };
      workflowSnapshot = await hashNodes(nodesOf({ definition: JSON.parse(cur?.[0]?.definition ?? "{}") }));
      let base: Record<string, string> | null = null;
      const snap: any = await ctx.swarm.kv_getOrNull({ namespace: NS, key: "wf-snapshot" }).catch(() => null);
      if (snap?.value?.nodes) {
        base = snap.value.nodes;
        workflowChanges.base = "kv";
        workflowChanges.baseRef = snap.value.runId ?? null;
      } else if (night.previousStartedAt) {
        const v = await q(
          "workflowVersionAtPrevRun",
          `SELECT version, snapshot FROM workflow_versions WHERE workflowId = ? AND julianday(createdAt) > julianday(?) ORDER BY version ASC LIMIT 1`,
          [wfId, night.previousStartedAt],
        );
        workflowChanges.base = "workflow_versions";
        if (v?.length) {
          base = await hashNodes(nodesOf(JSON.parse(v[0].snapshot ?? "{}")));
          workflowChanges.baseRef = `version ${v[0].version}`;
        } else {
          base = workflowSnapshot;
          workflowChanges.baseRef = "no version since previous run";
        }
      }
      if (base) {
        workflowChanges.added = Object.keys(workflowSnapshot).filter((k) => !(k in base!));
        workflowChanges.removed = Object.keys(base).filter((k) => !(k in workflowSnapshot));
        workflowChanges.changed = Object.keys(workflowSnapshot).filter((k) => k in base! && base![k] !== workflowSnapshot[k]);
      }
    }
  } catch (e: any) {
    errors.push(`workflowChanges: ${String(e?.message ?? e).slice(0, 200)}`);
  }

  // Audits: latest completed script_runs.output of the seeded audit scripts. Never nest ctx.swarm.script_run.
  const audit = async (name: string, pick: (o: any) => any) => {
    const c = await q(
      `${name}-latest`,
      `SELECT output, ROUND((julianday('now') - julianday(startedAt)) * 1440) ageMinutes
       FROM script_runs WHERE scriptName = ? AND status = 'completed' ORDER BY startedAt DESC LIMIT 1`,
      [name],
    );
    if (!c?.length) return { source: "missing" };
    const age = Number(c[0].ageMinutes);
    try {
      const o = JSON.parse(c[0].output);
      const r = o?.result ?? o;
      return { source: age > 180 ? "stale" : "cached", ageMinutes: age, ...pick(r) };
    } catch {
      return { source: "unparsable", ageMinutes: age };
    }
  };
  const first = (v: unknown, n: number) => (Array.isArray(v) ? v.slice(0, n) : null);
  const audits = {
    compoundInsights: await audit("compound-insights", (r) => ({
      taskSummary: r?.taskSummary ?? null,
      failureClusters: first(r?.failureClusters, 10),
      scheduleHealth: first(r?.scheduleHealth, 10),
      memoryHealth: r?.memoryHealth
        ? {
            total: r.memoryHealth.total ?? null,
            bySource: r.memoryHealth.bySource ?? null,
            autoSnapshotPercent: r.memoryHealth.pollution?.autoSnapshotPercent ?? null,
          }
        : null,
    })),
    taskFailures: await audit("task-failure-audit", (r) => ({
      totalFailed: r?.totalFailed ?? null,
      clusterCount: r?.clusterCount ?? null,
      groups: first(r?.groups, 10),
    })),
    memoryDedup: await audit("memory-dedup-check", (r) => ({
      isDuplicate: r?.isDuplicate ?? null,
      duplicateCount: r?.duplicateCount ?? null,
      topSimilarity: r?.topSimilarity ?? null,
    })),
    opsCatalog: await audit("ops-catalog-audit", (r) => ({
      summary: r?.summary ?? null,
      goals:
        r?.goals && typeof r.goals === "object"
          ? Object.fromEntries(
              Object.entries(r.goals).map(([k, g]: [string, any]) => [k, { findingCount: g?.findingCount ?? null, checks: g?.checks ?? null }]),
            )
          : null,
    })),
  };

  // Skills: catalog counts, 7d usage, 14d never-invoked (enabled only).
  const sk = await q("skillCounts", `SELECT COUNT(*) total, SUM(isEnabled) enabled, SUM(systemDefault) systemDefault FROM skills`);
  const inv7 = await q(
    "skillInvoked7d",
    `SELECT json_extract(data,'$.skillName') name, COUNT(*) n FROM events
     WHERE event = 'skill.invoke' AND createdAt > strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')
     GROUP BY name ORDER BY n DESC LIMIT 60`,
  );
  const never14 = await q(
    "skillNeverInvoked14d",
    `SELECT id, name, scope, systemDefault FROM skills WHERE isEnabled = 1 AND name NOT IN (
       SELECT DISTINCT json_extract(data,'$.skillName') FROM events
       WHERE event = 'skill.invoke' AND createdAt > strftime('%Y-%m-%dT%H:%M:%fZ','now','-14 days')
         AND json_extract(data,'$.skillName') IS NOT NULL)
     ORDER BY name LIMIT 40`,
  );
  const skills = {
    total: Number(sk?.[0]?.total ?? 0),
    enabled: Number(sk?.[0]?.enabled ?? 0),
    systemDefault: Number(sk?.[0]?.systemDefault ?? 0),
    invoked7d: (inv7 ?? []).map((x: any) => ({ name: x.name, n: Number(x.n) })),
    neverInvoked14d: (never14 ?? []).map((x: any) => ({
      id: x.id,
      name: x.name,
      scope: x.scope,
      systemDefault: !!x.systemDefault,
    })),
  };

  // Memory candidates: manual rows only.
  const dups = await q(
    "memExactDuplicates",
    `SELECT contentHash, group_concat(id, '|') ids, group_concat(name, '|') names FROM (
       SELECT contentHash, id, name FROM agent_memory
       WHERE source = 'manual' AND contentHash IS NOT NULL ORDER BY createdAt ASC)
     GROUP BY contentHash
     HAVING COUNT(*) > 1 AND contentHash IN (
       SELECT contentHash FROM agent_memory WHERE source = 'manual' AND contentHash IS NOT NULL
       GROUP BY contentHash HAVING MAX(COALESCE(totalChunks, 1)) = 1)
     LIMIT 20`,
  );
  const unhelpful = await q(
    "memUnhelpful",
    `SELECT id, name, scope, alpha, beta, accessCount FROM agent_memory
     WHERE source = 'manual' AND beta > alpha + 3 AND accessCount >= 5
     ORDER BY (beta - alpha) DESC LIMIT 20`,
  );
  const badKeys = await q(
    "memBadKeys",
    `SELECT id, name FROM agent_memory WHERE source = 'manual'
       AND julianday(createdAt) > julianday('now', ?)
       AND (instr(name, char(10)) > 0 OR length(name) > 90) LIMIT 20`,
    [win],
  );
  const created = await q(
    "memCreatedInWindow",
    `SELECT source, COUNT(*) n FROM agent_memory WHERE julianday(createdAt) > julianday('now', ?) GROUP BY source`,
    [win],
  );
  const cnt = (s: string) => Number((created ?? []).find((x: any) => x.source === s)?.n ?? 0);
  const memory = {
    exactDuplicates: (dups ?? []).map((x: any) => ({
      contentHash: x.contentHash,
      ids: String(x.ids ?? "").split("|"),
      names: String(x.names ?? "").split("|"),
    })),
    unhelpful: unhelpful ?? [],
    badKeys: badKeys ?? [],
    createdInWindow: {
      manual: cnt("manual"),
      taskCompletion: cnt("task_completion"),
      sessionSummary: cnt("session_summary"),
      fileIndex: cnt("file_index"),
    },
  };

  // The previous run's full cost and the learning feedback.
  const budget: any = {
    cap: cfg.budgetUsd,
    softCap: Math.round(cfg.budgetUsd * 0.88 * 100) / 100,
    prevRunId: night.previousRunId ?? null,
    prevRunUsd: null,
    overBudget: false,
  };
  if (night.previousRunId) {
    const c = await q(
      "prevRunCost",
      `SELECT ROUND(SUM(c.totalCostUsd), 2) usd, COUNT(DISTINCT t.id) tasks FROM session_costs c JOIN agent_tasks t ON t.id = c.taskId WHERE t.workflowRunId = ?`,
      [night.previousRunId],
    );
    budget.prevRunUsd = c?.[0]?.usd === null || c?.[0]?.usd === undefined ? null : Number(c[0].usd);
    budget.prevRunTasks = Number(c?.[0]?.tasks ?? 0);
    budget.overBudget = budget.prevRunUsd !== null && budget.prevRunUsd > budget.softCap;
  }
  const learning: any = { recent: [], candidates: [], pins: [] };
  try {
    const list = async (prefix: string, limit: number) => {
      const r: any = await ctx.swarm.kv_list({ namespace: NS, prefix, limit });
      return (r?.data?.entries ?? r?.entries ?? []).map((e: any) => {
        let v = e.value;
        if (typeof v === "string") try { v = JSON.parse(v); } catch {}
        return { key: e.key, value: v };
      });
    };
    const rowsL = (await list("learn:", 60)).filter((e: any) => e.key !== "learn:latest" && e.value?.at).sort((x: any, y: any) => String(y.value.at).localeCompare(String(x.value.at)));
    learning.recent = rowsL.slice(0, 7).map((e: any) => ({ runId: e.value.runId, at: e.value.at, learning: e.value.metrics?.learning ?? null, trend: e.value.trend ?? null }));
    learning.candidates = (rowsL[0]?.value?.candidates ?? []).slice(0, 10);
    learning.pins = (await list("pin:", 200)).map((e: any) => ({ key: e.key, probe: e.value?.probe ?? null, lane: String(e.key).split(":")[1] ?? null })).slice(0, 100);
  } catch (e: any) {
    errors.push(`learning: ${String(e?.message ?? e).slice(0, 200)}`);
  }

  return {
    ok: roster.length > 0,
    mode,
    dryRun,
    lastGreenDryRun,
    leadId,
    workerId,
    lanes,
    caps,
    cfg,
    overlap,
    budget,
    learning,
    runId: a.runId ?? null,
    windowStart,
    generatedAt,
    errors,
    agents,
    skippedAgents,
    budgetUsd: cfg.budgetUsd,
    night,
    workflowChanges,
    workflowSnapshot,
    swarm: { audits, skills, memory },
  };
}
