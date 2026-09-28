import type { WalletChoice } from "./api";

export type SignInFormProps = {
  remember: boolean;
  onRemember: (remember: boolean) => void;
  progress: string;
  detail: string;
  error: string;
  onConnect: (choice: WalletChoice) => void;
  onCancel: () => void;
  keyDraft: string;
  onKeyDraft: (value: string) => void;
  onKeySubmit: () => void;
};

export default function SignInForm(props: SignInFormProps) {
  return (
    <div className="sign-in-form">
      <fieldset disabled={!!props.progress}>
        <div className="sign-in-wallets">
          <button type="button" className="gate-connect" onClick={() => props.onConnect("keepkey")}>Connect KeepKey</button>
          <button type="button" className="btn" onClick={() => props.onConnect("browser")}>Other wallet</button>
        </div>
        <label className="remember-wallet">
          <input type="checkbox" checked={props.remember} onChange={(event) => props.onRemember(event.target.checked)} />
          Remember me
        </label>
        <p className="gate-note">{props.remember ? "Wallet sign-in stays on this device until your session expires." : "Wallet sign-in lasts only in this browser tab."} Signing in does not send a transaction.</p>
        <div className="gate-or">or use a Pioneer key</div>
        <form onSubmit={(event) => { event.preventDefault(); props.onKeySubmit(); }}>
          <input type="password" className="gate-key" name="pioneer-key" aria-label="Pioneer API key" placeholder="sk-pioneer-…" autoComplete="off" value={props.keyDraft} onChange={(event) => props.onKeyDraft(event.target.value)} />
          <button type="submit" className="btn" disabled={!props.keyDraft.trim()}>Sign in with key</button>
        </form>
        <p className="gate-note">Pasted API keys are never saved.</p>
      </fieldset>
      {props.progress && <div className="sign-in-progress" role="status"><strong>{props.progress}</strong>{props.detail && <span>{props.detail}</span>}<button type="button" className="mini-btn" onClick={props.onCancel}>Cancel sign-in</button></div>}
      {props.error && <div className="sign-in-error" role="alert">{props.error}</div>}
    </div>
  );
}
