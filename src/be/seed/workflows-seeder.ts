import alertsTriageConfig from "../../../templates/workflows/alerts-triage/config.json" with {
  type: "text",
};
import alertsTriageContent from "../../../templates/workflows/alerts-triage/content.md" with {
  type: "text",
};
import autopilotConfig from "../../../templates/workflows/autopilot/config.json" with {
  type: "text",
};
import autopilotContent from "../../../templates/workflows/autopilot/content.md" with {
  type: "text",
};
import claudeCodeChangelogWatchConfig from "../../../templates/workflows/claude-code-changelog-watch/config.json" with {
  type: "text",
};
import claudeCodeChangelogWatchContent from "../../../templates/workflows/claude-code-changelog-watch/content.md" with {
  type: "text",
};
import competitorRadarConfig from "../../../templates/workflows/competitor-radar/config.json" with {
  type: "text",
};
import competitorRadarContent from "../../../templates/workflows/competitor-radar/content.md" with {
  type: "text",
};
import docsSiteReleasesConfig from "../../../templates/workflows/docs-site-releases/config.json" with {
  type: "text",
};
import docsSiteReleasesContent from "../../../templates/workflows/docs-site-releases/content.md" with {
  type: "text",
};
import dreamingConfig from "../../../templates/workflows/dreaming/config.json" with {
  type: "text",
};
import dreamingContent from "../../../templates/workflows/dreaming/content.md" with {
  type: "text",
};
import gscTopicMinerConfig from "../../../templates/workflows/gsc-topic-miner/config.json" with {
  type: "text",
};
import gscTopicMinerContent from "../../../templates/workflows/gsc-topic-miner/content.md" with {
  type: "text",
};
import linearDrainLoopConfig from "../../../templates/workflows/linear-drain-loop/config.json" with {
  type: "text",
};
import linearDrainLoopContent from "../../../templates/workflows/linear-drain-loop/content.md" with {
  type: "text",
};
import llmSafeReleaseContextConfig from "../../../templates/workflows/llm-safe-release-context/config.json" with {
  type: "text",
};
import llmSafeReleaseContextContent from "../../../templates/workflows/llm-safe-release-context/content.md" with {
  type: "text",
};
import prReviewStatusSweepConfig from "../../../templates/workflows/pr-review-status-sweep/config.json" with {
  type: "text",
};
import prReviewStatusSweepContent from "../../../templates/workflows/pr-review-status-sweep/content.md" with {
  type: "text",
};
import ralphLoopConfig from "../../../templates/workflows/ralph-loop/config.json" with {
  type: "text",
};
import ralphLoopContent from "../../../templates/workflows/ralph-loop/content.md" with {
  type: "text",
};
import type {
  AutomationIntegrationId,
  CooldownConfig,
  InputValue,
  TriggerConfig,
  Workflow,
  WorkflowDefinition,
} from "../../types";
import { validateDefinition } from "../../workflows/definition";
import {
  computeContentHash,
  createWorkflow,
  getLeadAgent,
  listWorkflows,
  updateWorkflow,
} from "../db";
import { resolveSeededEnabled } from "./automation-toggle";
import { getSeedState } from "./state-db";
import type { Seeder, SeedItem } from "./types";

type AutomationTemplateConfig = {
  name: string;
  description: string;
  placeholders?: string[];
  requires?: AutomationIntegrationId[];
  runAllSeedersCandidate?: boolean;
  /** Explicit, reviewed opt-in into the auto-enable policy — see ./automation-toggle. */
  autoEnableCandidate?: boolean;
  /**
   * Principal for the seeded workflow's script nodes. A seeded row has no
   * `createdByAgentId` and scheduled triggers carry no agent, so without this
   * scripts run as the literal `workflow`, which privileged writes refuse.
   * `"lead"` resolves the current Lead at run time. See {@link resolveSeededWorkflowPrincipal}.
   */
  runAs?: "lead";
};

type WorkflowTemplatePayload = {
  nodes: WorkflowDefinition["nodes"];
  onNodeFailure?: WorkflowDefinition["onNodeFailure"];
  enabled?: boolean;
  triggers?: TriggerConfig[];
  cooldown?: CooldownConfig;
  input?: Record<string, InputValue>;
  triggerSchema?: Record<string, unknown>;
};

export type SeedWorkflow = {
  name: string;
  description: string;
  enabled: boolean;
  definition: WorkflowDefinition;
  triggers: TriggerConfig[];
  cooldown?: CooldownConfig;
  input?: Record<string, InputValue>;
  triggerSchema?: Record<string, unknown>;
  params: Record<string, unknown>;
  requiredParams: string[];
  requires: AutomationIntegrationId[];
};

export type WorkflowTemplateSource = { config: string; content: string };
type WorkflowSeedItem = SeedItem & { workflow: SeedWorkflow };

const asText = (value: unknown): string => value as string;

const BUILT_IN_WORKFLOW_SOURCES: readonly WorkflowTemplateSource[] = [
  { config: asText(alertsTriageConfig), content: asText(alertsTriageContent) },
  { config: asText(autopilotConfig), content: asText(autopilotContent) },
  {
    config: asText(claudeCodeChangelogWatchConfig),
    content: asText(claudeCodeChangelogWatchContent),
  },
  { config: asText(competitorRadarConfig), content: asText(competitorRadarContent) },
  { config: asText(docsSiteReleasesConfig), content: asText(docsSiteReleasesContent) },
  { config: asText(dreamingConfig), content: asText(dreamingContent) },
  { config: asText(gscTopicMinerConfig), content: asText(gscTopicMinerContent) },
  { config: asText(linearDrainLoopConfig), content: asText(linearDrainLoopContent) },
  { config: asText(llmSafeReleaseContextConfig), content: asText(llmSafeReleaseContextContent) },
  { config: asText(prReviewStatusSweepConfig), content: asText(prReviewStatusSweepContent) },
  { config: asText(ralphLoopConfig), content: asText(ralphLoopContent) },
];

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

/** Deterministic JSON representation used by workflow and schedule seed hashes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function parseWorkflowSource(source: WorkflowTemplateSource): SeedWorkflow | null {
  const config = JSON.parse(source.config) as AutomationTemplateConfig;
  if (!config.runAllSeedersCandidate) return null;

  const match = source.content.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match?.[1]) throw new Error(`Workflow template ${config.name} has no JSON definition`);
  const payload = JSON.parse(match[1]) as WorkflowTemplatePayload;

  const requires = config.requires ?? [];
  const requiredParams = config.placeholders ?? [];
  return {
    name: config.name,
    description: config.description,
    // Boot seeding always inventories the automation. Whether it also arrives
    // enabled is gated by the operator switch (SEED_AUTOMATIONS_ENABLED), the
    // item being zero-config (no requires/placeholders), the template's own
    // explicit autoEnableCandidate opt-in, and the template not explicitly
    // recommending it stay off. See ./automation-toggle.
    enabled: resolveSeededEnabled({
      requires,
      requiredParams,
      autoEnableCandidate: config.autoEnableCandidate === true,
      templateRecommendsEnabled: payload.enabled !== false,
    }),
    definition: {
      nodes: payload.nodes,
      onNodeFailure: payload.onNodeFailure ?? "fail",
    },
    triggers: payload.triggers ?? [],
    cooldown: payload.cooldown,
    input: payload.input,
    triggerSchema: payload.triggerSchema,
    params: {},
    requiredParams,
    requires,
  };
}

export function loadSeedWorkflows(
  sources: readonly WorkflowTemplateSource[] = BUILT_IN_WORKFLOW_SOURCES,
): SeedWorkflow[] {
  return sources
    .map(parseWorkflowSource)
    .filter((workflow): workflow is SeedWorkflow => workflow !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The part of a seeded workflow that the seed hash covers. `enabled` is left
 * out on purpose: it is an operator switch, not content. Toggling it must not
 * mark the row as user-edited, and flipping SEED_AUTOMATIONS_ENABLED must not
 * change any source hash.
 */
type HashedSeedWorkflow = Omit<SeedWorkflow, "enabled">;

function hashedWorkflow(workflow: SeedWorkflow): HashedSeedWorkflow {
  const { enabled: _enabled, ...hashed } = workflow;
  return hashed;
}

function workflowSeedHash(workflow: HashedSeedWorkflow): string {
  return computeContentHash(canonicalJson(workflow));
}

/**
 * Seed hashes recorded before `enabled` left the hash covered it. Return the
 * old-formula hash of the live row under both `enabled` values, so a row whose
 * only change is an `enabled` toggle still counts as pristine and is
 * rebaselined to the new formula.
 */
function legacyWorkflowSeedHashes(workflow: HashedSeedWorkflow): string[] {
  return [true, false].map((enabled) =>
    computeContentHash(canonicalJson({ ...workflow, enabled })),
  );
}

/** Names of seeded workflow templates that declare `runAs: "lead"`. Not part of the seed hash. */
export function seededLeadPrincipalWorkflowNames(
  sources: readonly WorkflowTemplateSource[] = BUILT_IN_WORKFLOW_SOURCES,
): Set<string> {
  const names = new Set<string>();
  for (const source of sources) {
    const config = JSON.parse(source.config) as AutomationTemplateConfig;
    if (config.runAllSeedersCandidate && config.runAs === "lead") names.add(config.name);
  }
  return names;
}

/**
 * The agent a seeded workflow's script nodes run as when the row has no
 * `createdByAgentId`: the current Lead, but only for a template that opts in
 * with `runAs: "lead"` and a row the seeder created or adopted (a `seed_state`
 * record exists). Returns undefined otherwise, or when no Lead is registered,
 * so the caller fails closed to its existing fallback.
 */
export async function resolveSeededWorkflowPrincipal(
  workflow: Pick<Workflow, "name">,
  sources: readonly WorkflowTemplateSource[] = BUILT_IN_WORKFLOW_SOURCES,
): Promise<string | undefined> {
  if (!seededLeadPrincipalWorkflowNames(sources).has(workflow.name)) return undefined;
  if (!(await getSeedState("workflow", workflow.name))) return undefined;
  return (await getLeadAgent())?.id ?? undefined;
}

async function findWorkflowByName(name: string): Promise<Workflow | null> {
  return (await listWorkflows()).find((workflow) => workflow.name === name) ?? null;
}

function workflowFromRow(workflow: Workflow): HashedSeedWorkflow {
  return {
    name: workflow.name,
    description: workflow.description ?? "",
    definition: workflow.definition,
    triggers: workflow.triggers,
    cooldown: workflow.cooldown,
    input: workflow.input,
    triggerSchema: workflow.triggerSchema,
    params: workflow.params ?? {},
    requiredParams: workflow.requiredParams ?? [],
    requires: workflow.requires ?? [],
  };
}

export function createWorkflowsSeeder(
  sources: readonly WorkflowTemplateSource[] = BUILT_IN_WORKFLOW_SOURCES,
): Seeder<WorkflowSeedItem> {
  const workflows = loadSeedWorkflows(sources);
  return {
    kind: "workflow",

    items(): WorkflowSeedItem[] {
      return workflows.map((workflow) => ({
        key: workflow.name,
        contentHash: workflowSeedHash(hashedWorkflow(workflow)),
        workflow,
      }));
    },

    async upstreamHash(item): Promise<string | null> {
      const existing = await findWorkflowByName(item.key);
      return existing ? workflowSeedHash(workflowFromRow(existing)) : null;
    },

    async legacyUpstreamHashes(item): Promise<string[]> {
      const existing = await findWorkflowByName(item.key);
      return existing ? legacyWorkflowSeedHashes(workflowFromRow(existing)) : [];
    },

    async apply(item): Promise<void> {
      const { workflow } = item;
      const validation = validateDefinition(workflow.definition);
      if (!validation.valid) {
        throw new Error(`Invalid workflow definition: ${validation.errors.join("; ")}`);
      }

      const data = {
        description: workflow.description,
        definition: workflow.definition,
        triggers: workflow.triggers,
        cooldown: workflow.cooldown,
        input: workflow.input,
        triggerSchema: workflow.triggerSchema,
        params: workflow.params,
        requiredParams: workflow.requiredParams,
        requires: workflow.requires,
      };
      const existing = await findWorkflowByName(workflow.name);
      if (!existing) {
        const created = await createWorkflow({ name: workflow.name, ...data });
        if (!workflow.enabled) await updateWorkflow(created.id, { enabled: false });
        return;
      }

      // `enabled` is the operator's switch: an update ships new content and
      // keeps whatever the row is set to.
      await updateWorkflow(existing.id, data);
    },
  };
}

export const workflowsSeeder = createWorkflowsSeeder();
