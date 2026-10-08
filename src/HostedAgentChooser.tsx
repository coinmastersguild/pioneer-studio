import { useState } from "react";
import { callAction } from "./control";

export type HostedAgentChoice = { id: string; name: string; status: string };
export default function HostedAgentChooser({ agents, onSelected }: { agents: HostedAgentChoice[]; onSelected: (agentId: string) => Promise<void> }) {
  const [selected, setSelected] = useState(""); const [consumed, setConsumed] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  return <section className="agent-card"><p>Select your own intended agent for this request.</p>
    {consumed ? <p>Agent selected. Follow this request’s task or review below; send a new request for further work.</p> : !agents.length ? <p>No hosted agents are available for this account. Claim one in Agents to begin.</p> : <>
      <select aria-label="Choose task agent" value={selected} disabled={busy} onChange={(event) => setSelected(event.target.value)}><option value="">Select an agent</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.status}</option>)}</select>
      <button className="btn" disabled={!selected || busy} onClick={() => { setBusy(true); setError(""); void (async () => {
        try { await callAction("agents.select", { agent_id: selected }); setConsumed(true); await onSelected(selected); }
        catch (error) { setError(error instanceof Error ? error.message : "Agent selection failed."); }
        finally { setBusy(false); }
      })(); }}>Use this agent</button></>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
