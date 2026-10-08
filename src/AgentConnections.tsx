import { useEffect, useRef, useState } from "react";
import { AgentApiError, agentRequest, connectionMutation, connectionResources,
  type AgentAuthorization, type AgentConnection, type AgentConnectionCapabilities,
  type AgentConnectionMutation, type AgentInstallation, type AgentRepository } from "./api";
import { AGENT_TEMPLATE_URL } from "./agentRuntime";
import AgentGithubAuthorization from "./AgentGithubAuthorization";
import { connectionIsVerified, connectionReturnUrl, githubConnectionUrl, newConnectionMutation, repositoryBinding, connectionAvailabilityError, connectionCapabilitiesMessage } from "./agentConnectionState";

type Review = { title: string; detail: string; request: AgentConnectionMutation };
export default function AgentConnections({ apiKey, agentId, callbackId, required = false, provisioning = false, onClose }: {
  apiKey: string; agentId: string; callbackId?: string; required?: boolean; provisioning?: boolean; onClose: () => void;
}) {
  const [capabilities, setCapabilities] = useState<AgentConnectionCapabilities | null>(null);
  const [state, setState] = useState<AgentConnection | null>(null);
  const [connectionId, setConnectionId] = useState(callbackId || "");
  const [authorization, setAuthorization] = useState<AgentAuthorization | null>(null);
  const [installations, setInstallations] = useState<AgentInstallation[]>([]);
  const [installation, setInstallation] = useState(0);
  const [repositories, setRepositories] = useState<AgentRepository[]>([]);
  const [chosen, setChosen] = useState<number[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  const [pending, setPending] = useState<AgentConnectionMutation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [retryUntil, setRetryUntil] = useState(0);
  const [, tick] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const observationSequence = useRef(0);
  const root = `/${encodeURIComponent(agentId)}/connections`;
  const available = capabilities?.github_read === true;

  async function refresh(signal: AbortSignal) {
    const sequence = ++observationSequence.current;
    const caps = await agentRequest<AgentConnectionCapabilities>(apiKey, "/connections/capabilities", { signal });
    if (signal.aborted || sequence !== observationSequence.current) return;
    setCapabilities(caps); setError("");
    if (!caps.github_read) { setState(null); setStale(false); return; }
    const observation = await agentRequest<AgentConnection>(apiKey, root, { signal });
    if (!signal.aborted && sequence === observationSequence.current) {
      setState((old) => !old || observation.revision >= old.revision ? observation : old); setStale(false);
    }
  }
  function failure(e: unknown) {
    setError(e instanceof AgentApiError && (["capability_disabled", "capability_unavailable", "runtime_protocol_pending"].includes(e.code) || (e.code === "not_found" && !capabilities))
      ? connectionAvailabilityError(e.code) : e instanceof AgentApiError ? `Connection request failed (${e.code}). Refresh state or retry when available.` : "Connection request failed. Refresh state or retry the same request.");
    if (e instanceof AgentApiError && e.retryAfter !== null) setRetryUntil(Date.now() + e.retryAfter * 1000);
  }
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (locked.current || Date.now() < retryUntil) return;
    locked.current = true; setBusy(true); setError("");
    const controller = new AbortController(); abort.current = controller;
    try { await action(controller.signal); }
    catch (e) { if (!controller.signal.aborted) failure(e); }
    finally { if (!controller.signal.aborted) { locked.current = false; setBusy(false); } }
  }
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    let delay = 5000;
    async function poll() {
      if (locked.current) { timer = setTimeout(poll, 5000); return; }
      try { await refresh(controller.signal); delay = 10000; }
      catch (e) {
        if (!controller.signal.aborted) { setStale(true); failure(e); }
        delay = Math.min(delay * 2, 60000);
        if (e instanceof AgentApiError && e.retryAfter !== null) delay = Math.max(delay, e.retryAfter * 1000);
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, delay);
    }
    void poll();
    return () => { controller.abort(); abort.current?.abort(); clearTimeout(timer); };
    // The parent keys this component by authenticated session and agent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  async function resources(signal: AbortSignal, install?: number) {
    if (!connectionId) throw new Error("Authorize GitHub first.");
    const foundInstallations: AgentInstallation[] = [], foundRepositories: AgentRepository[] = [];
    let page: number | null = 1;
    const visited = new Set<number>();
    while (page !== null) {
      if (visited.has(page) || !Number.isSafeInteger(page) || page < 1 || page > 100) throw new Error("Invalid resource pagination.");
      visited.add(page);
      const result = await connectionResources(apiKey, agentId, connectionId, install, page, signal);
      foundInstallations.push(...result.installations || []); foundRepositories.push(...result.repositories || []);
      page = result.next_page;
    }
    if (signal.aborted) return;
    if (install === undefined) { setInstallations(foundInstallations); setInstallation(0); setRepositories([]); setChosen([]); }
    else { setRepositories(foundRepositories); setChosen([]); }
  }
  async function execute(request: AgentConnectionMutation, signal: AbortSignal) {
    setPending(request);
    let result: AgentAuthorization | AgentConnection | { accepted: boolean };
    try { result = await connectionMutation(apiKey, agentId, request, signal); }
    catch (e) {
      // Ambiguous failures retain the exact body and key; another mutation is blocked.
      if (!signal.aborted && e instanceof AgentApiError && e.status >= 400 && e.status < 500 && e.status !== 429) setPending(null);
      throw e;
    }
    if (signal.aborted) return;
    setPending(null);
    if ("revision" in result) setState((old) => !old || result.revision >= old.revision ? result as AgentConnection : old);
    if (request.path === "github/authorize") {
      const auth = result as AgentAuthorization;
      const safe = { ...auth, authorization_url: githubConnectionUrl(auth.authorization_url, "authorize") };
      setAuthorization(safe); setConnectionId(auth.connection_id);
      setInstallations([]); setRepositories([]); setChosen([]); setInstallation(0);
    }
    await refresh(signal);
  }
  const disabled = busy || provisioning || !!review || !!pending || retryUntil > Date.now();
  const verified = state && connectionIsVerified(state) && !stale;
  const installUrl = (() => {
    try { return capabilities ? githubConnectionUrl(capabilities.github_installation_url, "install") : null; }
    catch { return null; }
  })();
  const login = state?.github_identity?.login;
  const granted = state?.repositories.map((r) => r.full_name).join(", ");
  const status = !state ? "Not connected" : verified ? `Ready · reads ${granted}`
    : state.sync_pending ? "Delivering access to the agent…" : state.repositories.length ? `Granted ${granted} · not yet tested` : "Authorized · no repository chosen";
  return <section className="agent-card agent-connections" aria-label="Agent GitHub connections">
    <h3>{required ? "Connect this agent's repository" : "GitHub"}</h3>
    <p>Create one repository from the public template in your personal GitHub account. Pioneer grants read-only access to that repository, so the agent can pull what you push. The provided credential cannot push or access your other repositories.</p>
    {!state?.repositories.length && <p>No agent repository yet? <a href={AGENT_TEMPLATE_URL} target="_blank" rel="noopener noreferrer">Create one from the template</a>, then come back and sign in.</p>}
    {provisioning && <p>The agent is still starting. GitHub setup unlocks once it's ready.</p>}
    {!capabilities ? <p role="status">{stale ? "GitHub setup is unavailable right now. The agent still works." : "Checking GitHub availability…"}</p> : !available ? <p role="status">{connectionCapabilitiesMessage(capabilities)}</p> : <>
      <p role="status"><strong>{status}</strong>{login ? ` · GitHub account @${login}` : ""}{stale ? " · status may be out of date" : ""}</p>
      {state?.error_code && <p>Last error: {state.error_code}</p>}
      {state?.provider_revocation_pending && <p>Revoking the agent's GitHub access…</p>}
      {state?.legacy.state === "unknown" && <div>
        <p>Before connecting: has a GitHub token or Pioneer API key ever been pasted into this agent by hand?</p>
        <button className="btn" disabled={disabled} onClick={() => setReview({ title: "No hand-pasted credentials", detail: "I confirm nobody has given this agent a GitHub token or Pioneer key by hand.", request: newConnectionMutation("migration", "PUT", { declaration: "none" }) })}>No, never</button>
        <button className="btn" disabled={disabled} onClick={() => setReview({ title: "Pasted credentials revoked", detail: "I confirm every GitHub token and Pioneer key pasted into this agent is revoked on GitHub / Pioneer. Deleting the file is not enough. The agent will be reset before connecting.", request: newConnectionMutation("migration", "PUT", { declaration: "issuer_revoked" }) })}>Yes, and I revoked them</button>
      </div>}
      {state?.legacy.state === "cleanup_required" && <p>The agent is being reset to remove old pasted credentials. Connect once that finishes.</p>}
      {!verified && <button className="btn" disabled={disabled} onClick={() => setReview({ title: "Sign in with GitHub", detail: "GitHub opens in a new tab using whichever GitHub account this browser is signed in to. If that isn't your account, sign out of GitHub first.", request: newConnectionMutation("github/authorize", "POST", { return_url: connectionReturnUrl(window.location.href, agentId) }) })}>{connectionId ? "Sign in with GitHub again" : "1 · Sign in with GitHub"}</button>}
      {authorization && <AgentGithubAuthorization authorization={authorization} />}
      {connectionId && !verified && <div>
        <button className="btn" disabled={disabled} onClick={() => void run((signal) => resources(signal))}>2 · Load my repositories</button>
        {installUrl && <p>Repository missing? <a href={installUrl} target="_blank" rel="noopener noreferrer">Install Pioneer Studio Agents</a> and pick <em>Only select repositories</em>, then load again.</p>}
        {installations.length > 0 && <label>Account<select value={installation} disabled={disabled} onChange={(e) => {
          const value = Number(e.target.value); setInstallation(value); setRepositories([]); setChosen([]);
          if (value) void run((signal) => resources(signal, value));
        }}><option value={0}>Choose an account</option>{installations.map((i) => <option key={i.id} value={i.id}>{i.account}</option>)}</select></label>}
        {repositories.map((repo) => <label key={repo.id}><input type="radio" name="agent-repository" disabled={disabled} checked={chosen.includes(repo.id)} onChange={() => setChosen([repo.id])} /> {repo.full_name}</label>)}
        {repositories.length > 0 && <button className="btn" disabled={disabled || !state || stale || state.legacy.state !== "resolved" || !chosen.length} onClick={() => {
          if (!state) return;
          setReview({ title: "Give the agent read access", detail: `${repositories.filter((r) => chosen.includes(r.id)).map((r) => r.full_name).join(", ")} becomes this agent's repository. The agent can read it and nothing else. This replaces any earlier choice.`, request: newConnectionMutation("binding", "PUT", repositoryBinding(connectionId, installation, chosen, state.revision)) });
        }}>3 · Grant read access</button>}
      </div>}
      {!!state?.repositories.length && !verified && <button className="btn" disabled={disabled} onClick={() => setReview({ title: "Test access", detail: "The agent will try to read the chosen repository. Nothing is written.", request: newConnectionMutation("verify", "POST", {}) })}>4 · Test access</button>}
      {!!state?.repositories.length && <button className="btn" disabled={disabled} onClick={() => setReview({ title: "Disconnect GitHub", detail: "The agent loses repository access and its GitHub token is revoked.", request: newConnectionMutation("binding", "DELETE", null) })}>Disconnect</button>}
    </>}
    {pending && <div role="status"><p>We didn't hear back. Retry the same request before doing anything else.</p><button className="btn" disabled={busy || retryUntil > Date.now()} onClick={() => void run((signal) => execute(pending, signal))}>Retry</button></div>}
    {review && <div className="agent-confirm"><h4>{review.title}</h4><p>{review.detail}</p><button className="btn" disabled={busy || provisioning || retryUntil > Date.now()} onClick={() => { const request = review.request; setReview(null); void run((signal) => execute(request, signal)); }}>Confirm</button> <button className="btn" disabled={busy} onClick={() => setReview(null)}>Cancel</button></div>}
    {error && <p role="alert">{error}{retryUntil > Date.now() ? ` Retry in ${Math.ceil((retryUntil - Date.now()) / 1000)}s.` : ""}</p>}
    <button className="btn" disabled={busy || !!review} onClick={() => void run(refresh)}>Refresh</button>
    <button className="btn" disabled={busy || !!pending} onClick={onClose}>Close</button>
  </section>;
}
