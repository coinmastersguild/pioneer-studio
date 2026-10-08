export type AgentReplyState = "streaming" | "complete" | "interrupted";

/** Both API control errors and in-stream errors carry owner-facing details. */
export function agentErrorDetails(value: unknown, fallbackMessage: string, fallbackCode: string, fallbackStatus: number) {
  const object = (input: unknown): Record<string, unknown> => input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const body = object(value);
  const error = object(body.error), detail = object(body.detail);
  const envelope = Object.keys(error).length ? error : Object.keys(detail).length ? detail : body;
  const text = (...candidates: unknown[]) => candidates.find((candidate) => typeof candidate === "string" && candidate.trim()) as string | undefined;
  const status = envelope.status ?? body.status;
  return {
    message: text(envelope.message, body.message, body.detail, body.error) || fallbackMessage,
    code: text(envelope.code, body.code) || fallbackCode,
    status: typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : fallbackStatus,
  };
}

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
