// Studio control surface — one typed registry of app actions that the copilot,
// the browser console, and external agents (MCP) all drive. Invariant borrowed
// from Motion Previs Studio: every agent action runs the IDENTICAL code path as
// the UI click — views register the same handlers their buttons call.
//
// Agents: `window.__studio.actions()` lists what's live; `window.__studio.call
// (action, params)` runs one. External automation can forward tool calls here.
import type { ChatTool } from "./api";

export type ControlResult = unknown;
export type ControlAction = {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  /** Why this action must pause for an explicit click in the copilot rail. */
  confirmation?: string;
  run: (params?: Record<string, unknown>) => Promise<ControlResult> | ControlResult;
};

const registry = new Map<string, ControlAction>();

export function registerActions(actions: ControlAction[]): void {
  for (const a of actions) registry.set(a.name, a);
}

export function listActions(): { name: string; description: string; parameters: Record<string, unknown>; confirmation?: string }[] {
  return [...registry.values()].map(({ name, description, parameters, confirmation }) => ({
    name,
    description,
    parameters: parameters || { type: "object", properties: {}, additionalProperties: false },
    confirmation,
  }));
}

const toolName = (actionName: string) => actionName.replace(/[^a-zA-Z0-9_-]/g, "_");

export function actionTools(): ChatTool[] {
  return listActions().map((action) => ({
    type: "function",
    function: {
      name: toolName(action.name),
      description: action.description,
      parameters: action.parameters,
    },
  }));
}

export function actionForTool(name: string): ReturnType<typeof listActions>[number] | undefined {
  return listActions().find((action) => toolName(action.name) === name);
}

export async function callAction(name: string, params?: Record<string, unknown>): Promise<ControlResult> {
  const a = registry.get(name);
  if (!a) throw new Error(`unknown action "${name}" — known: ${[...registry.keys()].join(", ")}`);
  return a.run(params);
}

declare global {
  interface Window {
    __studio?: { actions: typeof listActions; call: typeof callAction };
  }
}

// published once at import time; views add their actions as they mount
if (typeof window !== "undefined") {
  window.__studio = { actions: listActions, call: callAction };
}
