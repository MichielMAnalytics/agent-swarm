import { getSwarmConfigs } from "../be/db";
import { isSensitiveKey } from "../utils/secret-scrubber";

/**
 * `${ENV_VAR:-default}`: the env var when it is set and non-empty, else the
 * literal default (which may be empty). Checked before the plain `${ENV_VAR}`
 * form, whose broader pattern would otherwise capture the whole `NAME:-default`.
 */
const ENV_DEFAULT_PATTERN = /^\$\{([A-Z0-9_]+):-(.*)\}$/;
const ENV_PATTERN = /^\$\{(.+)\}$/;

/**
 * Return the env var name a `${NAME}` or `${NAME:-default}` reference points
 * at, or `undefined` when the value is not an env reference.
 */
function envReferenceName(value: string): string | undefined {
  return ENV_DEFAULT_PATTERN.exec(value)?.[1] ?? ENV_PATTERN.exec(value)?.[1];
}

/**
 * Resolve workflow input values.
 *
 * Patterns:
 *   - `${ENV_VAR:-default}` -> process.env[ENV_VAR] if set and non-empty, else `default`
 *   - `${ENV_VAR}` -> process.env[ENV_VAR] (throws when unset)
 *   - `secret.NAME` -> look up in DB config store (global scope, isSecret=true)
 *   - literal string -> pass through
 */
export async function resolveInputs(
  input: Record<string, string>,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  for (const [key, value] of Object.entries(input)) {
    resolved[key] = await resolveInputValue(value);
  }

  return resolved;
}

/**
 * Resolve a single input value, supporting `${ENV_VAR:-default}`,
 * `${ENV_VAR}` and `secret.NAME` references. A plain string is returned
 * unchanged. Throws if a referenced env var (without a default) or swarm
 * secret cannot be found.
 */
export async function resolveInputValue(value: string): Promise<string> {
  // Env var reference with a default: ${MY_VAR:-fallback}
  const defaultMatch = ENV_DEFAULT_PATTERN.exec(value);
  if (defaultMatch?.[1]) {
    const envValue = process.env[defaultMatch[1]];
    return envValue !== undefined && envValue !== "" ? envValue : (defaultMatch[2] ?? "");
  }

  // Env var reference: ${MY_VAR}
  const envMatch = ENV_PATTERN.exec(value);
  if (envMatch?.[1]) {
    const envName = envMatch[1];
    const envValue = process.env[envName];
    if (envValue === undefined) {
      throw new Error(`Environment variable "${envName}" is not set`);
    }
    return envValue;
  }

  // Secret reference: secret.NAME
  if (value.startsWith("secret.")) {
    const secretName = value.slice("secret.".length);
    const configs = await getSwarmConfigs({ scope: "global", key: secretName });
    const secretConfig = configs.find((c) => c.isSecret);
    if (!secretConfig) {
      throw new Error(`Secret "${secretName}" not found in config store`);
    }
    return secretConfig.value;
  }

  // Literal
  return value;
}

/**
 * Marker placed in persisted step inputs in place of a secret value.
 * Kept short and stable so future readers (logs, debug tools) can grep for it.
 */
export const REDACTED_SECRET_VALUE = "***REDACTED***";

/**
 * Determine which keys of a workflow's `input` map carry a secret value once
 * resolved. A key is treated as a secret iff it references either:
 *   - `secret.NAME` — always sensitive (DB-stored swarm secrets).
 *   - `${ENV_VAR}` or `${ENV_VAR:-default}` where ENV_VAR's name matches the
 *     secret-scrubber sensitive heuristic (`*_TOKEN`, `*_KEY`, `*_SECRET`,
 *     etc., or an explicit `SENSITIVE_KEY_EXACT` entry). Only the name part is
 *     checked, so a default never hides a sensitive name.
 *
 * Pure function — does NOT resolve values. Safe to call during recovery
 * without DB lookups.
 */
export function getSecretInputKeys(input: Record<string, string> | undefined): Set<string> {
  const keys = new Set<string>();
  if (!input) return keys;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") continue;
    if (value.startsWith("secret.")) {
      keys.add(key);
      continue;
    }
    const envName = envReferenceName(value);
    if (envName && isSensitiveKey(envName)) {
      keys.add(key);
    }
  }
  return keys;
}

/**
 * Return a shallow clone of `ctx` suitable for persistence to
 * `workflow_run_steps.input`, with `ctx.input[k]` replaced by
 * `REDACTED_SECRET_VALUE` for every k in `secretKeys`.
 *
 * The live `ctx` is not mutated — executors continue to see real values.
 * Only the persisted record is redacted, eliminating the leak surface that
 * `get-workflow-run` and any other reader of `workflow_run_steps` exposes.
 *
 * Empty secretKeys → returns `ctx` unchanged (no allocation).
 */
export function redactSecretsForStorage(
  ctx: Record<string, unknown>,
  secretKeys: Set<string>,
): Record<string, unknown> {
  if (secretKeys.size === 0) return ctx;
  const inputBlock = ctx.input;
  if (!inputBlock || typeof inputBlock !== "object") return ctx;
  const redactedInput: Record<string, unknown> = { ...(inputBlock as Record<string, unknown>) };
  let touched = false;
  for (const key of secretKeys) {
    if (key in redactedInput) {
      redactedInput[key] = REDACTED_SECRET_VALUE;
      touched = true;
    }
  }
  if (!touched) return ctx;
  return { ...ctx, input: redactedInput };
}
