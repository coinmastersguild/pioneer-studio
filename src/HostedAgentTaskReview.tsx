import { useState } from "react";
export default function HostedAgentTaskReview({ detail, onConfirm }: { detail: string; onConfirm: () => Promise<void> }) {
  const [state, setState] = useState("pending"); const [error, setError] = useState("");
  return <section className="agent-card"><p>{detail}</p>{state === "pending" ? <>
    <button className="btn" onClick={() => { setState("confirmed"); void onConfirm().catch((error) => { setState("failed"); setError(error instanceof Error ? error.message : "The reviewed task could not start. It was not retried."); }); }}>Confirm agent task</button>
    <button className="btn" onClick={() => setState("cancelled")}>Cancel agent task</button></> : <p>{state === "confirmed" ? "Confirmed; see the task progress below." : state === "failed" ? error : "Cancelled; no task was sent."}</p>}
  </section>;
}
