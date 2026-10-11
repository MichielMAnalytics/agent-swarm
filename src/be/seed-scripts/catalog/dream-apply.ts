import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

// Dreaming apply node: apply tier:"auto" identity + memory actions from synthesis, verify each by re-read.
// See the dreaming design (apply node, pre-images and rollback). Never throws.
// Writes happen iff !dryRun. `lanes.identity === false` / `lanes.memory === false` refuse that lane's actions.

export const argsSchema = z.object({
  runId: z.string().optional(),
  dryRun: z.union([z.boolean(), z.string()]).optional(),
  synth: z.unknown().optional(),
  caps: z.unknown().optional(),
  // { heartbeat, trim, identity, memory }. Missing = every lane on; an explicit false turns a lane off.
  lanes: z.unknown().optional(),
  // dryRun only: synthetic cut ledgers for the restore-runner controls. Ignored on live runs.
  fixtureCuts: z.array(z.unknown()).optional(),
  // dryRun only: read `before` (identity), the memory-edit pre-image and the rename body through the plain (scrubbed) db_query path, as v5 did. Negative control for the write guard.
  legacyRead: z.boolean().optional(),
  // Replay: load a past run's synthesize output, keep only `approve` ids, force tier auto, merge `patch`.
  replayRunId: z.string().optional(),
  approve: z.array(z.string()).optional(),
  patch: z.record(z.string(), z.unknown()).optional(),
});

const NS = "dreaming";
const FIELD: Record<string, string> = {
  SOUL: "soulMd",
  IDENTITY: "identityMd",
  CLAUDE: "claudeMd",
  TOOLS: "toolsMd",
  HEARTBEAT: "heartbeatMd",
};
const DEFAULT_CAPS = { identityOpsTotal: 6, identityOpsPerAgent: 1, memoryStore: 5, memoryEdit: 5, memoryDelete: 10 };

// ---- memory-edit guards (same block in dream-verify). A past run had synthesis put the edit
// instruction ("APPEND to the end of the existing text (keep everything above): ...") in `content`
// and apply wrote it as the whole body (3857 -> 392 chars). `content` is a body, never an instruction.
const EDIT_INSTRUCTION =
  /^[\s*_#>`"'(\[-]*(append|prepend|replace|insert)\b[^\n]{0,80}?\b(existing\s+(text|body|content|memory|section|paragraph)|above|below|(the\s+)?end\s+of|(the\s+)?(top|beginning|start)\s+of)\b/i;
const KEEP_ABOVE = /keep\s+everything\s+(above|below)/i;
export function editMode(act: any): string {
  const m = act?.mode ?? act?.target?.mode;
  return m === undefined || m === null || m === "" ? "replace" : String(m);
}
// allowShrink counts only with a reason: "<reason>" or { reason: "<reason>" }.
export function shrinkReason(act: any): string {
  const s = act?.allowShrink;
  const r = typeof s === "string" ? s : s && typeof s === "object" ? s.reason : "";
  return typeof r === "string" ? r.trim() : "";
}
export function memEditBody(pre: string, content: string, mode: string): string {
  return mode === "append" ? `${pre.trimEnd()}\n${content}` : content;
}
export function memEditDefects(e: { pre: string; next: string; mode: string; shrinkReason?: string }): string[] {
  const d: string[] = [];
  let added = e.next;
  if (e.mode === "append") {
    const head = `${e.pre.trimEnd()}\n`;
    if (!e.next.startsWith(head)) d.push("append: new body does not start with the pre-image");
    else added = e.next.slice(head.length);
  } else if (e.mode !== "replace") d.push(`unknown mode: ${e.mode}`);
  if (EDIT_INSTRUCTION.test(added)) d.push(`instruction-text: content starts with an edit instruction ("${added.trim().slice(0, 60)}")`);
  if (KEEP_ABOVE.test(added)) d.push('instruction-text: content contains "keep everything above"');
  if (e.mode === "replace" && e.next.length < 0.5 * e.pre.length && !e.shrinkReason)
    d.push(`shrink: ${e.pre.length} -> ${e.next.length} chars (<50% of the pre-image) without allowShrink reason`);
  return d;
}

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

// Every ctx.swarm response passes the secret scrubber, which rewrites secret-looking `key=value` text to
// `[REDACTED:<key>]`. Profile text is read as hex(...) and decoded here, so a write never carries the markers back.
const MARK = "[REDACTED:";
const markers = (s: string) => String(s ?? "").split(MARK).length - 1;
const decodeHex = (hx: unknown) =>
  new TextDecoder().decode(new Uint8Array((String(hx ?? "").match(/../g) ?? []).map((h) => parseInt(h, 16))));
// Refuse when the new text holds more markers than the stored text plus the approved op content.
const scrubberGuard = (stored: string, next: string, content: string) => {
  const s = markers(stored), n = markers(next), c = markers(content);
  return n > s + c ? { ok: false as const, reason: "scrubber-corruption", stored: s, next: n, content: c } : { ok: true as const, stored: s, next: n, content: c };
};
// Memory pre-image row: stored bytes in `content`, plus the hex itself so a restore decodes it even when its own read is scrubbed.
const storedRow = (r: any) => {
  const { hx, ...rest } = r ?? {};
  return { ...rest, content: decodeHex(hx), contentHex: String(hx ?? "") };
};
// Rename: compose the new body from stored bytes (hex). legacy: from the plain (scrubbed) read, dryRun negative control only.
const renameCompose = (rws: { content?: unknown; hx?: unknown }[], legacy: boolean) => {
  const stored = joinChunks(rws.map((r) => decodeHex(r.hx)));
  const content = legacy ? joinChunks(rws.map((r) => String(r.content ?? ""))) : stored;
  return { content, stored, guard: scrubberGuard(stored, content, "") };
};

// ---- H2-anchored profile edit helpers (getH2Anchors / applyAnchoredProfileOp) ----
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
function h2Ranges(text: string) {
  const ms = [...maskFenced(text).matchAll(/^## (?!#).*$/gm)];
  return ms.map((m, i) => {
    const start = m.index ?? 0;
    const lineEnd = start + m[0].length;
    return { heading: text.slice(start, lineEnd), start, lineEnd, nextStart: ms[i + 1]?.index ?? text.length };
  });
}
type OpResult = { applied: true; text: string; section: string } | { applied: false; reason: string };
function applyAnchored(text: string, file: string, op: string, anchorRaw: string, contentRaw: string): OpResult {
  const anchor = (anchorRaw ?? "").trim();
  if (!/^## (?!#)/.test(anchor)) return { applied: false, reason: "anchor must be an exact H2 heading" };
  const matches = h2Ranges(text).filter((h) => h.heading.trim() === anchor);
  if (matches.length !== 1)
    return { applied: false, reason: matches.length === 0 ? `anchor not found: ${anchor}` : `anchor is ambiguous: ${anchor}` };
  const content = (contentRaw ?? "").trim();
  if ((op === "append-under" || op === "replace-section") && !content) return { applied: false, reason: `${op} requires content` };
  if (/^## /m.test(content)) return { applied: false, reason: "content must not introduce H2 headings" };
  const m = matches[0]!;
  const section = text.slice(m.start, m.nextStart);
  let next: string;
  if (op === "append-under") {
    const has = text.slice(m.lineEnd, m.nextStart).trim().length > 0;
    const before = text.slice(0, m.nextStart).replace(/[ \t]*(?:\r?\n)+$/, "");
    const after = text.slice(m.nextStart);
    next = `${before}${has ? "\n\n" : "\n"}${content}${after.length > 0 ? "\n\n" : text.endsWith("\n") ? "\n" : ""}${after}`;
  } else if (op === "replace-section") {
    const after = text.slice(m.nextStart);
    next = `${text.slice(0, m.lineEnd)}\n${content}${after.length > 0 ? "\n\n" : text.endsWith("\n") ? "\n" : ""}${after}`;
  } else if (op === "remove-section") {
    next = `${text.slice(0, m.start)}${text.slice(m.nextStart)}`;
  } else return { applied: false, reason: `unsupported profile op: ${op}` };
  if ((file === "SOUL" || file === "IDENTITY") && next.length < 200)
    return { applied: false, reason: `${file} would be shorter than 200 characters` };
  return { applied: true, text: next, section };
}
function replaceExact(text: string, file: string, find: string, content: string): OpResult {
  if (!find || find.length < 40) return { applied: false, reason: "find must be >= 40 chars" };
  const i = text.indexOf(find);
  if (i < 0) return { applied: false, reason: "find not found" };
  if (text.indexOf(find, i + 1) >= 0) return { applied: false, reason: "find is ambiguous" };
  if (/^## /m.test(content ?? "")) return { applied: false, reason: "content must not introduce H2 headings" };
  const next = text.slice(0, i) + (content ?? "") + text.slice(i + find.length);
  if ((file === "SOUL" || file === "IDENTITY") && next.length < 200)
    return { applied: false, reason: `${file} would be shorter than 200 characters` };
  return { applied: true, text: next, section: find };
}

// Chunks of one memory overlap: drop the longest suffix of `a` that prefixes `b` (>= 20 chars).
function joinChunks(parts: string[]): string {
  // Two chunkers exist: markdown-section chunks start with a "# Title > ## Section" breadcrumb line;
  // sliding-window chunks overlap the previous chunk's tail.
  let out = parts[0] ?? "";
  for (const raw of parts.slice(1)) {
    const crumb = raw.match(/^# [^\n]*? > (#{2,6} [^\n]*)/);
    if (crumb) {
      out = `${out.replace(/\s+$/, "")}\n\n${crumb[1]}${raw.slice(crumb[0].length)}`;
      continue;
    }
    let k = 0;
    for (let n = Math.min(out.length, raw.length); n >= 20; n--) {
      if (out.endsWith(raw.slice(0, n))) {
        k = n;
        break;
      }
    }
    out += k ? raw.slice(k) : `\n${raw}`;
  }
  return out;
}

function parseObj(v: unknown): any {
  if (v && typeof v === "object") return v;
  if (typeof v === "string" && v.trim().startsWith("{")) {
    try {
      return JSON.parse(v);
    } catch {}
  }
  return null;
}

/** Dreaming apply: write approved identity and memory actions with pre-images, scrubber guards and re-read verification. */
export default async function (args: unknown, ctx: ScriptContext) {
  const a: any = args ?? {};
  const out = {
    mode: "",
    applied: [] as any[],
    refused: [] as any[],
    refusedSilently: [] as any[],
    wouldApply: [] as any[],
    alreadyApplied: [] as string[],
    skippedPropose: [] as string[],
    // Net-positive identity ops: never written alone. The trim lane folds them into a net-smaller rewrite.
    deferredToTrim: [] as any[],
    // Live runs: HEARTBEAT ops leave this script; the heartbeat lane folds them into the next hb-draft.
    deferredToHeartbeat: [] as any[],
    // Restore runner (synthesis restores[]): written only on live runs.
    restores: [] as any[],
    wouldRestore: [] as any[],
    restoreRefused: [] as any[],
    replay: null as any,
    errors: [] as string[],
  };
  const dry = a.dryRun === true || a.dryRun === "true";
  out.mode = dry ? "dry-run" : "live";
  const q = async (sql: string, params: unknown[] = []) => rows(await ctx.swarm.db_query({ sql, params }));
  // Stored bytes of one profile field (field comes from FIELD, never from input).
  const readStored = async (field: string, agentId: string) => {
    const r = await q(`SELECT isLead, hex(CAST(${field} AS BLOB)) AS hx FROM agents WHERE id = ?`, [agentId]);
    return r.length ? { isLead: r[0].isLead, body: decodeHex(r[0].hx) } : null;
  };
  // Stored bytes of one memory's content, same hex path.
  const readMemory = async (memoryId: string) => {
    const r = await q(`SELECT hex(CAST(content AS BLOB)) AS hx FROM agent_memory WHERE id = ?`, [memoryId]);
    return r.length ? decodeHex(r[0].hx) : null;
  };
  // Controls, every run. Positive: a secret-looking fixture round-trips byte-identical through the hex read
  // while the plain read is scrubbed. Negative: a write whose text gained a marker is refused.
  const controls: any = { ok: false };
  try {
    const fx = "api" + "_key=sk-" + "fixture-9f8e7d6c5b4a39281706f5e4d3c2b1a0";
    const p = (await q(`SELECT ? AS plain, hex(CAST(? AS BLOB)) AS hx`, [fx, fx]))[0] ?? {};
    const roundTrip = decodeHex(p.hx) === fx;
    const scrubberActive = String(p.plain ?? "") !== fx && markers(String(p.plain ?? "")) > 0;
    const g = scrubberGuard(fx + "\n", String(p.plain ?? "") + "\nadded line", "added line");
    controls.positive = { fixture: "secret-looking key=value", roundTrip, scrubberActive, ok: roundTrip && scrubberActive };
    controls.negative = { guard: g, ok: !g.ok && g.reason === "scrubber-corruption" };
    // Memory-edit lane: an append composed on the scrubbed read is refused against the stored bytes.
    const mg = scrubberGuard(fx, memEditBody(String(p.plain ?? ""), "added line", "append"), "added line");
    controls.memEdit = { guard: mg, ok: !mg.ok && mg.reason === "scrubber-corruption" };
    // Rename lane: a two-chunk fixture whose plain read is scrubbed. The hex compose must round-trip
    // byte-identical; the legacy (plain) compose must be refused.
    const tail = "shared overlap tail for the chunk join";
    const c1 = `${fx}\n${tail}`, c2 = `${tail}\nsecond chunk line`;
    const pr = await q(`SELECT ? AS c1, hex(CAST(? AS BLOB)) AS h1, ? AS c2, hex(CAST(? AS BLOB)) AS h2`, [c1, c1, c2, c2]);
    const rws = [{ content: pr[0]?.c1, hx: pr[0]?.h1 }, { content: pr[0]?.c2, hx: pr[0]?.h2 }];
    const rh = renameCompose(rws, false), rl = renameCompose(rws, true);
    const roundTripR = rh.guard.ok && rh.content === `${fx}\n${tail}\nsecond chunk line`;
    const plainScrubbed = String(pr[0]?.c1 ?? "") !== c1;
    controls.rename = {
      fixture: "two chunks, secret-looking key=value in chunk 0",
      result: roundTripR ? "round-trip" : !rh.guard.ok ? "refused" : "mismatch",
      plainScrubbed,
      guard: rh.guard,
      legacy: { guard: rl.guard, refused: !rl.guard.ok && rl.guard.reason === "scrubber-corruption" },
      ok: plainScrubbed && roundTripR && !rl.guard.ok && rl.guard.reason === "scrubber-corruption",
    };
    controls.ok = controls.positive.ok && controls.negative.ok && controls.memEdit.ok && controls.rename.ok;
  } catch (e: any) {
    controls.error = String(e?.message ?? e).slice(0, 200);
  }
  (out as any).controls = controls;
  const legacyRead = dry && a.legacyRead === true;
  const replayRunId = typeof a.replayRunId === "string" && a.replayRunId ? a.replayRunId : "";
  const runId = replayRunId || (typeof a.runId === "string" && a.runId ? a.runId : "");
  if (!runId) {
    out.errors.push("runId missing");
    return out;
  }
  let synth = parseObj(a.synth);
  if (replayRunId) {
    const approve: string[] = Array.isArray(a.approve) ? a.approve.map(String) : [];
    const patch: Record<string, any> = parseObj(a.patch) ?? {};
    try {
      const st = await q(`SELECT output FROM workflow_run_steps WHERE runId = ? AND nodeId = 'synthesize'`, [replayRunId]);
      const o = parseObj(st[0]?.output);
      synth = parseObj(o?.taskOutput);
    } catch (e: any) {
      out.errors.push(`replay load: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    if (synth && Array.isArray(synth.actions)) {
      const found = synth.actions.filter((x: any) => approve.includes(String(x?.id)));
      synth = {
        actions: found.map((x: any) => {
          const p = patch[String(x.id)] ?? {};
          return { ...x, ...p, target: { ...(x.target ?? {}), ...(p.target ?? {}) }, tier: "auto" };
        }),
      };
      out.replay = { runId: replayRunId, approve, found: found.map((x: any) => x.id), patched: Object.keys(patch) };
    }
  }
  if (!synth || !Array.isArray(synth.actions)) {
    out.errors.push("no synthesis output (synthesize failed or was skipped)");
    return out;
  }
  const caps = { ...DEFAULT_CAPS, ...(parseObj(a.caps) ?? {}) };
  const lanes = parseObj(a.lanes) ?? {};
  const laneOff = (lane: string) => lanes[lane] === false || lanes[lane] === "false";
  (out as any).lanes = { identity: !laneOff("identity"), memory: !laneOff("memory") };
  const writes = !dry;

  const kvGet = async (key: string) => ctx.swarm.kv_getOrNull({ namespace: NS, key });
  const kvSet = async (key: string, value: unknown) => ctx.swarm.kv_set({ namespace: NS, key, value: value as any });

  const perAgent = new Map<string, number>();
  const used = { identity: 0, store: 0, edit: 0, delete: 0 };
  const byId = (x: any, y: any) => {
    const n = (s: any) => Number(String(s?.id ?? "").replace(/\D/g, "")) || 0;
    return n(x) - n(y);
  };
  const actions = [...synth.actions].filter((x: any) => x && typeof x === "object").sort(byId);

  for (const act of actions) {
    if (act.lane !== "identity" && act.lane !== "memory") continue;
    const id = String(act.id ?? "");
    if (act.tier !== "auto") {
      out.skippedPropose.push(id);
      continue;
    }
    const refuse = (reason: string) => out.refused.push({ actionId: id, reason });
    if (laneOff(act.lane)) {
      refuse("lane off");
      continue;
    }
    try {
      const t = act.target ?? {};
      const appliedKey = `applied:${runId}:${id}`;
      const preKey = `preimage:${runId}:${id}`;

      if (act.lane === "identity") {
        const file = String(t.file ?? "");
        const field = FIELD[file];
        const agentId = String(t.agentId ?? "");
        if (!field) { refuse(`unknown file: ${file}`); continue; }
        if (!agentId) { refuse("target.agentId missing"); continue; }
        if (used.identity >= caps.identityOpsTotal) { refuse("cap: identityOpsTotal"); continue; }
        if ((perAgent.get(agentId) ?? 0) >= caps.identityOpsPerAgent) { refuse("cap: identityOpsPerAgent"); continue; }
        // 1. read fresh: stored bytes via hex (legacyRead: the scrubbed plain read, dryRun negative control only)
        const stored = await readStored(field, agentId);
        if (!stored) { refuse("agent not found"); continue; }
        const r = [stored];
        const before = legacyRead
          ? String((await q(`SELECT ${field} AS body FROM agents WHERE id = ?`, [agentId]))[0]?.body ?? "")
          : stored.body;
        const op = String(act.op ?? "");
        const content = String(act.content ?? "");
        // 2. guard
        if (file === "HEARTBEAT") {
          if (!Number(r[0]!.isLead)) { refuse("HEARTBEAT is Lead-only"); continue; }
          if (writes) {
            out.deferredToHeartbeat.push({ actionId: id, agentId, op, find: t.find ?? null, anchor: t.anchor ?? null, content });
            continue;
          }
          const removal = op === "remove-section" || (op === "replace-exact" && content.trim() === "");
          if (!removal) { refuse("HEARTBEAT allows removal only"); continue; }
        }
        const res =
          op === "replace-exact"
            ? replaceExact(before, file, String(t.find ?? ""), content)
            : applyAnchored(before, file, op, String(t.anchor ?? ""), content);
        if (!res.applied) { refuse(res.reason); continue; }
        const guard = scrubberGuard(stored.body, res.text, content);
        if (!guard.ok) {
          out.refused.push({ actionId: id, status: "refused", reason: "scrubber-corruption", markers: guard, legacyRead });
          continue;
        }
        const net = res.text.length - before.length;
        const growthOk = file === "CLAUDE" && op === "append-under" && content.trim().length <= 400;
        if (net > 0 && !growthOk) {
          out.deferredToTrim.push({ actionId: id, agentId, file, field, op, find: t.find ?? null, anchor: t.anchor ?? null, content, netChars: net });
          continue;
        }
        // 3. idempotency
        if (await kvGet(appliedKey)) { out.alreadyApplied.push(id); continue; }
        used.identity++;
        perAgent.set(agentId, (perAgent.get(agentId) ?? 0) + 1);
        const beforeSha = await sha(before);
        const afterSha = await sha(res.text);
        const target = { agentId, file, op, anchor: t.anchor ?? null };
        if (dry) {
          out.wouldApply.push({ actionId: id, kind: "identity", target, netChars: net, beforeSha, afterSha, storedSha: await sha(stored.body), guard });
          continue;
        }
        // 4. pre-image (rollback pointer = latest context_versions row, not the full field)
        const cv = await q(
          `SELECT id FROM context_versions WHERE agentId = ? AND field = ? ORDER BY version DESC, createdAt DESC LIMIT 1`,
          [agentId, field],
        );
        await kvSet(preKey, {
          kind: "identity",
          agentId,
          file,
          field,
          sha256: beforeSha,
          contextVersionId: cv[0]?.id ?? null,
          section: res.section,
          op,
          content,
        });
        // 5. write
        await ctx.swarm.profile_update({ agentId, [field]: res.text });
        // 6. re-read
        const reSha = await sha((await readStored(field, agentId))?.body ?? "");
        if (reSha === afterSha) {
          await kvSet(appliedKey, { at: new Date().toISOString(), afterSha });
          out.applied.push({ actionId: id, kind: "identity", target, netChars: net, preimageKey: preKey, verifiedBy: `sha256(re-read ${field}) = ${afterSha.slice(0, 12)}`, afterSha, section: res.section, content });
        } else {
          out.refusedSilently.push({ actionId: id, detail: `re-read sha ${reSha.slice(0, 12)} != expected ${afterSha.slice(0, 12)} (before ${beforeSha.slice(0, 12)})` });
        }
        continue;
      }

      // ---- memory lane ----
      const op = String(act.op ?? "");
      // A multi-chunk memory is one document: resolve every chunk of it, never a partial set.
      const expandDocs = async (ids: string[]) => {
        const docs: any[] = [];
        const bad: string[] = [];
        for (const mid of ids) {
          if (docs.some((d) => d.rows.some((r: any) => r.id === mid))) continue;
          const h = await q(`SELECT id, name, agentId, scope, source, totalChunks, createdAt FROM agent_memory WHERE id = ?`, [mid]);
          if (!h.length) { bad.push(`${mid}: missing`); continue; }
          const m = h[0];
          if (m.source !== "manual") { bad.push(`${mid}: source ${m.source}`); continue; }
          const all = await q(
            `SELECT id, name, agentId, scope, source, content, hex(CAST(content AS BLOB)) AS hx, tags, chunkIndex, totalChunks FROM agent_memory
             WHERE name = ? AND agentId IS ? AND COALESCE(totalChunks, 1) = ? AND source = 'manual'
               AND abs(julianday(createdAt) - julianday(?)) < 60.0 / 86400 ORDER BY chunkIndex`,
            [m.name, m.agentId, Number(m.totalChunks ?? 1), m.createdAt],
          );
          if (all.length !== Number(m.totalChunks ?? 1)) { bad.push(`${mid}: found ${all.length} of ${m.totalChunks} chunks`); continue; }
          docs.push({ name: m.name, agentId: m.agentId, scope: m.scope, tags: all[0].tags, rows: all });
        }
        return { docs, bad };
      };
      if (op === "memory-rename") {
        const ids: string[] = Array.isArray(t.memoryIds) ? t.memoryIds.map(String) : [];
        const name = String(t.name ?? "");
        if (!ids.length) { refuse("target.memoryIds empty"); continue; }
        if (!/^[a-z0-9-]{3,90}$/.test(name)) { refuse("name fails ^[a-z0-9-]{3,90}$"); continue; }
        if (used.edit + 1 > caps.memoryEdit) { refuse("cap: memory-rename (counts against memoryEdit)"); continue; }
        const { docs, bad } = await expandDocs(ids);
        if (bad.length) { refuse(bad.join("; ")); continue; }
        if (docs.length !== 1) { refuse(`memory-rename takes one document, got ${docs.length}`); continue; }
        const c = await q(`SELECT COUNT(*) n FROM agent_memory WHERE name = ?`, [name]);
        if (Number(c[0]?.n) > 0) { refuse("new name already exists"); continue; }
        if (await kvGet(appliedKey)) { out.alreadyApplied.push(id); continue; }
        used.edit++;
        const doc = docs[0];
        const oldIds = doc.rows.map((r: any) => r.id);
        // Compose from stored bytes (hex); refuse before memory_store if the body gained scrubber markers.
        const { content, guard } = renameCompose(doc.rows, legacyRead);
        let tags: string[] = [];
        try { tags = JSON.parse(doc.tags ?? "[]"); } catch {}
        const target = { memoryIds: oldIds, name, oldName: doc.name };
        if (!guard.ok) {
          out.refused.push({ actionId: id, status: "refused", reason: "scrubber-corruption", markers: guard, legacyRead });
          used.edit--;
          continue;
        }
        if (dry) { out.wouldApply.push({ actionId: id, kind: op, target, netChars: 0, contentChars: content.length }); continue; }
        await kvSet(preKey, { kind: op, rows: doc.rows.map(storedRow) });
        await ctx.swarm.memory_store({ name, content, scope: doc.scope === "agent" ? "agent" : "swarm", tags: [...tags, "dreaming", runId], intent: `dreaming ${runId} ${id}: rename of "${String(doc.name).slice(0, 80)}"` });
        const n1 = await q(`SELECT COUNT(*) n FROM agent_memory WHERE name = ? AND COALESCE(chunkIndex, 0) = 0`, [name]);
        if (Number(n1[0]?.n) !== 1) { out.refusedSilently.push({ actionId: id, detail: `COUNT(new name chunk0)=${n1[0]?.n}; old rows kept` }); continue; }
        // Re-read the new document via hex; old rows go only when it equals the composed body (stored trimmed).
        const nr = await q(`SELECT id, hex(CAST(content AS BLOB)) AS hx FROM agent_memory WHERE name = ? ORDER BY chunkIndex`, [name]);
        const reread = joinChunks(nr.map((r: any) => decodeHex(r.hx)));
        if (reread !== content.trim()) {
          out.refusedSilently.push({ actionId: id, detail: `re-read of new name (${nr.length} rows: ${nr.map((r: any) => r.id).join(",")}) differs from composed body; old rows kept` });
          continue;
        }
        for (const mid of oldIds) await ctx.swarm.memory_delete({ id: mid });
        const n2 = await q(`SELECT COUNT(*) n FROM agent_memory WHERE id IN (${oldIds.map(() => "?").join(",")})`, oldIds);
        if (Number(n2[0]?.n) === 0) {
          await kvSet(appliedKey, { at: new Date().toISOString() });
          out.applied.push({ actionId: id, kind: op, target, netChars: 0, preimageKey: preKey, verifiedBy: `hex re-read of new name equals composed body; COUNT(name=${name} chunk0)=1 and COUNT(old ids)=0` });
        } else out.refusedSilently.push({ actionId: id, detail: `new row stored but ${n2[0]?.n} old rows still present` });
        continue;
      }
      if (op === "memory-store") {
        const name = String(t.name ?? "");
        const content = String(act.content ?? "");
        if (used.store >= caps.memoryStore) { refuse("cap: memoryStore"); continue; }
        if (!/^[a-z0-9-]{3,90}$/.test(name)) { refuse("name fails ^[a-z0-9-]{3,90}$"); continue; }
        if (!content.trim()) { refuse("content empty"); continue; }
        const c = await q(`SELECT COUNT(*) n FROM agent_memory WHERE name = ?`, [name]);
        if (Number(c[0]?.n) > 0) { refuse("name already exists"); continue; }
        if (await kvGet(appliedKey)) { out.alreadyApplied.push(id); continue; }
        used.store++;
        const target = { name };
        if (dry) { out.wouldApply.push({ actionId: id, kind: "memory-store", target, netChars: content.length }); continue; }
        await kvSet(preKey, { kind: "memory-store", name });
        await ctx.swarm.memory_store({ name, content, scope: "swarm", tags: ["dreaming", runId], intent: `dreaming ${runId} ${id}` });
        const c2 = await q(`SELECT id FROM agent_memory WHERE name = ?`, [name]);
        if (c2.length === 1) {
          await kvSet(appliedKey, { at: new Date().toISOString(), memoryId: c2[0].id });
          out.applied.push({ actionId: id, kind: "memory-store", target: { name, memoryId: c2[0].id }, netChars: content.length, preimageKey: preKey, verifiedBy: "COUNT(name)=1" });
        } else out.refusedSilently.push({ actionId: id, detail: `COUNT(name)=${c2.length} after store` });
        continue;
      }
      if (op === "memory-edit" || op === "memory-delete") {
        let ids: string[] = Array.isArray(t.memoryIds) ? t.memoryIds.map(String) : [];
        if (!ids.length) { refuse("target.memoryIds empty"); continue; }
        if (op === "memory-edit" && ids.length !== 1) { refuse("memory-edit takes exactly one id"); continue; }
        const capKey = op === "memory-edit" ? "edit" : "delete";
        const capVal = op === "memory-edit" ? caps.memoryEdit : caps.memoryDelete;
        let docCount = ids.length;
        if (op === "memory-delete") {
          // Delete whole documents: every chunk of each named memory. The cap counts documents.
          const { docs, bad } = await expandDocs(ids);
          if (bad.length) { refuse(bad.join("; ")); continue; }
          ids = docs.flatMap((d) => d.rows.map((r: any) => r.id));
          docCount = docs.length;
        }
        if (used[capKey] + docCount > capVal) { refuse(`cap: ${op}`); continue; }
        const found = await q(
          `SELECT id, name, content, hex(CAST(content AS BLOB)) AS hx, scope, agentId, source, totalChunks, tags FROM agent_memory WHERE id IN (${ids.map(() => "?").join(",")})`,
          ids,
        );
        const bad = ids
          .map((mid) => {
            const m = found.find((x: any) => x.id === mid);
            if (!m) return `${mid}: missing`;
            if (op === "memory-edit" && Number(m.totalChunks ?? 1) > 1) return `${mid}: multi-chunk (edit)`;
            if (m.source !== "manual") return `${mid}: source ${m.source}`;
            return null;
          })
          .filter(Boolean);
        if (bad.length) { refuse(bad.join("; ")); continue; }
        if (await kvGet(appliedKey)) { out.alreadyApplied.push(id); continue; }
        used[capKey] += docCount;
        const content = String(act.content ?? "");
        if (op === "memory-edit" && !content.trim()) { refuse("edit content empty"); used[capKey] -= docCount; continue; }
        const target = { memoryIds: ids };
        const mode = editMode(act);
        const shrink = shrinkReason(act);
        // memory-edit: stored bytes via hex (legacyRead: the scrubbed plain read, dryRun negative control only)
        const storedBody = op === "memory-edit" ? await readMemory(ids[0]!) : "";
        if (storedBody === null) { refuse(`${ids[0]}: missing`); used[capKey] -= docCount; continue; }
        const preBody = op === "memory-edit" && !legacyRead ? storedBody : String(found[0].content ?? "");
        const body = op === "memory-edit" ? memEditBody(preBody, content, mode) : "";
        if (op === "memory-edit") {
          const defects = memEditDefects({ pre: preBody, next: body, mode, shrinkReason: shrink });
          if (defects.length) { refuse(defects.join("; ")); used[capKey] -= docCount; continue; }
          const guard = scrubberGuard(storedBody, body, content);
          if (!guard.ok) {
            out.refused.push({ actionId: id, status: "refused", reason: "scrubber-corruption", markers: guard, legacyRead });
            used[capKey] -= docCount;
            continue;
          }
        }
        const net = op === "memory-edit" ? body.length - preBody.length : -found.reduce((s: number, m: any) => s + String(m.content ?? "").length, 0);
        if (dry) { out.wouldApply.push({ actionId: id, kind: op, target, netChars: net, ...(op === "memory-edit" ? { mode } : {}) }); continue; }
        // Pre-image holds stored bytes (hex read), never the scrubbed plain content.
        const preRows = found.map(storedRow);
        await kvSet(preKey, op === "memory-edit" ? { kind: op, rows: preRows, mode, ...(shrink ? { allowShrink: shrink } : {}) } : { kind: op, rows: preRows });
        if (op === "memory-delete") {
          for (const mid of ids) await ctx.swarm.memory_delete({ id: mid });
          const c = await q(`SELECT COUNT(*) n FROM agent_memory WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
          if (Number(c[0]?.n) === 0) {
            await kvSet(appliedKey, { at: new Date().toISOString() });
            out.applied.push({ actionId: id, kind: op, target, netChars: net, preimageKey: preKey, verifiedBy: "COUNT(id)=0" });
          } else out.refusedSilently.push({ actionId: id, detail: `${c[0]?.n} of ${ids.length} rows still present after delete` });
        } else {
          // Append is composed here and written as a replace, so the re-read can be checked byte for byte.
          await ctx.swarm.memory_edit({ memoryId: ids[0], mode: "replace", content: body, intent: `dreaming ${runId} ${id}` });
          const rr = await readMemory(ids[0]!);
          if (rr === body) {
            const afterSha = await sha(body);
            await kvSet(appliedKey, { at: new Date().toISOString() });
            out.applied.push({ actionId: id, kind: op, target, netChars: net, mode, ...(shrink ? { allowShrink: shrink } : {}), preimageKey: preKey, afterSha, verifiedBy: `re-read content equals new body (sha ${afterSha.slice(0, 12)})` });
          } else out.refusedSilently.push({ actionId: id, detail: "re-read content differs from new content" });
        }
        continue;
      }
      refuse(`unsupported op for lane ${act.lane}: ${op}`);
    } catch (e: any) {
      out.errors.push(`${id}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }

  // ---- restore runner. Max 5 a night. Lane A (profile trims) re-inserts the cut block after its anchor line;
  // lane C (heartbeat) queues the line for the next hb-draft (hb-restore:<cutId>); lane B is not built. Every restore pins its probe.
  // A lane A restore writes a profile field, so it obeys lanes.identity; a lane C restore obeys lanes.heartbeat.
  const restoresIn: any[] = Array.isArray(synth.restores) ? synth.restores.slice(0, 5) : [];
  if (restoresIn.length) {
    let ledgers: any[] = [];
    if (dry && Array.isArray(a.fixtureCuts)) ledgers = a.fixtureCuts.map((x: any) => parseObj(x) ?? x);
    else {
      try {
        const r: any = await ctx.swarm.kv_list({ namespace: NS, prefix: "cuts:", limit: 200 });
        ledgers = (r?.data?.entries ?? r?.entries ?? []).map((e: any) => parseObj(e.value) ?? e.value);
      } catch (e: any) {
        out.errors.push(`restores kv_list: ${String(e?.message ?? e).slice(0, 160)}`);
      }
    }
    const cuts = ledgers.flatMap((l: any) => (Array.isArray(l?.cuts) ? l.cuts.map((c: any) => ({ ...c, runId: l.runId })) : []));
    const pinKey = async (c: any) => `pin:${c.lane}:${(await sha(`${c.target?.agentId ?? ""}:${c.target?.field ?? c.target?.kind}:${c.probe}`)).slice(0, 16)}`;
    for (const r of restoresIn) {
      const cutId = String(r?.cutId ?? "");
      const no = (reason: string) => out.restoreRefused.push({ cutId, reason });
      try {
        const c = cuts.find((x: any) => String(x?.cutId) === cutId);
        if (!c) { no("unknown cutId"); continue; }
        if ((c.lane === "A" && laneOff("identity")) || (c.lane === "C" && laneOff("heartbeat"))) { no("lane off"); continue; }
        const pin = { key: await pinKey(c), value: { probe: c.probe, cutId, target: c.target, reason: `restore: ${String(r?.reason ?? "").slice(0, 200)}`, at: new Date().toISOString() } };
        if (c.lane === "A") {
          const field = String(c.target?.field ?? "");
          if (!Object.values(FIELD).includes(field) || field === "heartbeatMd") { no(`bad field ${field}`); continue; }
          // Pre-image value: { content, sha, at } (trim plan), or the older { text } shape.
          const pv = parseObj((await kvGet(String(c.preimageKey ?? "")))?.value);
          const pre = c.preimageText ?? pv?.content ?? pv?.text;
          if (typeof pre !== "string") { no("pre-image missing"); continue; }
          const block = pre.split("\n").slice(Number(c.line), Number(c.line) + Number(c.nLines)).join("\n");
          if (!block.includes(String(c.probe))) { no("pre-image block does not hold the probe"); continue; }
          const rs = await readStored(field, String(c.target?.agentId ?? ""));
          if (!rs) { no("agent not found"); continue; }
          const live = rs.body;
          if (live.includes(String(c.probe))) { out.wouldRestore.push({ cutId, lane: "A", status: "already-present", pinOnly: true }); if (writes) await kvSet(pin.key, pin.value); continue; }
          const ls = live.split("\n");
          const hits = c.anchor ? ls.filter((l) => l === c.anchor).length : 0;
          if (hits !== 1) { no(hits === 0 ? "anchor-missing" : "anchor-ambiguous"); continue; }
          const i = ls.indexOf(c.anchor);
          const next = [...ls.slice(0, i + 1), block, ...ls.slice(i + 1)].join("\n");
          // The pre-image block comes back through kv_get (scrubbed), so it gets no marker allowance.
          const rg = scrubberGuard(live, next, "");
          if (!rg.ok) { no("scrubber-corruption"); continue; }
          const row = { cutId, lane: "A", agentId: c.target.agentId, field, netChars: next.length - live.length, pinKey: pin.key };
          if (!writes) { out.wouldRestore.push({ ...row, gate: "dryRun" }); continue; }
          const beforeSha = await sha(live);
          const again = await readStored(field, c.target.agentId);
          if ((await sha(again?.body ?? "")) !== beforeSha) { no("field changed during restore"); continue; }
          await ctx.swarm.profile_update({ agentId: c.target.agentId, [field]: next });
          const re = await readStored(field, c.target.agentId);
          const afterSha = await sha(next);
          if ((await sha(re?.body ?? "")) !== afterSha) { no("re-read mismatch after restore"); continue; }
          await kvSet(pin.key, pin.value);
          await kvSet(`restored:${cutId}`, { at: new Date().toISOString(), runId, afterSha });
          out.restores.push({ ...row, beforeSha, afterSha, verifiedBy: `sha256(re-read ${field}) = ${afterSha.slice(0, 12)}` });
        } else if (c.lane === "C") {
          const row = { cutId, lane: "C", probe: c.probe, pinKey: pin.key, via: "next hb-draft (hb-restore key, pinned)" };
          if (!writes) { out.wouldRestore.push({ ...row, gate: "dryRun" }); continue; }
          await kvSet(`hb-restore:${cutId}`, { cutId, probe: c.probe, runId: c.runId, at: new Date().toISOString() });
          await kvSet(pin.key, pin.value);
          await kvSet(`restored:${cutId}`, { at: new Date().toISOString(), runId, queued: true });
          out.restores.push(row);
        } else no(`lane ${c.lane} restore not built`);
      } catch (e: any) {
        out.errors.push(`restore ${cutId}: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
  }
  return out;
}

