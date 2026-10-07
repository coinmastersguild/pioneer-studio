import type { Mode } from "./shared";

/** Hosted tasks use their own confirmation and budget, never the media copilot. */
export function dispatchWorkspaceInput(
  mode: Mode,
  text: string,
  handlers: Partial<Record<Mode, (text: string) => void>>,
): "handled" | "unavailable" | "copilot" {
  if (mode !== "chat" && mode !== "agents") return "copilot";
  const handler = handlers[mode];
  if (!handler) return "unavailable";
  handler(text);
  return "handled";
}
