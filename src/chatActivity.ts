export type ChatRunStage = "thinking" | "running" | "reviewing the result";

export type ChatActivity = {
  count: number;
  label: string;
  working: boolean;
};

// Chat requests finish independently. Keeping their stages by request prevents
// the first completed render from marking the copilot idle while others run.
export class ChatRunTracker {
  private readonly runs = new Map<string, ChatRunStage>();

  start(id: string): ChatActivity {
    this.runs.set(id, "thinking");
    return this.snapshot();
  }

  setStage(id: string, stage: ChatRunStage): ChatActivity {
    if (this.runs.has(id)) this.runs.set(id, stage);
    return this.snapshot();
  }

  finish(id: string): ChatActivity {
    this.runs.delete(id);
    return this.snapshot();
  }

  snapshot(): ChatActivity {
    const count = this.runs.size;
    if (!count) return { count: 0, label: "idle", working: false };
    if (count === 1) return { count, label: this.runs.values().next().value!, working: true };
    return { count, label: `${count} generations running`, working: true };
  }
}
