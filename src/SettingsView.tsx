import { API_BASE } from "./api";
import { type PS } from "./shared";

// Auth/account state lives in App (it's app-wide, not per-view), so Settings
// receives it directly rather than through the PS view contract.
export type SettingsAuth = {
  apiKey: string;
  setApiKey: (k: string) => void;
  wallet: string;
  onConnectWallet: () => void;
  signOut: () => void;
  credits: number | null;
  usedGb: number;
  mediaCount: number;
};

// ps_storyboard / ps_pipeline_* / ps_phase are the local-first caches the
// pipeline writes while a project is operating in local-only mode.
function clearLocalData() {
  for (const k of Object.keys(localStorage)) {
    if (k === "ps_storyboard" || k === "ps_phase" || k.startsWith("ps_pipeline_")) localStorage.removeItem(k);
  }
  location.reload();
}

export default function SettingsView({ ps, auth }: { ps: PS; auth: SettingsAuth }) {
  const { apiKey, setApiKey, wallet, onConnectWallet, signOut, credits, usedGb, mediaCount } = auth;

  return (
    <div className="media-wrap">
      <div className="media-head">
        <div>
          <h2>Settings</h2>
          <div className="sub">Your account, sign-in, and local data. Nothing here leaves this browser except the key you send with each request.</div>
        </div>
      </div>

      {/* Account */}
      <div className="media-billing">
        <div className="bill-card">
          <span className="eyebrow">Credits</span>
          <div className="stat-value">{credits === null ? "—" : credits.toLocaleString()}</div>
          <div className="foot-note">
            fund at <b>alpha.pioneers.dev/leaderboard</b>
          </div>
        </div>
        <div className="bill-card">
          <span className="eyebrow">Storage used</span>
          <div className="stat-value">
            {usedGb.toFixed(2)} <span>GB</span>
          </div>
          <div className="foot-note">{mediaCount} objects on R2</div>
        </div>
        <div className="bill-card">
          <span className="eyebrow">Wallet</span>
          <div className="stat-value" style={{ fontSize: 16 }}>{wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "not connected"}</div>
          <div className="foot-note">
            <button type="button" className="btn" onClick={onConnectWallet}>
              {wallet ? "Reconnect" : "Connect wallet"}
            </button>
          </div>
        </div>
      </div>

      {/* Sign-in / key */}
      <div style={{ marginBottom: 22 }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 14 }}>Sign in</h3>
        <div className="sub" style={{ marginBottom: 10 }}>
          Paste an <code>sk-pioneer-…</code> key, or connect a wallet above (both land in the same session-only slot — a wallet mints a JWT). Required before any job runs.
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", maxWidth: 560 }}>
          <input
            type="password"
            placeholder="sk-pioneer-…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            style={{
              flex: 1, padding: "9px 12px", fontSize: 13, borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-strong)", background: "var(--bg-accent)", color: "var(--fg1)",
            }}
          />
          {apiKey && (
            <button type="button" className="btn" onClick={signOut}>
              Sign out
            </button>
          )}
        </div>
      </div>

      {/* Backend + local data */}
      <div style={{ marginBottom: 22 }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 14 }}>Backend</h3>
        <div className="sub">
          API: <code>{API_BASE}</code>
        </div>
      </div>

      <div>
        <h3 style={{ margin: "0 0 4px", fontSize: 14 }}>Local data</h3>
        <div className="sub" style={{ marginBottom: 10 }}>
          Your storyboard and pipeline are cached in this browser for local-only projects. Clearing resets them here only.
        </div>
        <button type="button" className="btn" onClick={() => { ps.toast("local storyboard cleared", "ok"); setTimeout(() => clearLocalData(), 600); }}>
          Clear local storyboard & pipeline
        </button>
      </div>
    </div>
  );
}
