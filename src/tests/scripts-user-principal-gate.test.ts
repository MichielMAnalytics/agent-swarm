/**
 * script.author gate for user principals, over real HTTP.
 *
 * A user token on the default admin role (grant-all) must not run, save, or launch script code,
 * expose a script as an API, or open an agent MCP session by naming an agent in X-Agent-ID. A
 * user that holds the built-in script-author role may. The operator key and agent runtime tokens
 * keep their behaviour (positive controls); no bearer and an unknown user token stay 401
 * (negative controls).
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  api,
  E2E_API_KEY,
  makeScratchDir,
  registerAgent,
  removeScratchDir,
  type SwarmServer,
  spawnSwarmServer,
  WORKER_A,
} from "./rbac-e2e-helpers";

setDefaultTimeout(120_000);

const SCRIPT_AUTHOR_ROLE_ID = "rbac-role-script-author";
const INLINE_SOURCE = "export default async function () { return { ran: true }; }";

let dir: string;
let server: SwarmServer;
let defaultUserToken: string;
let grantedUserToken: string;
let agentToken: string;
let scriptId: string;

function grantScriptAuthor(dbPath: string, userId: string): void {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.prepare(
      `INSERT OR IGNORE INTO principal_roles (principalType, principalId, roleId)
       VALUES ('user', ?, ?)`,
    ).run(userId, SCRIPT_AUTHOR_ROLE_ID);
  } finally {
    db.close();
  }
}

async function mintUserToken(name: string, email: string): Promise<{ id: string; token: string }> {
  const user = await api(server.base, "POST", "/api/users", { body: { name, email } });
  expect(user.status).toBe(200);
  const id = user.body.user.id as string;
  const minted = await api(server.base, "POST", `/api/users/${id}/mcp-tokens`, { body: {} });
  expect(minted.status).toBe(200);
  const token = minted.body.plaintext as string;
  expect(token).toStartWith("aswt_");
  return { id, token };
}

function runInline(bearer: string | null, agentId?: string) {
  return request("POST", "/api/scripts/run", bearer, agentId, {
    source: INLINE_SOURCE,
    args: {},
  });
}

function upsert(bearer: string, name: string) {
  return request("POST", "/api/scripts/upsert", bearer, WORKER_A, {
    name,
    source: INLINE_SOURCE,
    description: "gate test",
    scope: "agent",
  });
}

function launchDurableRun(bearer: string) {
  return request("POST", "/api/script-runs", bearer, WORKER_A, {
    source: INLINE_SOURCE,
    background: true,
  });
}

function createScriptApi(bearer: string) {
  return request("POST", `/api/scripts/${scriptId}/apis`, bearer, undefined, {
    authMode: "bearer",
  });
}

async function request(
  method: string,
  path: string,
  bearer: string | null,
  agentId: string | undefined,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer !== null) headers.Authorization = `Bearer ${bearer}`;
  if (agentId) headers["X-Agent-ID"] = agentId;
  const res = await fetch(`${server.base}${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

async function mcpInitialize(bearer: string): Promise<number> {
  const res = await fetch(`${server.base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "X-Agent-ID": WORKER_A,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "script-author-gate", version: "1" },
        capabilities: {},
      },
    }),
  });
  await res.text();
  return res.status;
}

describe("script.author gate for user principals", () => {
  beforeAll(async () => {
    dir = await makeScratchDir();
    const dbPath = join(dir, "script-author.sqlite");
    // Production default: RBAC on, single runtime.
    server = await spawnSwarmServer({
      dbPath,
      logPath: join(dir, "server.log"),
      env: { RBAC_ENABLED: "true", MULTI_RUNTIME_ENABLED: "false", SCRIPT_EXECUTOR: "native" },
    });
    await registerAgent(server.base, WORKER_A, "script-author-gate-worker", false);

    defaultUserToken = (await mintUserToken("default-admin-user", "gate-default@example.com"))
      .token;
    const granted = await mintUserToken("script-author-user", "gate-granted@example.com");
    grantedUserToken = granted.token;
    grantScriptAuthor(dbPath, granted.id);

    const runtime = await api(server.base, "POST", "/api/sessions/tokens", {
      body: { agentId: WORKER_A, runtimeId: crypto.randomUUID(), ttlMs: 600_000 },
    });
    expect(runtime.status).toBe(200);
    agentToken = runtime.body.plaintext as string;

    expect((await upsert(E2E_API_KEY, "gate-api-target")).status).toBe(200);
    const listed = await api(server.base, "GET", "/api/scripts");
    expect(listed.status).toBe(200);
    scriptId = (listed.body.scripts as Array<{ id: string; name: string }>).find(
      (script) => script.name === "gate-api-target",
    )!.id;
  });

  afterAll(async () => {
    if (server) await server.stop();
    if (dir) await removeScratchDir(dir);
  });

  test("a default admin user token is refused on every script authoring path", async () => {
    const run = await runInline(defaultUserToken, WORKER_A);
    expect(run.status).toBe(403);
    expect(run.body.error).toContain("script.author");
    expect(run.body.result).toBeUndefined();

    // The gate runs before X-Agent-ID is resolved: no 400 for the missing header.
    expect((await runInline(defaultUserToken)).status).toBe(403);
    expect((await upsert(defaultUserToken, "gate-user-upsert")).status).toBe(403);
    expect((await launchDurableRun(defaultUserToken)).status).toBe(403);
    expect((await createScriptApi(defaultUserToken)).status).toBe(403);
    expect(await mcpInitialize(defaultUserToken)).toBe(403);
  });

  test("a user holding the script-author role may author scripts", async () => {
    const run = await runInline(grantedUserToken, WORKER_A);
    expect(run.status).toBe(200);
    expect(run.body.result).toEqual({ ran: true });
    expect((await upsert(grantedUserToken, "gate-granted-upsert")).status).toBe(200);
    expect((await launchDurableRun(grantedUserToken)).status).toBe(201);
    expect((await createScriptApi(grantedUserToken)).status).toBe(201);
    expect(await mcpInitialize(grantedUserToken)).toBe(200);
  });

  test("operator key and agent tokens are unchanged (positive controls)", async () => {
    const operatorRun = await runInline(E2E_API_KEY, WORKER_A);
    expect(operatorRun.status).toBe(200);
    expect(operatorRun.body.result).toEqual({ ran: true });
    expect((await upsert(E2E_API_KEY, "gate-operator-upsert")).status).toBe(200);
    expect((await createScriptApi(E2E_API_KEY)).status).toBe(201);
    expect(await mcpInitialize(E2E_API_KEY)).toBe(200);

    const agentRun = await runInline(agentToken, WORKER_A);
    expect(agentRun.status).toBe(200);
    expect(agentRun.body.result).toEqual({ ran: true });
    expect((await upsert(agentToken, "gate-agent-upsert")).status).toBe(200);
  });

  test("no bearer and an unknown user token stay 401 (negative controls)", async () => {
    expect((await runInline(null, WORKER_A)).status).toBe(401);
    expect((await runInline(`aswt_${"x".repeat(24)}`, WORKER_A)).status).toBe(401);
  });
});
