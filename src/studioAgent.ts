import {
  chatCompletionMessage,
  type ChatAssistantMessage,
  type ChatMessage,
  type ChatToolCall,
  type MediaList,
  type Storyboard,
} from "./api";
import { actionForTool, actionTools, callAction, confirmationForTool } from "./control";
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
  let production = "Cast: (none)";
  if (board && typeof localStorage !== "undefined") {
    const pipe = loadPipeline(board.id);
    production = `Cast: ${pipe.characters.map((character) => `${character.id}=${character.name}`).join(", ") || "(none)"}`;
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
    if (!action) throw new Error(`The copilot requested an unavailable tool: ${call.function.name}. That tool call was not executed.`);
    const params = paramsOf(call);
    actions.push({
      call,
      actionName: action.name,
      description: action.description,
      confirmation: confirmationForTool(call.function.name, params),
      params,
    });
  }
  return actions;
}

export async function beginStudioAgentTurn(
  apiKey: string,
  userText: string,
  context: {
    mode: Mode;
    board: Storyboard | null;
    media?: MediaList | null;
    history?: ChatMessage[];
    /** Spoken-character brief. The head keeps its voice while holding the tools. */
    persona?: string;
  },
): Promise<StudioAgentTurn> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `You are the Pioneer Studio copilot. Drive the application through the provided tools when the user asks for an app action. Never claim an action happened unless you call its tool. Saying you did something without calling its tool is the single worst thing you can do. For questions, answer briefly without a tool. Use exact beat ids from the project digest. The client itself requests confirmation before any paid or destructive action.

Navigating is free and expected: call app.set_mode to open a screen, then use the actions that screen registers as it mounts. Chain as many tool calls as the request needs rather than asking the user to click.${
        context.persona
          ? `\n\nSpeak in character throughout: ${context.persona}\nThe character is how you talk, never a reason to skip a tool call.`
          : ""
      }

For an explicit request to tell, ask, have or delegate work to a hosted agent, use agents_delegate when advertised. agents_list can discover this owner's agents. Preserve the complete user goal and its clarification; if a target is ambiguous, let the user select it. Never substitute a generation job for an explicit hosted-agent request. agents_delegate only prepares a task for the SAME hosted-agent UI confirmation: a result with prepared:true and confirmation_required:true means no task has run yet. Report it as prepared for review, never completed, and stop until that confirmation.

When jobs_submit is advertised, it can run one paid generation job using ONLY an exact model/endpoint pair and parameter schema in that tool. If no live matching endpoint is advertised, explain that it is unavailable. For video, offer local Blender authoring by a hosted agent as an explicit alternative; never claim it has started. Do not invent model names, tool names, endpoints, credentials or capabilities. Never print a {"job": ...} plan as assistant text: that does not execute anything. Paid generation and hosted-agent tasks require their own explicit user confirmation before they run.

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

const PREPARED_TASK_MESSAGE = "The hosted-agent task is prepared for review and has not run. Review the selected agent and task, then confirm it in Agents.";

function hasPreparedHostedTask(results: StudioActionResult[]): boolean {
  return results.some((result) => {
    if (result.error || result.action.actionName !== "agents.delegate") return false;
    try {
      const value: unknown = JSON.parse(result.message.content);
      return !!value && typeof value === "object" && !Array.isArray(value)
        && "prepared" in value && value.prepared === true
        && "confirmation_required" in value && value.confirmation_required === true;
    } catch { return false; }
  });
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
  if (hasPreparedHostedTask(results)) return {
    messages,
    assistant: { role: "assistant", content: PREPARED_TASK_MESSAGE },
    actions: [],
  };
  const assistant = await chatCompletionMessage(apiKey, messages, { tools: actionTools(), toolChoice: "auto" });
  return { messages, assistant, actions: preparedActions(assistant) };
}

export async function finishStudioAgentTurn(
  apiKey: string,
  turn: StudioAgentTurn,
  results: StudioActionResult[],
): Promise<string> {
  if (hasPreparedHostedTask(results)) return PREPARED_TASK_MESSAGE;
  const response = await chatCompletionMessage(
    apiKey,
    [...turn.messages, turn.assistant, ...results.map((result) => result.message)],
    { tools: actionTools(), toolChoice: "none" },
  );
  return response.content || (results.some((result) => result.error) ? "The action failed." : "Done.");
}
