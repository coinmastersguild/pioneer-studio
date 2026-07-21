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
  type Company,
  type ProjectSummary,
} from "./api";
import { relTime, type PS } from "./shared";

// Lists the user's companies and every project they can see — personal ones
// plus every company's shared projects (the server returns those for any
// member, so a company's work shows up automatically on login). Opening a
// project loads its doc into the storyboard and jumps to that view.
export default function ProjectsView({ ps }: { ps: PS }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState("personal"); // "personal" | companyAddress
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const active = activeProjectId();

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
      await openProject(ps.apiKey, id);
      ps.refreshBoard();
      ps.setMode("board");
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

  const nameFor = (addr: string) => companies.find((c) => c.companyAddress === addr)?.name || `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  const personal = projects.filter((p) => p.ownerType === "personal");
  const byCompany = (addr: string) => projects.filter((p) => p.ownerType === "company" && p.owner === addr);

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
        {active && (
          <button type="button" className="pill" onClick={close}>
            Close project — back to local board
          </button>
        )}
      </div>
      {err && <p style={{ color: "#f88" }}>{err}</p>}

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

      <Section title="Personal" projects={personal} active={active} onOpen={open} onDelete={remove} />
      {companies.map((c) => (
        <Section
          key={c.companyAddress}
          title={`${c.name || nameFor(c.companyAddress)} · shared`}
          subtitle={c.role}
          projects={byCompany(c.companyAddress)}
          active={active}
          onOpen={open}
          onDelete={remove}
        />
      ))}
    </div>
  );
}

function Section({
  title, subtitle, projects, active, onOpen, onDelete,
}: {
  title: string; subtitle?: string; projects: ProjectSummary[]; active: string | null;
  onOpen: (id: string) => void; onDelete: (id: string, name: string) => void;
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
            <div key={p.id} style={{ ...rowStyle, outline: p.id === active ? "1px solid #22c55e" : "none" }}>
              <button type="button" onClick={() => onOpen(p.id)} style={openBtn}>
                <b>{p.title}</b>
                <span style={{ opacity: 0.5, fontSize: 12, marginLeft: 8 }}>
                  {relTime(p.updatedAt)}{p.id === active ? " · open" : ""}
                </span>
              </button>
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
