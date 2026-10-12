/**
 * Built-in global scripts catalog — the one concrete {@link Seeder} wired into
 * the generic seeder framework (see `src/be/seed`).
 *
 * Each entry's runtime source is a real `.ts` file under `./catalog/`, imported
 * here as text so it ships embedded in the compiled binary. {@link scriptsSeeder}
 * mirrors the `/api/scripts/upsert` pipeline (import allowlist -> typecheck ->
 * signature + argsSchema extraction -> upsert at `global` scope). The framework
 * harness makes re-seeding version-aware: a pristine script updates when its
 * catalog source changes, a user-modified one is preserved.
 *
 * To add a script: drop a `<name>.ts` file in `./catalog/`, text-import it below,
 * and add a manifest entry to {@link SEED_SCRIPTS}. The `description` + `intent`
 * power `script-search` ranking — write them with the keywords an agent would
 * actually search for.
 */

import { extractScriptSignature } from "../../scripts-runtime/extract-signature";
import { validateScriptImports } from "../../scripts-runtime/import-allowlist";
import { computeContentHash } from "../db";
import { getScript, upsertScriptByName } from "../scripts/db";
import { extractArgsJsonSchema } from "../scripts/extract-schema";
import { typecheckScript } from "../scripts/typecheck";
import type { Seeder, SeederRunOptions, SeedItem } from "../seed/types";
import appSyncRunSrc from "./catalog/app-sync-run.ts" with { type: "text" };
import bootTriageSrc from "./catalog/boot-triage.inline.ts" with { type: "text" };
// @ts-expect-error Bun text imports synthesize a default string for this helper.
import catalogReportSrc from "./catalog/catalog-report.inline.ts" with { type: "text" };
import completeTaskSrc from "./catalog/complete-task.ts" with { type: "text" };
import compoundInsightsSrc from "./catalog/compound-insights.inline.ts" with { type: "text" };
import dateResolveSrc from "./catalog/date-resolve.ts" with { type: "text" };
import delegateSrc from "./catalog/delegate.ts" with { type: "text" };
import dreamApplySrc from "./catalog/dream-apply.ts" with { type: "text" };
import dreamGatherSrc from "./catalog/dream-gather.ts" with { type: "text" };
import dreamHeartbeatSrc from "./catalog/dream-heartbeat.ts" with { type: "text" };
import dreamLearnSrc from "./catalog/dream-learn.ts" with { type: "text" };
import dreamOwnersSrc from "./catalog/dream-owners.ts" with { type: "text" };
import dreamReportsCheckSrc from "./catalog/dream-reports-check.ts" with { type: "text" };
import dreamRollbackSrc from "./catalog/dream-rollback.ts" with { type: "text" };
import dreamTrimSrc from "./catalog/dream-trim.ts" with { type: "text" };
import dreamVerifySrc from "./catalog/dream-verify.ts" with { type: "text" };
import fetchReadableSrc from "./catalog/fetch-readable.ts" with { type: "text" };
import getChildOutputsSrc from "./catalog/get-child-outputs.ts" with { type: "text" };
import ghPrSnapshotSrc from "./catalog/gh-pr-snapshot.ts" with { type: "text" };
import githubIssuesPullSrc from "./catalog/github-issues-pull.ts" with { type: "text" };
import groupCountSrc from "./catalog/group-count.ts" with { type: "text" };
import jsonQuerySrc from "./catalog/json-query.ts" with { type: "text" };
import linearIssueSrc from "./catalog/linear-issue.ts" with { type: "text" };
import memoryDedupCheckSrc from "./catalog/memory-dedup-check.ts" with { type: "text" };
import memoryEvalSrc from "./catalog/memory-eval.ts" with { type: "text" };
import opsCatalogAuditSrc from "./catalog/ops-catalog-audit.inline.ts" with { type: "text" };
import reportProgressSrc from "./catalog/report-progress.ts" with { type: "text" };
import scheduleHealthSrc from "./catalog/schedule-health.ts" with { type: "text" };
import slackThreadFlattenSrc from "./catalog/slack-thread-flatten.ts" with { type: "text" };
import smartRecallSrc from "./catalog/smart-recall.ts" with { type: "text" };
import starHistoryRefreshSrc from "./catalog/star-history-refresh.ts" with { type: "text" };
// @ts-expect-error Bun text imports synthesize a default string for this helper.
import starHistoryRendererSrc from "./catalog/star-history-renderer.ts" with { type: "text" };
import swarmOverviewSrc from "./catalog/swarm-overview.ts" with { type: "text" };
import taskContextGatheringSrc from "./catalog/task-context-gathering.ts" with { type: "text" };
import taskFailureAuditSrc from "./catalog/task-failure-audit.ts" with { type: "text" };
import textDiffSrc from "./catalog/text-diff.ts" with { type: "text" };
import toolUsageSrc from "./catalog/tool-usage.ts" with { type: "text" };
import waitForTaskSrc from "./catalog/wait-for-task.ts" with { type: "text" };

export type SeedScript = {
  name: string;
  description: string;
  intent: string;
  source: string;
};

// Text imports resolve to a string at runtime; TypeScript types them as the
// module's default export, so the cast restores the real shape.
const asText = (s: unknown): string => s as string;

const CATALOG_REPORT_IMPORT_RE = /^import\s+\{[^}]*\}\s+from "\.\/catalog-report";\n\n?/m;

function bundleCatalogReport(source: string): string {
  const helper = asText(catalogReportSrc);
  if (!CATALOG_REPORT_IMPORT_RE.test(source)) return source;
  return `${helper}\n\n${source.replace(CATALOG_REPORT_IMPORT_RE, "")}`;
}

export const SEED_SCRIPTS: SeedScript[] = [
  {
    name: "star-history-refresh",
    description:
      "Refresh stable public light/dark SVG star-history pages from GitHub with ETags and a last-known KV series.",
    intent:
      "Run hourly under the same page-owning agent identity; dryRun validates rendering before SVG page support deploys.",
    source:
      asText(starHistoryRendererSrc) +
      "\n" +
      asText(starHistoryRefreshSrc).replace(
        'import { renderChart } from "./star-history-renderer";',
        "",
      ),
  },
  {
    name: "gh-pr-snapshot",
    description:
      "One-call GitHub pull request snapshot: title, state, draft, mergeable, CI check tallies (passed/failed/pending) and review tallies (approved/changes-requested/pending).",
    intent:
      "Triage a GitHub PR's status in a single call instead of running several gh pr view / gh pr checks / gh api invocations.",
    source: asText(ghPrSnapshotSrc),
  },
  {
    name: "github-issues-pull",
    description:
      "Pull a GitHub repository's issues (pull requests filtered out) as app-sync records: number, title, state, body, author, labels, comments and timestamps, with a completeness flag for the pull window.",
    intent:
      "Back a Swarm App model with GitHub issues — the worked example of a sync source script returning {records, complete} with placeholder-based auth.",
    source: asText(githubIssuesPullSrc),
  },
  {
    name: "app-sync-run",
    description:
      "Run a Swarm App's sync passes — refreshes every source-backed model, or just one model/source, and returns the per-pass created/updated/refreshed tallies.",
    intent:
      "Keep an app's synced rows fresh on a schedule or on demand; the script a targetType:'script' schedule points at to sync an app.",
    source: asText(appSyncRunSrc),
  },
  {
    name: "fetch-readable",
    description:
      "Fetch a web page and extract clean readable article text — strips scripts, styles, nav, headers, footers, ads and HTML tags, and decodes entities.",
    intent:
      "Read the actual content of a URL without wading through raw HTML; readable-article / reader-mode extraction.",
    source: asText(fetchReadableSrc),
  },
  {
    name: "json-query",
    description:
      "Run a jq-style path/filter query over any JSON value: dot fields, [n] indexing, [] iteration, | pipes, and keys/values/length/type functions.",
    intent: "Extract a value from a JSON blob without shelling out to a curl | jq pipeline.",
    source: asText(jsonQuerySrc),
  },
  {
    name: "group-count",
    description:
      "Group an array of objects by a field (dotted paths supported), returning per-group counts sorted by frequency plus an optional numeric sum.",
    intent:
      "Aggregate or tally records — counts and sums by category — without writing ad-hoc reduce code.",
    source: asText(groupCountSrc),
  },
  {
    name: "date-resolve",
    description:
      "Resolve a natural-language date expression (yesterday, last week, Thursday, 7d ago, an ISO date) into an ISO timestamp or a {start,end} range.",
    intent:
      "Turn fuzzy human date phrases into concrete timestamps for filtering, querying or scheduling.",
    source: asText(dateResolveSrc),
  },
  {
    name: "text-diff",
    description:
      "Compare two strings line-by-line with an LCS diff and return a unified-diff summary plus added/removed/unchanged counts.",
    intent: "See exactly what changed between two versions of a text, config or document.",
    source: asText(textDiffSrc),
  },
  {
    name: "task-failure-audit",
    description:
      "Scan recently failed swarm tasks and cluster them by failure reason, agent or schedule to surface recurring problems.",
    intent:
      "Find patterns in swarm task failures — which agent, schedule or error keeps breaking — for a reliability review.",
    source: bundleCatalogReport(asText(taskFailureAuditSrc)),
  },
  {
    name: "memory-dedup-check",
    description:
      "Semantic-search existing swarm memories for near-duplicates of a candidate text and report matches above a similarity threshold.",
    intent:
      "Avoid writing a redundant memory — check whether something equivalent is already stored before saving.",
    source: asText(memoryDedupCheckSrc),
  },
  {
    name: "linear-issue",
    description:
      "Fetch a Linear issue by its identifier (e.g. DES-123): title, status, priority, assignee and comments.",
    intent:
      "Pull Linear ticket context into a task without leaving the swarm or opening a browser.",
    source: asText(linearIssueSrc),
  },
  {
    name: "slack-thread-flatten",
    description:
      "Fetch a Slack thread by channel + thread timestamp and flatten it into a readable chronological transcript.",
    intent: "Turn a Slack thread into plain text for summarizing or as task context.",
    source: asText(slackThreadFlattenSrc),
  },
  {
    name: "smart-recall",
    description:
      "Multi-query fan-out memory search with dedup and composite reranking (bestSimilarity + 0.05 * hitCount). Returns unique memories across all queries.",
    intent:
      "Recall relevant memories using multiple search angles — better coverage than a single query. Use for task onboarding, context gathering, or before writing new memories.",
    source: asText(smartRecallSrc),
  },
  {
    name: "task-context-gathering",
    description:
      "Get task details and recall relevant memories in one call — returns a slimmed task projection plus deduped and reranked memories from multi-query fan-out.",
    intent:
      "Task onboarding: one call instead of task_get plus multiple memory_search calls. Pass the task description split into 2-4 natural-language queries.",
    source: asText(taskContextGatheringSrc),
  },
  {
    name: "schedule-health",
    description:
      "Per-schedule failure rate check over recent tasks — flags schedules with failure rates above a configurable threshold.",
    intent:
      "Find unhealthy schedules that keep failing — for daily compounding, reliability reviews, or ops triage.",
    source: bundleCatalogReport(asText(scheduleHealthSrc)),
  },
  {
    name: "tool-usage",
    description:
      "Tool usage histogram from session_logs — top tools by call count over a time window, optionally filtered by agent.",
    intent:
      "See which MCP tools agents use most — for SDK gap analysis, optimization, or daily ops snapshots.",
    source: asText(toolUsageSrc),
  },
  {
    name: "compound-insights",
    description:
      "All-in-one swarm-wide daily ops snapshot: task completion/failure summary, real failure clusters (excludes superseded/cancelled bookkeeping), schedule health flags, tool usage top-25, memory health/pollution stats, seed-script candidate tool triplets, and a per-agent breakdown. Aggregates across ALL agents via direct read-only SQL.",
    intent:
      "Single-call daily compounding Phase 0 helper — replaces ~25 raw tool roundtrips with one compressed JSON result covering every agent. For daily evolution, self-scripting candidates, ops reviews, or heartbeat context.",
    source: bundleCatalogReport(asText(compoundInsightsSrc)),
  },
  {
    name: "memory-eval",
    description:
      "3-axis memory quality evaluation: carry-forward context (do follow-up tasks retrieve useful memories from prior tasks?), follow preferences (are CLAUDE.md/IDENTITY.md/SOUL.md/TOOLS.md memories retrieved and useful?), and stay current (what fraction of retrieved memories are fresh vs stale?). Outputs a baseline report to a swarm Page and the return value.",
    intent:
      "Measure memory system health across OpenAI Dreaming-inspired axes — before/after baseline for architecture changes, blog-post numbers, daily quality monitoring.",
    source: asText(memoryEvalSrc),
  },
  {
    name: "ops-catalog-audit",
    description:
      "Audit-as-code catalog check for schedules, workflows, and prompt/template drift. Clusters actionable findings by goal and can publish an authed HTML report page.",
    intent:
      "Re-run the ops inventory audit in one call: duplicate/dead schedules, code-work routing risks, enabled workflow fixtures, structured-output gate gaps, prompt registry drift, stale hosts, and systemDefault skill duplicates.",
    source: bundleCatalogReport(asText(opsCatalogAuditSrc)),
  },
  {
    name: "boot-triage",
    description:
      "Post-restart heartbeat triage snapshot: deploy restart PR context, recent real failures, stuck offline-agent work, orphaned tasks, and superseded tasks missing resume children.",
    intent:
      "Run immediately after a swarm restart to gather deterministic boot triage data in one read-only call before the Lead decides what to retry, cancel, or escalate.",
    source: asText(bootTriageSrc),
  },
  {
    name: "delegate",
    description:
      "Delegate a task to a swarm agent BY NAME — resolves the agent name to its id, sends the subtask (optionally linked via parentTaskId), and returns the created taskId.",
    intent:
      "Send / assign / hand off a subtask to another agent by name without knowing its UUID — one call instead of get-swarm + send-task.",
    source: asText(delegateSrc),
  },
  {
    name: "wait-for-task",
    description:
      "Bounded wait (max ~25s per call) for a task to reach a terminal state (completed/failed/cancelled). Returns {done, status, output}; while done=false, call it again.",
    intent:
      "Wait for / poll a subtask or delegated child task to finish and get its output, without hand-rolling sleep + get-task-details loops.",
    source: asText(waitForTaskSrc),
  },
  {
    name: "get-child-outputs",
    description:
      "Collect all child tasks of a parent task with their status and output in one call. Returns {children:[{id,status,agentId,output}], allDone} for fan-out aggregation.",
    intent:
      "Gather results of delegated subtasks / children of a parent task to aggregate fan-out work without per-child get-task-details calls.",
    source: asText(getChildOutputsSrc),
  },
  {
    name: "complete-task",
    description:
      "Mark a task completed (or failed) with its final output via task_storeProgress — the one-call way to finish an assigned task from a script.",
    intent:
      "Complete / finish / close out my task with final output from inside a script (code-mode) instead of the store-progress tool.",
    source: asText(completeTaskSrc),
  },
  {
    name: "report-progress",
    description:
      "Post an in-progress note on a task via task_storeProgress without changing its terminal state.",
    intent: "Report / store a progress update note on my current task from inside a script.",
    source: asText(reportProgressSrc),
  },
  {
    name: "swarm-overview",
    description:
      "One-call swarm snapshot: every registered agent's name/role/status plus task counts grouped by status.",
    intent:
      "See who is in the swarm and what tasks are running — swarm stats / agent list / task counts in a single call.",
    source: asText(swarmOverviewSrc),
  },
  {
    name: "dream-gather",
    description:
      "Dreaming gather: the last N days of per-agent task, cost, skill, memory and profile evidence, plus the normalized nightly config (mode, lanes, caps, cfg, lead and worker ids).",
    intent:
      "First node of the nightly dreaming workflow; decides off, dry-run or live and feeds every later node.",
    source: asText(dreamGatherSrc),
  },
  {
    name: "dream-reports-check",
    description:
      "Dreaming reports guard: validate each per-agent reflection report against its slot and schema, list slots to retry once, then merge the retry pass.",
    intent:
      "Reject malformed or mismatched reflection reports before synthesis in the dreaming workflow.",
    source: asText(dreamReportsCheckSrc),
  },
  {
    name: "dream-apply",
    description:
      "Dreaming apply: write approved identity and memory actions with pre-images, scrubber guards and re-read verification.",
    intent:
      "Nightly dreaming run applies auto-tier identity and memory actions, honouring lanes and caps.",
    source: asText(dreamApplySrc),
  },
  {
    name: "dream-trim",
    description:
      "Dreaming trim: plan profile-field trims with KV pre-images, then apply net-smaller drafts with re-read verification.",
    intent: "Keep agent profile fields short; plan, apply or revert one night's trims.",
    source: asText(dreamTrimSrc),
  },
  {
    name: "dream-heartbeat",
    description:
      "Dreaming heartbeat lane: plan, validate and apply a prune of the Lead's HEARTBEAT checklist, with the draft and pre-image held in KV.",
    intent:
      "Run from the dreaming workflow to shrink the Lead heartbeat safely: validator parity, kept pins, a quiet window, sha-checked apply and rollback.",
    source: asText(dreamHeartbeatSrc),
  },
  {
    name: "dream-verify",
    description:
      "Dreaming verify: re-check every lane's claims against the database, flag unclaimed writes and dry-run violations, track survival, and mark a clean dry run green.",
    intent:
      "Run after the dreaming lanes to prove what changed, keep the ledger, and unlock the first live run.",
    source: asText(dreamVerifySrc),
  },
  {
    name: "dream-learn",
    description:
      "Dreaming learning loop: score past profile, heartbeat and memory cuts (reverted, reintroduced, referenced), pin reintroduced ones, store nightly metrics with trends.",
    intent: "Measure whether dreaming cuts stuck and feed that back into the next night's gather.",
    source: asText(dreamLearnSrc),
  },
  {
    name: "dream-owners",
    description:
      "Dreaming owners: turn every action no lane closed tonight into one task per owner, idempotent per run, and flag degraded sends with the unowned action ids.",
    intent: "Make sure nothing the nightly dreaming run found stays parked without an owner.",
    source: asText(dreamOwnersSrc),
  },
  {
    name: "dream-rollback",
    description:
      "Dreaming rollback: restore profile fields, identity edits and memories a dreaming run wrote, from its KV pre-images.",
    intent: "Undo one dreaming run by hand.",
    source: asText(dreamRollbackSrc),
  },
];

let shippedHashes: Map<string, string> | undefined;

/**
 * True when `source` hashes to the catalog source this build ships for `name`.
 * The catalog is compiled into the binary, so after a release only the new
 * shipped source matches; an edited or replaced row never does.
 */
export function isShippedSeedScriptSource(name: string, source: string): boolean {
  shippedHashes ??= new Map(SEED_SCRIPTS.map((s) => [s.name, computeContentHash(s.source)]));
  const shipped = shippedHashes.get(name);
  return shipped !== undefined && shipped === computeContentHash(source);
}

/** A catalog entry resolved into a generic {@link SeedItem}. */
type ScriptSeedItem = SeedItem & { script: SeedScript };

/**
 * The one concrete {@link Seeder} wired up today: lands the built-in scripts
 * catalog at `global` scope.
 *
 * `key` is the script name. `contentHash` is the same SHA-256 of the source
 * that the `scripts` table stores in its `contentHash` column, so a pristine
 * upstream row hashes identically to its catalog source — letting the harness
 * detect "pristine vs user-modified" without any script-specific logic.
 */
export const scriptsSeeder: Seeder<ScriptSeedItem> = {
  kind: "script",

  items(): ScriptSeedItem[] {
    return SEED_SCRIPTS.map((script) => ({
      key: script.name,
      contentHash: computeContentHash(script.source),
      script,
    }));
  },

  async upstreamHash(item): Promise<string | null> {
    const existing = await getScript({ name: item.key, scope: "global" });
    return existing ? existing.contentHash : null;
  },

  async apply(item, _action, opts?: SeederRunOptions): Promise<void> {
    const { script } = item;

    const imports = validateScriptImports(script.source);
    if (!imports.ok) throw new Error(`import check: ${imports.diagnostic}`);

    const typecheck = await typecheckScript(script.source);
    if (!typecheck.ok) throw new Error(`typecheck: ${typecheck.diagnostics.join(" | ")}`);

    // upsertScriptByName handles both create and update (and bumps the
    // script_versions history), so a single path serves either action.
    const argsJsonSchema = await extractArgsJsonSchema(script.source);
    await upsertScriptByName({
      name: script.name,
      scope: "global",
      scopeId: null,
      source: script.source,
      description: script.description,
      intent: script.intent,
      signatureJson: JSON.stringify(extractScriptSignature(script.source)),
      argsJsonSchema,
      fsMode: "none",
      agentId: null,
      isScratch: false,
      typeChecked: true,
      changeReason: "Seeded from the built-in scripts catalog (src/be/seed-scripts)",
      embeddingMode: opts?.scriptEmbeddingMode ?? "sync",
    });
  },
};
