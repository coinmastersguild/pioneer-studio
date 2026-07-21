import {
  chatCompletionMessage,
  type ChatAssistantMessage,
  type ChatMessage,
  type ChatToolCall,
  type MediaList,
  type Storyboard,
} from "./api";
import { actionForTool, actionTools, callAction } from "./control";
import type { Mode } from "./shared";
import { loadPipeline } from "./pipeline";

export type PreparedStudioAction = {
  call: ChatToolCall;
  actionName: string;
  description: string;
  confirmation?: string;
  params: Record<string, unknown>;
};

export type StudioAgentTurn = {
  messages: ChatMessage[];
  assistant: ChatAssistantMessage;
  actions: PreparedStudioAction[];
};

export type StudioActionResult = {
  action: PreparedStudioAction;
  message: Extract<ChatMessage, { role: "tool" }>;
  error?: string;
};

function digest(mode: Mode, board: Storyboard | null, media: MediaList | null): string {
  const beats = (board?.shots || [])
    .map((shot, index) => `${index + 1}. id=${shot.id} status=${shot.status} text=${JSON.stringify(shot.prompt || "")}`)
    .join("\n");
  let production = "Phase: 1\nCast: (none)\nLocations: (none)";
  if (board && typeof localStorage !== "undefined") {
    const pipe = loadPipeline(board.id);
    production = `Phase: ${pipe.phase}
Cast: ${pipe.characters.map((character) => `${character.id}=${character.name}`).join(", ") || "(none)"}
Locations: ${pipe.locations.map((location) => `${location.id}=${location.name}`).join(", ") || "(none)"}`;
  }
  const mediaLines = (media?.objects || [])
    .slice(0, 30)
    .map((object) => `- ${object.name} (${object.content_type}) key=${object.key} url=${object.url}`)
    .join("\n");
  return `Current view: ${mode}
Project: ${board?.title || "Untitled"} (${board?.id || "local"})
${production}
Storyboard beats:
${beats || "(none)"}
Project Media:
${mediaLines || "(none)"}`;
}

function paramsOf(call: ChatToolCall): Record<string, unknown> {
  if (!call.function.arguments.trim()) return {};
  const value = JSON.parse(call.function.arguments);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tool arguments must be an object");
  return value;
}

function preparedActions(assistant: ChatAssistantMessage): PreparedStudioAction[] {
  const actions: PreparedStudioAction[] = [];
  for (const call of assistant.tool_calls || []) {
    const action = actionForTool(call.function.name);
    if (!action) continue;
    actions.push({
      call,
      actionName: action.name,
      description: action.description,
      confirmation: action.confirmation,
      params: paramsOf(call),
    });
  }
  return actions;
}

export async function beginStudioAgentTurn(
  apiKey: string,
  userText: string,
  context: { mode: Mode; board: Storyboard | null; media?: MediaList | null; history?: ChatMessage[] },
): Promise<StudioAgentTurn> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `You are the Pioneer Studio copilot. Drive the application through the provided tools when the user asks for an app action. Never claim an action happened unless you call its tool. For questions, answer briefly without a tool. Use exact beat ids from the project digest. The client itself requests confirmation before any paid or destructive action.

${digest(context.mode, context.board, context.media || null)}`,
    },
    ...(context.history || []).filter((message) => message.role !== "system").slice(-30),
    { role: "user", content: userText },
  ];
  const assistant = await chatCompletionMessage(apiKey, messages, { tools: actionTools(), toolChoice: "auto" });
  return { messages, assistant, actions: preparedActions(assistant) };
}

function resultText(result: unknown): string {
  if (result === undefined) return JSON.stringify({ ok: true });
  try {
    return JSON.stringify(result);
  } catch {
    return JSON.stringify({ ok: true, result: String(result) });
  }
}

export async function executeStudioAction(action: PreparedStudioAction): Promise<StudioActionResult> {
  try {
    const result = await callAction(action.actionName, action.params);
    return {
      action,
      message: {
        role: "tool",
        tool_call_id: action.call.id,
        name: action.call.function.name,
        content: resultText(result),
      },
    };
  } catch (error: any) {
    const text = String(error?.message || error);
    return {
      action,
      error: text,
      message: {
        role: "tool",
        tool_call_id: action.call.id,
        name: action.call.function.name,
        content: JSON.stringify({ ok: false, error: text }),
      },
    };
  }
}

export async function continueStudioAgentTurn(
  apiKey: string,
  turn: StudioAgentTurn,
  results: StudioActionResult[],
): Promise<StudioAgentTurn> {
  const messages: ChatMessage[] = [
    ...turn.messages,
    turn.assistant,
    ...results.map((result) => result.message),
  ];
  const assistant = await chatCompletionMessage(apiKey, messages, { tools: actionTools(), toolChoice: "auto" });
  return { messages, assistant, actions: preparedActions(assistant) };
}

export async function finishStudioAgentTurn(
  apiKey: string,
  turn: StudioAgentTurn,
  results: StudioActionResult[],
): Promise<string> {
  const response = await chatCompletionMessage(
    apiKey,
    [...turn.messages, turn.assistant, ...results.map((result) => result.message)],
    { tools: actionTools(), toolChoice: "none" },
  );
  return response.content || (results.some((result) => result.error) ? "The action failed." : "Done.");
}
