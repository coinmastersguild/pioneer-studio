import AgentTaskArtifacts from "./AgentTaskArtifacts";
import { hostedAgentTaskMessage, type HostedAgentTask } from "./hostedAgentTask";

export default function HostedAgentTaskPanel({ task, apiKey, onReview }: { task: HostedAgentTask; apiKey: string; onReview: () => void }) {
  return <section className="agent-card" aria-label="Hosted agent task"><strong>{task.name}</strong>
    <p role="status">{hostedAgentTaskMessage(task)}</p>
    {task.text && <pre>{task.text}</pre>}
    {["complete", "empty"].includes(task.state) && task.outputPrefix && <AgentTaskArtifacts key={`${task.task_id}:${task.agent_id}:${task.outputPrefix}`} apiKey={apiKey} agentId={task.agent_id} prefix={task.outputPrefix} />}
    {task.state === "uncertain" && <button className="btn" onClick={onReview}>Review previous task</button>}
  </section>;
}
