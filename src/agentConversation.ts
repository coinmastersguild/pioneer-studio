type Conversation = { session: string; state: "idle" | "running" | "uncertain" };

/** Conversation IDs and reconciliation state live only in this signed-in tab. */
export class AgentConversations {
  private readonly conversations = new Map<string, Conversation>();
  private get(agentId: string): Conversation {
    let conversation = this.conversations.get(agentId);
    if (!conversation) {
      conversation = { session: crypto.randomUUID(), state: "idle" };
      this.conversations.set(agentId, conversation);
    }
    return conversation;
  }
  forAgent(agentId: string): string { return this.get(agentId).session; }
  begin(agentId: string): void {
    const conversation = this.get(agentId);
    if (conversation.state !== "idle") throw new Error("Review this conversation's files, status and logs before sending another task.");
    conversation.state = "running";
  }
  finish(agentId: string, completed: boolean): void { this.get(agentId).state = completed ? "idle" : "uncertain"; }
  needsReview(agentId: string): boolean { return this.get(agentId).state === "uncertain"; }
  reviewed(agentId: string): void {
    const conversation = this.get(agentId);
    if (conversation.state === "running") throw new Error("Wait for the active request to finish.");
    conversation.state = "idle";
  }
  clear(): void { this.conversations.clear(); }
}

export type DesktopRuntimeBinding = { agentId: string; generation?: number };
export function desktopRuntimeChanged(opened: DesktopRuntimeBinding, agentId: string, generation?: number): boolean {
  return opened.agentId !== agentId || (opened.generation !== undefined && generation !== undefined && opened.generation !== generation);
}
