import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

// Dreaming manual rollback (Lead runs it by hand; not part of the nightly graph). Never throws.
// 1. Profile pre-images: KV dreaming/preimage:<runId>:<agentId>:<field> (written by trim plan and heartbeat). Each is
//    restored when the live field is still this run's write (trim-state / hb-state afterSha), or with overwrite:true.
//    They go first: trims run after apply, so their pre-image already holds apply's edits.
// 2. Ledger: KV dreaming/ledger:<runId>; undoes each applied item in reverse order, re-reads after each restore.
// agentId/field select profile pre-images only; actionIds select ledger items only. See the dreaming design.
// mode "artifact" {kind, name}: undo one adoption-gate retirement from KV dreaming/artifact:<kind>:<name>. A skill is
// re-enabled; a script is re-upserted at its recorded scope from the record's `source`. The record becomes `restored`,
// so the gate stops checking it.

export const argsSchema = z.object({
  // Required for the run rollback; unused in mode "artifact".
  runId: z.string().optional(),
  mode: z.enum(["run", "artifact"]).optional(),
  // mode "artifact": which retired artifact to bring back.
  kind: z.enum(["skill", "script"]).optional(),
  name: z.string().optional(),
  actionIds: z.array(z.string()).optional(),
  dryRun: z.union([z.boolean(), z.string()]).optional(),
  // dryRun only: run the read control on the plain (scrubbed) read. Negative control, never live.
  legacyRead: z.union([z.boolean(), z.string()]).optional(),
  // Profile pre-image filter (restores only matching preimage:<runId>:<agentId>:<field> keys, no ledger items).
  agentId: z.string().optional(),
  field: z.string().optional(),
  // Restore a profile pre-image even when the live field is not this run's recorded write.
  overwrite: z.union([z.boolean(), z.string()]).optional(),
});

const NS = "dreaming";
const PROFILE_FIELDS = ["claudeMd", "soulMd", "identityMd", "toolsMd", "heartbeatMd"];
const FIELD: Record<string, string> = {
  SOUL: "soulMd",
  IDENTITY: "identityMd",
  CLAUDE: "claudeMd",
  TOOLS: "toolsMd",
  HEARTBEAT: "heartbeatMd",
};

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
// Every ctx.swarm response (db_query and kv reads) passes the secret scrubber, which rewrites secret-looking
// `key=value` text to `[REDACTED:<key>]`. Apply's memory pre-image rows carry `contentHex` (stored bytes), so the
// restore body is decoded from it and the re-read uses hex(...) too; plain reads would corrupt or false-fail.
const MARK = "[REDACTED:";
const markers = (s: string) => String(s ?? "").split(MARK).length - 1;
const decodeHex = (hx: unknown) =>
  new TextDecoder().decode(new Uint8Array((String(hx ?? "").match(/../g) ?? []).map((h) => parseInt(h, 16))));
// Stored bytes of a pre-image row: contentHex when present (apply v8+), else the legacy `content`.
const preBody = (m: any) => (typeof m?.contentHex === "string" && m.contentHex ? decodeHex(m.contentHex) : String(m?.content ?? ""));
const once = (text: string, s: string) => {
  const i = s ? text.indexOf(s) : -1;
  return i >= 0 && text.indexOf(s, i + 1) < 0 ? i : -1;
};

/** Dreaming rollback: restore profile fields, identity edits and memories a dreaming run wrote, from its KV pre-images. */
export default async function (args: unknown, ctx: ScriptContext) {
  const a: any = args ?? {};
  const restored: any[] = [];
  const failed: any[] = [];
  const planned: any[] = [];
  const dry = a.dryRun === true || a.dryRun === "true";
  if (a.mode === "artifact") return rollbackArtifact(a, ctx, dry);
  const runId = typeof a.runId === "string" ? a.runId : "";
  if (!runId) return { restored, failed: [{ actionId: null, reason: "runId required" }], planned };
  const only: string[] = Array.isArray(a.actionIds) ? a.actionIds.map(String) : [];
  const q = async (sql: string, params: unknown[] = []) => rows(await ctx.swarm.db_query({ sql, params }));
  const legacyRead = dry && (a.legacyRead === true || a.legacyRead === "true");
  // Stored bytes of one memory's content via hex (legacy: the scrubbed plain read, dryRun control only).
  const readMemory = async (memoryId: string, legacy = false) => {
    const r = await q(`SELECT content, hex(CAST(content AS BLOB)) AS hx FROM agent_memory WHERE id = ?`, [memoryId]);
    return r.length ? (legacy ? String(r[0].content ?? "") : decodeHex(r[0].hx)) : null;
  };
  // Stored bytes of one profile field via hex (field comes from PROFILE_FIELDS, never from free input).
  const readField = async (field: string, agentId: string) => {
    const r = await q(`SELECT hex(CAST(${field} AS BLOB)) AS hx FROM agents WHERE id = ?`, [agentId]);
    return r.length ? decodeHex(r[0].hx) : null;
  };
  // Read control, every run. Positive: a secret-looking pre-image row (content scrubbed as a kv read would be,
  // contentHex intact) restores the stored bytes, and the hex re-read of those bytes matches. Negative
  // (legacyRead): the plain re-read of the same bytes differs, the false "re-read differs" failure.
  const controls: any = { ok: false, legacyRead };
  try {
    const fx = "api" + "_key=sk-" + "fixture-9f8e7d6c5b4a39281706f5e4d3c2b1a0\nsecond line of the memory body";
    const p = (await q(`SELECT ? AS plain, hex(CAST(? AS BLOB)) AS hx`, [fx, fx]))[0] ?? {};
    const plain = String(p.plain ?? "");
    const row = { content: plain, contentHex: String(p.hx ?? "") };
    const body = preBody(row);
    const reread = (legacy: boolean) => (legacy ? plain : decodeHex(p.hx));
    const scrubberActive = plain !== fx && markers(plain) > 0;
    controls.positive = { fixture: "secret-looking key=value", scrubberActive, bodyIsStored: body === fx, rereadMatches: reread(legacyRead) === body };
    controls.positive.ok = scrubberActive && controls.positive.bodyIsStored && controls.positive.rereadMatches;
    controls.negative = { rereadMatches: reread(true) === body };
    controls.negative.ok = !controls.negative.rereadMatches;
    controls.ok = controls.positive.ok && controls.negative.ok;
  } catch (e: any) {
    controls.error = String(e?.message ?? e).slice(0, 200);
  }
  // Live memory writes need preBody to yield stored bytes. Not gated on scrubberActive: a scrubber change must
  // never block an emergency rollback.
  const bodyGate = () => controls.positive?.bodyIsStored === true;
  const BODY_GATE = "skipped: controls.positive.bodyIsStored is not true, preBody may not yield stored bytes";

  // ---- 1. profile pre-images ----
  const wantAgent = typeof a.agentId === "string" ? a.agentId : "";
  const wantField = typeof a.field === "string" ? a.field : "";
  const profileOnly = !!(wantAgent || wantField);
  const overwrite = a.overwrite === true || a.overwrite === "true";
  const skipped: any[] = [];
  let profileKeys = 0;
  if (profileOnly || !only.length) {
    try {
      // Stored bytes of the KV value (hex), so the restore text never carries scrubber markers.
      const prefix = `preimage:${runId}:`;
      const kv = await q(
        `SELECT key, hex(CAST(value AS BLOB)) AS hx FROM kv_entries WHERE namespace = ? AND substr(key, 1, length(?)) = ? ORDER BY key`,
        [NS, prefix, prefix],
      );
      for (const e of kv) {
        const parts = String(e.key).slice(prefix.length).split(":");
        if (parts.length !== 2) continue; // apply's preimage:<runId>:<actionId> rows belong to the ledger path
        const [agentId, field] = parts as [string, string];
        if (!PROFILE_FIELDS.includes(field)) continue;
        if ((wantAgent && agentId !== wantAgent) || (wantField && field !== wantField)) continue;
        profileKeys++;
        const ref = { actionId: null, kind: "profile", agentId, field, preimageKey: String(e.key) };
        try {
          let pre: any = null;
          try { pre = JSON.parse(decodeHex(e.hx)); } catch {}
          const text = pre?.content;
          if (typeof text !== "string" || typeof pre?.sha !== "string") { failed.push({ ...ref, reason: "pre-image has no content/sha" }); continue; }
          if ((await sha(text)) !== pre.sha) { failed.push({ ...ref, reason: "pre-image content does not match its sha" }); continue; }
          const cur = (await readField(field, agentId)) ?? null;
          if (cur === null) { failed.push({ ...ref, reason: "agent not found" }); continue; }
          const curSha = await sha(cur);
          if (curSha === pre.sha) { skipped.push({ ...ref, reason: "live field already equals the pre-image" }); continue; }
          // Ours = the live field is still the write this run recorded.
          const st: any = field === "heartbeatMd"
            ? (await ctx.swarm.kv_getOrNull({ namespace: NS, key: `hb-state:${runId}` }))?.value
            : (await ctx.swarm.kv_getOrNull({ namespace: NS, key: `trim-state:${agentId}:${field}` }))?.value;
          const ours = !!st && (field === "heartbeatMd" || st.runId === runId) && typeof st.afterSha === "string" && st.afterSha === curSha;
          if (!ours && !overwrite) { failed.push({ ...ref, reason: "live field is not this run's recorded write (changed since, or no record); pass overwrite:true to restore anyway" }); continue; }
          const how = ours ? "full pre-image (live field = this run's write)" : "full pre-image (overwrite)";
          if (dry) { planned.push({ ...ref, how, netChars: text.length - cur.length }); continue; }
          await ctx.swarm.profile_update({ agentId, [field]: text });
          if ((await sha((await readField(field, agentId)) ?? "")) === pre.sha) {
            restored.push({ ...ref, how, verifiedBy: `sha256(re-read ${field}) = ${pre.sha.slice(0, 12)}` });
            if (field !== "heartbeatMd" && st?.runId === runId)
              await ctx.swarm.kv_set({ namespace: NS, key: `trim-state:${agentId}:${field}`, value: { ...st, revertedAt: new Date().toISOString(), revertedRunId: runId } as any });
          } else failed.push({ ...ref, reason: "re-read sha differs after restore" });
        } catch (err: any) {
          failed.push({ ...ref, reason: String(err?.message ?? err).slice(0, 200) });
        }
      }
    } catch (e: any) {
      failed.push({ actionId: null, reason: `pre-image scan: ${String(e?.message ?? e).slice(0, 200)}` });
    }
  }
  const done = (extra: Record<string, unknown> = {}) => ({ mode: dry ? "dry-run" : "live", runId, restored, failed, planned, skipped, controls, ...extra });
  if (profileOnly) {
    if (!profileKeys) failed.push({ actionId: null, reason: `no profile pre-image for ${runId}${wantAgent ? `:${wantAgent}` : ""}${wantField ? `:${wantField}` : ""}` });
    return done();
  }

  // ---- 2. ledger ----
  let ledger: any = null;
  try {
    ledger = (await ctx.swarm.kv_getOrNull({ namespace: NS, key: `ledger:${runId}` }))?.value ?? null;
  } catch (e: any) {
    failed.push({ actionId: null, reason: `ledger read: ${String(e?.message ?? e).slice(0, 200)}` });
    return done();
  }
  if (!ledger || !Array.isArray(ledger.applied)) {
    // A run with profile pre-images but no ledger (a dry run, or verify did not finish) is still a rollback.
    if (!profileKeys) failed.push({ actionId: null, reason: `no ledger:${runId}` });
    return done({ ledger: false });
  }

  const items = [...ledger.applied].filter((x: any) => !only.length || only.includes(String(x.actionId))).reverse();
  for (const it of items) {
    const id = String(it.actionId);
    try {
      const pre: any = it.preimageKey ? ((await ctx.swarm.kv_getOrNull({ namespace: NS, key: it.preimageKey }))?.value ?? null) : null;

      if (it.kind === "identity") {
        const field = FIELD[it.target?.file] ?? "";
        const agentId = String(it.target?.agentId ?? "");
        if (!field || !pre) { failed.push({ actionId: id, reason: "missing field or pre-image" }); continue; }
        const cur = String((await q(`SELECT ${field} AS body FROM agents WHERE id = ?`, [agentId]))[0]?.body ?? "");
        let next: string | null = null;
        let how = "";
        if ((await sha(cur)) === it.afterSha && pre.contextVersionId) {
          const cv = await q(`SELECT content FROM context_versions WHERE id = ?`, [pre.contextVersionId]);
          if (cv.length && (await sha(String(cv[0].content ?? ""))) === pre.sha256) {
            next = String(cv[0].content);
            how = "full pre-image from context_versions";
          }
        }
        if (next === null) {
          // Field changed since our write (or pointer mismatch): splice back only our section.
          const op = String(it.target?.op ?? pre.op ?? "");
          const content = String(pre.content ?? it.content ?? "").trim();
          const section = String(pre.section ?? "");
          if (op === "remove-section") {
            next = `${cur.replace(/\s*$/, "")}\n\n${section.trim()}\n`;
            how = "re-appended removed section at end of file";
          } else if (op === "replace-exact") {
            const i = content ? once(cur, content) : -1;
            if (i >= 0) { next = cur.slice(0, i) + section + cur.slice(i + content.length); how = "replace-exact reversed"; }
          } else if (op === "append-under") {
            const i = once(cur, content);
            if (i >= 0) { next = (cur.slice(0, i).replace(/\n+$/, "\n") + cur.slice(i + content.length).replace(/^\n+/, "\n")); how = "appended text removed"; }
          } else if (op === "replace-section") {
            const i = once(cur, content);
            if (i >= 0) {
              const body = section.replace(/^## .*\r?\n?/, "").trim();
              next = cur.slice(0, i) + body + cur.slice(i + content.length);
              how = "section body restored";
            }
          }
          if (next === null) { failed.push({ actionId: id, reason: `cannot splice back ${op}: our text no longer occurs exactly once` }); continue; }
        }
        const want = await sha(next);
        if (dry) { planned.push({ actionId: id, kind: "identity", agentId, field, how, netChars: next.length - cur.length }); continue; }
        await ctx.swarm.profile_update({ agentId, [field]: next });
        const re = String((await q(`SELECT ${field} AS body FROM agents WHERE id = ?`, [agentId]))[0]?.body ?? "");
        if ((await sha(re)) === want) restored.push({ actionId: id, kind: "identity", how });
        else failed.push({ actionId: id, reason: "re-read sha differs after restore" });
      } else if (it.kind === "memory-store") {
        const mid = String(it.target?.memoryId ?? "");
        const r = mid ? await q(`SELECT COUNT(*) n FROM agent_memory WHERE id = ?`, [mid]) : [];
        if (!mid || Number(r[0]?.n) === 0) { failed.push({ actionId: id, reason: "stored memory already gone or id unknown" }); continue; }
        if (dry) { planned.push({ actionId: id, kind: "memory-store", how: `memory_delete ${mid}` }); continue; }
        await ctx.swarm.memory_delete({ id: mid });
        const r2 = await q(`SELECT COUNT(*) n FROM agent_memory WHERE id = ?`, [mid]);
        if (Number(r2[0]?.n) === 0) restored.push({ actionId: id, kind: "memory-store", how: "deleted" });
        else failed.push({ actionId: id, reason: "row still present after delete" });
      } else if (it.kind === "memory-delete") {
        const pr: any[] = pre?.rows ?? [];
        if (!pr.length) { failed.push({ actionId: id, reason: "no pre-image rows" }); continue; }
        if (dry) { planned.push({ actionId: id, kind: "memory-delete", how: `re-store ${pr.length} row(s) (new ids)` }); continue; }
        if (!bodyGate()) { failed.push({ actionId: id, reason: BODY_GATE }); continue; }
        for (const m of pr) {
          let tags: string[] = [];
          try { tags = Array.isArray(m.tags) ? m.tags : JSON.parse(m.tags ?? "[]"); } catch {}
          await ctx.swarm.memory_store({ name: String(m.name), content: preBody(m), scope: m.scope === "agent" ? "agent" : "swarm", tags: [...tags, "dreaming-restored"], intent: `dreaming-rollback ${runId} ${id}` });
          const c = await q(`SELECT COUNT(*) n FROM agent_memory WHERE name = ?`, [m.name]);
          if (Number(c[0]?.n) >= 1) restored.push({ actionId: id, kind: "memory-delete", how: `re-stored ${m.name}` });
          else failed.push({ actionId: id, reason: `re-store of ${m.name} not visible` });
        }
      } else if (it.kind === "memory-edit") {
        const m = pre?.rows?.[0];
        if (!m) { failed.push({ actionId: id, reason: "no pre-image row" }); continue; }
        if (dry) { planned.push({ actionId: id, kind: "memory-edit", how: `memory_edit ${m.id} back to pre-image` }); continue; }
        if (!bodyGate()) { failed.push({ actionId: id, reason: BODY_GATE }); continue; }
        const body = preBody(m);
        await ctx.swarm.memory_edit({ memoryId: m.id, mode: "replace", content: body, intent: `dreaming-rollback ${runId} ${id}` });
        const r = await readMemory(m.id, legacyRead);
        if (r !== null && r === body) restored.push({ actionId: id, kind: "memory-edit", how: "content restored" });
        else failed.push({ actionId: id, reason: "re-read differs after restore" });
      } else if (it.kind === "skill") {
        const skillId = String(it.skillId ?? "");
        if (!skillId) { failed.push({ actionId: id, reason: "skillId missing" }); continue; }
        if (pre?.content) {
          if (dry) { planned.push({ actionId: id, kind: "skill", how: "skill_update content back to pre-image" }); continue; }
          await ctx.swarm.skill_update({ skillId, content: String(pre.content) });
          const r = await q(`SELECT content FROM skills WHERE id = ?`, [skillId]);
          if (r.length && String(r[0].content) === String(pre.content)) restored.push({ actionId: id, kind: "skill", how: "content restored" });
          else failed.push({ actionId: id, reason: "skill content differs after restore" });
        } else {
          // No pre-image: a skill-create. Disable (reversible); delete after the week-1 review.
          if (dry) { planned.push({ actionId: id, kind: "skill", how: "skill_update isEnabled:false (created skill)" }); continue; }
          await ctx.swarm.skill_update({ skillId, isEnabled: false });
          const r = await q(`SELECT isEnabled FROM skills WHERE id = ?`, [skillId]);
          if (r.length && !Number(r[0].isEnabled)) restored.push({ actionId: id, kind: "skill", how: "disabled" });
          else failed.push({ actionId: id, reason: "skill still enabled after disable" });
        }
      } else failed.push({ actionId: id, reason: `unknown kind ${it.kind}` });
    } catch (e: any) {
      failed.push({ actionId: id, reason: String(e?.message ?? e).slice(0, 200) });
    }
  }
  return done();
}

/** mode "artifact": bring back one skill or script the adoption gate retired. Never throws. */
async function rollbackArtifact(a: any, ctx: ScriptContext, dry: boolean) {
  const restored: any[] = [];
  const failed: any[] = [];
  const planned: any[] = [];
  const kind = a.kind === "skill" || a.kind === "script" ? a.kind : "";
  const name = typeof a.name === "string" ? a.name : "";
  const key = `artifact:${kind}:${name}`;
  const done = () => ({ mode: dry ? "dry-run" : "live", target: "artifact", key, restored, failed, planned });
  if (!kind || !name) {
    failed.push({ key, reason: "mode artifact needs kind (skill|script) and name" });
    return done();
  }
  const q = async (sql: string, params: unknown[] = []) => rows(await ctx.swarm.db_query({ sql, params }));
  try {
    // Stored bytes (hex): the script source must survive the scrubber byte-exact.
    const kv = await q(`SELECT hex(CAST(value AS BLOB)) AS hx FROM kv_entries WHERE namespace = ? AND key = ?`, [NS, key]);
    let rec: any = null;
    try { rec = kv.length ? JSON.parse(decodeHex(kv[0].hx)) : null; } catch {}
    if (!rec || typeof rec !== "object") { failed.push({ key, reason: "no artifact record" }); return done(); }
    const mark = async (extra: Record<string, unknown>) =>
      ctx.swarm.kv_set({ namespace: NS, key, value: { ...rec, ...extra, status: "restored", restoredAt: new Date().toISOString() } as any });

    if (kind === "skill") {
      const skillId = String(rec.id ?? "");
      const live = skillId ? await q(`SELECT isEnabled FROM skills WHERE id = ?`, [skillId]) : [];
      if (!live.length) { failed.push({ key, reason: "skill row is gone" }); return done(); }
      if (dry) { planned.push({ key, how: "skill_update isEnabled:true" }); return done(); }
      if (!Number(live[0].isEnabled)) await ctx.swarm.skill_update({ skillId, isEnabled: true });
      const back = await q(`SELECT isEnabled FROM skills WHERE id = ?`, [skillId]);
      if (back.length && Number(back[0].isEnabled)) {
        await mark({});
        restored.push({ key, how: "skill re-enabled" });
      } else failed.push({ key, reason: "skill still disabled after skill_update" });
      return done();
    }

    const scope = rec.scope === "global" ? "global" : "agent";
    const source = typeof rec.source === "string" ? rec.source : "";
    if (!source) { failed.push({ key, reason: "record has no source" }); return done(); }
    if ((await sha(source)) !== String(rec.contentHash ?? "")) { failed.push({ key, reason: "record source does not match its contentHash" }); return done(); }
    // script_upsert writes an agent-scope row under the CALLER, not the recorded owner: run by anyone else it
    // would create or overwrite the caller's own same-name script. Only the owner restores an agent-scope script.
    const owner = scope === "agent" ? String(rec.agentId ?? "") : "";
    if (scope === "agent") {
      if (!owner) { failed.push({ key, reason: "agent-scope record has no owner (agentId)" }); return done(); }
      let caller = "";
      try { caller = String(ctx.stdlib.Redacted.value(ctx.swarm.config.agentId) ?? ""); } catch {}
      if (caller !== owner) {
        failed.push({ key, reason: `agent-scope script restores only when its owner ${owner} runs the rollback`, owner });
        return done();
      }
    }
    const ownerClause = scope === "agent" ? " AND scopeId = ?" : "";
    const ownerParam = ownerClause ? [owner] : [];
    const live = await q(`SELECT id, contentHash FROM scripts WHERE name = ? AND scope = ?${ownerClause}`, [name, scope, ...ownerParam]);
    if (live.length && String(live[0].contentHash) === String(rec.contentHash)) {
      if (!dry) await mark({ id: String(live[0].id) });
      restored.push({ key, how: "script already present with the recorded contentHash" });
      return done();
    }
    if (live.length) { failed.push({ key, reason: "another script now holds this name; not overwritten" }); return done(); }
    if (dry) { planned.push({ key, how: `script_upsert scope ${scope} from the recorded source` }); return done(); }
    await ctx.swarm.script_upsert({
      name,
      source,
      scope,
      description: typeof rec.description === "string" && rec.description ? rec.description : `Restored ${name} (dreaming adoption-gate rollback).`,
      intent: typeof rec.intent === "string" && rec.intent ? rec.intent : "Brought back by hand after the dreaming adoption gate retired it.",
    });
    const back = await q(`SELECT id FROM scripts WHERE name = ? AND scope = ? AND contentHash = ?${ownerClause}`, [name, scope, String(rec.contentHash), ...ownerParam]);
    if (back.length) {
      await mark({ id: String(back[0].id) });
      restored.push({ key, how: `script_upsert scope ${scope}` });
    } else failed.push({ key, reason: "script not visible after script_upsert" });
  } catch (e: any) {
    failed.push({ key, reason: String(e?.message ?? e).slice(0, 200) });
  }
  return done();
}
