export type AgentReplyState = "streaming" | "complete" | "interrupted";

export function agentReplyPlaceholder(state?: AgentReplyState): string {
  if (state === "streaming") return "Working…";
  if (state === "complete") return "The reply ended without text. Check workspace files and runtime logs before sending another task; work may have been performed and tokens consumed.";
  if (state === "interrupted") return "The reply was interrupted. Check workspace files and runtime logs before sending another task; work may still be running.";
  return "";
}

/** Observe this request once. An empty reply never authorizes replaying work. */
export async function observeAgentReply(run: () => Promise<void>, onState: (state: AgentReplyState) => void): Promise<void> {
  onState("streaming");
  try {
    await run();
    onState("complete");
  } catch (error) {
    onState("interrupted");
    throw error;
  }
}
