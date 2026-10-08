import { useEffect, useRef, useState } from "react";
import { agentRequest, downloadAgentFile, type AgentFile } from "./api";
import { taskArtifactFiles, verifiedVideoBlob } from "./taskArtifactFiles";
import { saveWorkspaceDownload } from "./agentWorkspaceFiles";

export default function AgentTaskArtifacts({ apiKey, agentId, prefix }: { apiKey: string; agentId: string; prefix: string }) {
  const [video, setVideo] = useState(""); const [source, setSource] = useState("");
  const [status, setStatus] = useState("Checking saved files for this task…"); const [playable, setPlayable] = useState(false);
  const [busy, setBusy] = useState(false); const sourceRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController(); let url = "";
    setVideo(""); setSource(""); setPlayable(false); setStatus("Checking saved files for this task…");
    void (async () => {
      try {
        const files = await agentRequest<{ entries: AgentFile[] }>(apiKey, `/${encodeURIComponent(agentId)}/files?area=workspace&path=desktop-test`, { signal: abort.signal });
        const outputs = taskArtifactFiles(prefix, files.entries);
        if (abort.signal.aborted) return;
        setSource(outputs.source?.name || "");
        if (!outputs.video) { setStatus("No matching saved MP4 for this task. Inspect the agent's files; a text reply does not prove a video was created."); return; }
        const blob = await verifiedVideoBlob(await downloadAgentFile(apiKey, agentId, `desktop-test/${outputs.video.name}`, abort.signal, "workspace"));
        if (abort.signal.aborted) return;
        url = URL.createObjectURL(blob); setVideo(url); setStatus("Saved MP4 found for this task; checking browser playback.");
      } catch { if (!abort.signal.aborted) setStatus("The saved video could not be verified. Inspect the agent's files and logs."); }
    })();
    return () => { abort.abort(); sourceRequest.current?.abort(); if (url) URL.revokeObjectURL(url); };
  }, [apiKey, agentId, prefix]);
  async function downloadSource() {
    if (!source || busy) return;
    const abort = new AbortController(); sourceRequest.current?.abort(); sourceRequest.current = abort; setBusy(true);
    try { const blob = await downloadAgentFile(apiKey, agentId, `desktop-test/${source}`, abort.signal, "workspace"); if (!abort.signal.aborted) saveWorkspaceDownload(blob, source); }
    catch { if (!abort.signal.aborted) setStatus("Source download did not complete."); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  useEffect(() => () => sourceRequest.current?.abort(), []);
  return <section className="agent-card agent-deliverables" aria-label="Task deliverables"><h3>Task deliverables</h3><p role="status">{status}</p>
    {video && <><video controls preload="metadata" src={video} aria-label="Agent video deliverable" onCanPlay={(event) => {
      const duration = event.currentTarget.duration;
      if (Number.isFinite(duration) && duration > 0 && event.currentTarget.videoWidth > 0 && event.currentTarget.videoHeight > 0) { setPlayable(true); setStatus(`Playable video · ${duration.toFixed(1)} seconds. Review it against your request.`); }
      else { setPlayable(false); setStatus("The saved video has no verified duration."); }
    }} onError={() => { setPlayable(false); setStatus("The saved video could not be played. Inspect its file before calling this task complete."); }} />
      <a className="btn" href={video} download={`${prefix}.mp4`}>Download MP4</a>{playable && <small>Browser can play a video stream; content still needs your review.</small>}</>}
    {source && <button className="btn" disabled={busy} aria-label={`Download ${source}`} onClick={() => void downloadSource()}>Download Blender source</button>}
  </section>;
}
