import { useEffect, useRef, useState } from "react";
import { getAgentMemory, memoryAvailability, setAgentMemoryEnabled, type AgentMemory } from "./agentMemory";

export default function AgentMemoryPanel({ apiKey, agentId, onClose }: { apiKey: string; agentId: string; onClose: () => void }) {
  const [memory, setMemory] = useState<AgentMemory | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<boolean | null>(null);
  const request = useRef<AbortController | null>(null);
  async function load() {
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    setBusy(true); setError("");
    try { const value = await getAgentMemory(apiKey, agentId, abort.signal); if (!abort.signal.aborted) setMemory(value); }
    catch { if (!abort.signal.aborted) { setMemory(null); setError("Memory status is unavailable. Refresh to check again."); } }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  useEffect(() => {
    setMemory(null); setConfirm(null); void load();
    return () => { request.current?.abort(); };
    // The request is scoped to this authenticated owner and agent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, agentId]);
  async function apply(enabled: boolean) {
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    setBusy(true); setConfirm(null); setError("");
    try { const value = await setAgentMemoryEnabled(apiKey, agentId, enabled, abort.signal); if (!abort.signal.aborted) setMemory(value); }
    catch { if (!abort.signal.aborted) { setMemory(null); setError("Memory policy was not confirmed. Refresh its status before changing it again."); } }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  return <section className="agent-card" aria-label="Agent memory">
    <h3>Persistent memory</h3>
    <p role="status">{memory ? memoryAvailability(memory) : busy ? "Checking memory status…" : "Unavailable"} · host-managed</p>
    <p>The agent explicitly remembers confirmed preferences, decisions and outcomes. Full transcripts are not saved automatically. Do not ask it to remember credentials or instructions from web pages.</p>
    <p>Pausing blocks new memory operations; in-flight work can finish. It does not delete remembered facts. Deleting the agent's files does not erase host memory. Fact browsing, export and deletion are not available here.</p>
    <p>Memory model computation is currently not included in the agent's displayed inference token usage. Memory has separate operation and concurrency limits.</p>
    {memory?.configured && <>
      <p>Available operations: {memory.operations.join(", ") || "none"}</p>
      <button className="btn" data-memory-toggle disabled={busy || confirm !== null} onClick={() => setConfirm(!memory.enabled)}>{memory.enabled ? "Pause memory" : "Resume memory"}</button>
      {confirm !== null && <div className="agent-confirm"><p>{confirm ? "Resume new memory operations using existing remembered facts?" : "Pause new memory operations? Existing facts will remain."}</p>
        <button className="btn" disabled={busy} onClick={() => void apply(confirm)}>{confirm ? "Confirm resume" : "Confirm pause"}</button>
        <button className="btn" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button></div>}
      <h4>Recent operations</h4>
      <p>Operation metadata only; remembered content is not shown.</p>
      {memory.recent_operations.length ? <ul>{memory.recent_operations.map((row, index) => <li key={`${row.ts}:${index}`}>{row.operation} · {row.status} · {new Date(row.ts * 1000).toLocaleString()}</li>)}</ul> : <p>No recent operations.</p>}
    </>}
    {error && <p role="alert">{error}</p>}
    <button className="btn" disabled={busy} onClick={() => { setConfirm(null); void load(); }}>Refresh memory</button>
    <button className="btn" onClick={onClose}>Close memory</button>
  </section>;
}
