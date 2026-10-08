import { agentRequest } from "./api";

type MemoryOperation = "retain" | "recall";
export type AgentMemory = {
  configured: boolean; enabled: boolean; storage: "host-managed"; operations: MemoryOperation[];
  recent_operations: { operation: MemoryOperation; ts: number; status: "pending" | "ok" | "failed" }[];
};

/** Only the owner-visible policy and operation metadata reach the UI, never facts or bank identifiers. */
export function parseAgentMemory(value: unknown): AgentMemory {
  if (!value || typeof value !== "object") throw new Error("Memory status is unavailable.");
  const v = value as Record<string, unknown>;
  if (typeof v.configured !== "boolean" || typeof v.enabled !== "boolean" || v.storage !== "host-managed" ||
      !Array.isArray(v.operations) || v.operations.length > 2 || !Array.isArray(v.recent_operations) || v.recent_operations.length > 50 ||
      v.operations.some((op) => op !== "retain" && op !== "recall")) throw new Error("Memory status is unavailable.");
  const recent_operations = v.recent_operations.map((row) => {
    if (!row || typeof row !== "object") throw new Error("Memory status is unavailable.");
    const r = row as Record<string, unknown>;
    if ((r.operation !== "retain" && r.operation !== "recall") || typeof r.ts !== "number" || !Number.isFinite(r.ts) || r.ts < 0 ||
        !["pending", "ok", "failed"].includes(String(r.status))) throw new Error("Memory status is unavailable.");
    return { operation: r.operation as MemoryOperation, ts: r.ts, status: r.status as "pending" | "ok" | "failed" };
  });
  return { configured: v.configured, enabled: v.enabled, storage: "host-managed",
    operations: [...new Set(v.operations)] as MemoryOperation[], recent_operations };
}

export function memoryAvailability(memory: AgentMemory): "Available" | "Paused" | "Unavailable" {
  return !memory.configured ? "Unavailable" : memory.enabled ? "Available" : "Paused";
}

export async function getAgentMemory(apiKey: string, id: string, signal?: AbortSignal): Promise<AgentMemory> {
  return parseAgentMemory(await agentRequest(apiKey, `/${encodeURIComponent(id)}/memory`, { signal }));
}

export async function setAgentMemoryEnabled(apiKey: string, id: string, enabled: boolean, signal?: AbortSignal): Promise<AgentMemory> {
  return parseAgentMemory(await agentRequest(apiKey, `/${encodeURIComponent(id)}/memory`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }), signal,
  }));
}
