import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, computeContentHash, initDb, listWorkflows, updateWorkflow } from "../be/db";
import { getSeedState, recordSeedState, runSeeder } from "../be/seed";
import {
  canonicalJson,
  createWorkflowsSeeder,
  loadSeedWorkflows,
  type WorkflowTemplateSource,
} from "../be/seed/workflows-seeder";
import type { Workflow } from "../types";

const TEST_DB_PATH = "./test-seed-workflows.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function workflowSource(template = "Do the work.", description = "Seeded workflow.") {
  return {
    config: JSON.stringify({
      name: "test-seeded-workflow",
      description,
      placeholders: ["REPO_URL"],
      requires: ["github"],
      runAllSeedersCandidate: true,
    }),
    content: `# Test\n\n\`\`\`json\n${JSON.stringify({
      nodes: [{ id: "work", type: "agent-task", config: { template } }],
    })}\n\`\`\``,
  } satisfies WorkflowTemplateSource;
}

/** A zero-config candidate: no requires, no placeholders — eligible for auto-enable. */
function zeroConfigWorkflowSource(opts?: {
  name?: string;
  templateEnabled?: boolean;
  autoEnableCandidate?: boolean;
}) {
  const name = opts?.name ?? "test-zero-config-workflow";
  const payloadEnabled = opts?.templateEnabled === false ? { enabled: false } : {};
  return {
    config: JSON.stringify({
      name,
      description: "Zero-config seeded workflow.",
      placeholders: [],
      requires: [],
      runAllSeedersCandidate: true,
      autoEnableCandidate: opts?.autoEnableCandidate ?? true,
    }),
    content: `# Test\n\n\`\`\`json\n${JSON.stringify({
      nodes: [{ id: "work", type: "agent-task", config: { template: "Do the work." } }],
      ...payloadEnabled,
    })}\n\`\`\``,
  } satisfies WorkflowTemplateSource;
}

async function getWorkflow(name = "test-seeded-workflow") {
  return (await listWorkflows()).find((workflow) => workflow.name === name) ?? null;
}

const EDITED_DEFINITION = {
  nodes: [{ id: "ui-edit", type: "agent-task", config: { template: "Edited." } }],
  onNodeFailure: "fail" as const,
};

/**
 * Local copy of the seed hash shape from before `enabled` left the hash: the
 * hashed fields of the row plus `enabled`. Deliberately not imported from the
 * seeder, so these fixtures keep the old formula even if the seeder changes.
 */
function legacyWorkflowHash(row: Workflow, enabled: boolean): string {
  const hashed = {
    name: row.name,
    description: row.description ?? "",
    definition: row.definition,
    triggers: row.triggers,
    cooldown: row.cooldown,
    input: row.input,
    triggerSchema: row.triggerSchema,
    params: row.params ?? {},
    requiredParams: row.requiredParams ?? [],
    requires: row.requires ?? [],
  };
  return computeContentHash(canonicalJson({ ...hashed, enabled }));
}

function legacyWorkflowHashes(row: Workflow): string[] {
  return [legacyWorkflowHash(row, true), legacyWorkflowHash(row, false)];
}

/**
 * Seed `source` and then rewrite its seed_state the way the pre-fix seeder
 * recorded it: the legacy-formula hash, including the row's create-time
 * `enabled`. Returns the row as seeded.
 */
async function seedLegacyWorkflow(source = workflowSource()): Promise<Workflow> {
  await runSeeder(createWorkflowsSeeder([source]), { quiet: true });
  const row = (await getWorkflow(JSON.parse(source.config).name))!;
  await recordSeedState("workflow", row.name, legacyWorkflowHash(row, row.enabled));
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

describe("workflows seeder", () => {
  test("loads all eleven workflow templates with their setup metadata", () => {
    const workflows = loadSeedWorkflows();
    expect(workflows).toHaveLength(11);
    expect(workflows.find((workflow) => workflow.name === "autopilot")).toMatchObject({
      enabled: false,
      requiredParams: ["REPO_URL"],
      requires: ["github"],
    });
    expect(
      workflows.find((workflow) => workflow.name === "claude-code-changelog-watch"),
    ).toMatchObject({
      enabled: false,
      requiredParams: [],
      requires: [],
    });
    expect(workflows.find((workflow) => workflow.name === "gsc-topic-miner")).toMatchObject({
      enabled: false,
      requiredParams: ["GSC_PROPERTY"],
      requires: ["gsc", "agentfs"],
    });
    // dreaming is the one zero-config auto-enable candidate: the workflow arrives
    // enabled and DREAMING_ENABLED (default false) is its real switch.
    expect(workflows.find((workflow) => workflow.name === "dreaming")).toMatchObject({
      enabled: true,
      requiredParams: [],
      requires: [],
    });
    expect(
      workflows.filter((workflow) => workflow.name !== "dreaming").every((w) => !w.enabled),
    ).toBe(true);
  });

  test("SEED_AUTOMATIONS_ENABLED=false still seeds all workflows disabled", async () => {
    process.env.SEED_AUTOMATIONS_ENABLED = "false";
    const result = await runSeeder(createWorkflowsSeeder(), { quiet: true });
    expect(result).toMatchObject({ created: 11, failed: [] });
    const workflows = await listWorkflows();
    expect(workflows).toHaveLength(11);
    expect(workflows.every((workflow) => workflow.enabled === false)).toBe(true);
  });

  test("switch on: a zero-config candidate auto-enables via createWorkflowsSeeder/apply", async () => {
    delete process.env.SEED_AUTOMATIONS_ENABLED;
    const seeder = createWorkflowsSeeder([zeroConfigWorkflowSource()]);
    await runSeeder(seeder, { quiet: true });
    expect(await getWorkflow("test-zero-config-workflow")).toMatchObject({ enabled: true });
  });

  test("switch on: an item with unmet requires stays disabled", async () => {
    delete process.env.SEED_AUTOMATIONS_ENABLED;
    const seeder = createWorkflowsSeeder([workflowSource()]);
    await runSeeder(seeder, { quiet: true });
    expect(await getWorkflow()).toMatchObject({ enabled: false });
  });

  test("switch off: a zero-config candidate stays disabled", async () => {
    process.env.SEED_AUTOMATIONS_ENABLED = "false";
    const seeder = createWorkflowsSeeder([zeroConfigWorkflowSource()]);
    await runSeeder(seeder, { quiet: true });
    expect(await getWorkflow("test-zero-config-workflow")).toMatchObject({ enabled: false });
  });

  test("switch on: a zero-config candidate whose template recommends staying off stays disabled", async () => {
    delete process.env.SEED_AUTOMATIONS_ENABLED;
    const seeder = createWorkflowsSeeder([zeroConfigWorkflowSource({ templateEnabled: false })]);
    await runSeeder(seeder, { quiet: true });
    expect(await getWorkflow("test-zero-config-workflow")).toMatchObject({ enabled: false });
  });

  test("switch on: a zero-config candidate without an explicit autoEnableCandidate opt-in stays disabled", async () => {
    delete process.env.SEED_AUTOMATIONS_ENABLED;
    const seeder = createWorkflowsSeeder([
      zeroConfigWorkflowSource({ autoEnableCandidate: false }),
    ]);
    await runSeeder(seeder, { quiet: true });
    expect(await getWorkflow("test-zero-config-workflow")).toMatchObject({ enabled: false });
  });

  test("seeds a workflow and re-runs as a no-op", async () => {
    const seeder = createWorkflowsSeeder([workflowSource()]);
    const first = await runSeeder(seeder, { quiet: true });
    expect(first).toMatchObject({ created: 1, failed: [] });
    expect(await getWorkflow()).toMatchObject({
      name: "test-seeded-workflow",
      enabled: false,
      params: {},
      requiredParams: ["REPO_URL"],
      requires: ["github"],
    });

    const second = await runSeeder(seeder, { quiet: true });
    expect(second).toMatchObject({ skippedUnchanged: 1, updated: 0, failed: [] });
  });

  test("keeps updating a workflow the operator enabled, and keeps it enabled", async () => {
    await runSeeder(createWorkflowsSeeder([workflowSource()]), { quiet: true });
    const seeded = await getWorkflow();
    await updateWorkflow(seeded!.id, { enabled: true });

    const result = await runSeeder(createWorkflowsSeeder([workflowSource("Source update.")]), {
      quiet: true,
    });
    expect(result).toMatchObject({ updated: 1, skippedUserModified: 0, failed: [] });
    expect(await getWorkflow()).toMatchObject({
      enabled: true,
      definition: {
        nodes: [{ id: "work", type: "agent-task", config: { template: "Source update." } }],
        onNodeFailure: "fail",
      },
    });
  });

  test("an update keeps a disabled workflow disabled", async () => {
    await runSeeder(createWorkflowsSeeder([zeroConfigWorkflowSource()]), { quiet: true });
    const seeded = await getWorkflow("test-zero-config-workflow");
    expect(seeded?.enabled).toBe(true);
    await updateWorkflow(seeded!.id, { enabled: false });

    const changed = zeroConfigWorkflowSource();
    changed.content = changed.content.replace("Do the work.", "Source update.");
    const result = await runSeeder(createWorkflowsSeeder([changed]), { quiet: true });
    expect(result).toMatchObject({ updated: 1, skippedUserModified: 0 });
    const updated = await getWorkflow("test-zero-config-workflow");
    expect(updated?.enabled).toBe(false);
    expect(updated?.definition.nodes[0]?.config.template).toBe("Source update.");
  });

  describe("rows seeded under the legacy hash (enabled was hashed)", () => {
    test("(a) an unedited legacy row is rebaselined, and a later template change updates it", async () => {
      const row = await seedLegacyWorkflow();
      const seeder = createWorkflowsSeeder([workflowSource()]);
      const item = seeder.items()[0]!;

      const first = await runSeeder(seeder, { quiet: true });
      expect(first).toMatchObject({ skippedUnchanged: 1, rebaselined: 1, skippedUserModified: 0 });
      const recorded = (await getSeedState("workflow", item.key))?.seededHash;
      expect(recorded).toBe(item.contentHash);
      // Legacy -> new: the recorded hash is now a new-formula hash, which no
      // legacy-formula hash of the same row can equal.
      expect(legacyWorkflowHashes(row)).not.toContain(recorded);

      const second = await runSeeder(createWorkflowsSeeder([workflowSource("Source update.")]), {
        quiet: true,
      });
      expect(second).toMatchObject({ updated: 1, rebaselined: 0, skippedUserModified: 0 });
      expect((await getWorkflow())?.definition.nodes[0]?.config.template).toBe("Source update.");
    });

    test("(b) a legacy row with only enabled toggled is pristine: it updates and stays enabled", async () => {
      const row = await seedLegacyWorkflow();
      await updateWorkflow(row.id, { enabled: true });

      const result = await runSeeder(createWorkflowsSeeder([workflowSource("Source update.")]), {
        quiet: true,
      });
      expect(result).toMatchObject({
        updated: 1,
        rebaselined: 1,
        skippedUserModified: 0,
        failed: [],
      });
      const updated = await getWorkflow();
      expect(updated?.enabled).toBe(true);
      expect(updated?.definition.nodes[0]?.config.template).toBe("Source update.");
    });

    test("(c) a legacy row with a description edit is preserved", async () => {
      const row = await seedLegacyWorkflow();
      await updateWorkflow(row.id, { description: "Operator description." });

      const result = await runSeeder(createWorkflowsSeeder([workflowSource("Source update.")]), {
        quiet: true,
      });
      expect(result).toMatchObject({ skippedUserModified: 1, updated: 0, rebaselined: 0 });
      const kept = await getWorkflow();
      expect(kept?.description).toBe("Operator description.");
      expect(kept?.definition.nodes[0]?.config.template).toBe("Do the work.");
    });

    test("(c) a legacy row with a definition edit is preserved", async () => {
      const row = await seedLegacyWorkflow();
      await updateWorkflow(row.id, { definition: EDITED_DEFINITION });

      const result = await runSeeder(createWorkflowsSeeder([workflowSource("Source update.")]), {
        quiet: true,
      });
      expect(result).toMatchObject({ skippedUserModified: 1, updated: 0, rebaselined: 0 });
      expect((await getWorkflow())?.definition.nodes[0]?.id).toBe("ui-edit");
    });

    test("(d) a legacy row with a content edit plus an enabled toggle is preserved", async () => {
      const row = await seedLegacyWorkflow();
      await updateWorkflow(row.id, { definition: EDITED_DEFINITION, enabled: true });

      const result = await runSeeder(createWorkflowsSeeder([workflowSource("Source update.")]), {
        quiet: true,
      });
      expect(result).toMatchObject({ skippedUserModified: 1, updated: 0, rebaselined: 0 });
      const kept = await getWorkflow();
      expect(kept?.enabled).toBe(true);
      expect(kept?.definition.nodes[0]?.id).toBe("ui-edit");
    });

    test("new -> legacy: a rebaselined row edited later is preserved, never matched as legacy", async () => {
      await seedLegacyWorkflow();
      await runSeeder(createWorkflowsSeeder([workflowSource()]), { quiet: true }); // rebaseline
      const rebaselined = await getWorkflow();
      await updateWorkflow(rebaselined!.id, { description: "Edited after rebaseline." });

      const result = await runSeeder(createWorkflowsSeeder([workflowSource("Source update.")]), {
        quiet: true,
      });
      expect(result).toMatchObject({ skippedUserModified: 1, updated: 0, rebaselined: 0 });
      expect((await getWorkflow())?.description).toBe("Edited after rebaseline.");
    });
  });

  test("(e) a workflow with filled params is still preserved", async () => {
    await runSeeder(createWorkflowsSeeder([workflowSource()]), { quiet: true });
    const seeded = await getWorkflow();
    await updateWorkflow(seeded!.id, {
      params: { REPO_URL: "https://example.com/repo.git" },
      enabled: true,
    });

    const result = await runSeeder(createWorkflowsSeeder([workflowSource("Source update.")]), {
      quiet: true,
    });
    expect(result).toMatchObject({ skippedUserModified: 1, updated: 0 });
    const kept = await getWorkflow();
    expect(kept?.params).toEqual({ REPO_URL: "https://example.com/repo.git" });
    expect(kept?.definition.nodes[0]?.config.template).toBe("Do the work.");
  });

  test("(f) flipping SEED_AUTOMATIONS_ENABLED changes no hash", async () => {
    delete process.env.SEED_AUTOMATIONS_ENABLED;
    const on = createWorkflowsSeeder([zeroConfigWorkflowSource()]).items()[0]!;
    process.env.SEED_AUTOMATIONS_ENABLED = "false";
    const off = createWorkflowsSeeder([zeroConfigWorkflowSource()]).items()[0]!;
    // Control: the switch does change the create-time enabled value.
    expect(on.workflow.enabled).toBe(true);
    expect(off.workflow.enabled).toBe(false);
    expect(off.contentHash).toBe(on.contentHash);

    // A row seeded with the switch on stays in sync after the switch flips.
    delete process.env.SEED_AUTOMATIONS_ENABLED;
    await runSeeder(createWorkflowsSeeder([zeroConfigWorkflowSource()]), { quiet: true });
    process.env.SEED_AUTOMATIONS_ENABLED = "false";
    const result = await runSeeder(createWorkflowsSeeder([zeroConfigWorkflowSource()]), {
      quiet: true,
    });
    expect(result).toMatchObject({ skippedUnchanged: 1, skippedUserModified: 0 });
    expect((await getWorkflow("test-zero-config-workflow"))?.enabled).toBe(true);
  });

  test("preserves a workflow edited by the operator", async () => {
    await runSeeder(createWorkflowsSeeder([workflowSource()]), { quiet: true });
    const seeded = await getWorkflow();
    await updateWorkflow(seeded!.id, {
      definition: {
        nodes: [{ id: "ui-edit", type: "agent-task", config: { template: "Edited." } }],
        onNodeFailure: "fail",
      },
    });

    const result = await runSeeder(createWorkflowsSeeder([workflowSource("Source update.")]), {
      quiet: true,
    });
    expect(result.skippedUserModified).toBe(1);
    expect((await getWorkflow())?.definition.nodes[0]?.id).toBe("ui-edit");
  });

  test("updates a pristine workflow when its template changes", async () => {
    await runSeeder(createWorkflowsSeeder([workflowSource()]), { quiet: true });
    const result = await runSeeder(createWorkflowsSeeder([workflowSource("Source update.")]), {
      quiet: true,
    });
    expect(result).toMatchObject({ updated: 1, failed: [] });
    expect((await getWorkflow())?.definition.nodes[0]?.config.template).toBe("Source update.");
  });

  test("records the template hash after a successful seed", async () => {
    const seeder = createWorkflowsSeeder([workflowSource()]);
    const item = seeder.items()[0]!;
    await runSeeder(seeder, { quiet: true });
    expect((await getSeedState("workflow", item.key))?.seededHash).toBe(item.contentHash);
  });
});
