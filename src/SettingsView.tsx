import { API_BASE } from "./api";
import SignInForm, { type SignInFormProps } from "./SignInForm";
import { type PS } from "./shared";

// Auth/account state lives in App (it's app-wide, not per-view), so Settings
// receives it directly rather than through the PS view contract.
export type SettingsAuth = {
  hasCredential: boolean;
  signIn: SignInFormProps;
  wallet: string;
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
  const { hasCredential, wallet, signOut, credits, usedGb, mediaCount, signIn } = auth;

  return (
    <div className="media-wrap">
      <div className="media-head">
        <div>
          <h2>Settings</h2>
          <div className="sub">Your account, sign-in, and local project data.</div>
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

        </div>
      </div>

      {/* Sign-in / key */}
      <div style={{ marginBottom: 22 }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 14 }}>Sign in</h3>
        <SignInForm {...signIn} />
        {hasCredential && <button type="button" className="btn" style={{ marginTop: 12 }} onClick={signOut}>Sign out</button>}
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
