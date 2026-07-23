import { useEffect, useState } from "react";
import {
  API_BASE,
  fetchCompanyLeaderboard,
  joinCompany,
  listMyCompanies,
  setCompanyInvite,
  type CompanyLeaderboardEntry,
} from "./api";
import { type PS } from "./shared";

// Public company directory / leaderboard (ranked by member count). Any company
// can be joined via its invite link if the owner turned on open invites — the
// request still lands in the owner's approval queue. Owners get an invite-link
// copy button and an open-invites toggle on their own rows.
export default function CompaniesView({ ps }: { ps: PS }) {
  const [rows, setRows] = useState<CompanyLeaderboardEntry[]>([]);
  const [roles, setRoles] = useState<Record<string, string>>({}); // companyAddress → my role
  const [err, setErr] = useState("");
  const [pending, setPending] = useState<Record<string, boolean>>({}); // addr → request sent this session

  async function refresh() {
    setErr("");
    try {
      const board = await fetchCompanyLeaderboard();
      setRows(board);
      if (ps.apiKey) {
        const mine = await listMyCompanies(ps.apiKey);
        setRoles(Object.fromEntries(mine.map((c) => [c.companyAddress, c.role])));
      } else {
        setRoles({});
      }
    } catch (e: any) {
      setErr(String(e.message || e));
    }
  }

  useEffect(() => {
    if (ps.mode === "companies") refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ps.mode, ps.apiKey]);

  // Invite-link deep link: /?join=<companyAddress> → auto-request once when authed.
  useEffect(() => {
    if (ps.mode !== "companies") return;
    const addr = new URLSearchParams(location.search).get("join");
    if (!addr) return;
    if (!ps.apiKey) {
      ps.toast("Connect your wallet or add a key to join");
      return;
    }
    history.replaceState(null, "", location.pathname);
    join(addr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ps.mode, ps.apiKey]);

  async function join(addr: string) {
    try {
      const r = await joinCompany(ps.apiKey, addr);
      setPending((p) => ({ ...p, [addr]: true }));
      ps.toast(r.status === "already_member" ? "You're already a member" : "Join request sent — awaiting owner approval", "gold");
      refresh();
    } catch (e: any) {
      ps.toast(String(e.message || e));
    }
  }

  async function toggleInvite(addr: string, on: boolean) {
    try {
      await setCompanyInvite(ps.apiKey, addr, on);
      setRows((rs) => rs.map((r) => (r.companyAddress === addr ? { ...r, openInvite: on } : r)));
      ps.toast(on ? "Open invites enabled" : "Open invites disabled");
    } catch (e: any) {
      ps.toast(String(e.message || e));
    }
  }

  function copyInvite(addr: string) {
    const link = `${location.origin}/?join=${addr}`;
    if (!navigator.clipboard) {
      ps.toast(link); // no Clipboard API (insecure context) — show the link instead
      return;
    }
    navigator.clipboard.writeText(link).then(
      () => ps.toast("Invite link copied", "ok"),
      () => ps.toast(link),
    );
  }

  return (
    <div style={pad}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h2 style={{ margin: 0 }}>Companies</h2>
        <button type="button" className="pill" onClick={refresh}>Refresh</button>
        <a href={`${API_BASE}/companies/create`} target="_blank" rel="noreferrer" className="pill on" style={{ textDecoration: "none" }}>
          Start a company ↗
        </a>
      </div>
      {err && <p style={{ color: "#f88" }}>{err}</p>}
      {!ps.apiKey && <p style={{ opacity: 0.6, fontSize: 13 }}>Connect your wallet to join a company or manage your own.</p>}

      <div style={{ display: "grid", gap: 6, marginTop: 16 }}>
        {rows.length === 0 && <p style={{ opacity: 0.4 }}>No companies yet.</p>}
        {rows.map((c, i) => {
          const role = roles[c.companyAddress];
          const isOwner = role === "owner";
          const isMember = !!role;
          return (
            <div key={c.companyAddress} style={rowStyle}>
              <span style={{ opacity: 0.4, width: 22, textAlign: "right" }}>{i + 1}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{c.name || c.slug || `${c.companyAddress.slice(0, 8)}…`}</b>
                {c.slug && <span style={{ opacity: 0.4, fontSize: 12, marginLeft: 6 }}>{c.slug}.pioneers.dev</span>}
                <div style={{ fontSize: 12, opacity: 0.55, marginTop: 2 }}>
                  {c.memberCount} member{c.memberCount === 1 ? "" : "s"}
                  {isMember && <span style={{ color: "#22c55e" }}> · you're {role}</span>}
                  {c.openInvite && <span style={{ opacity: 0.7 }}> · open invites</span>}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {isOwner && (
                  <>
                    <button type="button" className="pill" onClick={() => copyInvite(c.companyAddress)}>Copy invite</button>
                    <button type="button" className={`pill${c.openInvite ? " on" : ""}`} onClick={() => toggleInvite(c.companyAddress, !c.openInvite)}>
                      {c.openInvite ? "Invites: on" : "Invites: off"}
                    </button>
                  </>
                )}
                {!isMember && c.openInvite && (
                  <button type="button" className="pill on" disabled={!ps.apiKey || pending[c.companyAddress]} onClick={() => join(c.companyAddress)}>
                    {pending[c.companyAddress] ? "Requested" : "Request to join"}
                  </button>
                )}
                {!isMember && !c.openInvite && <span style={{ opacity: 0.35, fontSize: 12 }}>invite-only</span>}
                {isMember && !isOwner && <span style={{ color: "#22c55e", fontSize: 13 }}>Member ✓</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const pad: React.CSSProperties = { padding: 24, maxWidth: 760, overflowY: "auto", height: "100%" };
const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, background: "#0e1a14", border: "1px solid #1a2c22", borderRadius: 8, padding: "10px 12px" };
