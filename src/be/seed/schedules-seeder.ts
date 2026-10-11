import { CronExpressionParser } from "cron-parser";
import dailyBlockerDigestConfig from "../../../templates/schedules/daily-blocker-digest/config.json" with {
  type: "text",
};
import dailyBlockerDigestContent from "../../../templates/schedules/daily-blocker-digest/content.md" with {
  type: "text",
};
import dailyCompoundingReflectionConfig from "../../../templates/schedules/daily-compounding-reflection/config.json" with {
  type: "text",
};
import dailyCompoundingReflectionContent from "../../../templates/schedules/daily-compounding-reflection/content.md" with {
  type: "text",
};
import dailyHnBriefingConfig from "../../../templates/schedules/daily-hn-briefing/config.json" with {
  type: "text",
};
import dailyHnBriefingContent from "../../../templates/schedules/daily-hn-briefing/content.md" with {
  type: "text",
};
import dailyStatusReportConfig from "../../../templates/schedules/daily-status-report/config.json" with {
  type: "text",
};
import dailyStatusReportContent from "../../../templates/schedules/daily-status-report/content.md" with {
  type: "text",
};
import dailySwarmUpdateCheckConfig from "../../../templates/schedules/daily-swarm-update-check/config.json" with {
  type: "text",
};
import dailySwarmUpdateCheckContent from "../../../templates/schedules/daily-swarm-update-check/content.md" with {
  type: "text",
};
import dailyWorkflowHealthAuditConfig from "../../../templates/schedules/daily-workflow-health-audit/config.json" with {
  type: "text",
};
import dailyWorkflowHealthAuditContent from "../../../templates/schedules/daily-workflow-health-audit/content.md" with {
  type: "text",
};
import gtmWeeklyReviewConfig from "../../../templates/schedules/gtm-weekly-review/config.json" with {
  type: "text",
};
import gtmWeeklyReviewContent from "../../../templates/schedules/gtm-weekly-review/content.md" with {
  type: "text",
};
import weeklyCodeHealthReportsConfig from "../../../templates/schedules/weekly-code-health-reports/config.json" with {
  type: "text",
};
import weeklyCodeHealthReportsContent from "../../../templates/schedules/weekly-code-health-reports/content.md" with {
  type: "text",
};
import weeklyDependabotTriageConfig from "../../../templates/schedules/weekly-dependabot-triage/config.json" with {
  type: "text",
};
import weeklyDependabotTriageContent from "../../../templates/schedules/weekly-dependabot-triage/content.md" with {
  type: "text",
};
import weeklyDoraMetricsConfig from "../../../templates/schedules/weekly-dora-metrics/config.json" with {
  type: "text",
};
import weeklyDoraMetricsContent from "../../../templates/schedules/weekly-dora-metrics/content.md" with {
  type: "text",
};
import weeklyHarnessUpgradeCheckConfig from "../../../templates/schedules/weekly-harness-upgrade-check/config.json" with {
  type: "text",
};
import weeklyHarnessUpgradeCheckContent from "../../../templates/schedules/weekly-harness-upgrade-check/content.md" with {
  type: "text",
};
import type { AutomationIntegrationId, ScheduledTask } from "../../types";
import {
  computeContentHash,
  createScheduledTask,
  getScheduledTaskByName,
  updateScheduledTask,
} from "../db";
import { resolveSeededEnabled } from "./automation-toggle";
import type { Seeder, SeedItem } from "./types";
import { canonicalJson } from "./workflows-seeder";

type ScheduleTemplateConfig = {
  name: string;
  title: string;
  description: string;
  placeholders?: string[];
  requires?: AutomationIntegrationId[];
  runAllSeedersCandidate?: boolean;
  /** Explicit, reviewed opt-in into the auto-enable policy — see ./automation-toggle. */
  autoEnableCandidate?: boolean;
  tags?: string[];
};

type ScheduleBlock = {
  cron: string;
  timezone?: string;
  enabled?: boolean;
};

export type SeedSchedule = {
  name: string;
  description: string;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  taskTemplate: string;
  taskType: string;
  tags: string[];
  params: Record<string, unknown>;
  requiredParams: string[];
  requires: AutomationIntegrationId[];
};

export type ScheduleTemplateSource = { config: string; content: string };
type ScheduleSeedItem = SeedItem & { schedule: SeedSchedule };

const asText = (value: unknown): string => value as string;

const BUILT_IN_SCHEDULE_SOURCES: readonly ScheduleTemplateSource[] = [
  { config: asText(dailyBlockerDigestConfig), content: asText(dailyBlockerDigestContent) },
  {
    config: asText(dailyCompoundingReflectionConfig),
    content: asText(dailyCompoundingReflectionContent),
  },
  { config: asText(dailyHnBriefingConfig), content: asText(dailyHnBriefingContent) },
  { config: asText(dailyStatusReportConfig), content: asText(dailyStatusReportContent) },
  {
    config: asText(dailySwarmUpdateCheckConfig),
    content: asText(dailySwarmUpdateCheckContent),
  },
  {
    config: asText(dailyWorkflowHealthAuditConfig),
    content: asText(dailyWorkflowHealthAuditContent),
  },
  { config: asText(gtmWeeklyReviewConfig), content: asText(gtmWeeklyReviewContent) },
  {
    config: asText(weeklyCodeHealthReportsConfig),
    content: asText(weeklyCodeHealthReportsContent),
  },
  {
    config: asText(weeklyDependabotTriageConfig),
    content: asText(weeklyDependabotTriageContent),
  },
  { config: asText(weeklyDoraMetricsConfig), content: asText(weeklyDoraMetricsContent) },
  {
    config: asText(weeklyHarnessUpgradeCheckConfig),
    content: asText(weeklyHarnessUpgradeCheckContent),
  },
];

function parseScheduleSource(source: ScheduleTemplateSource): SeedSchedule | null {
  const config = JSON.parse(source.config) as ScheduleTemplateConfig;
  if (!config.runAllSeedersCandidate) return null;

  const scheduleHeading = source.content.match(/## Schedule\s*\n+/);
  const scheduleStart = scheduleHeading
    ? scheduleHeading.index! + scheduleHeading[0].length
    : source.content.indexOf("```json");
  const scheduleText = source.content.slice(scheduleStart);
  const blockMatch =
    scheduleText.match(/^\s*```json\s*\n([\s\S]*?)\n```/) ?? scheduleText.match(/(\{[\s\S]*?\})/);
  if (!blockMatch?.[1]) throw new Error(`Schedule template ${config.name} has no schedule JSON`);
  const block = JSON.parse(blockMatch[1]) as ScheduleBlock;
  const afterBlock = scheduleStart + blockMatch.index! + blockMatch[0].length;
  const taskHeading = source.content.indexOf("## Scheduled Task", afterBlock);
  const taskTemplate = source.content
    .slice(taskHeading >= 0 ? taskHeading + "## Scheduled Task".length : afterBlock)
    .trim();
  if (!taskTemplate) throw new Error(`Schedule template ${config.name} has no task prompt`);

  const requires = config.requires ?? [];
  const requiredParams = config.placeholders ?? [];
  return {
    name: config.name,
    description: config.description,
    cronExpression: block.cron,
    timezone: block.timezone ?? "UTC",
    // Boot seeding always inventories the automation. Whether it also arrives
    // enabled is gated by the operator switch (SEED_AUTOMATIONS_ENABLED), the
    // item being zero-config (no requires/placeholders), the template's own
    // explicit autoEnableCandidate opt-in, and the template not explicitly
    // recommending it stay off. See ./automation-toggle.
    enabled: resolveSeededEnabled({
      requires,
      requiredParams,
      autoEnableCandidate: config.autoEnableCandidate === true,
      templateRecommendsEnabled: block.enabled !== false,
    }),
    taskTemplate,
    taskType: config.title,
    tags: config.tags ?? [],
    params: {},
    requiredParams,
    requires,
  };
}

export function loadSeedSchedules(
  sources: readonly ScheduleTemplateSource[] = BUILT_IN_SCHEDULE_SOURCES,
): SeedSchedule[] {
  return sources
    .map(parseScheduleSource)
    .filter((schedule): schedule is SeedSchedule => schedule !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The part of a seeded schedule that the seed hash covers. `enabled` is left
 * out on purpose: it is an operator switch, not content. Toggling it must not
 * mark the row as user-edited, and flipping SEED_AUTOMATIONS_ENABLED must not
 * change any source hash.
 */
type HashedSeedSchedule = Omit<SeedSchedule, "enabled">;

function hashedSchedule(schedule: SeedSchedule): HashedSeedSchedule {
  const { enabled: _enabled, ...hashed } = schedule;
  return hashed;
}

function scheduleSeedHash(schedule: HashedSeedSchedule): string {
  return computeContentHash(canonicalJson(schedule));
}

/**
 * Seed hashes recorded before `enabled` left the hash covered it. Return the
 * old-formula hash of the live row under both `enabled` values, so a row whose
 * only change is an `enabled` toggle still counts as pristine and is
 * rebaselined to the new formula.
 */
function legacyScheduleSeedHashes(schedule: HashedSeedSchedule): string[] {
  return [true, false].map((enabled) =>
    computeContentHash(canonicalJson({ ...schedule, enabled })),
  );
}

function scheduleFromRow(schedule: ScheduledTask): HashedSeedSchedule {
  return {
    name: schedule.name,
    description: schedule.description ?? "",
    cronExpression: schedule.cronExpression ?? "",
    timezone: schedule.timezone,
    taskTemplate: schedule.taskTemplate ?? "",
    taskType: schedule.taskType ?? "",
    tags: schedule.tags,
    params: schedule.params ?? {},
    requiredParams: schedule.requiredParams ?? [],
    requires: schedule.requires ?? [],
  };
}

function nextRunAt(schedule: SeedSchedule, enabled: boolean): string | null {
  try {
    // Disabled templates can await a required timezone parameter. Validate the
    // cron in UTC until setup supplies it, retaining the placeholder in the row.
    const timezonePending =
      !enabled &&
      schedule.requiredParams.some((param) => schedule.timezone.includes(`{{${param}}}`));
    const interval = CronExpressionParser.parse(schedule.cronExpression, {
      currentDate: new Date(),
      tz: timezonePending ? "UTC" : schedule.timezone,
    });
    return enabled ? interval.next().toISOString() : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid cron expression";
    throw new Error(`Invalid cron expression: ${message}`);
  }
}

export function createSchedulesSeeder(
  sources: readonly ScheduleTemplateSource[] = BUILT_IN_SCHEDULE_SOURCES,
): Seeder<ScheduleSeedItem> {
  const schedules = loadSeedSchedules(sources);
  return {
    kind: "schedule",

    items(): ScheduleSeedItem[] {
      return schedules.map((schedule) => ({
        key: schedule.name,
        contentHash: scheduleSeedHash(hashedSchedule(schedule)),
        schedule,
      }));
    },

    async upstreamHash(item): Promise<string | null> {
      const existing = await getScheduledTaskByName(item.key);
      return existing ? scheduleSeedHash(scheduleFromRow(existing)) : null;
    },

    async legacyUpstreamHashes(item): Promise<string[]> {
      const existing = await getScheduledTaskByName(item.key);
      return existing ? legacyScheduleSeedHashes(scheduleFromRow(existing)) : [];
    },

    async apply(item): Promise<void> {
      const { schedule } = item;
      const data = {
        description: schedule.description,
        cronExpression: schedule.cronExpression,
        timezone: schedule.timezone,
        targetType: "agent-task" as const,
        taskTemplate: schedule.taskTemplate,
        taskType: schedule.taskType,
        tags: schedule.tags,
        params: schedule.params,
        requiredParams: schedule.requiredParams,
        requires: schedule.requires,
      };
      const existing = await getScheduledTaskByName(schedule.name);
      if (existing) {
        // `enabled` is the operator's switch: an update ships new content and
        // keeps whatever the row is set to. The cron is validated either way,
        // but only an enabled row gets a fresh nextRunAt.
        const resolvedNextRunAt = nextRunAt(schedule, existing.enabled);
        await updateScheduledTask(existing.id, {
          ...data,
          ...(existing.enabled ? { nextRunAt: resolvedNextRunAt } : {}),
        });
      } else {
        const resolvedNextRunAt = nextRunAt(schedule, schedule.enabled);
        await createScheduledTask({
          name: schedule.name,
          ...data,
          enabled: schedule.enabled,
          nextRunAt: resolvedNextRunAt ?? undefined,
        });
      }
    },
  };
}

export const schedulesSeeder = createSchedulesSeeder();
