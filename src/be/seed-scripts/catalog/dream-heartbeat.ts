import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

// Dreaming heartbeat lane (lane C): Lead HEARTBEAT triage and prune.
// mode "plan":     parse Lead heartbeatMd, list deterministic + LLM candidates, pins, deferred ops, handshake, survival.
//                  Live runs store the pre-image at KV preimage:<runId>:<leadId>:heartbeatMd.
// mode "text":     live Lead heartbeatMd + sha (the hb-draft task reads it over REST).
// mode "check":    store the hb-draft task's `draft` text at KV hb-draft:<runId>, validate it (validator port, pins,
//                  size, removed coverage), then wait for a quiet window. lead-disk reads the KV draft and checks its sha.
// mode "quiet":    read-only: is any Lead heartbeat-checklist task live? lead-disk runs it right before the disk copy.
// mode "apply":    DB write after lead-disk wrote the disk (live runs only); else wouldApply. The draft comes from KV.
// mode "restore-db": set the DB back to the run's pre-image once Lead has restored the disk copy.
// mode "revert":   return the Lead brief for a rollback (no writes).
// mode "verify":   survival of the last applied prune (read-only).
// mode "selftest": validator parity with src/tests/heartbeat-expiry.test.ts + check/handshake controls.
// Writes happen only when dryRun is false (an absent dryRun counts as a dry run). Never throws.

export const argsSchema = z.object({
  mode: z.enum(["plan", "text", "check", "quiet", "apply", "restore-db", "revert", "verify", "selftest"]),
  runId: z.string().optional(),
  // Lead agent id. Absent: the first agent with isLead = 1.
  leadId: z.string().optional(),
  dryRun: z.union([z.boolean(), z.string()]).optional(),
  // { heartbeat: false } turns the lane off (plan returns skipReason "lane off"). Absent: on.
  lanes: z.unknown().optional(),
  date: z.string().optional(),
  apply: z.unknown().optional(),
  plan: z.unknown().optional(),
  check: z.unknown().optional(),
  // hb-draft task output: { draft: string, notes?, removed?, compressed?, movedToMemory?, runbookAdds?, draftSha? }.
  draft: z.unknown().optional(),
  // Alias of `draft` (the workflow input name).
  hd: z.unknown().optional(),
  disk: z.unknown().optional(),
  waitMs: z.number().int().min(0).max(270000).optional(),
  confirmDiskSha: z.string().optional(),
  skillName: z.string().optional(),
});

const NS = "dreaming";
const DEFAULT_DISK_BACKUP_DIR = "/workspace/personal/heartbeat-backups";
const PROCEDURES_SKILL = "lead-heartbeat-procedures";
const TARGETS = { firstRunChars: 60000, steadyChars: 50000, trackedItemsChars: 25000, itemChars: 500, standingOrdersChars: 25000 };
const MAX_MEMORIES = 10;
const BUSY = ["unassigned", "offered", "reviewing", "pending", "in_progress", "paused"];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

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
const isFalse = (v: unknown) => v === false || v === "false" || v === "0" || v === 0;
const preimageKey = (runId: string, leadId: string) => `preimage:${runId}:${leadId}:heartbeatMd`;
const draftKeyOf = (runId: string) => `hb-draft:${runId}`;

// ---- Port of src/utils/heartbeat-expiry.ts.
// Same regex and order; scrubSecrets dropped (the message is never posted anywhere).
const EXPIRY = /delete\s+(on\s+)?\d{2}-\d{2}/i;
function trackedLines(markdown: string): string[] {
  const marker = "## Tracked Items";
  const start = markdown.lastIndexOf(marker);
  if (start < 0) return [];
  const lineEnd = markdown.indexOf("\n", start);
  if (lineEnd < 0) return [];
  const section = markdown.slice(lineEnd + 1).split(/^#{1,2}\s/m)[0] ?? "";
  return section
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?/, ""))
    .filter((line) => line && !line.startsWith("#") && !/^[-*_]{3,}$/.test(line));
}
function title(line: string): string | undefined {
  return /^\*\*([^*]+)\*\*/.exec(line)?.[1];
}
function isShortening(old: string, next: string): boolean {
  let cursor = 0;
  for (const character of next) {
    const index = old.indexOf(character, cursor);
    if (index < 0) return false;
    cursor = index + character.length;
  }
  return true;
}
class HeartbeatExpiryError extends Error {
  constructor(line: string) {
    super(`Update rejected for heartbeatMd: new tracked item requires DELETE <MM-DD> (or DELETE on <MM-DD>): ${line}`);
    this.name = "HeartbeatExpiryError";
  }
}
export function validateHeartbeatExpiry(currentValue: string, nextValue: string): void {
  const previous = trackedLines(currentValue);
  const incoming = trackedLines(nextValue);
  const changed = incoming.filter((line) => {
    const index = previous.indexOf(line);
    if (index < 0) return true;
    previous.splice(index, 1);
    return false;
  });
  for (const line of changed) {
    if (!line.startsWith("📌") && !EXPIRY.test(line)) continue;
    const itemTitle = title(line.replace(/^📌\s*/, ""));
    const index = previous.findIndex((old) => line.includes(old) || (itemTitle !== undefined && itemTitle === title(old)));
    if (index >= 0) previous.splice(index, 1);
  }
  for (const line of changed) {
    if (line.startsWith("📌") || EXPIRY.test(line)) continue;
    const itemTitle = title(line);
    const index = previous.findIndex(
      (old) => !old.startsWith("📌") && !EXPIRY.test(old) && (isShortening(old, line) || (itemTitle !== undefined && itemTitle === title(old))),
    );
    if (index < 0) throw new HeartbeatExpiryError(line);
    previous.splice(index, 1);
  }
}
// ---- end port

const strip = (line: string) => line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?/, "");
const probeOf = (norm: string) => {
  const t = title(norm.replace(/^📌\s*/, ""));
  return (t ? `**${t}**` : norm).slice(0, 80);
};
// Every 📌 line in the whole file (validator form), verbatim.
const pinLines = (text: string) => text.split(/\r?\n/).map(strip).filter((l) => l.startsWith("📌"));

// MM-DD -> Date in the year that puts it nearest to (and not >180 days after) today.
function mmdd(m: string, d: string, today: Date): Date {
  let y = today.getUTCFullYear();
  let dt = new Date(Date.UTC(y, Number(m) - 1, Number(d)));
  if (dt.getTime() - today.getTime() > 180 * 86400000) dt = new Date(Date.UTC(y - 1, Number(m) - 1, Number(d)));
  return dt;
}

type Item = { line: number; raw: string; norm: string; probe: string; title: string | null; chars: number; pinned: boolean; expiry: Date | null; closedAt: Date | null; closed: boolean; taskIds: string[] };

function parseHeartbeat(text: string, today: Date) {
  const lines = text.split("\n");
  const sections: Array<{ line: number; heading: string; level: number; chars: number }> = [{ line: 0, heading: "(top)", level: 1, chars: 0 }];
  lines.forEach((l, i) => {
    const m = /^(#{2,3}) /.exec(l);
    if (m) sections.push({ line: i, heading: l.slice(0, 120), level: (m[1] ?? "").length, chars: 0 });
    const cur = sections[sections.length - 1];
    if (cur) cur.chars += l.length + 1;
  });
  let tStart = -1;
  lines.forEach((l, i) => {
    if (l.startsWith("## Tracked Items")) tStart = i;
  });
  const items: Item[] = [];
  if (tStart >= 0) {
    for (let i = tStart + 1; i < lines.length; i++) {
      const raw = lines[i] ?? "";
      if (/^#{1,2}\s/.test(raw)) break;
      const norm = strip(raw);
      if (!norm || norm.startsWith("#") || /^[-*_]{3,}$/.test(norm)) continue;
      const ex = /delete\s+(?:on\s+)?(\d{2})-(\d{2})/i.exec(norm);
      const cl = /(?:CLOSED|MERGED)\s+(\d{2})-(\d{2})/.exec(norm);
      items.push({
        line: i,
        raw,
        norm,
        probe: probeOf(norm),
        title: title(norm.replace(/^📌\s*/, "")) ?? null,
        chars: raw.length,
        pinned: norm.startsWith("📌"),
        expiry: ex ? mmdd(ex[1] ?? "", ex[2] ?? "", today) : null,
        closedAt: cl ? mmdd(cl[1] ?? "", cl[2] ?? "", today) : null,
        closed: /⚰️|\bCLOSED\b/.test(norm),
        taskIds: [...new Set(norm.match(UUID) ?? [])],
      });
    }
  }
  return { lines, sections, items, trackedStart: tStart };
}

const shingles = (s: string, k = 8) => {
  const w = s.toLowerCase().replace(/[^a-z0-9#@._/-]+/g, " ").split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(" "));
  return out;
};

// Pure draft check, shared by mode "check" and selftest.
export function checkDraft(env: { live: string; next: string; removed: any[]; deferred: any[]; mustKeep: string[]; maxChars: number }): string[] {
  const reasons: string[] = [];
  const { live, next } = env;
  try {
    validateHeartbeatExpiry(live, next);
  } catch (e: any) {
    reasons.push(`validator: ${String(e?.message ?? e).slice(0, 220)}`);
  }
  if (!next.includes("## Tracked Items")) reasons.push("draft has no ## Tracked Items heading");
  if (next.length > env.maxChars) reasons.push(`draft ${next.length} chars > ${env.maxChars}`);
  if (next.length >= live.length) reasons.push(`not net-smaller: ${live.length} -> ${next.length}`);
  const nextPins = new Set(pinLines(next));
  const lostPins = pinLines(live).filter((p) => !nextPins.has(p));
  if (lostPins.length) reasons.push(`📌 lines changed or dropped: ${lostPins.length} (first: ${(lostPins[0] ?? "").slice(0, 80)})`);
  // Every live tracked item that is gone (no line with its title, and no line it shortens to) needs a removed[] entry.
  const nextTracked = trackedLines(next);
  const removedKeys = env.removed.map((r: any) => String(r?.title ?? r?.probe ?? "")).filter(Boolean);
  const gone = trackedLines(live).filter((old) => {
    const t = title(old.replace(/^📌\s*/, ""));
    if (t !== undefined && nextTracked.some((l) => title(l.replace(/^📌\s*/, "")) === t)) return false;
    if (nextTracked.includes(old)) return false;
    return !nextTracked.some((l) => l.length >= 20 && isShortening(old, l));
  });
  const unexplained = gone.filter((old) => !removedKeys.some((k) => old.includes(k.replace(/^\*\*|\*\*$/g, "")) || k.includes(old.slice(0, 60))));
  if (unexplained.length) reasons.push(`removed without a removed[] reason: ${unexplained.length} (first: ${(unexplained[0] ?? "").slice(0, 80)})`);
  for (const d of env.deferred) {
    const f = String(d?.find ?? d?.anchor ?? "").trim();
    if (f && next.includes(f)) reasons.push(`deferred removal not done: ${d?.actionId ?? f.slice(0, 40)}`);
  }
  for (const p of env.mustKeep) if (p && live.includes(p) && !next.includes(p)) reasons.push(`pinned probe dropped: ${p.slice(0, 80)}`);
  // Rule #N labels outside Tracked Items stay (rubric rule 2); a removed[] entry naming the label as retired explains one.
  const outside = (t: string) => {
    const i = t.lastIndexOf("## Tracked Items");
    if (i < 0) return t;
    const rest = t.slice(i);
    const m = /\n#{1,2}\s/.exec(rest.slice(1));
    return t.slice(0, i) + (m ? rest.slice(m.index + 1) : "");
  };
  const labels = (t: string) => new Set(t.match(/Rule #\d+\b/g) ?? []);
  const nextLabels = labels(next);
  const retired = env.removed.map((r: any) => `${r?.title ?? ""} ${r?.probe ?? ""} ${r?.reason ?? ""}`).join(" ");
  const dropped = [...labels(outside(live))].filter((l) => !nextLabels.has(l) && !(retired.includes(l) && /retired/i.test(retired)));
  if (dropped.length) reasons.push(`Rule labels dropped outside Tracked Items: ${dropped.join(", ")}`);
  return reasons;
}

// Handshake: may night N+1 cut Standing Orders text whose probe the procedures skill should now carry?
export function handshake(skill: { systemDefault: number; content: string } | null, probes: string[]) {
  if (!skill) return { status: "no-skill", ready: [] as string[], waiting: probes };
  if (Number(skill.systemDefault)) return { status: "refused: system-default", ready: [] as string[], waiting: probes };
  const ready = probes.filter((p) => skill.content.includes(p));
  return { status: "ok", ready, waiting: probes.filter((p) => !ready.includes(p)) };
}

/** Plan, check and apply a prune of the Lead's HEARTBEAT checklist, with the draft and pre-image held in KV. */
export default async function (args: unknown, ctx: ScriptContext) {
  const p = argsSchema.safeParse(args ?? {});
  if (!p.success) return { ok: false, errors: [p.error.message] };
  const a = p.data;
  // Fail closed: only an explicit false makes a live run.
  const dry = !isFalse(a.dryRun);
  const runId = a.runId ?? "";
  const now = new Date();
  const date = a.date ?? now.toISOString().slice(0, 10);
  const today = new Date(`${date}T00:00:00Z`);
  const errors: string[] = [];
  const q = async (sql: string, params: unknown[] = []) => rows(await ctx.swarm.db_query({ sql, params }));
  const kvGet = async (key: string): Promise<any> => {
    const v = (await ctx.swarm.kv_getOrNull({ namespace: NS, key }))?.value;
    return parse(v) ?? v ?? null;
  };
  const kvSet = async (key: string, value: unknown) => ctx.swarm.kv_set({ namespace: NS, key, value: value as any });
  const kvList = async (prefix: string): Promise<any[]> => {
    try {
      const r: any = await ctx.swarm.kv_list({ namespace: NS, prefix, limit: 200 });
      return (r?.data?.entries ?? r?.entries ?? []).map((e: any) => ({ key: e.key, value: parse(e.value) ?? e.value }));
    } catch (e: any) {
      errors.push(`kv_list ${prefix}: ${String(e?.message ?? e).slice(0, 160)}`);
      return [];
    }
  };
  let LEAD = "";
  const liveHb = async () => String((await q(`SELECT heartbeatMd FROM agents WHERE id = ?`, [LEAD]))[0]?.heartbeatMd ?? "");
  const pinsC = async () => (await kvList("pin:C:")).map((e) => String(e.value?.probe ?? "")).filter(Boolean);
  // Every Lead heartbeat that can still run or write: not just in_progress. Fail-closed: a stuck row blocks lane C until cancelled.
  const busyHb = async () =>
    (await q(`SELECT id, status, createdAt FROM agent_tasks WHERE agentId = ? AND taskType = 'heartbeat-checklist' AND status IN (${BUSY.map(() => "?").join(", ")}) ORDER BY createdAt`, [LEAD, ...BUSY])).map((r) => ({
      id: String(r.id),
      status: String(r.status),
      createdAt: String(r.createdAt),
    }));
  // Draft text from KV, verified against its stored sha. null when missing or corrupt.
  const kvDraft = async () => {
    const d = runId ? await kvGet(draftKeyOf(runId)) : null;
    if (typeof d?.text !== "string" || typeof d?.sha !== "string") return { text: "", sha: "", ok: false, detail: `no ${draftKeyOf(runId)}` };
    const textSha = await sha(d.text);
    return { text: d.text, sha: d.sha, ok: textSha === d.sha, detail: textSha === d.sha ? "" : `KV text hashes to ${textSha.slice(0, 12)}, stored sha ${d.sha.slice(0, 12)}` };
  };

  try {
    if (a.mode !== "selftest") {
      LEAD = a.leadId ?? "";
      if (!LEAD) LEAD = String((await q(`SELECT id FROM agents WHERE isLead = 1 ORDER BY createdAt LIMIT 1`))[0]?.id ?? "");
      if (!LEAD) return { ok: false, mode: a.mode, errors: ["no leadId and no Lead agent"] };
    }

    // ---------------- selftest ----------------
    if (a.mode === "selftest") {
      const section = (...l: string[]) => `## Tracked Items\n${l.join("\n")}\n`;
      const passes = (cur: string, next: string) => {
        try {
          validateHeartbeatExpiry(cur, next);
          return true;
        } catch {
          return false;
        }
      };
      // [name, current, next, expectPass] — every case of src/tests/heartbeat-expiry.test.ts "heartbeat expiry validation".
      const V: Array<[string, string, string, boolean]> = [
        ["accepts DELETE 09-30", "", section("- New item. DELETE 09-30"), true],
        ["accepts delete on 09-30", "", section("- New item. delete on 09-30"), true],
        ["accepts DeLeTe ON 09-30", "", section("- New item. DeLeTe ON 09-30"), true],
        ["rejects new undated item", "", section("- Check the queue"), false],
        ["pin durable 1", "", section("📌 Permanent rule"), true],
        ["pin durable 2", "", section("- 📌 Permanent rule"), true],
        ["pin durable 3", "", section("- [ ] 📌 Permanent rule"), true],
        ["pin mid-line not exempt", "", section("- Check 📌 status"), false],
        ...["- **Queue:** Check the queue every morning and evening", "- **Queue:** Check the queue", "- **Queue:** Inspect pending work weekly"].map(
          (l, i) => [`legacy edit ${i}`, section("- **Queue:** Check the queue every morning and evening", "- Keep this item"), section(l, "- Keep this item"), true] as [string, string, string, boolean],
        ),
        ["legacy shorten", section("- Check the queue daily"), section("- Check the queue"), true],
        ["pure deletion", section("- Old undated item"), section(), true],
        ["delete whole section", section("- Old undated item"), "", true],
        ["last marker", "", "## Tracked Items\n- Earlier example\n## Tracked Items (current)\n- New. DELETE 09-30\n## Notes\nUndated notes", true],
        ["marker mid-line", "", "Mention ## Tracked Items here\n- Undated", false],
        ["marker only", "", "## Tracked Items", true],
        ["other section", "", "## Other\n- Undated", true],
        ["token on marker", "", "## Tracked Items DELETE 09-30\n- Undated", false],
        ["token on other line", "", section("- Dated DELETE 09-30", "- Undated"), false],
        ["reordered one-to-one", section("- **Old:** Keep", "- **Other:** Keep"), section("- **Other:** Keep", "- **Old:** Updated"), true],
        ["one old cannot sponsor two", section("- **Old:** Keep", "- **Other:** Keep"), section("- **Old:** Keep", "- **Old:** New"), false],
        ["unrelated new", section("- **Old:** Keep", "- **Other:** Keep"), section("- **Unrelated:** New"), false],
        ["condense middle", section("- Check the large queue daily"), section("- Check the queue"), true],
        ...[
          ["- **Old:** New", "- **Old:** Updated DELETE 09-30"],
          ["- **Old:** Updated DELETE 09-30", "- **Old:** New"],
          ["- Legacy text DELETE 09-30", "- Legacy"],
        ].map((l, i) => [`dating cannot authorize copy ${i}`, section("- **Old:** Original", "- Legacy text"), section(...l), false] as [string, string, string, boolean]),
        ["no date removal", section("- **Old:** DELETE 09-30"), section("- **Old:** Undated"), false],
        ["no pin removal", section("📌 Permanent"), section("Permanent"), false],
      ];
      const parity = V.map(([name, c, n, want]) => ({ name, want: want ? "pass" : "throw", got: passes(c, n) ? "pass" : "throw" }));
      // Check controls on a 12-item fixture.
      const base = Array.from({ length: 12 }, (_, i) => `- **Item ${i}:** undated tracked item number ${i} with some detail text`);
      const live = `# HB\n\n## Standing Orders\n- do things\n\n${section("📌 keep me forever", ...base)}\n## Reference\n- ref\n`;
      const pureDeletion = live.replace(base.slice(0, 10).join("\n") + "\n", "");
      const removed10 = base.slice(0, 10).map((_, i) => ({ title: `Item ${i}:`, reason: "fixture" }));
      const rewriteNoTitle = live.replace(base[0] ?? "", "- a rewritten undated item without its title");
      const c = (next: string, removed: any[]) => checkDraft({ live, next, removed, deferred: [], mustKeep: [], maxChars: 60000 });
      const checks = [
        { name: "check- rewrite of undated item drops its **title** -> refused", got: c(rewriteNoTitle, []), wantRefused: true },
        { name: "check+ pure deletion of 10 items with reasons -> passes", got: c(pureDeletion, removed10), wantRefused: false },
        { name: "check- pure deletion with no removed[] reasons -> refused", got: c(pureDeletion, []), wantRefused: true },
        { name: "check- Rule #N label in Standing Orders dropped -> refused", got: checkDraft({ live: live.replace("- do things", "- do things per Rule #7"), next: pureDeletion, removed: removed10, deferred: [], mustKeep: [], maxChars: 60000 }), wantRefused: true },
        { name: "check- 📌 line dropped -> refused", got: c(pureDeletion.replace("📌 keep me forever\n", ""), removed10), wantRefused: true },
      ].map((x) => ({ name: x.name, pass: (x.got.length > 0) === x.wantRefused, reasons: x.got.slice(0, 2) }));
      const hs = [
        { name: "handshake- systemDefault skill refused", pass: handshake({ systemDefault: 1, content: "probe A" }, ["probe A"]).status === "refused: system-default" },
        { name: "handshake+ probe present -> ready", pass: handshake({ systemDefault: 0, content: "x probe A y" }, ["probe A"]).ready.length === 1 },
        { name: "handshake- probe absent -> waiting", pass: handshake({ systemDefault: 0, content: "x y" }, ["probe A"]).waiting.length === 1 },
      ];
      const ok = parity.every((r) => r.want === r.got) && checks.every((x) => x.pass) && hs.every((x) => x.pass);
      return { ok, mode: "selftest", parity: { cases: parity.length, mismatches: parity.filter((r) => r.want !== r.got) }, checks, handshake: hs };
    }

    // ---------------- plan ----------------
    if (a.mode === "plan") {
      const lanes = parse(a.lanes) ?? {};
      if (isFalse(lanes.heartbeat)) {
        // Shaped so a draft gate reading chars/targets/candidates routes to skip instead of throwing.
        return { ok: true, mode: dry ? "dry-run" : "live", skipReason: "lane off", runId, leadId: LEAD, chars: 0, targets: { ...TARGETS, maxChars: TARGETS.firstRunChars }, candidates: { remove: [] }, deferredToHeartbeat: [], mustRestore: [], errors };
      }
      const live = await liveHb();
      const planSha = await sha(live);
      // Live runs: pre-image before anything is drafted; hb-apply and rollback read it.
      let preimage: string | null = null;
      if (!dry && runId) {
        const key = preimageKey(runId, LEAD);
        await kvSet(key, { content: live, sha: planSha, at: now.toISOString() });
        const back = await kvGet(key);
        if (back?.sha === planSha && (await sha(String(back?.content ?? ""))) === planSha) preimage = key;
        else errors.push(`pre-image re-read mismatch at ${key}`);
      }
      const hb = parseHeartbeat(live, today);
      const items = hb.items;
      const dayMs = 86400000;
      // Terminal-task lookup for every referenced task id (bounded).
      const ids = [...new Set(items.flatMap((i) => i.taskIds))].slice(0, 400);
      const term = new Map<string, any>();
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const r = await q(`SELECT id, status, finishedAt FROM agent_tasks WHERE id IN (${chunk.map(() => "?").join(",")})`, chunk);
        for (const x of r) term.set(x.id, x);
      }
      const isOld = (t: any) => ["completed", "failed", "cancelled"].includes(String(t?.status)) && t?.finishedAt && now.getTime() - Date.parse(t.finishedAt) > 7 * dayMs;
      const seen = new Map<string, number>();
      const remove: any[] = [];
      const review: any[] = [];
      for (const it of items) {
        if (it.pinned) continue;
        const row = { line: it.line, probe: it.probe, chars: it.chars };
        if (it.expiry && it.expiry.getTime() <= today.getTime()) remove.push({ ...row, reason: `due: DELETE ${it.expiry.toISOString().slice(5, 10)}` });
        else if (it.closed && it.closedAt && now.getTime() - it.closedAt.getTime() > 2 * dayMs) remove.push({ ...row, reason: `closed ${it.closedAt.toISOString().slice(5, 10)} (>48h)` });
        else if (it.norm.length >= 20 && seen.has(it.norm)) remove.push({ ...row, reason: `exact duplicate of line ${seen.get(it.norm)}` });
        else if (it.taskIds.length && it.taskIds.every((id) => isOld(term.get(id)))) review.push({ ...row, reason: `all ${it.taskIds.length} referenced task(s) terminal >7d` });
        seen.set(it.norm, it.line);
      }
      const closedUndated = items.filter((i) => !i.pinned && i.closed && !i.closedAt).map((i) => ({ line: i.line, probe: i.probe, reason: "⚰️/CLOSED without a date" }));
      // LLM candidates.
      const over500 = items.filter((i) => i.chars > TARGETS.itemChars).map((i) => ({ line: i.line, probe: i.probe, chars: i.chars }));
      const soIdx = hb.sections.findIndex((s) => s.heading.startsWith("## Standing Orders"));
      const so = soIdx >= 0 ? hb.sections.slice(soIdx + 1).filter((s, i, arr) => s.level === 3 && arr.slice(0, i).every((x) => x.level === 3)) : [];
      const soTotal = so.reduce((n, s) => n + s.chars, 0);
      const perSection = so.length ? Math.floor(TARGETS.standingOrdersChars / so.length) : 0;
      const sectionsOver = so.filter((s) => s.chars > perSection).map((s) => ({ heading: s.heading, chars: s.chars, target: perSection }));
      // Duplicates with Lead's other fields and the procedures skill (8-word shingles, overlap >= 0.6).
      const lead = (await q(`SELECT claudeMd, toolsMd, soulMd, identityMd FROM agents WHERE id = ?`, [LEAD]))[0] ?? {};
      const skillRows = await q(`SELECT id, name, systemDefault, content FROM skills WHERE name IN (?, 'heartbeat-runbook')`, [a.skillName ?? PROCEDURES_SKILL]);
      const procSkill = skillRows.find((s: any) => s.name === (a.skillName ?? PROCEDURES_SKILL)) ?? null;
      const others: Array<[string, string]> = [
        ["claudeMd", String(lead.claudeMd ?? "")],
        ["toolsMd", String(lead.toolsMd ?? "")],
        ["soulMd", String(lead.soulMd ?? "")],
        ["identityMd", String(lead.identityMd ?? "")],
        ...skillRows.map((s: any) => [`skill:${s.name}`, String(s.content ?? "")] as [string, string]),
      ];
      const otherSh = others.map(([k, t]) => [k, shingles(t)] as [string, Set<string>]);
      const dupes: any[] = [];
      hb.lines.forEach((l, i) => {
        if (l.length < 200) return;
        const sh = shingles(l);
        if (sh.size < 5) return;
        for (const [k, o] of otherSh) {
          let n = 0;
          for (const s of sh) if (o.has(s)) n++;
          const r = n / sh.size;
          if (r >= 0.6) {
            dupes.push({ line: i, probe: probeOf(strip(l)), chars: l.length, dupOf: k, overlap: Math.round(r * 100) / 100 });
            break;
          }
        }
      });
      const applyRes = parse(a.apply) ?? {};
      const deferred: any[] = Array.isArray(applyRes.deferredToHeartbeat) ? applyRes.deferredToHeartbeat : [];
      const pins = await pinsC();
      // Restores queued by apply (synthesis restores[] on lane C cuts): the next draft re-inserts these lines.
      const mustRestore: any[] = [];
      for (const v of (await kvList("hb-restore:")).map((e) => e.value).filter((v) => v?.probe)) {
        const pre = await kvGet(preimageKey(String(v.runId), LEAD));
        const line = typeof pre?.content === "string" ? pre.content.split("\n").find((l: string) => l.includes(v.probe)) ?? null : null;
        mustRestore.push({ cutId: v.cutId, probe: v.probe, line, present: live.includes(v.probe) });
      }
      // Handshake for last night's runbookAdds.
      const adds = await kvGet("hb-runbook-adds:latest");
      const addProbes: string[] = Array.isArray(adds?.adds) ? adds.adds.map((x: any) => String(x?.probe ?? "")).filter(Boolean) : [];
      const hs = handshake(procSkill ? { systemDefault: Number(procSkill.systemDefault), content: String(procSkill.content ?? "") } : null, addProbes);
      // Survival of the last applied prune.
      const st = await kvGet("hb-state:lead");
      let survival: any = { status: "none" };
      if (st?.afterSha) {
        if (planSha === st.afterSha) survival = { status: "intact", runId: st.runId };
        else if (planSha === st.beforeSha) survival = { status: "reverted", runId: st.runId, action: "re-run lead-disk + hb-apply with hb-state.afterText" };
        else {
          const back = (Array.isArray(st.removedProbes) ? st.removedProbes : []).filter((pr: string) => pr && live.includes(pr));
          survival = { status: back.length ? "reintroduced" : "drifted", runId: st.runId, reintroduced: back.slice(0, 30) };
        }
      }
      const pinCount = pinLines(live).length;
      const trackedChars = items.reduce((n, i) => n + i.chars + 1, 0);
      return {
        ok: true,
        mode: dry ? "dry-run" : "live",
        runId,
        leadId: LEAD,
        date,
        planSha,
        chars: live.length,
        lines: hb.lines.length,
        targets: { ...TARGETS, maxChars: st?.afterSha ? TARGETS.steadyChars : TARGETS.firstRunChars },
        sections: hb.sections.map((s) => ({ heading: s.heading, chars: s.chars })),
        tracked: {
          count: items.length,
          chars: trackedChars,
          pinned: items.filter((i) => i.pinned).length,
          dated: items.filter((i) => i.expiry).length,
          undated: items.filter((i) => !i.expiry && !i.pinned).length,
          over500: over500.length,
          over1000: items.filter((i) => i.chars > 1000).length,
          due: remove.filter((r) => r.reason.startsWith("due")).length,
        },
        pinLines: pinCount,
        standingOrders: { chars: soTotal, target: TARGETS.standingOrdersChars, sections: so.map((s) => ({ heading: s.heading, chars: s.chars })) },
        candidates: { remove, review, closedUndated, over500, sectionsOver, dupes: dupes.slice(0, 60) },
        deferredToHeartbeat: deferred,
        pins,
        mustRestore,
        handshake: { skill: procSkill ? { id: procSkill.id, name: procSkill.name, systemDefault: Number(procSkill.systemDefault) } : null, ...hs },
        runbookSkill: a.skillName ?? PROCEDURES_SKILL,
        survival,
        draftKey: runId ? draftKeyOf(runId) : null,
        preimageKey: preimage,
        errors,
      };
    }

    // ---------------- quiet (read-only; lead-disk calls it inside its copy command) ----------------
    if (a.mode === "quiet") {
      const busy = await busyHb();
      return { ok: true, quiet: busy.length === 0, busy, at: now.toISOString() };
    }

    // ---------------- text ----------------
    if (a.mode === "text") {
      const live = await liveHb();
      return { ok: true, planSha: await sha(live), chars: live.length, text: live };
    }

    const plan = parse(a.plan) ?? {};
    const draftRaw = parse(a.draft ?? a.hd) ?? {};
    const draft = parse(draftRaw.taskOutput) ?? draftRaw;

    // ---------------- check ----------------
    if (a.mode === "check") {
      const reasons: string[] = [];
      const next = typeof draft.draft === "string" ? draft.draft : "";
      if (!runId) reasons.push("no runId (the draft is stored at hb-draft:<runId>)");
      if (!plan.planSha) reasons.push("no plan");
      if (!next.trim()) reasons.push("no draft text (hb-draft failed or returned no `draft`)");
      const live = await liveHb();
      const liveSha = await sha(live);
      if (plan.planSha && liveSha !== plan.planSha) reasons.push(`db-drift since plan: ${liveSha.slice(0, 12)} != ${String(plan.planSha).slice(0, 12)}`);
      const draftSha = next ? await sha(next) : null;
      if (next && draft.draftSha && draft.draftSha !== draftSha) reasons.push(`draftSha mismatch: returned ${String(draft.draftSha).slice(0, 12)}, text hashes to ${String(draftSha).slice(0, 12)}`);
      // Stage the draft in KV: lead-disk reads it with kv-get and hb-apply reads it back. Scratch data, so dry runs store it too.
      let draftKey: string | null = null;
      if (runId && next.trim() && draftSha) {
        const key = draftKeyOf(runId);
        await kvSet(key, { text: next, sha: draftSha, at: now.toISOString() });
        const back = await kvDraft();
        if (back.ok && back.sha === draftSha) draftKey = key;
        else reasons.push(`KV draft re-read mismatch at ${key}: ${back.detail || "sha differs"}`);
      }
      const removed: any[] = Array.isArray(draft.removed) ? draft.removed : [];
      if (next) {
        reasons.push(
          ...checkDraft({
            live,
            next,
            removed,
            deferred: Array.isArray(plan.deferredToHeartbeat) ? plan.deferredToHeartbeat : [],
            mustKeep: Array.isArray(plan.pins) ? plan.pins : [],
            maxChars: Number(plan.targets?.maxChars ?? TARGETS.firstRunChars),
          }),
        );
      }
      const diskMode = !dry ? "live" : "dry";
      // Quiet window: no live Lead heartbeat (pending, in_progress, paused...). Live writes wait (poll every 30 s); dry checks once.
      // lead-disk re-checks with mode "quiet" inside its copy command, so the gap until the copy is covered too.
      let busyRows = await busyHb();
      const waitMs = diskMode === "live" ? (a.waitMs ?? 240000) : 0;
      const t0 = Date.now();
      while (busyRows.length > 0 && Date.now() - t0 + 30000 <= waitMs) {
        await new Promise((r) => setTimeout(r, 30000));
        busyRows = await busyHb();
      }
      const quiet = busyRows.length === 0;
      if (diskMode === "live" && !quiet) reasons.push(`no quiet window: ${busyRows.length} live Lead heartbeat task(s) after ${Math.round((Date.now() - t0) / 1000)}s: ${busyRows.map((b) => `${b.id.slice(0, 8)}/${b.status}`).join(", ")}`);
      const ready = reasons.length === 0;
      return {
        ok: true,
        mode: dry ? "dry-run" : "live",
        ready,
        port: ready ? "run" : "skip",
        diskMode,
        reasons,
        quiet,
        busy: busyRows,
        planSha: plan.planSha ?? null,
        draftSha,
        draftKey,
        notes: typeof draft.notes === "string" ? draft.notes.slice(0, 2000) : null,
        stats: {
          liveChars: live.length,
          draftChars: next.length,
          pinsBefore: pinLines(live).length,
          pinsAfter: pinLines(next).length,
          trackedBefore: trackedLines(live).length,
          trackedAfter: trackedLines(next).length,
          removed: removed.length,
          compressed: Array.isArray(draft.compressed) ? draft.compressed.length : 0,
          movedToMemory: Array.isArray(draft.movedToMemory) ? draft.movedToMemory.length : 0,
          runbookAdds: Array.isArray(draft.runbookAdds) ? draft.runbookAdds.length : 0,
        },
        errors,
      };
    }

    // ---------------- apply ----------------
    if (a.mode === "apply") {
      const check = parse(a.check) ?? {};
      const diskRaw = parse(a.disk) ?? {};
      const disk = parse(diskRaw.taskOutput) ?? diskRaw;
      const removed: any[] = Array.isArray(draft.removed) ? draft.removed : [];
      const diskField = (Array.isArray(disk.fields) ? disk.fields : []).find((f: any) => f?.field === "heartbeatMd") ?? null;
      const baseOf = (next: string, draftSha: string) => ({ ok: true, runId, leadId: LEAD, planSha: plan.planSha ?? null, draftSha, draftChars: next.length, removed: removed.length, disk: disk.mode ? { mode: disk.mode, ...diskField } : null });
      if (!check.ready) return { ...baseOf("", ""), status: "skipped", reason: `check not ready: ${(check.reasons ?? []).slice(0, 3).join("; ") || "no check"}`, errors };
      // The draft is the KV copy hb-check stored, never a path. Its text, its stored sha and hb-check's sha must agree.
      const kd = await kvDraft();
      const next = kd.ok ? kd.text : "";
      const draftSha = kd.ok ? kd.sha : "";
      const base = baseOf(next, draftSha);
      if (!kd.ok || kd.sha !== check.draftSha) {
        return { ...base, ok: false, status: "refused: draft-sha-mismatch", detail: kd.detail || `KV draft ${kd.sha.slice(0, 12)} != check ${String(check.draftSha ?? "none").slice(0, 12)}`, errors };
      }
      const diskDryOk = !!diskField && diskField.diskBeforeSha === plan.planSha && diskField.draftShaOk === true;
      if (dry || check.diskMode !== "live") {
        return { ...base, status: "wouldApply", gate: dry ? "dryRun" : "check.diskMode dry", diskDryOk, errors };
      }
      if (disk.mode !== "live" || !diskField || diskField.diskAfterSha !== draftSha) {
        return { ...base, ok: false, status: "refused: disk-not-written", detail: diskField?.stopReason ?? `disk after ${String(diskField?.diskAfterSha ?? "none").slice(0, 12)} != draft ${draftSha.slice(0, 12)}`, errors };
      }
      const live = await liveHb();
      const dbSha = await sha(live);
      const preKey = preimageKey(runId, LEAD);
      // lead-disk copies Lead's disk file here before it writes the draft.
      const diskBackup = `${DEFAULT_DISK_BACKUP_DIR}/${runId}.md`;
      const restoreTask = async (why: string) =>
        ctx.swarm.task_send({
          agentId: LEAD,
          routingReason: "human_pinned",
          routingNote: `dreaming heartbeat lane: restore HEARTBEAT.md after ${why}`,
          task: `dreaming heartbeat lane (run ${runId}): ${why}, so the prune was not applied. Restore your disk copy with ONE bash call and no Write/Edit tool: \`cp ${diskBackup} /workspace/HEARTBEAT.md && sha256sum /workspace/HEARTBEAT.md\`. Expected sha ${dbSha}. Reply with the sha.`,
        });
      let status = "";
      if (dbSha === plan.planSha) {
        // Pre-image: plan stored it; re-store it from the live text when missing or stale (live = plan here).
        let pre = await kvGet(preKey);
        if (pre?.sha !== dbSha || (await sha(String(pre?.content ?? ""))) !== dbSha) {
          await kvSet(preKey, { content: live, sha: dbSha, at: now.toISOString() });
          pre = await kvGet(preKey);
        }
        if (pre?.sha !== dbSha || (await sha(String(pre?.content ?? ""))) !== dbSha) {
          await restoreTask("the heartbeat pre-image could not be stored");
          return { ...base, ok: false, status: "refused: no pre-image", detail: `${preKey} missing or sha differs`, restoreTask: "sent to Lead", errors };
        }
        let msg = "";
        try {
          const res: any = await ctx.swarm.profile_update({ agentId: LEAD, heartbeatMd: next } as any);
          if (res?.success === false) msg = String(res?.data?.error ?? res?.data?.message ?? `status ${res?.status}`);
        } catch (e: any) {
          msg = String(e?.message ?? e);
        }
        if (msg) {
          // The disk already holds the draft; put it back so disk and DB both hold the old text.
          await restoreTask(`the DB rejected the heartbeat prune (${msg.slice(0, 200)})`);
          return { ...base, ok: false, status: "rejected", detail: msg.slice(0, 300), restoreTask: "sent to Lead", errors };
        }
        const reSha = await sha(await liveHb());
        status = reSha === draftSha ? "applied" : "";
        if (!status) return { ...base, ok: false, status: "refused: re-read mismatch", detail: `re-read ${reSha.slice(0, 12)} != draft ${draftSha.slice(0, 12)}`, errors };
      } else if (dbSha === draftSha) {
        status = "applied-via-self-edit";
      } else {
        const back = removed.map((r: any) => String(r?.probe ?? r?.title ?? "")).filter((pr) => pr && live.includes(pr));
        if (!back.length && trackedLines(next).every((l) => live.includes(l))) status = "applied-via-self-edit";
        else {
          await restoreTask("your heartbeatMd changed in the DB while the prune ran");
          return { ...base, ok: false, status: "refused: db-drift", detail: `db ${dbSha.slice(0, 12)} is neither plan nor draft; ${back.length} removed probe(s) present`, restoreTask: "sent to Lead", errors };
        }
      }
      const removedProbes = removed.map((r: any) => String(r?.probe ?? r?.title ?? "").slice(0, 80)).filter(Boolean);
      const state = { runId, at: now.toISOString(), beforeSha: plan.planSha, afterSha: draftSha, afterChars: next.length, afterText: next, preimageKey: preKey, diskBackup, removedProbes, status };
      await kvSet("hb-state:lead", state);
      await kvSet(`hb-state:${runId}`, { ...state, afterText: undefined });
      await kvSet(`cuts:${runId}:C`, {
        runId,
        lane: "C",
        at: now.toISOString(),
        cuts: removed.map((r: any, i: number) => ({
          cutId: `${runId.slice(0, 8)}:C:${i}`,
          lane: "C",
          target: { kind: "heartbeat", agentId: LEAD, field: "heartbeatMd" },
          probe: String(r?.probe ?? r?.title ?? "").slice(0, 80),
          kind: String(r?.reason ?? "removed").slice(0, 60),
          movedTo: r?.movedTo ?? "none",
          backupRef: preKey,
        })),
      });
      const adds: any[] = Array.isArray(draft.runbookAdds) ? draft.runbookAdds : [];
      if (adds.length) await kvSet("hb-runbook-adds:latest", { runId, at: now.toISOString(), skill: plan.runbookSkill ?? PROCEDURES_SKILL, adds });
      const memories: any[] = [];
      for (const m of (Array.isArray(draft.movedToMemory) ? draft.movedToMemory : []).slice(0, MAX_MEMORIES)) {
        const name = String(m?.name ?? "");
        const content = String(m?.content ?? "");
        if (!/^[a-z0-9-]{3,90}$/.test(name) || !content.trim()) { memories.push({ name, status: "refused" }); continue; }
        const c = await q(`SELECT COUNT(*) n FROM agent_memory WHERE name = ?`, [name]);
        if (Number(c[0]?.n) > 0) { memories.push({ name, status: "exists" }); continue; }
        await ctx.swarm.memory_store({ name, content, scope: "swarm", tags: ["dreaming", runId, "heartbeat"], intent: `dreaming heartbeat lane ${runId}` } as any);
        memories.push({ name, status: "stored" });
      }
      return { ...base, status, stateKey: "hb-state:lead", cutsKey: `cuts:${runId}:C`, preimageKey: preKey, beforeSha: plan.planSha, afterSha: draftSha, memories, runbookAdds: adds.length, errors };
    }

    // ---------------- restore-db ----------------
    if (a.mode === "restore-db") {
      const preKey = preimageKey(runId, LEAD);
      const pre = await kvGet(preKey);
      if (typeof pre?.content !== "string") return { ok: false, errors: [`no ${preKey}`] };
      if (a.confirmDiskSha !== pre.sha) return { ok: false, errors: ["confirmDiskSha must equal the pre-image sha (restore the disk copy first)"], preimageSha: pre.sha };
      if (dry) return { ok: true, mode: "dry-run", wouldRestoreChars: pre.content.length };
      await ctx.swarm.profile_update({ agentId: LEAD, heartbeatMd: pre.content } as any);
      const ok = (await sha(await liveHb())) === pre.sha;
      if (ok) await kvSet("hb-state:lead", { runId, revertedAt: now.toISOString(), afterSha: null });
      return { ok, mode: "live", restoredChars: pre.content.length };
    }

    // ---------------- revert ----------------
    if (a.mode === "revert") {
      const preKey = preimageKey(runId, LEAD);
      const pre = await kvGet(preKey);
      if (!pre?.sha) return { ok: false, errors: [`no ${preKey}`] };
      const st = await kvGet(`hb-state:${runId}`);
      const diskBackup = typeof st?.diskBackup === "string" && st.diskBackup ? st.diskBackup : `${DEFAULT_DISK_BACKUP_DIR}/${runId}.md`;
      return {
        ok: true,
        brief: [
          `Lead, one bash call, no Write/Edit tool: cp ${diskBackup} /workspace/HEARTBEAT.md && sha256sum /workspace/HEARTBEAT.md (expect ${pre.sha}).`,
          `Then: script-run name="dream-heartbeat" scope="global" args={"mode":"restore-db","runId":"${runId}","leadId":"${LEAD}","dryRun":false,"confirmDiskSha":"${pre.sha}"}`,
        ],
      };
    }

    // ---------------- verify ----------------
    const st = await kvGet("hb-state:lead");
    const live = await liveHb();
    const s = await sha(live);
    if (!st?.afterSha) return { ok: true, mode: "verify", status: "none", chars: live.length };
    const back = (Array.isArray(st.removedProbes) ? st.removedProbes : []).filter((pr: string) => pr && live.includes(pr));
    return {
      ok: true,
      mode: "verify",
      runId: st.runId,
      status: s === st.afterSha ? "intact" : s === st.beforeSha ? "reverted" : back.length ? "reintroduced" : "drifted",
      chars: live.length,
      underTarget: live.length <= TARGETS.firstRunChars,
      reintroduced: back.slice(0, 30),
    };
  } catch (e: any) {
    return { ok: false, mode: a.mode, errors: [...errors, String(e?.message ?? e).slice(0, 300)] };
  }
}
