import { useEffect, useState } from "react";
import {
  activeProjectId,
  API_BASE,
  closeProject,
  createProject,
  deleteProject,
  listMyCompanies,
  listProjects,
  openProject,
  projectOpeningMode,
  type Company,
  type ProjectSummary,
} from "./api";
import { relTime, type PS } from "./shared";
import { exportProjectToFile, importProjectFile, listCheckpoints, restoreCheckpoint, takeCheckpoint, type Checkpoint } from "./projectTransfer";
import { registerActions } from "./control";

// Lists the user's companies and every project they can see — personal ones
// plus every company's shared projects (the server returns those for any
// member, so a company's work shows up automatically on login). Opening a
// project loads its document and opens the editor containing authored work.
export default function ProjectsView({ ps }: { ps: PS }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState("personal"); // "personal" | companyAddress
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const active = activeProjectId();
  const [work, setWork] = useState(""); // export/import progress line
  const [cpFor, setCpFor] = useState<string | null>(null);
  const [cps, setCps] = useState<Checkpoint[]>([]);
  const progress = (verb: string) => (done: number, total: number) => setWork(`${verb} ${done}/${total} files…`);

  async function refresh() {
    if (!ps.apiKey) return;
    setErr("");
    try {
      const [c, p] = await Promise.all([listMyCompanies(ps.apiKey), listProjects(ps.apiKey)]);
      setCompanies(c);
      setProjects(p);
    } catch (e: any) {
      setErr(String(e.message || e));
    }
  }

  // Reload whenever this view becomes visible (so a project made elsewhere shows).
  useEffect(() => {
    if (ps.mode === "projects") refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ps.mode, ps.apiKey]);

  async function create() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const companyAddress = scope === "personal" ? undefined : scope;
      const proj = await createProject(ps.apiKey, title.trim(), companyAddress);
      setTitle("");
      await refresh();
      open(proj.id);
    } catch (e: any) {
      ps.toast(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function open(id: string) {
    try {
      const doc = await openProject(ps.apiKey, id);
      ps.setBoard(doc);
      ps.setMode(projectOpeningMode(doc));
      ps.toast("Project opened", "gold");
    } catch (e: any) {
      ps.toast(String(e.message || e));
    }
  }

  function close() {
    closeProject();
    ps.refreshBoard();
    ps.toast("Back to local board", "gold");
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This can't be undone.`)) return;
    try {
      await deleteProject(ps.apiKey, id);
      // deleting the open project: drop back to local so edits stop PUTting to it
      if (activeProjectId() === id) {
        closeProject();
        ps.refreshBoard();
      }
      await refresh();
    } catch (e: any) {
      ps.toast(String(e.message || e));
    }
  }

  async function exportOne(id: string) {
    try {
      const m = await exportProjectToFile(ps.apiKey, id, progress("Exporting"));
      ps.toast(`Exported ${m.assets.length} files, every one verified`, "gold");
    } catch (e: any) {
      if (e?.name !== "AbortError") ps.toast(String(e.message || e));
    } finally {
      setWork("");
    }
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    try {
      const ask = (n: number, bytes: number, name: string) =>
        confirm(`Import "${name}" as a new project? ${n ? `${n} file(s), ${(bytes / 1e6).toFixed(1)} MB, will be uploaded (each upload uses intake credits).` : "Every file is already in your media, nothing to upload."}`);
      const p = await importProjectFile(ps.apiKey, file, ask, progress("Importing"));
      if (!p) return;
      ps.toast(`Imported "${p.title}"`, "gold");
      await refresh();
    } catch (e: any) {
      ps.toast(String(e.message || e));
    } finally {
      setWork("");
    }
  }

  async function showCheckpoints(id: string) {
    if (cpFor === id) return setCpFor(null);
    setCpFor(id);
    setCps([]);
    try {
      setCps(await listCheckpoints(ps.apiKey, id));
    } catch (e: any) {
      ps.toast(String(e.message || e));
    }
  }

  async function checkpointNow(id: string) {
    try {
      await takeCheckpoint(ps.apiKey, id, "manual");
      setCps(await listCheckpoints(ps.apiKey, id));
    } catch (e: any) {
      ps.toast(String(e.message || e));
    }
  }

  async function restore(id: string, cp: Checkpoint) {
    if (!confirm(`Restore "${cp.title}" to rev ${cp.rev} (${new Date(cp.at).toLocaleString()})? The current state is checkpointed first.`)) return;
    try {
      await restoreCheckpoint(ps.apiKey, id, cp.id);
      setCps(await listCheckpoints(ps.apiKey, id));
      if (activeProjectId() === id) await open(id);
      ps.toast(`Restored rev ${cp.rev}`, "gold");
    } catch (e: any) {
      ps.toast(String(e.message || e));
    }
  }

  // Agents get the same rollback path the buttons use.
  useEffect(() => {
    if (!ps.apiKey) return;
    registerActions([
      { name: "projects.checkpoints", description: "List a project's checkpoints (newest first).", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        run: (p) => listCheckpoints(ps.apiKey, String(p?.id)) },
      { name: "projects.checkpoint", description: "Save a checkpoint of a project now.", parameters: { type: "object", properties: { id: { type: "string" }, label: { type: "string" } }, required: ["id"] },
        run: (p) => takeCheckpoint(ps.apiKey, String(p?.id), String(p?.label ?? "agent")) },
      { name: "projects.restore", description: "Restore a project to a checkpoint (the current state is checkpointed first).", confirmation: "Restore this project to an earlier checkpoint?",
        parameters: { type: "object", properties: { id: { type: "string" }, checkpoint: { type: "string" } }, required: ["id", "checkpoint"] },
        run: (p) => restoreCheckpoint(ps.apiKey, String(p?.id), String(p?.checkpoint)) },
    ]);
  }, [ps.apiKey]);

  const nameFor = (addr: string) => companies.find((c) => c.companyAddress === addr)?.name || `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  const personal = projects.filter((p) => p.ownerType === "personal");
  const byCompany = (addr: string) => projects.filter((p) => p.ownerType === "company" && p.owner === addr);

  // Per-project tools: export, and the checkpoint list (restore / checkpoint now).
  const row = (p: ProjectSummary) => (
    <>
      <button type="button" className="pill" onClick={() => exportOne(p.id)} title="Export as a .pstudio bundle">Export</button>
      <button type="button" className={`pill ${cpFor === p.id ? "on" : ""}`} onClick={() => showCheckpoints(p.id)} title="Checkpoints">⟲</button>
      {cpFor === p.id && (
        <div style={{ flexBasis: "100%", fontSize: 12, marginTop: 6 }}>
          <button type="button" className="pill" onClick={() => checkpointNow(p.id)}>Checkpoint now</button>
          {cps.length === 0 && <span style={{ opacity: 0.5, marginLeft: 8 }}>No checkpoints yet.</span>}
          {cps.map((c) => (
            <div key={c.id} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
              <span style={{ flex: 1, opacity: 0.85 }}>rev {c.rev} · {relTime(c.at)}{c.label ? ` · ${c.label}` : ""}</span>
              <button type="button" className="pill" onClick={() => restore(p.id, c)}>Restore</button>
            </div>
          ))}
        </div>
      )}
    </>
  );

  if (!ps.apiKey) {
    return (
      <div style={pad}>
        <h2 style={{ margin: 0 }}>Projects</h2>
        <p style={{ opacity: 0.7 }}>Connect your wallet or add an sk-pioneer key in Settings to see your companies and projects.</p>
      </div>
    );
  }

  return (
    <div style={pad}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h2 style={{ margin: 0 }}>Projects</h2>
        <button type="button" className="pill" onClick={refresh}>Refresh</button>
        <label className="pill" style={{ cursor: "pointer" }} title="Import a .pstudio project bundle as a new project">
          Import…
          <input type="file" accept=".pstudio,application/zip" hidden onChange={(e) => importFile(e.target.files?.[0])} />
        </label>
        {active && (
          <button type="button" className="pill" onClick={close}>
            Close project — back to local board
          </button>
        )}
      </div>
      {err && <p style={{ color: "#f88" }}>{err}</p>}
      {work && <p style={{ fontSize: 13, opacity: 0.8 }}>{work}</p>}

      {/* Company status — always shown so it's clear whether you're in a company */}
      <div style={{ ...rowStyle, margin: "12px 0 4px", display: "block" }}>
        {companies.length === 0 ? (
          <span style={{ fontSize: 13, opacity: 0.85 }}>
            You're not in a company yet. Company projects are shared with every member.{" "}
            <a href={`${API_BASE}/companies/create`} target="_blank" rel="noreferrer" style={{ color: "#22c55e" }}>
              Start a company ↗
            </a>{" "}
            <span style={{ opacity: 0.5 }}>(one-time LP burn)</span>
          </span>
        ) : (
          <span style={{ fontSize: 13, opacity: 0.85 }}>
            In {companies.length} {companies.length === 1 ? "company" : "companies"}:{" "}
            {companies.map((c) => c.name || nameFor(c.companyAddress)).join(", ")}.{" "}
            <a href={`${API_BASE}/companies/create`} target="_blank" rel="noreferrer" style={{ color: "#22c55e" }}>
              New company ↗
            </a>
          </span>
        )}
      </div>

      {/* New project */}
      <div style={{ display: "flex", gap: 8, margin: "14px 0 22px", flexWrap: "wrap" }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          placeholder="New project title…"
          style={{ flex: "1 1 240px", minWidth: 200, ...inputStyle }}
        />
        <select value={scope} onChange={(e) => setScope(e.target.value)} style={inputStyle}>
          <option value="personal">Personal</option>
          {companies.map((c) => (
            <option key={c.companyAddress} value={c.companyAddress}>
              {c.name || nameFor(c.companyAddress)} (shared)
            </option>
          ))}
        </select>
        <button type="button" className="pill on" onClick={create} disabled={busy || !title.trim()}>
          Create
        </button>
      </div>

      <Section title="Personal" projects={personal} active={active} onOpen={open} onDelete={remove} row={row} />
      {companies.map((c) => (
        <Section
          key={c.companyAddress}
          title={`${c.name || nameFor(c.companyAddress)} · shared`}
          subtitle={c.role}
          projects={byCompany(c.companyAddress)}
          active={active}
          onOpen={open}
          onDelete={remove}
          row={row}
        />
      ))}
    </div>
  );
}

function Section({
  title, subtitle, projects, active, onOpen, onDelete, row,
}: {
  title: string; subtitle?: string; projects: ProjectSummary[]; active: string | null;
  onOpen: (id: string) => void; onDelete: (id: string, name: string) => void; row: (p: ProjectSummary) => React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, letterSpacing: 0.3 }}>{title}</h3>
        {subtitle && <span style={{ opacity: 0.5, fontSize: 12 }}>{subtitle}</span>}
      </div>
      {projects.length === 0 ? (
        <p style={{ opacity: 0.4, fontSize: 13, margin: "4px 0" }}>No projects yet.</p>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {projects.map((p) => (
            <div key={p.id} style={{ ...rowStyle, flexWrap: "wrap", outline: p.id === active ? "1px solid #22c55e" : "none" }}>
              <button type="button" onClick={() => onOpen(p.id)} style={openBtn}>
                <b>{p.title}</b>
                <span style={{ opacity: 0.5, fontSize: 12, marginLeft: 8 }}>
                  {relTime(p.updatedAt)}{p.id === active ? " · open" : ""}
                </span>
              </button>
              {row(p)}
              <button type="button" className="pill" onClick={() => onDelete(p.id, p.title)} title="Delete">✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const pad: React.CSSProperties = { padding: 24, maxWidth: 720, overflowY: "auto", height: "100%" };
const inputStyle: React.CSSProperties = { background: "#0e1a14", border: "1px solid #1e3a2a", color: "#e8f0ea", borderRadius: 8, padding: "8px 10px", fontSize: 14 };
const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, background: "#0e1a14", border: "1px solid #1a2c22", borderRadius: 8, padding: "8px 10px" };
const openBtn: React.CSSProperties = { flex: 1, textAlign: "left", background: "none", border: "none", color: "#e8f0ea", cursor: "pointer", padding: 0 };
