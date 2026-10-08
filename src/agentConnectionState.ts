import { agentRequest, type AgentConnection, type AgentConnectionMutation, type AgentConnectionCapabilities, type HostedAgent } from "./api";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function connectionReturn(url: string): { agentId: string; connectionId: string } | null {
  const query = new URL(url).searchParams;
  const agentId = query.get("agent_id") || "", connectionId = query.get("connection_id") || "";
  return uuid.test(agentId) && uuid.test(connectionId) ? { agentId, connectionId } : null;
}
export function connectionReturnUrl(url: string, agentId: string): string {
  const target = new URL(url); target.search = ""; target.hash = "";
  target.searchParams.set("agent_id", agentId);
  return target.href;
}
export function githubConnectionUrl(value: string, kind: "authorize" | "install"): string {
  const url = new URL(value);
  const path = kind === "authorize" ? "/login/oauth/authorize" : "/apps/pioneer-studio-agents/installations/new";
  if (url.origin !== "https://github.com" || url.pathname !== path || url.username || url.password || url.hash)
    throw new Error("Alpha returned an invalid GitHub connection URL.");
  return url.href;
}
export function newConnectionMutation(path: string, method: AgentConnectionMutation["method"], body: AgentConnectionMutation["body"]): AgentConnectionMutation {
  return { path, method, body, key: crypto.randomUUID() };
}
export function connectionIsVerified(state: AgentConnection, now = Date.now()): boolean {
  return state.state === "active" && !state.sync_pending && state.legacy.state === "resolved" &&
    !state.provider_revocation_pending && state.repositories.length === 1 && !!state.last_verified_at &&
    !!state.credential_expires_at && state.credential_expires_at > now;
}
export async function verifyAgentGithubSetup(apiKey: string, agentId: string, signal?: AbortSignal): Promise<void> {
  const caps = await agentRequest<AgentConnectionCapabilities>(apiKey, "/connections/capabilities", { signal });
  if (!caps.github_read) throw new Error("Complete required GitHub setup before sending this agent a task.");
  const state = await agentRequest<AgentConnection>(apiKey, `/${encodeURIComponent(agentId)}/connections`, { signal });
  if (state.agent_id !== agentId || !connectionIsVerified(state))
    throw new Error("Complete required GitHub setup and verify repository access before sending this agent a task.");
}
export function connectionAvailabilityError(code: string): string {
  if (code === "not_found" || code === "capability_unavailable") return "Alpha has not deployed the GitHub connection API yet. Setup will be available after the server release.";
  if (code === "capability_disabled" || code === "runtime_protocol_pending") return "GitHub connections are waiting for Alpha configuration and feature enablement.";
  return "GitHub connection availability could not be checked. Refresh to try again.";
}
export function connectionCapabilitiesMessage(caps: AgentConnectionCapabilities): string {
  if (caps.github_read) return "GitHub setup is available.";
  if (!caps.configured && !caps.enabled) return "GitHub setup is not configured or enabled on Alpha yet.";
  if (!caps.configured) return "GitHub setup is not configured on Alpha yet.";
  if (!caps.enabled) return "GitHub setup is not enabled on Alpha yet.";
  return "GitHub read access is not available on Alpha yet.";
}
export function agentRequiresGithub(agent: Pick<HostedAgent, "id" | "setup_required">, localRequired: string[]): boolean {
  return typeof agent.setup_required === "boolean" ? agent.setup_required : localRequired.includes(agent.id);
}
export function agentGithubReady(agent: Pick<HostedAgent, "id" | "setup_state">, connection: AgentConnection | null): boolean {
  return (agent.setup_state === undefined || agent.setup_state === "ready") &&
    !!connection && connection.agent_id === agent.id && connectionIsVerified(connection);
}
export function repositoryBinding(connectionId: string, installationId: number, repositoryIds: number[], revision: number) {
  if (!uuid.test(connectionId) || !Number.isSafeInteger(installationId) || installationId < 1 ||
    !Number.isSafeInteger(revision) || revision < 0 || repositoryIds.length !== 1 ||
    repositoryIds.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error("Select one authorized repository and refresh connection state.");
  return { connection_id: connectionId, installation_id: installationId,
    repository_ids: [...new Set(repositoryIds)].sort((a, b) => a - b), expected_revision: revision };
}
