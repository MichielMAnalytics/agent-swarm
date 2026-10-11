import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  computeContentHash,
  createWorkflow,
  deleteWorkflow,
  getScheduledTaskByName,
  getScheduledTasks,
  initDb,
  updateScheduledTask,
} from "../be/db";
import { getSeedState, recordSeedState, runSeeder } from "../be/seed";
import {
  createSchedulesSeeder,
  loadSeedSchedules,
  type ScheduleTemplateSource,
} from "../be/seed/schedules-seeder";
import { canonicalJson } from "../be/seed/workflows-seeder";
import type { ScheduledTask, Workflow } from "../types";

const TEST_DB_PATH = "./test-seed-schedules.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function scheduleSource(cron = "0 9 * * *", description = "Seeded schedule.") {
  return {
    config: JSON.stringify({
      name: "test-seeded-schedule",
      title: "Test seeded schedule",
      description,
      placeholders: ["REPO_URL"],
      requires: ["github"],
      runAllSeedersCandidate: true,
      tags: ["fixture"],
    }),
    content: `# Test\n\n## Schedule\n\n\`\`\`json\n${JSON.stringify({
      cron,
      timezone: "UTC",
      enabled: true,
    })}\n\`\`\`\n\n## Scheduled Task\n\nRun work for {{REPO_URL}}.`,
  } satisfies ScheduleTemplateSource;
}

/** A zero-config candidate: no requires, no placeholders — eligible for auto-enable. */
function zeroConfigScheduleSource(opts?: {
  name?: string;
  templateEnabled?: boolean;
  autoEnableCandidate?: boolean;
}) {
  const name = opts?.name ?? "test-zero-config-schedule";
  const templateEnabled = opts?.templateEnabled ?? true;
  return {
    config: JSON.stringify({
      name,
      title: "Test zero-config schedule",
      description: "Zero-config seeded schedule.",
      placeholders: [],
      requires: [],
      runAllSeedersCandidate: true,
      autoEnableCandidate: opts?.autoEnableCandidate ?? true,
      tags: ["fixture"],
    }),
    content: `# Test\n\n## Schedule\n\n\`\`\`json\n${JSON.stringify({
      cron: "0 9 * * *",
      timezone: "UTC",
      enabled: templateEnabled,
    })}\n\`\`\`\n\n## Scheduled Task\n\nRun work.`,
  } satisfies ScheduleTemplateSource;
}

/** A schedule that fires a workflow by name, with no `## Scheduled Task` section. */
function workflowScheduleSource(workflow = "dreaming", cron = "25 3 * * *") {
  return {
    config: JSON.stringify({
      name: "test-workflow-schedule",
      title: "Test workflow schedule",
      description: "Fires a seeded workflow.",
      placeholders: [],
      requires: [],
      runAllSeedersCandidate: true,
      autoEnableCandidate: true,
      tags: ["fixture"],
    }),
    content: `# Test\n\n## Schedule\n\n\`\`\`json\n${JSON.stringify({
      cron,
      timezone: "UTC",
      enabled: true,
      workflow,
    })}\n\`\`\`\n`,
  } satisfies ScheduleTemplateSource;
}

/**
 * Stand-in for the seeded `dreaming` workflow, so these tests do not depend on
 * the workflow template's content.
 */
function createFixtureWorkflow(name = "dreaming"): Promise<Workflow> {
  return createWorkflow({ name, definition: { nodes: [] } });
}

/**
 * Local copy of the seed hash shape from before `enabled` left the hash: the
 * hashed fields of the row plus `enabled`. Deliberately not imported from the
 * seeder, so these fixtures keep the old formula even if the seeder changes.
 */
function legacyScheduleHash(row: ScheduledTask, enabled: boolean): string {
  const hashed = {
    name: row.name,
    description: row.description ?? "",
    cronExpression: row.cronExpression ?? "",
    timezone: row.timezone,
    taskTemplate: row.taskTemplate ?? "",
    taskType: row.taskType ?? "",
    tags: row.tags,
    params: row.params ?? {},
    requiredParams: row.requiredParams ?? [],
    requires: row.requires ?? [],
  };
  return computeContentHash(canonicalJson({ ...hashed, enabled }));
}

function legacyScheduleHashes(row: ScheduledTask): string[] {
  return [legacyScheduleHash(row, true), legacyScheduleHash(row, false)];
}

/**
 * Seed `source` and then rewrite its seed_state the way the pre-fix seeder
 * recorded it: the legacy-formula hash, including the row's create-time
 * `enabled`. Returns the row as seeded.
 */
async function seedLegacySchedule(source = scheduleSource()): Promise<ScheduledTask> {
  await runSeeder(createSchedulesSeeder([source]), { quiet: true });
  const row = (await getScheduledTaskByName(JSON.parse(source.config).name))!;
  await recordSeedState("schedule", row.name, legacyScheduleHash(row, row.enabled));
  return row;
}

const ORIGINAL_SEED_AUTOMATIONS_ENABLED = process.env.SEED_AUTOMATIONS_ENABLED;

beforeEach(async () => {
  delete process.env.SEED_AUTOMATIONS_ENABLED;
  await removeDbFiles();
  initDb(TEST_DB_PATH);
});

afterEach(async () => {
  closeDb();
  await removeDbFiles();
  if (ORIGINAL_SEED_AUTOMATIONS_ENABLED === undefined) {
    delete process.env.SEED_AUTOMATIONS_ENABLED;
  } else {
    process.env.SEED_AUTOMATIONS_ENABLED = ORIGINAL_SEED_AUTOMATIONS_ENABLED;
  }
});

describe("schedules seeder", () => {
  test("loads all twelve schedule templates, including the unfenced schedule block", () => {
    const schedules = loadSeedSchedules();
    expect(schedules).toHaveLength(12);
    // Zero-config, requires:[], placeholders:[], template enabled:true -> auto-enabled
    // under the default (unset -> on) SEED_AUTOMATIONS_ENABLED switch.
    expect(schedules.find((schedule) => schedule.name === "daily-status-report")).toMatchObject({
      cronExpression: "15 2 * * *",
      enabled: true,
      requiredParams: [],
      requires: [],
    });
    expect(
      schedules.find((schedule) => schedule.name === "daily-swarm-update-check"),
    ).toMatchObject({
      enabled: true,
      requiredParams: [],
      requires: [],
    });
    expect(
      schedules.find((schedule) => schedule.name === "weekly-harness-upgrade-check"),
    ).toMatchObject({
      enabled: false,
      requiredParams: ["REPO_URL", "PR_REVIEWER"],
      requires: ["github"],
    });
    expect(
      schedules.filter((schedule) => schedule.enabled).map((schedule) => schedule.name),
    ).toEqual([
      "daily-blocker-digest",
      "daily-compounding-reflection",
      "daily-status-report",
      "daily-swarm-update-check",
      "daily-workflow-health-audit",
      "dreaming-nightly",
    ]);
  });

  test("SEED_AUTOMATIONS_ENABLED=false still seeds all schedules disabled", async () => {
    process.env.SEED_AUTOMATIONS_ENABLED = "false";
    await createFixtureWorkflow();
    const result = await runSeeder(createSchedulesSeeder(), { quiet: true });
    expect(result).toMatchObject({ created: 12, failed: [] });
    const schedules = await getScheduledTasks();
    expect(schedules).toHaveLength(12);
    expect(schedules.every((schedule) => schedule.enabled === false)).toBe(true);
  });

  test("seeds a disabled schedule whose timezone still needs setup", async () => {
    await createFixtureWorkflow();
    const result = await runSeeder(createSchedulesSeeder(), { quiet: true });
    expect(result).toMatchObject({ created: 12, failed: [] });
    expect(await getScheduledTaskByName("weekly-dependabot-triage")).toMatchObject({
      cronExpression: "40 3 * * 0",
      timezone: "{{TIMEZONE}}",
      enabled: false,
      nextRunAt: undefined,
      requiredParams: ["REPO_URL", "SLACK_CHANNEL_ID", "TIMEZONE"],
      requires: ["github", "slack"],
    });
  });

  test("switch on: a zero-config candidate auto-enables via createSchedulesSeeder/apply", async () => {
    delete process.env.SEED_AUTOMATIONS_ENABLED;
    const seeder = createSchedulesSeeder([zeroConfigScheduleSource()]);
    await runSeeder(seeder, { quiet: true });
    expect(await getScheduledTaskByName("test-zero-config-schedule")).toMatchObject({
      enabled: true,
    });
  });

  test("switch on: an item with unmet requires stays disabled", async () => {
    delete process.env.SEED_AUTOMATIONS_ENABLED;
    const seeder = createSchedulesSeeder([scheduleSource()]);
    await runSeeder(seeder, { quiet: true });
    expect(await getScheduledTaskByName("test-seeded-schedule")).toMatchObject({
      enabled: false,
    });
  });

  test("switch off: a zero-config candidate stays disabled", async () => {
    process.env.SEED_AUTOMATIONS_ENABLED = "false";
    const seeder = createSchedulesSeeder([zeroConfigScheduleSource()]);
    await runSeeder(seeder, { quiet: true });
    expect(await getScheduledTaskByName("test-zero-config-schedule")).toMatchObject({
      enabled: false,
    });
  });

  test("switch on: a zero-config candidate whose template recommends staying off stays disabled", async () => {
    delete process.env.SEED_AUTOMATIONS_ENABLED;
    const seeder = createSchedulesSeeder([zeroConfigScheduleSource({ templateEnabled: false })]);
    await runSeeder(seeder, { quiet: true });
    expect(await getScheduledTaskByName("test-zero-config-schedule")).toMatchObject({
      enabled: false,
    });
  });

  test("switch on: a zero-config candidate without an explicit autoEnableCandidate opt-in stays disabled", async () => {
    delete process.env.SEED_AUTOMATIONS_ENABLED;
    const seeder = createSchedulesSeeder([
      zeroConfigScheduleSource({ autoEnableCandidate: false }),
    ]);
    await runSeeder(seeder, { quiet: true });
    expect(await getScheduledTaskByName("test-zero-config-schedule")).toMatchObject({
      enabled: false,
    });
  });

  test("seeds a schedule with setup metadata and re-runs as a no-op", async () => {
    const seeder = createSchedulesSeeder([scheduleSource()]);
    const first = await runSeeder(seeder, { quiet: true });
    expect(first).toMatchObject({ created: 1, failed: [] });
    expect(await getScheduledTaskByName("test-seeded-schedule")).toMatchObject({
      targetType: "agent-task",
      cronExpression: "0 9 * * *",
      enabled: false,
      nextRunAt: undefined,
      params: {},
      requiredParams: ["REPO_URL"],
      requires: ["github"],
      tags: ["fixture"],
    });

    const second = await runSeeder(seeder, { quiet: true });
    expect(second).toMatchObject({ skippedUnchanged: 1, updated: 0, failed: [] });
  });

  test("keeps updating a schedule the operator enabled, and keeps it enabled", async () => {
    await runSeeder(createSchedulesSeeder([scheduleSource()]), { quiet: true });
    const seeded = await getScheduledTaskByName("test-seeded-schedule");
    await updateScheduledTask(seeded!.id, { enabled: true });

    const result = await runSeeder(createSchedulesSeeder([scheduleSource("30 9 * * *")]), {
      quiet: true,
    });
    expect(result).toMatchObject({ updated: 1, skippedUserModified: 0, failed: [] });
    const updated = await getScheduledTaskByName("test-seeded-schedule");
    expect(updated).toMatchObject({ enabled: true, cronExpression: "30 9 * * *" });
    // An enabled row gets a nextRunAt computed from the new cron.
    expect(updated?.nextRunAt).toBeDefined();
    expect(new Date(updated!.nextRunAt!).getUTCMinutes()).toBe(30);
  });

  test("an update keeps a disabled schedule disabled and does not schedule a run", async () => {
    await runSeeder(createSchedulesSeeder([scheduleSource()]), { quiet: true });

    const result = await runSeeder(createSchedulesSeeder([scheduleSource("30 9 * * *")]), {
      quiet: true,
    });
    expect(result).toMatchObject({ updated: 1, skippedUserModified: 0 });
    expect(await getScheduledTaskByName("test-seeded-schedule")).toMatchObject({
      enabled: false,
      cronExpression: "30 9 * * *",
      nextRunAt: undefined,
    });
  });

  test("an update keeps an auto-enabled schedule the operator disabled disabled", async () => {
    await runSeeder(createSchedulesSeeder([zeroConfigScheduleSource()]), { quiet: true });
    const seeded = await getScheduledTaskByName("test-zero-config-schedule");
    expect(seeded?.enabled).toBe(true);
    await updateScheduledTask(seeded!.id, { enabled: false });

    const changed = zeroConfigScheduleSource();
    changed.content = changed.content.replace("Run work.", "Run updated work.");
    const result = await runSeeder(createSchedulesSeeder([changed]), { quiet: true });
    expect(result).toMatchObject({ updated: 1, skippedUserModified: 0 });
    expect(await getScheduledTaskByName("test-zero-config-schedule")).toMatchObject({
      enabled: false,
      taskTemplate: "Run updated work.",
    });
  });

  describe("rows seeded under the legacy hash (enabled was hashed)", () => {
    test("(a) an unedited legacy row is rebaselined, and a later template change updates it", async () => {
      const row = await seedLegacySchedule();
      const seeder = createSchedulesSeeder([scheduleSource()]);
      const item = seeder.items()[0]!;

      const first = await runSeeder(seeder, { quiet: true });
      expect(first).toMatchObject({ skippedUnchanged: 1, rebaselined: 1, skippedUserModified: 0 });
      const recorded = (await getSeedState("schedule", item.key))?.seededHash;
      expect(recorded).toBe(item.contentHash);
      // Legacy -> new: the recorded hash is now a new-formula hash, which no
      // legacy-formula hash of the same row can equal.
      expect(legacyScheduleHashes(row)).not.toContain(recorded);

      const second = await runSeeder(createSchedulesSeeder([scheduleSource("30 9 * * *")]), {
        quiet: true,
      });
      expect(second).toMatchObject({ updated: 1, rebaselined: 0, skippedUserModified: 0 });
      expect((await getScheduledTaskByName("test-seeded-schedule"))?.cronExpression).toBe(
        "30 9 * * *",
      );
    });

    test("(b) a legacy row with only enabled toggled is pristine: it updates and stays enabled", async () => {
      const row = await seedLegacySchedule();
      await updateScheduledTask(row.id, { enabled: true });

      const result = await runSeeder(createSchedulesSeeder([scheduleSource("30 9 * * *")]), {
        quiet: true,
      });
      expect(result).toMatchObject({
        updated: 1,
        rebaselined: 1,
        skippedUserModified: 0,
        failed: [],
      });
      expect(await getScheduledTaskByName("test-seeded-schedule")).toMatchObject({
        enabled: true,
        cronExpression: "30 9 * * *",
      });
    });

    test("(c) a legacy row with a description edit is preserved", async () => {
      const row = await seedLegacySchedule();
      await updateScheduledTask(row.id, { description: "Operator description." });

      const result = await runSeeder(createSchedulesSeeder([scheduleSource("30 9 * * *")]), {
        quiet: true,
      });
      expect(result).toMatchObject({ skippedUserModified: 1, updated: 0, rebaselined: 0 });
      expect(await getScheduledTaskByName("test-seeded-schedule")).toMatchObject({
        description: "Operator description.",
        cronExpression: "0 9 * * *",
      });
    });

    test("(c) a legacy row with a task-template edit is preserved", async () => {
      const row = await seedLegacySchedule();
      await updateScheduledTask(row.id, { taskTemplate: "Operator prompt." });

      const result = await runSeeder(createSchedulesSeeder([scheduleSource("30 9 * * *")]), {
        quiet: true,
      });
      expect(result).toMatchObject({ skippedUserModified: 1, updated: 0, rebaselined: 0 });
      expect(await getScheduledTaskByName("test-seeded-schedule")).toMatchObject({
        taskTemplate: "Operator prompt.",
        cronExpression: "0 9 * * *",
      });
    });

    test("(d) a legacy row with a content edit plus an enabled toggle is preserved", async () => {
      const row = await seedLegacySchedule();
      await updateScheduledTask(row.id, { taskTemplate: "Operator prompt.", enabled: true });

      const result = await runSeeder(createSchedulesSeeder([scheduleSource("30 9 * * *")]), {
        quiet: true,
      });
      expect(result).toMatchObject({ skippedUserModified: 1, updated: 0, rebaselined: 0 });
      expect(await getScheduledTaskByName("test-seeded-schedule")).toMatchObject({
        enabled: true,
        taskTemplate: "Operator prompt.",
        cronExpression: "0 9 * * *",
      });
    });

    test("new -> legacy: a rebaselined row edited later is preserved, never matched as legacy", async () => {
      await seedLegacySchedule();
      await runSeeder(createSchedulesSeeder([scheduleSource()]), { quiet: true }); // rebaseline
      const rebaselined = await getScheduledTaskByName("test-seeded-schedule");
      await updateScheduledTask(rebaselined!.id, { description: "Edited after rebaseline." });

      const result = await runSeeder(createSchedulesSeeder([scheduleSource("30 9 * * *")]), {
        quiet: true,
      });
      expect(result).toMatchObject({ skippedUserModified: 1, updated: 0, rebaselined: 0 });
      expect((await getScheduledTaskByName("test-seeded-schedule"))?.description).toBe(
        "Edited after rebaseline.",
      );
    });
  });

  test("(e) a schedule with filled params is still preserved", async () => {
    await runSeeder(createSchedulesSeeder([scheduleSource()]), { quiet: true });
    const seeded = await getScheduledTaskByName("test-seeded-schedule");
    await updateScheduledTask(seeded!.id, {
      params: { REPO_URL: "https://example.com/repo.git" },
      enabled: true,
    });

    const result = await runSeeder(createSchedulesSeeder([scheduleSource("30 9 * * *")]), {
      quiet: true,
    });
    expect(result).toMatchObject({ skippedUserModified: 1, updated: 0 });
    expect(await getScheduledTaskByName("test-seeded-schedule")).toMatchObject({
      params: { REPO_URL: "https://example.com/repo.git" },
      cronExpression: "0 9 * * *",
    });
  });

  test("(f) flipping SEED_AUTOMATIONS_ENABLED changes no hash", async () => {
    delete process.env.SEED_AUTOMATIONS_ENABLED;
    const on = createSchedulesSeeder([zeroConfigScheduleSource()]).items()[0]!;
    process.env.SEED_AUTOMATIONS_ENABLED = "false";
    const off = createSchedulesSeeder([zeroConfigScheduleSource()]).items()[0]!;
    // Control: the switch does change the create-time enabled value.
    expect(on.schedule.enabled).toBe(true);
    expect(off.schedule.enabled).toBe(false);
    expect(off.contentHash).toBe(on.contentHash);

    // A row seeded with the switch on stays in sync after the switch flips.
    delete process.env.SEED_AUTOMATIONS_ENABLED;
    await runSeeder(createSchedulesSeeder([zeroConfigScheduleSource()]), { quiet: true });
    process.env.SEED_AUTOMATIONS_ENABLED = "false";
    const result = await runSeeder(createSchedulesSeeder([zeroConfigScheduleSource()]), {
      quiet: true,
    });
    expect(result).toMatchObject({ skippedUnchanged: 1, skippedUserModified: 0 });
    expect((await getScheduledTaskByName("test-zero-config-schedule"))?.enabled).toBe(true);
  });

  test("updates a pristine schedule when its template changes", async () => {
    await runSeeder(createSchedulesSeeder([scheduleSource()]), { quiet: true });
    const result = await runSeeder(createSchedulesSeeder([scheduleSource("30 9 * * *")]), {
      quiet: true,
    });
    expect(result).toMatchObject({ updated: 1, failed: [] });
    expect((await getScheduledTaskByName("test-seeded-schedule"))?.cronExpression).toBe(
      "30 9 * * *",
    );
  });

  test("reports an invalid cron without creating a row", async () => {
    const result = await runSeeder(createSchedulesSeeder([scheduleSource("not a cron")]), {
      quiet: true,
    });
    expect(result.created).toBe(0);
    expect(result.failed[0]).toMatchObject({ key: "test-seeded-schedule" });
    expect(await getScheduledTaskByName("test-seeded-schedule")).toBeNull();
  });
});

describe("workflow-target seeded schedules", () => {
  test("the dreaming-nightly template targets the dreaming workflow and carries no prompt", () => {
    const schedule = loadSeedSchedules().find((item) => item.name === "dreaming-nightly");
    expect(schedule).toMatchObject({
      cronExpression: "25 3 * * *",
      timezone: "UTC",
      enabled: true,
      workflow: "dreaming",
      taskTemplate: "",
      requires: [],
      requiredParams: [],
    });
  });

  test("agent-task schedules carry no workflow key", () => {
    for (const schedule of loadSeedSchedules().filter((s) => s.name !== "dreaming-nightly")) {
      expect(schedule).not.toHaveProperty("workflow");
    }
  });

  test("the dreaming-nightly template seeds a workflow target with the dreaming id", async () => {
    const workflow = await createFixtureWorkflow();
    const result = await runSeeder(createSchedulesSeeder(), { quiet: true });
    expect(result.failed).toEqual([]);
    const row = await getScheduledTaskByName("dreaming-nightly");
    expect(row).toMatchObject({
      targetType: "workflow",
      workflowId: workflow.id,
      cronExpression: "25 3 * * *",
      enabled: true,
    });
    expect(row?.taskTemplate ?? null).toBeNull();
    expect(row?.nextRunAt).toBeDefined();
  });

  test("creates a workflow-target schedule, and a re-run is a no-op", async () => {
    const workflow = await createFixtureWorkflow();
    const seeder = createSchedulesSeeder([workflowScheduleSource()]);

    expect(await runSeeder(seeder, { quiet: true })).toMatchObject({ created: 1, failed: [] });
    const row = await getScheduledTaskByName("test-workflow-schedule");
    expect(row).toMatchObject({ targetType: "workflow", workflowId: workflow.id });
    expect(row?.taskTemplate ?? null).toBeNull();

    expect(await runSeeder(seeder, { quiet: true })).toMatchObject({
      created: 0,
      updated: 0,
      skippedUnchanged: 1,
      skippedUserModified: 0,
      failed: [],
    });
    expect(await getScheduledTaskByName("test-workflow-schedule")).toEqual(row);
  });

  test("the hash is stable across a workflow id change (delete and re-seed)", async () => {
    const original = await createFixtureWorkflow();
    const seeder = createSchedulesSeeder([workflowScheduleSource()]);
    await runSeeder(seeder, { quiet: true });
    const seeded = await getSeedState("schedule", "test-workflow-schedule");

    // The operator deletes the workflow; the workflows seeder re-creates it
    // under a new id on the next boot.
    expect(await deleteWorkflow(original.id)).toBe(true);
    const reseeded = await createFixtureWorkflow();
    expect(reseeded.id).not.toBe(original.id);

    expect(await runSeeder(seeder, { quiet: true })).toMatchObject({
      created: 0,
      updated: 0,
      skippedUnchanged: 1,
      skippedUserModified: 0,
      failed: [],
    });
    expect(await getSeedState("schedule", "test-workflow-schedule")).toMatchObject({
      seededHash: seeded!.seededHash,
    });
    // The dangling binding is repointed at the live workflow.
    expect(await getScheduledTaskByName("test-workflow-schedule")).toMatchObject({
      targetType: "workflow",
      workflowId: reseeded.id,
    });
  });

  test("an edited workflow-target schedule is still preserved", async () => {
    await createFixtureWorkflow();
    await runSeeder(createSchedulesSeeder([workflowScheduleSource()]), { quiet: true });
    const row = (await getScheduledTaskByName("test-workflow-schedule"))!;
    await updateScheduledTask(row.id, { cronExpression: "0 5 * * *" });

    const result = await runSeeder(
      createSchedulesSeeder([workflowScheduleSource("dreaming", "30 3 * * *")]),
      { quiet: true },
    );
    expect(result).toMatchObject({ updated: 0, skippedUserModified: 1, failed: [] });
    expect(await getScheduledTaskByName("test-workflow-schedule")).toMatchObject({
      cronExpression: "0 5 * * *",
    });
  });

  test("an unknown workflow is reported in failed[], not thrown, and writes no row", async () => {
    const result = await runSeeder(createSchedulesSeeder([workflowScheduleSource("no-such")]), {
      quiet: true,
    });
    expect(result).toMatchObject({ created: 0 });
    expect(result.failed).toEqual([
      { key: "test-workflow-schedule", error: 'workflow "no-such" not found' },
    ]);
    expect(await getScheduledTaskByName("test-workflow-schedule")).toBeNull();
  });

  test("a seeded workflow the operator deleted fails the item and leaves the row alone", async () => {
    const workflow = await createFixtureWorkflow();
    const seeder = createSchedulesSeeder([workflowScheduleSource()]);
    await runSeeder(seeder, { quiet: true });
    const row = await getScheduledTaskByName("test-workflow-schedule");
    await deleteWorkflow(workflow.id);

    const result = await runSeeder(seeder, { quiet: true });
    expect(result.failed).toEqual([
      { key: "test-workflow-schedule", error: 'workflow "dreaming" not found' },
    ]);
    expect(await getScheduledTaskByName("test-workflow-schedule")).toEqual(row);
  });

  test("a template that switches an agent-task schedule to a workflow drops the prompt", async () => {
    const workflow = await createFixtureWorkflow();
    const agentTask = zeroConfigScheduleSource({ name: "test-workflow-schedule" });
    await runSeeder(createSchedulesSeeder([agentTask]), { quiet: true });
    expect((await getScheduledTaskByName("test-workflow-schedule"))?.taskTemplate).toBe(
      "Run work.",
    );

    const seeder = createSchedulesSeeder([workflowScheduleSource()]);
    expect(await runSeeder(seeder, { quiet: true })).toMatchObject({ updated: 1, failed: [] });
    const row = await getScheduledTaskByName("test-workflow-schedule");
    expect(row).toMatchObject({ targetType: "workflow", workflowId: workflow.id });
    expect(row?.taskTemplate || null).toBeNull();
    expect(await runSeeder(seeder, { quiet: true })).toMatchObject({ skippedUnchanged: 1 });
  });
});
