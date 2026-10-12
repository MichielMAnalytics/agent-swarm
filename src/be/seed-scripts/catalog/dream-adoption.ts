import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

// Dreaming adoption gate. dream-verify writes one KV record per skill or script a dreaming run created
// (dreaming/artifact:<kind>:<name>, no TTL; scripts carry their source). This node counts real uses of every
// `active` record and retires the ones nobody used within `gateDays`:
//   skill  -> skill_update isEnabled:false, re-read to confirm.
//   script -> script_delete, only when the live contentHash still equals the recorded one (an edit is adoption)
//             and no workflow, schedule or other script names it (a wiring is adoption). The row is the
//             recorded owner's; an agent-scope script owned by another agent is never deleted from here
//             (script_delete targets the caller's own row): its owner gets one task to delete it.
// A use is a skill_invocations row, a script_runs row more than an hour after the build (the build-time controls
// run within minutes of it), or a swarm-script workflow step whose node names the script. Dreaming's own workflow
// runs never count. `gateDays` 0 counts but never retires. dryRun reports `wouldRetire` and writes nothing.
// A record is acted on only with provenance (see `provenance`): the KV namespace is writable by any agent.
// Never throws: errors go to `errors[]`.

const scalar = z.union([z.string(), z.number(), z.boolean()]).nullable().optional();

/** Arguments for the dreaming adoption node. */
export const argsSchema = z.object({
  runId: z
    .string()
    .nullable()
    .optional()
    .describe("Workflow run id of this dreaming run; every run of its workflow is excluded from the counts"),
  gateDays: scalar.describe("Days an unused artifact lives before it is retired; 0 counts uses but never retires (default 14)"),
  dryRun: scalar.describe("Report wouldRetire[] and write nothing. Only an explicit false is live"),
  workflowId: z
    .string()
    .nullable()
    .optional()
    .describe("Dreaming workflow id to exclude (default: the run's workflow plus any workflow named dreaming)"),
});

const NS = "dreaming";
const PREFIX = "artifact:";
const DAY_MS = 86400000;
const CONTROL_WINDOW_MS = 3600000;

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

function parseInt0(v: unknown, def: number): number {
  let n = Number.NaN;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && v.trim() !== "") n = Number(v.trim());
  if (!Number.isFinite(n)) return def;
  return Math.max(0, Math.trunc(n));
}

const rows = (r: any): any[] => {
  const d = r?.data ?? r;
  if (d?.error) throw new Error(String(d.error));
  if (!Array.isArray(d?.rows)) throw new Error("db_query returned no rows array (throttled?)");
  const c: string[] = d?.columns ?? [];
  return d.rows.map((x: any[]) => Object.fromEntries(c.map((k, i) => [k, x[i]])));
};

// db_query responses pass the secret scrubber; KV values are read as hex so a stored script source stays byte-exact.
const decodeHex = (hx: unknown) =>
  new TextDecoder().decode(new Uint8Array((String(hx ?? "").match(/../g) ?? []).map((h) => parseInt(h, 16))));

const iso = (ms: number) => new Date(ms).toISOString();
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Dreaming adoption gate: count uses of dreaming-created skills and scripts, retire the unused ones. */
export default async function (args: unknown, ctx: ScriptContext) {
  const a: any = args ?? {};
  const errors: string[] = [];
  const retired: any[] = [];
  const adopted: any[] = [];
  const pending: any[] = [];
  const wouldRetire: any[] = [];
  const skipped: any[] = [];
  const delegated: any[] = [];
  // The agent this script runs as: an agent-scope delete only ever reaches this agent's own rows.
  // Resolved on first need; unresolved ("") means every agent-scope retire goes to its owner.
  let caller: string | null = null;
  const callerId = (): string => {
    if (caller !== null) return caller;
    try {
      caller = String(ctx.stdlib.Redacted.value(ctx.swarm.config.agentId) ?? "");
    } catch (e: any) {
      caller = "";
      errors.push(`caller: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    return caller;
  };
  // Fail closed: only an explicit false makes a live run.
  const dry = parseBool(a.dryRun) !== false;
  const gateDays = parseInt0(a.gateDays, 14);
  const runId = typeof a.runId === "string" ? a.runId : "";
  const now = Date.now();
  const nowIso = iso(now);

  const q = async (label: string, sql: string, params: unknown[] = []): Promise<any[] | null> => {
    try {
      return rows(await ctx.swarm.db_query({ sql, params }));
    } catch (e: any) {
      errors.push(`${label}: ${String(e?.message ?? e).slice(0, 200)}`);
      return null;
    }
  };
  const n0 = (r: any[] | null) => Number(r?.[0]?.n ?? 0);

  // Dreaming's own workflows: the run's workflow, an explicit override, and any workflow named dreaming.
  const wfIds = new Set<string>();
  if (typeof a.workflowId === "string" && a.workflowId) wfIds.add(a.workflowId);
  if (runId)
    for (const r of (await q("runWorkflow", `SELECT workflowId FROM workflow_runs WHERE id = ?`, [runId])) ?? [])
      if (r.workflowId) wfIds.add(String(r.workflowId));
  for (const r of (await q("dreamingWorkflow", `SELECT id FROM workflows WHERE name = 'dreaming'`)) ?? [])
    wfIds.add(String(r.id));
  const wf = [...wfIds];
  const wfList = wf.map(() => "?").join(",");
  // `x NOT IN ()` is not valid SQL and `x NOT IN (NULL)` drops every row, so an empty list drops the clause.
  const notOurTask = wf.length
    ? `(si.taskId IS NULL OR si.taskId NOT IN (SELECT t.id FROM agent_tasks t JOIN workflow_runs wr ON wr.id = t.workflowRunId WHERE wr.workflowId IN (${wfList})))`
    : "1 = 1";
  const notOurRun = wf.length ? `r.workflowId NOT IN (${wfList})` : "1 = 1";

  const skillUses = async (name: string, id: string, since: string) =>
    (await q(
      `skillUses ${name}`,
      `SELECT COUNT(*) n, MAX(si.createdAt) last FROM skill_invocations si
       WHERE (si.skillName = ? OR si.skillId = ?) AND si.createdAt >= ? AND ${notOurTask}`,
      [name, id, since, ...wf],
    )) ?? null;
  const scriptRunUses = async (name: string, since: string) =>
    (await q(
      `scriptRuns ${name}`,
      `SELECT COUNT(*) n, MAX(startedAt) last FROM script_runs WHERE scriptName = ? AND startedAt >= ?`,
      [name, since],
    )) ?? null;
  // swarm-script steps carry no script name: resolve it from the step's node in its workflow's definition.
  const stepUses = async (o: { name?: string; since?: string; runId?: string; exclude: boolean }) =>
    (await q(
      `workflowSteps ${o.name ?? o.runId ?? ""}`,
      `SELECT COUNT(*) n, MAX(s.startedAt) last
       FROM workflow_run_steps s
       JOIN workflow_runs r ON r.id = s.runId
       JOIN workflows w ON w.id = r.workflowId
       WHERE s.status IN ('completed', 'failed')
         ${o.since ? "AND s.startedAt >= ?" : ""}
         ${o.runId ? "AND s.runId = ?" : ""}
         ${o.exclude ? `AND ${notOurRun}` : ""}
         AND EXISTS (
           SELECT 1 FROM json_each(CASE WHEN json_valid(w.definition) THEN w.definition ELSE '{}' END, '$.nodes') nd
           WHERE json_extract(nd.value, '$.id') = s.nodeId
             AND json_extract(nd.value, '$.type') = 'swarm-script'
             ${o.name ? "AND json_extract(nd.value, '$.config.scriptName') = ?" : ""}
         )`,
      [
        ...(o.since ? [o.since] : []),
        ...(o.runId ? [o.runId] : []),
        ...(o.exclude ? wf : []),
        ...(o.name ? [o.name] : []),
      ],
    )) ?? null;
  // Static references: a workflow definition, a schedule or another script that names this script. Dreaming's own
  // workflows do not count, as with uses.
  const staticRefs = async (name: string) =>
    (await q(
      `staticRefs ${name}`,
      `SELECT 'workflow' kind, id, name FROM workflows WHERE instr(definition, ?) > 0 ${wf.length ? `AND id NOT IN (${wfList})` : ""}
       UNION ALL
       SELECT 'schedule' kind, id, name FROM scheduled_tasks
         WHERE instr(COALESCE(taskTemplate, ''), ?) > 0 OR COALESCE(scriptName, '') = ?
       UNION ALL
       SELECT 'script' kind, id, name FROM scripts WHERE name <> ? AND instr(source, ?) > 0
       LIMIT 10`,
      [name, ...wf, name, name, name, name],
    )) ?? null;

  // Provenance. Any agent can kv_set a dreaming/artifact:* record, so its fields prove nothing on their own. A record
  // is trusted only when its runId is a run of the seeded dreaming workflow (named dreaming, no creating agent) whose
  // `verify` step ran the global dream-verify (a contentHash in that script's history; global writes are Lead-only)
  // and whose output lists this key as written and confirms the same skill id, or script name, scope and contentHash.
  // Step outputs are written by the workflow engine, not by a KV write. Returns the run's start, or why it failed.
  const provenance = async (key: string, kind: string, name: string, rec: any) => {
    const runOf = typeof rec.runId === "string" ? rec.runId : "";
    if (!runOf) return { reason: "record has no runId" };
    const scope = rec.scope === "global" ? "global" : "agent";
    const r = await q(
      `provenance ${key}`,
      `SELECT r.startedAt,
         (json_extract(s.output, '$.scriptName') = 'dream-verify' AND json_extract(s.output, '$.contentHash') IN (
           SELECT g.contentHash FROM scripts g WHERE g.name = 'dream-verify' AND g.scope = 'global'
           UNION SELECT v.contentHash FROM script_versions v JOIN scripts g ON g.id = v.scriptId
             WHERE g.name = 'dream-verify' AND g.scope = 'global')) verifier,
         EXISTS (SELECT 1 FROM json_each(s.output, '$.result.artifacts.written') j WHERE j.value = ?) written,
         EXISTS (SELECT 1 FROM json_each(s.output, '$.result.confirmed') c WHERE CASE ?
           WHEN 'skill' THEN json_extract(c.value, '$.lane') = 'skills' AND json_extract(c.value, '$.skillId') = ?
           ELSE json_extract(c.value, '$.lane') = 'scriptify' AND json_extract(c.value, '$.name') = ?
             AND (CASE WHEN json_extract(c.value, '$.scope') = 'global' THEN 'global' ELSE 'agent' END) = ?
             AND json_extract(c.value, '$.contentHash') = ? END) confirmed
       FROM workflow_runs r
       JOIN workflows w ON w.id = r.workflowId
       JOIN workflow_run_steps s ON s.runId = r.id AND s.nodeId = 'verify'
       WHERE r.id = ? AND w.name = 'dreaming' AND w.createdByAgentId IS NULL AND json_valid(s.output)
       ORDER BY verifier + written + confirmed DESC LIMIT 1`,
      [key, kind, String(rec.id ?? ""), name, scope, String(rec.contentHash ?? ""), runOf],
    );
    if (!r) return { reason: "provenance read failed" };
    const p = r[0];
    if (!p) return { reason: `run ${runOf} is not a seeded dreaming run with a verify step` };
    if (!Number(p.verifier)) return { reason: `run ${runOf} verify step did not run the global dream-verify` };
    if (!Number(p.written)) return { reason: `run ${runOf} verify step did not write ${key}` };
    if (!Number(p.confirmed))
      return { reason: `run ${runOf} verify step confirmed no ${kind} with this record's ${kind === "skill" ? "id" : "scope and contentHash"}` };
    return { startedAt: String(p.startedAt ?? "") };
  };

  // Artifact records, stored bytes (hex) so the script source survives the scrubber.
  const records: Array<{ key: string; rec: any }> = [];
  const kv = await q(
    "artifacts",
    `SELECT key, hex(CAST(value AS BLOB)) hx FROM kv_entries
     WHERE namespace = ? AND substr(key, 1, length(?)) = ? AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY key`,
    [NS, PREFIX, PREFIX, now],
  );
  for (const e of kv ?? []) {
    try {
      const rec = JSON.parse(decodeHex(e.hx));
      if (rec && typeof rec === "object") records.push({ key: String(e.key), rec });
      else errors.push(`${e.key}: record is not an object`);
    } catch {
      errors.push(`${e.key}: record is not JSON`);
    }
  }

  const writeRecord = async (key: string, value: any) => {
    // No TTL: a retired script is restored from this record's `source`.
    try {
      await ctx.swarm.kv_set({ namespace: NS, key, value });
    } catch (err: any) {
      errors.push(`record ${key}: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  };

  let checked = 0;
  for (const { key, rec } of records) {
    // Kind and name come from the key, which is what verify's output lists; a record that disagrees is not one.
    const parts = key.slice(PREFIX.length).split(":");
    const kind = String(parts[0] ?? "");
    const name = parts.slice(1).join(":");
    const status = String(rec.status ?? "active");
    if (status !== "active") continue; // adopted, retired, restored: the gate is done with it
    checked++;
    let createdMs = Date.parse(String(rec.createdAt ?? ""));
    if (
      !Number.isFinite(createdMs) ||
      (kind !== "skill" && kind !== "script") ||
      !name ||
      String(rec.kind ?? kind) !== kind ||
      String(rec.name ?? name) !== name
    ) {
      skipped.push({ key, reason: "record has no valid kind, name or createdAt" });
      continue;
    }
    // Never retired, never marked adopted without provenance.
    const prov: any = await provenance(key, kind, name, rec);
    if (prov.reason) {
      skipped.push({ key, kind, name, id: rec.id ?? null, reason: `no provenance: ${prov.reason}` });
      continue;
    }
    // The artifact cannot predate the run that built it: a backdated createdAt does not age it.
    const runMs = Date.parse(prov.startedAt);
    if (Number.isFinite(runMs) && runMs > createdMs) createdMs = runMs;
    const ageDays = round1((now - createdMs) / DAY_MS);
    const item: any = { kind, name, id: rec.id ?? null, ageDays, key };
    try {
      // 1. Count uses since the build.
      let uses = 0;
      let lastUseAt: string | null = null;
      const take = (r: any[] | null, label: string) => {
        if (!r) throw new Error(`count failed (${label})`);
        uses += Number(r[0]?.n ?? 0);
        const last = r[0]?.last ? String(r[0].last) : null;
        if (last && (!lastUseAt || last > lastUseAt)) lastUseAt = last;
      };
      if (kind === "skill") {
        take(await skillUses(name, String(rec.id ?? ""), iso(createdMs)), "skill_invocations");
      } else {
        take(await scriptRunUses(name, iso(createdMs + CONTROL_WINDOW_MS)), "script_runs");
        take(await stepUses({ name, since: iso(createdMs), exclude: true }), "workflow steps");
      }
      item.uses = uses;
      item.lastUseAt = lastUseAt;
      if (uses > 0) {
        adopted.push({ ...item, status: "adopted" });
        if (!dry) await writeRecord(key, { ...rec, status: "adopted", uses, lastUseAt, checkedAt: nowIso });
        continue;
      }
      if (gateDays === 0) {
        pending.push({ ...item, reason: "gate off (DREAMING_ADOPTION_GATE_DAYS=0)" });
        continue;
      }
      if (ageDays < gateDays) {
        pending.push({ ...item, daysLeft: round1(gateDays - ageDays) });
        continue;
      }

      // 2. Retire. Skills are disabled (reversible); scripts are deleted only when nobody touched them.
      const reason = `0 uses in ${gateDays} days`;
      if (kind === "skill") {
        const live =
          (await q("skillRow", `SELECT id, name, isEnabled, systemDefault FROM skills WHERE id = ?`, [String(rec.id ?? "")])) ?? null;
        if (!live) throw new Error("skill read failed");
        if (!live.length) {
          skipped.push({ ...item, reason: "skill row is gone" });
          if (!dry) await writeRecord(key, { ...rec, status: "missing", checkedAt: nowIso });
          continue;
        }
        if (Number(live[0].systemDefault)) {
          skipped.push({ ...item, reason: "systemDefault skill, never retired" });
          continue;
        }
        if (dry) {
          wouldRetire.push({ ...item, action: "skill_update isEnabled:false", reason });
          continue;
        }
        let how = "already disabled";
        if (Number(live[0].isEnabled)) {
          await ctx.swarm.skill_update({ skillId: String(live[0].id), isEnabled: false });
          how = "skill_update isEnabled:false";
        }
        const back = await q("skillReread", `SELECT isEnabled FROM skills WHERE id = ?`, [String(live[0].id)]);
        if (back?.length && !Number(back[0].isEnabled)) {
          retired.push({ ...item, how, reason });
          await writeRecord(key, { ...rec, status: "retired", retiredAt: nowIso, reason, uses: 0 });
        } else errors.push(`${key}: skill still enabled after skill_update`);
        continue;
      }

      const scope = rec.scope === "global" ? "global" : "agent";
      const owner = scope === "agent" ? String(rec.agentId ?? "") : "";
      if (scope === "agent" && !owner) {
        // Without the owner the row is ambiguous: another agent may hold a script of the same name.
        skipped.push({ ...item, reason: "agent-scope record has no owner (agentId)" });
        continue;
      }
      const live =
        (await q(
          "scriptRow",
          `SELECT id, contentHash, scope, scopeId FROM scripts WHERE name = ? AND scope = ?
           ${scope === "agent" ? "AND scopeId = ?" : ""} ORDER BY updatedAt DESC LIMIT 1`,
          [name, scope, ...(scope === "agent" ? [owner] : [])],
        )) ?? null;
      if (!live) throw new Error("script read failed");
      if (!live.length && scope === "agent") {
        // Promoted (the owners node asks Lead to promote a built script): a global copy is adoption.
        const promoted = await q("scriptPromoted", `SELECT id FROM scripts WHERE name = ? AND scope = 'global'`, [name]);
        if (promoted?.length) {
          adopted.push({ ...item, status: "adopted-promoted" });
          if (!dry) await writeRecord(key, { ...rec, status: "adopted-promoted", checkedAt: nowIso });
          continue;
        }
      }
      if (!live.length) {
        skipped.push({ ...item, reason: "script row is gone" });
        if (!dry) await writeRecord(key, { ...rec, status: "missing", checkedAt: nowIso });
        continue;
      }
      if (String(live[0].contentHash) !== String(rec.contentHash ?? "")) {
        adopted.push({ ...item, status: "adopted-edit" });
        if (!dry) await writeRecord(key, { ...rec, status: "adopted-edit", liveContentHash: live[0].contentHash, checkedAt: nowIso });
        continue;
      }
      const refs = await staticRefs(name);
      if (!refs) throw new Error("static reference check failed");
      if (refs.length) {
        const r = refs.map((x: any) => ({ kind: x.kind, id: x.id, name: x.name }));
        adopted.push({ ...item, status: "adopted-ref", refs: r });
        if (!dry) await writeRecord(key, { ...rec, status: "adopted-ref", refs: r, checkedAt: nowIso });
        continue;
      }
      // script_delete resolves an agent-scope row from the CALLER, not from the record: called for another
      // agent's script it would delete the caller's own same-name row. Only the owner deletes it, so ask them.
      const delegate = scope === "agent" && owner !== callerId();
      if (dry) {
        wouldRetire.push({ ...item, action: delegate ? `ask owner ${owner} to script_delete` : `script_delete scope ${scope}`, reason });
        continue;
      }
      if (delegate) {
        if (rec.retireRequestedFrom === owner) {
          pending.push({ ...item, owner, reason: `retire requested from its owner at ${rec.retireRequestedAt}` });
          continue;
        }
        await ctx.swarm.task_send({
          agentId: owner,
          routingReason: "skill",
          routingNote: "dreaming adoption gate: only a script's owner can delete an agent-scope script",
          tags: ["dreaming", "dreaming-adoption"],
          task:
            `dreaming adoption gate: your agent-scope script "${name}" was built by a dreaming run and has had ${reason}. ` +
            `Check that it is still unused and unwired, and that its contentHash is still ${String(rec.contentHash)} ` +
            `(db-query \`SELECT contentHash FROM scripts WHERE name = '${name}' AND scope = 'agent' AND scopeId = '${owner}'\`). ` +
            `If so, delete it with script-delete name "${name}" scope "agent". Otherwise keep it. ` +
            `Its source stays in KV dreaming/${key} for a restore. Reply with what you did.`,
        } as any);
        delegated.push({ ...item, owner, reason });
        await writeRecord(key, { ...rec, retireRequestedFrom: owner, retireRequestedAt: nowIso, checkedAt: nowIso });
        continue;
      }
      await ctx.swarm.script_delete({ name, scope });
      const back = await q("scriptReread", `SELECT COUNT(*) n FROM scripts WHERE id = ?`, [String(live[0].id)]);
      if (back && n0(back) === 0) {
        retired.push({ ...item, how: `script_delete scope ${scope}`, reason });
        await writeRecord(key, { ...rec, status: "retired", retiredAt: nowIso, reason, uses: 0 });
      } else
        errors.push(`${key}: script still present after script_delete`);
    } catch (err: any) {
      errors.push(`${key}: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }

  // Controls. Positive: a known invocation outside the loop counts >= 1 through the same query (a dreaming
  // skill first, any skill otherwise). Negative: this run's own tasks and swarm-script steps count 0.
  const controls: any = { ok: false };
  try {
    const skillNames = records.filter((r) => (r.rec.kind ?? "") === "skill").map((r) => String(r.rec.name ?? ""));
    const probeSql = (named: boolean) =>
      `SELECT si.skillName, si.skillId, si.createdAt FROM skill_invocations si
       WHERE si.skillName IS NOT NULL AND ${notOurTask}
       ${named ? `AND si.skillName IN (${skillNames.map(() => "?").join(",")})` : ""}
       ORDER BY si.createdAt DESC LIMIT 1`;
    let probe = skillNames.length ? ((await q("probeArtifact", probeSql(true), [...wf, ...skillNames])) ?? [])[0] : undefined;
    let source = "artifact";
    if (!probe) {
      probe = ((await q("probeAny", probeSql(false), wf)) ?? [])[0];
      source = "any";
    }
    if (probe) {
      const counted = n0(await skillUses(String(probe.skillName), String(probe.skillId ?? ""), String(probe.createdAt)));
      controls.positive = { skill: probe.skillName, source, counted, ok: counted >= 1 };
    } else controls.positive = { ok: true, vacuous: true, note: "no skill invocation outside the loop exists yet" };

    if (runId) {
      const rawSkill = n0(
        await q(
          "negSkillRaw",
          `SELECT COUNT(*) n FROM skill_invocations si WHERE si.taskId IN (SELECT id FROM agent_tasks WHERE workflowRunId = ?)`,
          [runId],
        ),
      );
      const countedSkill = n0(
        await q(
          "negSkill",
          `SELECT COUNT(*) n FROM skill_invocations si
           WHERE si.taskId IN (SELECT id FROM agent_tasks WHERE workflowRunId = ?) AND ${notOurTask}`,
          [runId, ...wf],
        ),
      );
      const rawSteps = n0(await stepUses({ runId, exclude: false }));
      const countedSteps = n0(await stepUses({ runId, exclude: true }));
      controls.negative = {
        excludedWorkflows: wf.length,
        runTaskInvocations: { raw: rawSkill, counted: countedSkill },
        runScriptSteps: { raw: rawSteps, counted: countedSteps },
        ok: wf.length > 0 && countedSkill === 0 && countedSteps === 0,
      };
    } else controls.negative = { ok: true, vacuous: true, note: "no runId (manual run)" };

    controls.artifacts = records.length;
    if (!records.length) controls.reason = "no artifacts";
    controls.ok = records.length > 0 && controls.positive.ok === true && controls.negative.ok === true;
  } catch (e: any) {
    controls.error = String(e?.message ?? e).slice(0, 200);
  }

  return {
    ok: errors.length === 0,
    mode: dry ? "dry-run" : "live",
    gateDays,
    artifacts: records.length,
    checked,
    retired,
    adopted,
    pending,
    wouldRetire,
    delegated,
    skipped,
    errors,
    controls,
  };
}
