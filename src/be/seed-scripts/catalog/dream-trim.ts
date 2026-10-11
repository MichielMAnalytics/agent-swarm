import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

// Dreaming trim lane. See the dreaming design (profile trims).
// mode "plan":   pick tonight's fields (reverted first, then deferred net-positive edits, over-target, rotation) and
//                write each target's pre-image to KV preimage:<runId>:<agentId>:<field> before returning it.
//                lanes.trim === false returns targets: []. maxTrims comes from the maxTrims arg, else caps.trims, else 3.
// mode "apply":  write each drafted trim that ends net-smaller; re-apply reverted trims; record trim-state. A slot
//                whose pre-image is missing or whose live sha differs from the pre-image sha is refused.
// mode "revert": restore one field from its KV pre-image. Never throws.
// Live trims also write the cut ledger KV cuts:<runId>:A (one record per removed block, with a probe dream-learn
// scores). mode "selftest": survival + cut-extraction controls on fixtures (no reads, no writes).
// Profile fields are read as hex(...) and decoded, so the secret scrubber never rewrites the bytes we hash or store.

export const argsSchema = z.object({
  mode: z.enum(["plan", "apply", "revert", "selftest"]),
  runId: z.string().optional(),
  dryRun: z.union([z.boolean(), z.string()]).optional(),
  date: z.string().optional(),
  // Override; when absent, caps.trims (then 3) decides.
  maxTrims: z.number().int().min(0).max(12).optional(),
  caps: z.unknown().optional(),
  // { heartbeat, trim, identity, memory }. Missing = every lane on; an explicit false turns a lane off.
  lanes: z.unknown().optional(),
  deferred: z.unknown().optional(),
  plan: z.unknown().optional(),
  drafts: z.unknown().optional(),
  agentId: z.string().optional(),
  field: z.string().optional(),
});

const NS = "dreaming";
// toolsMd is not a target: it is never injected into the prompt.
const FIELDS = ["claudeMd", "soulMd", "identityMd"] as const;
const FILE_OF: Record<string, string> = { claudeMd: "CLAUDE", soulMd: "SOUL", identityMd: "IDENTITY" };
// claudeMd is cut at BOOTSTRAP_MAX_CHARS when injected; soul/identity have no hard cap.
const TARGET: Record<string, number | null> = { claudeMd: 20000, soulMd: null, identityMd: null };
const ROTATION_MIN_CHARS = 6000;
const ROTATION_COOLDOWN_DAYS = 14;
const MIN_CHARS: Record<string, number> = { soulMd: 500, identityMd: 500, claudeMd: 200 };
const DEFAULT_MAX_TRIMS = 3;
const MAX_MEMORIES_PER_TRIM = 5;

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
const decodeHex = (hx: unknown) =>
  new TextDecoder().decode(new Uint8Array((String(hx ?? "").match(/../g) ?? []).map((h) => parseInt(h, 16))));
// Scrubber markers: a draft the agent wrote from a scrubbed read may carry them; never write more than the field holds.
const MARK = "[REDACTED:";
const markers = (s: string) => String(s ?? "").split(MARK).length - 1;
export const preimageKey = (runId: string, agentId: string, field: string) => `preimage:${runId}:${agentId}:${field}`;

function parse(v: unknown): any {
  if (v && typeof v === "object") return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        return JSON.parse(s);
      } catch {}
    }
  }
  return null;
}
const slug = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const revertLine = (runId: string, agentId: string, field: string) =>
  `script-run name="dream-trim" scope="global" args={"mode":"revert","runId":"${runId}","agentId":"${agentId}","field":"${field}"}`;

// Survival of one earlier trim against the live field sha. "reverted" carries the text to re-apply.
export function trimSurvival(st: any, liveSha: string): { status: "skip" | "intact" | "reverted" | "drifted"; restoreText: string | null } {
  if (!st?.afterSha || st?.revertedAt) return { status: "skip", restoreText: null };
  if (liveSha === st.afterSha) return { status: "intact", restoreText: null };
  if (liveSha === st.beforeSha && typeof st.afterText === "string") return { status: "reverted", restoreText: st.afterText };
  return { status: "drifted", restoreText: null };
}

// Cut ledger: one record per block of lines the trim removed. probe = a distinctive <=80-char phrase that is in
// `before` and not in `after`; line/nLines index the block in the pre-image so a restore can re-insert it after `anchor`.
export function cutsFrom(before: string, after: string, max = 40) {
  const afterSet = new Set(after.split("\n").map((l) => l.trim()).filter(Boolean));
  const lines = before.split("\n");
  const blocks: Array<{ line: number; nLines: number; lines: string[]; anchor: string | null }> = [];
  let cur: any = null;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t && !afterSet.has(t)) {
      if (!cur) {
        cur = { line: i, nLines: 0, lines: [], anchor: null };
        for (let k = i - 1; k >= 0; k--) {
          const u = lines[k]!.trim();
          if (u && afterSet.has(u)) { cur.anchor = lines[k]; break; }
        }
        blocks.push(cur);
      }
      cur.lines.push(l);
      cur.nLines = i - cur.line + 1;
    } else if (t) cur = null;
  });
  const out: any[] = [];
  for (const b of blocks) {
    if (out.length >= max) break;
    const cand = b.lines.map((x) => x.trim()).filter((x) => x.length >= 12);
    const head = cand.find((x) => /^#{1,4} /.test(x)) ?? [...cand].sort((x, y) => y.length - x.length)[0] ?? "";
    let probe = head.replace(/^[#>*\-\s\d.)]+/, "").slice(0, 80).trim();
    if (!probe || after.includes(probe)) probe = head.slice(0, 80).trim();
    if (probe.length < 8 || after.includes(probe) || !before.includes(probe)) continue;
    out.push({ probe, line: b.line, nLines: b.nLines, anchor: b.anchor ? b.anchor.slice(0, 300) : null, chars: b.lines.join("\n").length });
  }
  return out;
}

/** Dreaming trim: plan profile-field trims with KV pre-images, then apply net-smaller drafts with re-read verification. */
export default async function (args: unknown, ctx: ScriptContext) {
  const p = argsSchema.safeParse(args ?? {});
  if (!p.success) return { ok: false, errors: [p.error.message], targets: [], slackLine: "Trims: none (bad args)" };
  const a = p.data;
  const dry = a.dryRun === true || a.dryRun === "true";
  const runId = a.runId ?? "";
  const date = a.date ?? new Date().toISOString().slice(0, 10);
  const errors: string[] = [];
  const q = async (sql: string, params: unknown[] = []) => rows(await ctx.swarm.db_query({ sql, params }));
  const kvGet = async (key: string) => ctx.swarm.kv_getOrNull({ namespace: NS, key });
  const kvSet = async (key: string, value: unknown) => ctx.swarm.kv_set({ namespace: NS, key, value: value as any });
  const caps = parse(a.caps) ?? {};
  const lanes = parse(a.lanes) ?? {};
  const laneOff = lanes.trim === false || lanes.trim === "false";
  const capTrims = caps.trims == null || caps.trims === "" ? Number.NaN : Number(caps.trims);
  const maxTrims =
    a.maxTrims ?? (Number.isFinite(capTrims) && capTrims >= 0 ? Math.min(12, Math.floor(capTrims)) : DEFAULT_MAX_TRIMS);
  // Stored bytes of one profile field (field comes from FIELDS, never from free input).
  const readField = async (field: string, agentId: string) => {
    const r = await q(`SELECT hex(CAST(${field} AS BLOB)) AS hx FROM agents WHERE id = ?`, [agentId]);
    return r.length ? decodeHex(r[0].hx) : null;
  };
  // Pre-image { content, sha, at } written by plan mode, read as stored bytes (hex) so `content` is never scrubbed.
  const readPreimage = async (agentId: string, field: string): Promise<any> => {
    const r = await q(`SELECT hex(CAST(value AS BLOB)) AS hx FROM kv_entries WHERE namespace = ? AND key = ?`, [
      NS,
      preimageKey(runId, agentId, field),
    ]);
    if (!r.length) return null;
    try {
      return parse(JSON.parse(decodeHex(r[0].hx)));
    } catch {
      return null;
    }
  };
  const trimStates = async (): Promise<any[]> => {
    try {
      const r: any = await ctx.swarm.kv_list({ namespace: NS, prefix: "trim-state:", limit: 200 });
      return (r?.data?.entries ?? r?.entries ?? []).map((e: any) => ({ key: e.key, ...(parse(e.value) ?? {}) }));
    } catch (e: any) {
      errors.push(`kv_list trim-state: ${String(e?.message ?? e).slice(0, 200)}`);
      return [];
    }
  };

  // ---------------- selftest ----------------
  if (a.mode === "selftest") {
    const before = "## Rules\n- keep this rule line\n## Stories\n- 2026-08-01 a long incident story about a stale disk copy\n- proven again on 08-02 with evidence\n## Tools\n- host api:3013\n";
    const after = "## Rules\n- keep this rule line\n## Tools\n- host api:3013\n";
    const st = { afterSha: await sha(after), beforeSha: await sha(before), afterText: after };
    const sv = [
      { name: "survival+ live = pre-image -> reverted, restores afterText", got: trimSurvival(st, await sha(before)), want: "reverted", restore: after },
      { name: "survival- drifted live (third text) -> drifted, no restore", got: trimSurvival(st, await sha(before + "x")), want: "drifted", restore: null },
      { name: "survival+ live = afterText -> intact", got: trimSurvival(st, st.afterSha), want: "intact", restore: null },
      { name: "survival- reverted but no afterText stored -> drifted", got: trimSurvival({ ...st, afterText: undefined }, st.beforeSha), want: "drifted", restore: null },
      { name: "survival- reverted by hand (revertedAt) -> skip", got: trimSurvival({ ...st, revertedAt: "x" }, st.beforeSha), want: "skip", restore: null },
    ].map((x) => ({ name: x.name, pass: x.got.status === x.want && x.got.restoreText === x.restore, got: x.got.status }));
    const cuts = cutsFrom(before, after);
    const ct = [
      { name: "cuts+ one block removed -> one cut", pass: cuts.length === 1 },
      { name: "cuts+ probe in before, not in after", pass: cuts.every((c) => before.includes(c.probe) && !after.includes(c.probe)) },
      { name: "cuts+ anchor survives in after", pass: cuts.every((c) => c.anchor !== null && after.includes(c.anchor)) },
      { name: "cuts+ block re-inserted after anchor rebuilds before", pass: (() => { const c = cuts[0]; const bl = before.split("\n"); const block = bl.slice(c.line, c.line + c.nLines).join("\n"); return after.replace(c.anchor + "\n", c.anchor + "\n" + block + "\n") === before; })() },
      { name: "cuts- identical texts -> no cut", pass: cutsFrom(before, before).length === 0 },
    ];
    return { ok: sv.every((x) => x.pass) && ct.every((x) => x.pass), mode: "selftest", survival: sv, cuts: ct, sample: cuts };
  }

  // ---------------- revert ----------------
  if (a.mode === "revert") {
    const agentId = a.agentId ?? "";
    const field = a.field ?? "";
    if (!runId || !agentId || !(FIELDS as readonly string[]).includes(field)) return { ok: false, errors: ["revert needs runId, agentId, field"] };
    const pre = await readPreimage(agentId, field);
    const text = pre?.content;
    if (typeof text !== "string") return { ok: false, errors: ["no pre-image for that runId/agentId/field"] };
    // The KV read passes the secret scrubber; a pre-image whose bytes no longer hash to its sha is never written.
    if ((await sha(text)) !== pre.sha) return { ok: false, errors: ["pre-image content does not match its sha (scrubbed on read?)"] };
    if (dry) return { ok: true, mode: "dry-run", wouldRestoreChars: text.length };
    await ctx.swarm.profile_update({ agentId, [field]: text });
    const ok = (await sha((await readField(field, agentId)) ?? "")) === pre.sha;
    if (ok) await kvSet(`trim-state:${agentId}:${field}`, { agentId, field, revertedAt: new Date().toISOString(), revertedRunId: runId });
    return { ok, mode: "live", restoredChars: text.length, verifiedBy: ok ? "sha256(re-read) = sha256(pre-image)" : "MISMATCH after restore" };
  }

  // ---------------- plan, lane off ----------------
  if (a.mode === "plan" && laneOff) {
    return { ok: true, mode: dry ? "dry-run" : "live", date, maxTrims, skipReason: "lane off", targets: [], reapply: [], deferredUnplanned: [], backlog: [], errors };
  }

  const agents = (
    await q(
      `SELECT id, name, isLead, status, ${FIELDS.map((f) => `hex(CAST(${f} AS BLOB)) AS ${f}`).join(", ")} FROM agents
       WHERE name NOT LIKE 'ext:%' AND status != 'offline' ORDER BY isLead DESC, name`,
    )
  ).map((x: any) => ({ ...x, ...Object.fromEntries(FIELDS.map((f) => [f, decodeHex(x[f])])) }));
  const byId = new Map(agents.map((x: any) => [x.id, x]));
  const states = await trimStates();
  const stateOf = (agentId: string, field: string) => states.find((s) => s.agentId === agentId && s.field === field);

  // ---------------- plan ----------------
  if (a.mode === "plan") {
    const deferred: any[] = Array.isArray(parse(a.deferred)) ? parse(a.deferred) : (parse(a.deferred)?.deferredToTrim ?? []);
    const cands: any[] = [];
    for (const ag of agents) {
      for (const f of FIELDS) {
        const body = String(ag[f] ?? "");
        if (!body.trim()) continue;
        const st = stateOf(ag.id, f);
        const bodySha = await sha(body);
        const reverted = !!st?.beforeSha && bodySha === st.beforeSha && !st.revertedAt;
        const recent = st?.at && Date.now() - Date.parse(st.at) < ROTATION_COOLDOWN_DAYS * 86400000;
        const edits = deferred.filter((d) => d?.agentId === ag.id && d?.field === f);
        const tgt = TARGET[f] ?? null;
        const over = tgt !== null && body.length > tgt ? body.length - tgt : 0;
        let rank = -1;
        let reason = "";
        if (reverted) { rank = 3; reason = "reverted: live text equals the pre-trim text; re-applied deterministically"; }
        else if (edits.length) { rank = 2; reason = `folds ${edits.length} net-positive edit(s): ${edits.map((e) => e.actionId).join(", ")}`; }
        else if (over > 0) { rank = 1; reason = `over target by ${over} chars (target ${tgt})`; }
        else if (!recent && body.length >= ROTATION_MIN_CHARS) { rank = 0; reason = "rotation"; }
        if (rank < 0) continue;
        cands.push({
          slot: `${slug(ag.name)}-${f}`,
          agentId: ag.id,
          agentName: ag.name,
          isLead: !!ag.isLead,
          field: f,
          file: FILE_OF[f],
          chars: body.length,
          sha256: bodySha,
          targetChars: tgt,
          reason,
          rank,
          over,
          deferredEdits: edits,
          lastTrimAt: st?.at ?? null,
          preimageKey: preimageKey(runId, ag.id, f),
          body,
        });
      }
    }
    const reapply = cands.filter((c) => c.rank === 3);
    // One field per agent per night, so the rotation spreads across agents.
    const llm = cands
      .filter((c) => c.rank < 3)
      .sort((x, y) => y.rank - x.rank || y.over - x.over || y.chars - x.chars);
    const seen = new Set<string>();
    const targets: any[] = [];
    for (const c of llm) {
      if (targets.length >= maxTrims) break;
      if (seen.has(c.agentId) && c.rank < 2) continue;
      seen.add(c.agentId);
      targets.push(c);
    }
    // Pre-image per target, written before the target is returned. A target without one is dropped (apply would refuse it).
    for (const t of [...targets]) {
      try {
        if (!runId) throw new Error("runId missing");
        await kvSet(t.preimageKey, { content: t.body, sha: t.sha256, at: new Date().toISOString() });
      } catch (e: any) {
        errors.push(`pre-image ${t.slot}: ${String(e?.message ?? e).slice(0, 160)}`);
        targets.splice(targets.indexOf(t), 1);
      }
    }
    for (const c of cands) delete c.body;
    const deferredUnplanned = deferred.filter((d) => !targets.some((t) => t.agentId === d.agentId && t.field === d.field));
    return {
      ok: true,
      mode: dry ? "dry-run" : "live",
      date,
      maxTrims,
      targets,
      reapply: reapply.map((c) => ({ agentId: c.agentId, agentName: c.agentName, field: c.field })),
      deferredUnplanned,
      backlog: llm.filter((c) => !targets.includes(c)).map((c) => ({ slot: c.slot, chars: c.chars, reason: c.reason })),
      errors,
    };
  }

  // ---------------- apply ----------------
  const plan = parse(a.plan) ?? {};
  const targets: any[] = Array.isArray(plan.targets) ? plan.targets : [];
  const draftsRaw = parse(a.drafts);
  const results: any[] = Array.isArray(draftsRaw) ? draftsRaw : Array.isArray(draftsRaw?.results) ? draftsRaw.results : [];
  const out = {
    ok: true,
    mode: dry ? "dry-run" : "live",
    applied: [] as any[],
    wouldApply: [] as any[],
    refused: [] as any[],
    reapplied: [] as any[],
    memories: [] as any[],
    survival: { checked: 0, intact: 0, reverted: [] as any[], drifted: [] as any[] },
    slackLine: "",
    errors,
  };
  if (laneOff) (out as any).skipReason = "lane off";

  // Survival of every earlier trim; a reverted field is re-applied from its stored trimmed text.
  for (const st of states) {
    if (!st.afterSha || st.revertedAt) continue;
    const ag: any = byId.get(st.agentId);
    if (!ag) continue;
    out.survival.checked++;
    const body = String(ag[st.field] ?? "");
    const s = await sha(body);
    const sv = trimSurvival(st, s);
    if (sv.status === "intact") { out.survival.intact++; continue; }
    if (sv.status === "reverted") {
      out.survival.reverted.push({ agentId: st.agentId, agentName: ag.name, field: st.field, runId: st.runId });
      if (dry || laneOff || !(FIELDS as readonly string[]).includes(st.field)) continue;
      try {
        await ctx.swarm.profile_update({ agentId: st.agentId, [st.field]: st.afterText });
        const ok = (await sha((await readField(st.field, st.agentId)) ?? "")) === st.afterSha;
        out.reapplied.push({ agentId: st.agentId, agentName: ag.name, field: st.field, ok });
        if (ok) await kvSet(st.key, { ...st, key: undefined, reappliedAt: new Date().toISOString(), reappliedRunId: runId });
      } catch (e: any) {
        errors.push(`reapply ${st.agentId}:${st.field}: ${String(e?.message ?? e).slice(0, 160)}`);
      }
      continue;
    }
    out.survival.drifted.push({ agentId: st.agentId, agentName: ag.name, field: st.field, chars: body.length, trimmedChars: st.afterChars, note: "edited since the trim; back in rotation" });
  }

  const cutLedger: any[] = [];
  for (const t of targets) {
    const refuse = (reason: string) => out.refused.push({ slot: t.slot, agentId: t.agentId, agentName: t.agentName, field: t.field, reason });
    try {
      if (laneOff) { refuse("lane off"); continue; }
      if (!(FIELDS as readonly string[]).includes(t.field)) { refuse(`not a trim field: ${t.field}`); continue; }
      const r = results.find((x: any) => String(x?.itemKey ?? "") === t.slot) ?? null;
      if (!r) { refuse("no draft result for this slot"); continue; }
      if (r.status && r.status !== "completed" && r.status !== "success") { refuse(`draft task ${r.status}`); continue; }
      const o = parse(r.output) ?? {};
      const d = parse(o.taskOutput ?? r.taskOutput);
      if (!d || typeof d !== "object") { refuse("draft output is not JSON"); continue; }
      if (d.agentId !== t.agentId || d.field !== t.field) { refuse(`slot mismatch: draft is ${d.agentId}:${d.field}`); continue; }
      const next = typeof d.trimmed === "string" ? d.trimmed : "";
      if (!next.trim()) { refuse("empty draft"); continue; }
      if (/^## /m.test(next) === false && /^## /m.test(String(byId.get(t.agentId)?.[t.field] ?? ""))) { refuse("draft dropped every H2 heading"); continue; }
      if (next.length < (MIN_CHARS[t.field] ?? 200)) { refuse(`draft shorter than ${MIN_CHARS[t.field]} chars`); continue; }
      const live = String(byId.get(t.agentId)?.[t.field] ?? "");
      const liveSha = await sha(live);
      if (liveSha !== t.sha256) { refuse(`field changed since plan (${liveSha.slice(0, 12)} != ${String(t.sha256).slice(0, 12)})`); continue; }
      // The plan's KV pre-image is the rollback copy: no pre-image, or one for different bytes, means no write.
      const pre = await readPreimage(t.agentId, t.field);
      if (!pre || typeof pre.sha !== "string") { refuse("no pre-image for this slot"); continue; }
      if (pre.sha !== liveSha) { refuse(`live sha differs from pre-image (${liveSha.slice(0, 12)} != ${String(pre.sha).slice(0, 12)})`); continue; }
      if (markers(next) > markers(live)) { refuse("scrubber-corruption: draft holds more [REDACTED: markers than the stored field"); continue; }
      if (next.length >= live.length) { refuse(`not net-smaller: ${live.length} -> ${next.length}`); continue; }
      const missing = (t.deferredEdits ?? []).filter((e: any) => {
        const probe = String(e?.content ?? "").trim().slice(0, 60);
        return probe && !next.includes(probe);
      });
      if (missing.length) { refuse(`deferred edit(s) not folded in: ${missing.map((e: any) => e.actionId).join(", ")}`); continue; }
      const afterSha = await sha(next);
      const row = {
        slot: t.slot,
        agentId: t.agentId,
        agentName: t.agentName,
        field: t.field,
        beforeChars: live.length,
        afterChars: next.length,
        beforeSha: liveSha,
        afterSha,
        preimageKey: preimageKey(runId, t.agentId, t.field),
        foldedEdits: (t.deferredEdits ?? []).map((e: any) => e.actionId),
        overTarget: t.targetChars !== null && next.length > t.targetChars,
        revert: revertLine(runId, t.agentId, t.field),
      };
      const mems: any[] = (Array.isArray(d.movedToMemory) ? d.movedToMemory : []).slice(0, MAX_MEMORIES_PER_TRIM);
      if (dry) {
        out.wouldApply.push({ ...row, memories: mems.map((m) => m?.name), cuts: cutsFrom(live, next).length });
        continue;
      }
      // Re-check immediately before the write: the smallest window we can get without CAS on update-profile.
      const again = await readField(t.field, t.agentId);
      if ((await sha(again ?? "")) !== liveSha) { refuse("field changed between plan and write"); continue; }
      await ctx.swarm.profile_update({ agentId: t.agentId, [t.field]: next });
      const reSha = await sha((await readField(t.field, t.agentId)) ?? "");
      if (reSha !== afterSha) { refuse(`re-read sha ${reSha.slice(0, 12)} != ${afterSha.slice(0, 12)} after write`); continue; }
      await kvSet(`trim-state:${t.agentId}:${t.field}`, {
        agentId: t.agentId, field: t.field, runId, at: new Date().toISOString(),
        beforeSha: liveSha, beforeChars: live.length, afterSha, afterChars: next.length, afterText: next,
      });
      out.applied.push({ ...row, verifiedBy: `sha256(re-read ${t.field}) = ${afterSha.slice(0, 12)}` });
      for (const c of cutsFrom(live, next))
        cutLedger.push({
          cutId: `${runId.slice(0, 8)}:A:${cutLedger.length}`,
          lane: "A",
          target: { kind: "profile", agentId: t.agentId, field: t.field },
          kind: "removed-block",
          ...c,
          preimageKey: preimageKey(runId, t.agentId, t.field),
        });
      for (const m of mems) {
        const name = String(m?.name ?? "");
        const content = String(m?.content ?? "");
        if (!/^[a-z0-9-]{3,90}$/.test(name) || !content.trim()) { out.memories.push({ name, status: "refused", reason: "bad name or empty" }); continue; }
        const c = await q(`SELECT COUNT(*) n FROM agent_memory WHERE name = ?`, [name]);
        if (Number(c[0]?.n) > 0) { out.memories.push({ name, status: "exists" }); continue; }
        await ctx.swarm.memory_store({ name, content, scope: m?.scope === "agent" ? "agent" : "swarm", tags: ["dreaming", runId, "trim"], intent: `dreaming ${runId} trim ${t.slot}` });
        const c2 = await q(`SELECT COUNT(*) n FROM agent_memory WHERE name = ? AND COALESCE(chunkIndex, 0) = 0`, [name]);
        out.memories.push({ name, status: Number(c2[0]?.n) === 1 ? "stored" : "store-unverified", fromSlot: t.slot });
      }
    } catch (e: any) {
      errors.push(`${t.slot}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }

  if (!dry && runId && cutLedger.length) {
    try {
      await kvSet(`cuts:${runId}:A`, { runId, lane: "A", at: new Date().toISOString(), cuts: cutLedger });
      (out as any).cutsKey = `cuts:${runId}:A`;
    } catch (e: any) {
      errors.push(`cuts ledger: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  (out as any).cuts = cutLedger.length;
  const done = dry ? out.wouldApply : out.applied;
  const parts = done.map((x) => `${x.agentName} ${x.field} ${x.beforeChars}→${x.afterChars}`);
  for (const x of out.reapplied) parts.push(`${x.agentName} ${x.field} re-applied`);
  out.slackLine = parts.length ? `Trims${dry ? " (dry run, not written)" : ""}: ${parts.join("; ")}` : "Trims: none tonight";
  if (out.refused.length) out.slackLine += ` (${out.refused.length} refused)`;
  out.ok = errors.length === 0;
  return out;
}

