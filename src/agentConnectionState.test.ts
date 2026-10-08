import { afterEach, expect, test } from "bun:test";
import { AgentApiError, connectionMutation, connectionResources, type AgentConnection } from "./api";
import { connectionIsVerified, connectionReturn, connectionReturnUrl, githubConnectionUrl, newConnectionMutation, repositoryBinding, connectionAvailabilityError, verifyAgentGithubSetup, connectionCapabilitiesMessage, agentRequiresGithub, agentGithubReady } from "./agentConnectionState";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const agent = "00000000-0000-4000-8000-000000000001";
const connection = "00000000-0000-4000-8000-000000000002";

test("OAuth return contains public IDs only and restores the intended agent after reconnect", () => {
  const target = connectionReturnUrl("http://127.0.0.1:5175/?other=old#workspace", agent);
  expect(target).toBe(`http://127.0.0.1:5175/?agent_id=${agent}`);
  expect(connectionReturn(`${target}&connection_id=${connection}`)).toEqual({ agentId: agent, connectionId: connection });
  expect(connectionReturn(`${target}&connection_id=not-a-uuid`)).toBeNull();
  expect(connectionReturn(`https://studio.pioneers.dev/?connection_id=${connection}`)).toBeNull();
});

test("GitHub navigation refuses credential URLs, unexpected origins and endpoints", () => {
  expect(githubConnectionUrl("https://github.com/login/oauth/authorize?state=public-state", "authorize")).toContain("/login/oauth/authorize");
  expect(githubConnectionUrl("https://github.com/apps/pioneer-studio-agents/installations/new", "install")).toContain("/installations/new");
  for (const url of ["https://evil.example/login/oauth/authorize", "https://token@github.com/login/oauth/authorize", "http://github.com/login/oauth/authorize", "https://github.com/login/oauth/authorize#token", "https://github.com/other"])
    expect(() => githubConnectionUrl(url, "authorize")).toThrow();
});

test("bindings allow exactly one numeric repository selection and the observed revision", () => {
  expect(repositoryBinding(connection, 7, [12], 4)).toEqual({ connection_id: connection, installation_id: 7, repository_ids: [12], expected_revision: 4 });
  for (const ids of [[], [0], [-1], [1.5], [12, 13], [12, 12], Array.from({ length: 501 }, (_, i) => i + 1)])
    expect(() => repositoryBinding(connection, 7, ids, 4)).toThrow();
  expect(() => repositoryBinding(connection, 7, [12], -1)).toThrow();
});

test("historical probe evidence never implies active access after expiry or pending removal", () => {
  const now = Date.now();
  const state: AgentConnection = { agent_id: agent, revision: 4, generation: 1, state: "active", repositories: [{ id: 12, full_name: "fixture/private" }], permissions: ["contents:read"], sync_pending: false,
    error_code: null, last_verified_at: now - 1000, legacy: { state: "resolved", evidence: "owner_attested" }, credential_expires_at: now + 60000 };
  expect(connectionIsVerified(state, now)).toBe(true);
  for (const patch of [{ state: "pending_runtime" }, { sync_pending: true }, { provider_revocation_pending: true }, { credential_expires_at: now }, { repositories: [] }, { repositories: [{ id: 12, full_name: "fixture/private" }, { id: 13, full_name: "fixture/other" }] }, { last_verified_at: null }, { legacy: { state: "unknown", evidence: null } }])
    expect(connectionIsVerified({ ...state, ...patch }, now)).toBe(false);
});

test("required setup is rechecked against Alpha and rejects revocation, expiry and wrong agent", async () => {
  const now = Date.now();
  const state: AgentConnection = { agent_id: agent, revision: 4, generation: 1, state: "active", repositories: [{ id: 12, full_name: "fixture/private" }], permissions: ["contents:read"], sync_pending: false,
    error_code: null, last_verified_at: now - 1000, legacy: { state: "resolved", evidence: "owner_attested" }, credential_expires_at: now + 60000 };
  let readAvailable = true, observation = state;
  const paths: string[] = [];
  globalThis.fetch = (async (url) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    return Response.json(path.endsWith("/capabilities") ? { github_read: readAvailable } : observation);
  }) as typeof fetch;
  await verifyAgentGithubSetup("fixture-owner", agent);
  expect(paths).toEqual(["/api/v1/agents/connections/capabilities", `/api/v1/agents/${agent}/connections`]);
  for (const patch of [{ state: "revoked" }, { credential_expires_at: now - 1 }, { agent_id: connection }, { legacy: { state: "unknown", evidence: null } }]) {
    observation = { ...state, ...patch };
    await expect(verifyAgentGithubSetup("fixture-owner", agent)).rejects.toThrow("Complete required GitHub setup");
  }
  readAvailable = false; paths.length = 0;
  await expect(verifyAgentGithubSetup("fixture-owner", agent)).rejects.toThrow("Complete required GitHub setup");
  expect(paths).toHaveLength(1);
});

test("missing Alpha routes are explained as release blockers rather than lost agents", () => {
  expect(connectionAvailabilityError("not_found")).toContain("not deployed");
  expect(connectionAvailabilityError("capability_disabled")).toContain("feature enablement");
  expect(connectionAvailabilityError("network_error")).toContain("Refresh");
});

test("released capability responses distinguish configuration, enablement and runtime readiness", () => {
  const caps = { github_read: false, github_write: false as const, assets: false as const, configured: false, enabled: false, runtime_auth: "beast_mediated", github_installation_url: "https://github.com/apps/pioneer-studio-agents/installations/new" };
  expect(connectionCapabilitiesMessage(caps)).toContain("not configured or enabled");
  expect(connectionCapabilitiesMessage({ ...caps, configured: true })).toContain("not enabled");
  expect(connectionCapabilitiesMessage({ ...caps, enabled: true })).toContain("not configured");
  expect(connectionCapabilitiesMessage({ ...caps, enabled: true, configured: true })).toContain("read access is not available");
  expect(connectionCapabilitiesMessage({ ...caps, github_read: true, configured: true, enabled: true })).toBe("GitHub setup is available.");
});

test("durable Alpha setup policy survives another browser and grandfathers explicit false", () => {
  expect(agentRequiresGithub({ id: agent, setup_required: true }, [])).toBe(true);
  expect(agentRequiresGithub({ id: agent, setup_required: false }, [agent])).toBe(false);
  expect(agentRequiresGithub({ id: agent }, [agent])).toBe(true);
  expect(agentRequiresGithub({ id: agent }, [])).toBe(false);
});

test("server lifecycle setup state blocks tasks even when a historical connection looks valid", () => {
  const state: AgentConnection = { agent_id: agent, revision: 4, generation: 1, state: "active", repositories: [{ id: 12, full_name: "fixture/private" }], permissions: ["contents:read"], sync_pending: false,
    error_code: null, last_verified_at: Date.now() - 1000, legacy: { state: "resolved", evidence: "owner_attested" }, credential_expires_at: Date.now() + 60000 };
  expect(agentGithubReady({ id: agent, setup_state: "ready" }, state)).toBe(true);
  for (const setup_state of ["pending", "blocked", "suspended", "not_required"] as const)
    expect(agentGithubReady({ id: agent, setup_state }, state)).toBe(false);
  expect(agentGithubReady({ id: agent, setup_state: "ready" }, null)).toBe(false);
  expect(agentGithubReady({ id: connection, setup_state: "ready" }, state)).toBe(false);
});

test("uncertain connection retries preserve exact mutation body and idempotency key", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), init });
    if (requests.length === 1) throw new TypeError("transport lost");
    return Response.json({ state: "pending_runtime" });
  }) as typeof fetch;
  const request = newConnectionMutation("binding", "PUT", repositoryBinding(connection, 7, [12], 4));
  await expect(connectionMutation("fixture-owner", agent, request)).rejects.toThrow("transport lost");
  await connectionMutation("fixture-owner", agent, request);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0].url).toBe(`https://alpha.pioneers.dev/api/v1/agents/${agent}/connections/binding`);
  expect(requests[0].init?.headers).toMatchObject({ "Idempotency-Key": request.key });
  expect(JSON.parse(String(requests[0].init?.body))).not.toHaveProperty("token");
  expect(newConnectionMutation("verify", "POST", {}).key).not.toBe(request.key);
});

test("resources request uses connection ID, installation and page with owner authentication", async () => {
  let requested = "";
  globalThis.fetch = (async (url, init) => {
    requested = String(url);
    expect(init?.headers).toMatchObject({ Authorization: "Bearer fixture-owner" });
    return Response.json({ repositories: [{ id: 12, full_name: "fixture/private" }], next_page: null });
  }) as typeof fetch;
  expect((await connectionResources("fixture-owner", agent, connection, 7, 2)).repositories?.[0].id).toBe(12);
  const query = new URL(requested).searchParams;
  expect(query.get("connection_id")).toBe(connection); expect(query.get("installation_id")).toBe("7"); expect(query.get("page")).toBe("2");
});

test("capability and revision errors retain structured status and Retry-After", async () => {
  globalThis.fetch = (async () => Response.json({ error: { code: "runtime_protocol_pending", message: "Unavailable" } }, { status: 503, headers: { "Retry-After": "5" } })) as typeof fetch;
  try { await connectionMutation("fixture-owner", agent, newConnectionMutation("verify", "POST", {})); throw new Error("Expected rejection"); }
  catch (e) { expect(e).toBeInstanceOf(AgentApiError); expect((e as AgentApiError).code).toBe("runtime_protocol_pending"); expect((e as AgentApiError).retryAfter).toBe(5); }
});
