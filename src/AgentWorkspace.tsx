import { useEffect, useRef, useState } from "react";
import { agentRequest, downloadAgentFile, type AgentFile } from "./api";
import { canEditWorkspaceFile, saveWorkspaceDownload, workspaceEntryPath, type AgentFileArea } from "./agentWorkspaceFiles";

export default function AgentWorkspace({ apiKey, agentId, initialPath = "", onEdit, onClose }: {
  apiKey: string; agentId: string; initialPath?: string; onEdit: (path: string, area: AgentFileArea) => void; onClose: () => void;
}) {
  const [area, setArea] = useState<AgentFileArea>("projects");
  const [directory, setDirectory] = useState(initialPath);
  const [files, setFiles] = useState<AgentFile[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController(); request.current = abort;
    setBusy(true); setError(""); setFiles([]);
    void (async () => {
      try {
        const query = new URLSearchParams({ area, path: directory });
        const result = await agentRequest<{ entries: AgentFile[] }>(apiKey, `/${encodeURIComponent(agentId)}/files?${query}`, { signal: abort.signal });
        if (!Array.isArray(result.entries) || result.entries.length > 1000) throw new Error();
        for (const file of result.entries) {
          workspaceEntryPath(directory, file.name);
          if (typeof file.dir !== "boolean") throw new Error();
        }
        if (!abort.signal.aborted) setFiles(result.entries);
      } catch { if (!abort.signal.aborted) setError("Files are unavailable. Refresh or check the agent's status."); }
      finally { if (!abort.signal.aborted) setBusy(false); }
    })();
    return () => { abort.abort(); };
  }, [apiKey, agentId, area, directory, refresh]);
  async function download(file: AgentFile) {
    if (busy) return;
    const abort = new AbortController(); request.current?.abort(); request.current = abort;
    setBusy(true); setError("");
    try {
      const path = workspaceEntryPath(directory, file.name);
      const blob = await downloadAgentFile(apiKey, agentId, path, abort.signal, area);
      if (!abort.signal.aborted) saveWorkspaceDownload(blob, path);
    } catch { if (!abort.signal.aborted) setError("Download did not complete. Refresh files before trying again."); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  useEffect(() => () => { request.current?.abort(); }, [apiKey, agentId]);
  function switchArea(next: AgentFileArea) { setArea(next); setDirectory(""); }
  return <section className="agent-card" aria-label="Agent files">
    <h3>Agent files</h3>
    <div className="agent-file-navigation">
      <button className="btn" aria-pressed={area === "projects"} disabled={busy} onClick={() => switchArea("projects")}>Projects</button>
      <button className="btn" aria-pressed={area === "workspace"} disabled={busy} onClick={() => switchArea("workspace")}>Workspace</button>
      <button className="btn" disabled={busy || !directory} onClick={() => setDirectory(directory.split("/").slice(0, -1).join("/"))}>Parent directory</button>
      <button className="btn" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>Refresh files</button>
      <button className="btn" onClick={onClose}>Close files</button>
    </div>
    <p>{area === "projects" ? "Persistent project files and browser downloads." : "Runtime workspace and saved desktop artifacts."} /{directory}</p>
    <p>Ask the agent to write each deliverable to a saved file. Chat does not export screenshot tool attachments. Download images, Blender scenes and other binary artifacts here; only text files open in the editor.</p>
    {busy && <p role="status">Loading files…</p>}
    {error && <p role="alert">{error}</p>}
    <ul className="agent-file-list">{files.map((file) => <li key={file.name}>
      <span>{file.name}{!file.dir && typeof file.size === "number" ? ` · ${file.size.toLocaleString()} bytes` : ""}</span>
      {file.dir ? <button className="btn" aria-label={`Open folder ${file.name}`} disabled={busy} onClick={() => setDirectory(workspaceEntryPath(directory, file.name))}>Open folder</button> : <>
        <button className="btn" aria-label={`Download ${file.name}`} disabled={busy} onClick={() => void download(file)}>Download</button>
        {canEditWorkspaceFile(file) && <button className="btn" aria-label={`Edit ${file.name}`} disabled={busy} onClick={() => onEdit(workspaceEntryPath(directory, file.name), area)}>Edit text</button>}
      </>}
    </li>)}</ul>
    {!busy && !error && !files.length && <p>Empty directory.</p>}
  </section>;
}
