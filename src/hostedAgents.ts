export type AgentIntent = {
  key: string; suffix: string; method: "POST" | "PATCH" | "DELETE";
  body: Record<string, unknown> | null; operationId?: string; createdAt: number;
};

// Agent recovery stores only mutation intents, never credentials or workspace contents.
export function agentIntentStorageKey(owner: string, network: string): string {
  if (!/^0x[\da-f]{40}$/i.test(owner) || !["testnet", "mainnet"].includes(network)) throw new Error("Verified agent owner/network unavailable; purchases are disabled.");
  return `pioneer_agent_intents:${network}:${owner.toLowerCase()}`;
}

export function loadAgentIntents(storageKey: string): AgentIntent[] {
  const value = JSON.parse(localStorage.getItem(storageKey) || "[]");
  if (!Array.isArray(value)) throw new Error("Saved agent intents are invalid. Resolve storage before purchasing.");
  for (const intent of value) {
    if (!intent || typeof intent.key !== "string" || !/^[A-Za-z0-9_.:-]{8,128}$/.test(intent.key) ||
        typeof intent.suffix !== "string" || !/^(|\/[a-f0-9-]{36}(\/(suspend|resume|sync))?(\?purge=(true|false))?)$/.test(intent.suffix) ||
        !["POST", "PATCH", "DELETE"].includes(intent.method) || !Number.isFinite(intent.createdAt) ||
        (intent.body !== null && (typeof intent.body !== "object" || Array.isArray(intent.body)))) {
      throw new Error("Saved agent intents are invalid. Resolve storage before purchasing.");
    }
  }
  return value;
}

export function saveAgentIntents(storageKey: string, intents: AgentIntent[]): void {
  localStorage.setItem(storageKey, JSON.stringify(intents));
}

export function newAgentIntent(suffix: string, method: AgentIntent["method"], body: AgentIntent["body"]): AgentIntent {
  return { key: crypto.randomUUID(), suffix, method, body, createdAt: Date.now() };
}

export function canReplayAgentIntent(intent: AgentIntent, now = Date.now()): boolean {
  return now - intent.createdAt < 29 * 86400000;
}

export function agentSetupStorageKey(intentStorageKey: string): string {
  if (!/^pioneer_agent_intents:(testnet|mainnet):0x[0-9a-f]{40}$/.test(intentStorageKey)) throw new Error("Verified setup owner/network unavailable.");
  return intentStorageKey.replace("pioneer_agent_intents:", "pioneer_agent_github_setup:");
}
export function loadAgentSetup(storageKey: string): string[] {
  const ids = JSON.parse(localStorage.getItem(agentSetupStorageKey(storageKey)) || "[]");
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)))
    throw new Error("Saved agent setup state is invalid; resolve storage before purchasing.");
  return [...new Set<string>(ids)];
}
export function saveAgentSetup(storageKey: string, ids: string[]): void {
  localStorage.setItem(agentSetupStorageKey(storageKey), JSON.stringify([...new Set(ids)]));
}
export function selectVisibleAgent(agents: { id: string; status: string }[], selected: string, callbackAgent?: string): string {
  const visible = agents.filter((agent) => agent.status !== "deleted");
  return visible.find((agent) => agent.id === selected)?.id || visible.find((agent) => agent.id === callbackAgent)?.id || visible[0]?.id || "";
}
export function pendingIntentSummary(intent: AgentIntent): string {
  if (!intent.suffix && intent.method === "POST") return `Agent claim: ${String(intent.body?.name || "unnamed")} · ${Number(intent.body?.credits || 0)} credits`;
  if (intent.suffix.endsWith("/sync")) return `Pull & restart: ${intent.suffix.slice(1, -5)}`;
  return `${intent.method === "PATCH" ? "Top-up" : intent.method === "DELETE" ? "Delete" : "Agent operation"}: ${intent.suffix}`;
}

export type AgentCommand = { name: string; argument: string };
export function parseAgentCommand(input: string): AgentCommand | null {
  const match = input.trim().match(/^\/(new|claim|pair|status|agents|files|edit|github|credentials|memory|logs|usage|egress|topup|suspend|resume|delete|help)(?:\s+(.*))?$/is);
  if (match) return { name: match[1].toLowerCase(), argument: (match[2] || "").trim() };
  if (/^(create|set up|run|launch) (my |an? |own )*(agent|openclaw)\b/i.test(input)) return { name: "new", argument: "" };
  if (/^(show |check |monitor )?(my )?(agents|agent status|agent progress)\??$/i.test(input.trim())) return { name: "status", argument: "" };
  return null;
}
