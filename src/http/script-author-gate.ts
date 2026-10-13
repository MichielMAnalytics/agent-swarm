import type { IncomingMessage, ServerResponse } from "node:http";
import { userHasExplicitVerb } from "../be/rbac-roles";
import { can } from "../rbac";
import { getRequestAuth } from "../utils/request-auth-context";
import { requestPrincipal } from "./request-principal";
import { jsonError } from "./utils";

export const SCRIPT_AUTHOR_DENIED =
  "Forbidden: this user needs the script.author permission (grant it with the built-in script-author role)";

/**
 * Whether the request's own principal may author script code: run inline source, save a script,
 * launch a durable run, or expose a script as an API. Checked before X-Agent-ID is resolved, so
 * naming an agent never lends its rights to the caller.
 *
 * The operator key and agent tokens pass the legacy rule. A user passes only when one of their
 * roles lists `script.author` by name; the default admin role's grant-all does not count.
 */
export async function hasScriptAuthorRight(
  req: IncomingMessage,
  agentId: string | undefined,
): Promise<boolean> {
  const auth = getRequestAuth(req);
  if (auth?.kind === "user") {
    return await userHasExplicitVerb(auth.userId, "script.author");
  }
  const principal = await requestPrincipal(req, agentId);
  if (!principal) return false;
  return can({ principal, verb: "script.author", source: "http" }).allow;
}

/** Writes a 403 and returns true when the caller may not author script code. */
export async function rejectWithoutScriptAuthor(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string | undefined,
): Promise<boolean> {
  if (await hasScriptAuthorRight(req, agentId)) return false;
  jsonError(res, SCRIPT_AUTHOR_DENIED, 403);
  return true;
}
