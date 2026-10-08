import { getAgentTurnState, reconcileAgentTurn, type AgentTurnState } from "./api";

/** Read-only inspection precedes any owner attestation or local uncertainty reset. */
export async function inspectAgentTurnRecovery(apiKey: string, agentId: string, session: string, signal?: AbortSignal): Promise<AgentTurnState> {
  const state = await getAgentTurnState(apiKey, agentId, session, signal);
  if (state.state === "running") throw new Error("The previous task is still running. Wait and check its files, desktop or logs; do not resend it.");
  return state;
}

/** Called only after the owner explicitly reviews idle work or confirms an uncertain task stopped. */
export async function confirmAgentTurnRecovery(apiKey: string, agentId: string, session: string, reviewed: AgentTurnState, signal?: AbortSignal): Promise<void> {
  const current = await inspectAgentTurnRecovery(apiKey, agentId, session, signal);
  if (current.state === "idle") return;
  if (reviewed.state !== "uncertain" || !reviewed.turn_id || current.turn_id !== reviewed.turn_id)
    throw new Error("The previous task changed. Refresh its state and review it again before confirming.");
  await reconcileAgentTurn(apiKey, agentId, { session, turn_id: reviewed.turn_id, confirmed_stopped: true }, signal);
}
