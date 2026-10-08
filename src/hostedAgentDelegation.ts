import type { ChatMessage, JobModel } from "./api";

const MAX_TASK_BYTES = 16 * 1024;
const encoder = new TextEncoder();
const EXPLICIT_AGENT = /\b(?:(?:tell|ask|have|instruct|direct|use)\s+(?:(?:the|my|our|a|an|hosted|running|selected)\s+)*agents?\b|(?:delegate|send)\s+(?:.+?\s+)?to\s+(?:(?:the|my|our|a|an|hosted|running|selected)\s+)*agents?\b|(?:want|need)\s+(?:(?:the|my|our|a|an|hosted|running|selected)\s+)*agent\s+to\b)/i;
const VIDEO_REQUEST = /\b(?:video|movie|animation|animate|animated|clip)\b/i;

/** Keep explicit delegation out of generation planning, including its old ask flow. */
export function hostedAgentRequest(text: string, history: ChatMessage[] = []): string | null {
  const request = text.trim();
  if (!request) return null;
  if (EXPLICIT_AGENT.test(request)) return request;
  const last = history.at(-1);
  if (last?.role !== "assistant" || !last.content?.startsWith("I asked:")) return null;
  for (let index = history.length - 2; index >= 0; index--) {
    const entry = history[index];
    if (entry.role === "user") {
      return EXPLICIT_AGENT.test(entry.content)
        ? `${entry.content}\n\nClarification: ${request}`
        : null;
    }
  }
  return null;
}

/** Catalog names are not proof of video support; use its actual output contract. */
export function unavailableVideoRequest(text: string, models: JobModel[], catalogAvailable: boolean): boolean {
  return VIDEO_REQUEST.test(text) && (!catalogAvailable || !models.some((entry) =>
    entry.result === "binary" && /^\.(?:mp4|webm|mov|m4v|mkv|avi)$/i.test(entry.result_ext || ""),
  ));
}

/** This prepares text only. Selection, owner validation and spending stay in the UI. */
export function prepareHostedAgentTask(goal: string, outputPrefix?: string): string {
  const request = goal.trim();
  if (!request || request.startsWith("/") || request.includes("\0")) {
    throw new Error("Provide an authoring task, not a slash lifecycle command.");
  }
  if (outputPrefix !== undefined && !/^studio-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(outputPrefix)) {
    throw new Error("The hosted-agent output name is invalid.");
  }
  const instructions = [
    "Discover the tools actually available in this runtime and use their exact schemas. Do not invent tool names, hosted model endpoints or provider credentials. Explain an unavailable capability rather than substituting another service.",
    "Save authored artifacts in the agent's files and report their actual paths. Claim completion only after checking the requested output exists and is valid.",
  ];
  if (VIDEO_REQUEST.test(request)) instructions.push(
    "For a video task, use an available local animation tool to author a scene with motion and save both a playable MP4 (.mp4) and its editable .blend source. Verify the actual video duration and multiple distinct frames; a PNG preview or scene file alone is not a finished video. If no video tool is available, report that limitation instead of claiming a render.",
  );
  if (outputPrefix !== undefined) instructions.push(
    `Use the new output basename ${outputPrefix} with the exact tool schema's supported naming field; do not invent parameters. For video, save desktop-test/${outputPrefix}.mp4 and desktop-test/${outputPrefix}.blend and report those exact newly authored paths. Do not substitute files from an earlier task.`,
  );
  const task = `${request}\n\nExecution requirements:\n${instructions.join("\n")}`;
  if (encoder.encode(task).length > MAX_TASK_BYTES) throw new Error("The complete hosted-agent task must fit within 16 KiB.");
  return task;
}
