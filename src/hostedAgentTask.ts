export type HostedAgentTask = {
  task_id: string;
  agent_id: string;
  name: string;
  state: "checking" | "running" | "complete" | "empty" | "uncertain" | "failed";
  text: string;
  outputPrefix?: string;
  /** A new request was not dispatched; this is the previous task's progress. */
  existing?: boolean;
};

export function hostedAgentTaskMessage(task: HostedAgentTask): string {
  const previous = task.existing ? (["checking", "running"].includes(task.state) ? "Your new request was not sent. The agent is already working on its previous task. " : "Your new request was not sent. Showing the previous task’s outcome. ") : "";
  const messages = {
    checking: "Checking the selected agent's current access and runtime…",
    running: "Agent is working. Replies arrive after the task's tool work; this can take up to 15 minutes.",
    complete: "The agent reply completed. Review its saved output against your request.",
    empty: "The reply ended without text. Check saved files and logs; work may have been performed.",
    uncertain: "The request was interrupted and may still be running. It was not retried. Review the previous task before sending more work.",
    failed: "The task could not start. No substitute generation job was submitted.",
  };
  return previous + messages[task.state];
}
