import { walletSessionFromResponse, type WalletSession } from "./authSession";
import type { WalletOption } from "./wallets";
import { agentErrorDetails } from "./agentReply";
/** Public, metered Pioneer API. Users provide their own credential at runtime. */
export const API_BASE = "https://alpha.pioneers.dev";

export type JobParamSchema = {
  type: "str" | "int" | "float" | "bool" | "list" | "path-or-url" | "list-of-path-or-url";
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  enum?: unknown[];
};
export type JobModel = {
  model: string;
  endpoint: string;
  default?: boolean;
  credits: number;
  note: string;
  params?: Record<string, JobParamSchema>;
  result?: "json" | "binary";
  result_ext?: string | null;
  pricing?: {
    reserved_gpu_gb: number;
    reserved_seconds: number;
    credits_per_gpu_gb_hour: number;
  };
};
export type ModelsResponse = {
  catalog_revision?: string;
  jobs: JobModel[];
  usage: string;
  limits: Record<string, number>;
};
export type SubmitResponse = {
  job_id: string;
  status: string;
  model: string;
  endpoint: string;
  credits_charged: number;
  credits_remaining: number;
};
export type JobStatus = {
  job_id: string;
  status: string;
  stage: string | null;
  error: string | null;
  log_tail?: string[];
};
export type MediaObject = {
  key: string;
  name: string;
  url: string;
  bytes: number;
  content_type: string;
  type: "reference" | "result";
  added: number;
};
export type MediaList = {
  objects: MediaObject[];
  total_bytes: number;
  monthly_cr: number;
  daily_cr: number;
  rate?: string;
};
export type UploadResponse = {
  url: string;
  key: string;
  content_type: string;
  bytes: number;
  credits_charged: number;
  credits_remaining: number;
};

export function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

let onAuthRejected: ((credential: string) => void) | undefined;
export function setAuthErrorHandler(handler?: (credential: string) => void): void {
  onAuthRejected = handler;
}

/** Notify the shell only for the credential rejected by an authenticated API call. */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401 && input.startsWith(`${API_BASE}/`)) {
    const authorization = new Headers(init?.headers).get("authorization");
    if (authorization?.startsWith("Bearer ")) onAuthRejected?.(authorization.slice(7));
  }
  return response;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

export type HostedAgent = {
  id: string; name: string; template: string; status: string; network: string;
  token_budget: number; credits_paid: number; cpus: number; mem_gb: number; disk_gb: number;
  observed_at: number | null; pending_operation_id?: string | null;
  setup_required?: boolean; setup_state?: "not_required" | "pending" | "ready" | "blocked" | "suspended";
  /** Runtime state from the bound repository. Absent until Alpha ships repo runs. */
  source?: { full_name: string; commit: string | null; synced_at: number | null } | null;
  unlocked?: boolean;
  live: { budget_tokens: number; used_tokens: number; remaining_tokens: number; state?: string; status?: string; container?: string } | null;
};
export type AgentCatalog = {
  network: string; tokens_per_credit: number | null; purchasing_enabled: boolean;
  setup_required?: boolean;
  /** Each flag is false until Alpha enables that route; Studio keeps the control disabled. */
  features?: { unlock?: boolean; sync?: boolean; desktop?: boolean };
  templates: string[]; planned_templates?: string[];
  limits: { agents: number; cpus: number; mem_gb: number; disk_gb: number; per_agent: { cpus: number; mem_gb: number; disk_gb: number }; file_bytes: number };
};
export type AgentOperation = {
  id: string; state: string; kind: string; error_code?: string | null;
  reconciliation_required?: boolean; refunded?: number;
};
export type AgentOperationResult = { agent: HostedAgent; operation: AgentOperation };
export type AgentFile = { name: string; dir: boolean; size?: number; mtime?: number };
export type AgentUsage = { day: string; model: string; requests: number; prompt_tokens: number; completion_tokens: number };

export class AgentApiError extends ApiError {
  readonly code: string;
  readonly retryAfter: number | null;
  constructor(message: string, status: number, code: string, retryAfter: number | null = null) {
    super(message, status); this.code = code; this.retryAfter = retryAfter;
  }
}

async function checkAgentResponse(res: Response): Promise<void> {
  if (res.ok) return;
  const body = await res.json().catch(() => null);
  const retry = res.headers.get("Retry-After");
  const seconds = retry === null ? NaN : Number(retry);
  const retryAfter = retry === null ? null : Number.isFinite(seconds) ? seconds : Math.max(0, (Date.parse(retry) - Date.now()) / 1000);
  const failure = agentErrorDetails(body, `Agent request failed (${res.status})`, "request_failed", res.status);
  throw new AgentApiError(failure.message, res.status, failure.code, Number.isFinite(retryAfter) ? retryAfter : null);
}

export async function agentRequest<T>(apiKey: string, suffix: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(`${API_BASE}/api/v1/agents${suffix}`, {
    ...init, headers: { ...authHeaders(apiKey), ...init.headers },
  });
  await checkAgentResponse(res);
  return res.json();
}

export type AgentTurnState = { state: "idle"; turn_id?: never } | { state: "running" | "uncertain"; turn_id: string };
const TURN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function conversationSession(session: string): string {
  if (typeof session !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(session)) throw new Error("Invalid conversation session.");
  return session;
}
function agentTurnState(value: unknown): AgentTurnState {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (v.state === "idle") return { state: "idle" };
    if ((v.state === "running" || v.state === "uncertain") && typeof v.turn_id === "string" && TURN_UUID.test(v.turn_id))
      return { state: v.state, turn_id: v.turn_id };
  }
  throw new AgentApiError("Agent returned an invalid conversation state.", 502, "invalid_upstream");
}

/** Admission metadata only. Observing an outcome never resends the task. */
export async function getAgentTurnState(apiKey: string, id: string, session: string, signal?: AbortSignal): Promise<AgentTurnState> {
  const query = new URLSearchParams({ session: conversationSession(session) });
  return agentTurnState(await agentRequest(apiKey, `/${encodeURIComponent(id)}/messages/state?${query}`, { signal }));
}

export async function reconcileAgentTurn(apiKey: string, id: string,
  request: { session: string; turn_id: string; confirmed_stopped: true }, signal?: AbortSignal): Promise<AgentTurnState> {
  const session = conversationSession(request.session);
  if (typeof request.turn_id !== "string" || !TURN_UUID.test(request.turn_id)) throw new Error("Invalid conversation turn identity.");
  if (request.confirmed_stopped !== true) throw new Error("Explicit stopped confirmation is required.");
  const state = agentTurnState(await agentRequest(apiKey, `/${encodeURIComponent(id)}/messages/reconcile`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ session, turn_id: request.turn_id, confirmed_stopped: true }),
  }));
  if (state.state !== "idle") throw new AgentApiError("The server did not confirm reconciliation. Review the current conversation state before trying again.", 409, "conversation_unresolved");
  return state;
}

export function agentMutation(apiKey: string, suffix: string, method: string, body: Record<string, unknown> | null, key: string) {
  return agentRequest<AgentOperationResult>(apiKey, suffix, {
    method, headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
}

export type AgentConnectionCapabilities = {
  github_read: boolean; github_write: false; assets: false; configured: boolean;
  enabled: boolean; runtime_auth: string; github_installation_url: string;
};
export type AgentRepository = { id: number; full_name: string };
export type AgentInstallation = { id: number; account: string };
export type AgentConnection = {
  agent_id: string; revision: number; generation: number; state: string;
  repositories: AgentRepository[]; permissions: string[]; sync_pending: boolean;
  error_code: string | null; last_verified_at: number | null;
  legacy: { state: string; evidence: string | null };
  github_identity?: { id: number; login: string } | null;
  credential_expires_at?: number | null; provider_revocation_pending?: boolean;
};
export type AgentAuthorization = { connection_id: string; authorization_url: string; expires_at: number };
export type AgentConnectionMutation = {
  path: string; method: "POST" | "PUT" | "DELETE"; body: Record<string, unknown> | null; key: string;
};
export function connectionMutation<T>(apiKey: string, id: string, request: AgentConnectionMutation, signal?: AbortSignal) {
  return agentRequest<T>(apiKey, `/${encodeURIComponent(id)}/connections/${request.path}`, {
    method: request.method, headers: { "Content-Type": "application/json", "Idempotency-Key": request.key },
    ...(request.body === null ? {} : { body: JSON.stringify(request.body) }), signal,
  });
}
export function connectionResources(apiKey: string, id: string, connectionId: string, installationId?: number, page = 1, signal?: AbortSignal) {
  const query = new URLSearchParams({ connection_id: connectionId, page: String(page) });
  if (installationId !== undefined) query.set("installation_id", String(installationId));
  return agentRequest<{ installations?: AgentInstallation[]; repositories?: AgentRepository[]; next_page: number | null }>(
    apiKey, `/${encodeURIComponent(id)}/connections/github/resources?${query}`, { signal });
}

/** Sends the dotenvx key to the agent's runtime memory. Alpha forwards it without storing or logging it. */
export async function unlockAgent(apiKey: string, id: string, key: string, signal?: AbortSignal) {
  const result = await agentRequest<{ unlocked: boolean }>(apiKey, `/${encodeURIComponent(id)}/unlock`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }), signal,
  });
  if (result?.unlocked !== true) throw new AgentApiError("The runtime did not confirm unlocked configuration. Check its status before trying again.", 502, "unlock_not_confirmed");
  return result;
}

export function openAgentDesktop(apiKey: string, id: string, signal?: AbortSignal) {
  return agentRequest<{ websocket_url: string; ticket: string; expires_at: number }>(apiKey, `/${encodeURIComponent(id)}/desktop/session`, { method: "POST", signal });
}

export function validateAgentPath(path: string, allowRoot = false): string {
  if ((!path && !allowRoot) || path.startsWith("/") || /[\\\\%]/.test(path) || Array.from(path).some((c) => c.charCodeAt(0) < 32) ||
      (path && path.split("/").some((p) => !p || p === "." || p === ".."))) {
    throw new Error("Use a relative workspace path without traversal or encoded fragments.");
  }
  return path;
}

export type AgentFileArea = "workspace" | "projects";
const AGENT_FILE_BYTES = 10 * 1024 * 1024;
function agentFileQuery(path: string, area: AgentFileArea, download = false): URLSearchParams {
  if (area !== "workspace" && area !== "projects") throw new Error("Use the workspace or projects file area.");
  const query = new URLSearchParams({ path: validateAgentPath(path) });
  if (download) query.set("download", "true");
  if (area !== "workspace") query.set("area", area);
  return query;
}

export async function readAgentFile(apiKey: string, id: string, path: string, signal?: AbortSignal, area: AgentFileArea = "workspace"): Promise<string> {
  const query = agentFileQuery(path, area, true);
  const res = await apiFetch(`${API_BASE}/api/v1/agents/${encodeURIComponent(id)}/files?${query}`, { headers: authHeaders(apiKey), signal });
  await checkAgentResponse(res);
  return res.text();
}

/** Artifact downloads must preserve binary bytes and bound the actual transfer. */
export async function downloadAgentFile(apiKey: string, id: string, path: string, signal?: AbortSignal, area: AgentFileArea = "workspace"): Promise<Blob> {
  const query = agentFileQuery(path, area, true);
  const res = await apiFetch(`${API_BASE}/api/v1/agents/${encodeURIComponent(id)}/files?${query}`, { headers: authHeaders(apiKey), signal });
  await checkAgentResponse(res);
  if (Number(res.headers.get("Content-Length")) > AGENT_FILE_BYTES) {
    void res.body?.cancel().catch(() => {});
    throw new Error("File exceeds 10 MiB.");
  }
  if (!res.body) return new Blob([], { type: res.headers.get("Content-Type") || "application/octet-stream" });
  const reader = res.body.getReader();
  const parts: BlobPart[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > AGENT_FILE_BYTES) throw new Error("File exceeds 10 MiB.");
      parts.push(new Uint8Array(value));
    }
    return new Blob(parts, { type: res.headers.get("Content-Type") || "application/octet-stream" });
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function writeAgentFile(apiKey: string, id: string, path: string, content: string, signal?: AbortSignal, area: AgentFileArea = "workspace") {
  if (new TextEncoder().encode(content).length > AGENT_FILE_BYTES) throw new Error("File exceeds 10 MiB.");
  return agentRequest<{ written: boolean }>(apiKey, `/${encodeURIComponent(id)}/files?${agentFileQuery(path, area)}`, {
    method: "PUT", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: content, signal,
  });
}

function waitForAgentTask<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then((value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/** No task replay: an interrupted stream may already have performed work. */
export async function streamAgentMessage(apiKey: string, id: string, content: string, session: string,
  onText: (text: string, mode?: "append" | "replace") => void, signal?: AbortSignal): Promise<void> {
  // The service may spend 900 seconds on tool work. Keep one overall deadline,
  // with transport grace; heartbeat comments neither end nor replay the turn.
  const task = new AbortController();
  const cancel = () => task.abort(signal?.reason);
  if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
  let timedOut = false;
  const deadline = setTimeout(() => {
    if (task.signal.aborted) return;
    timedOut = true; task.abort(new Error("Agent task deadline exceeded"));
  }, 930_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    task.signal.throwIfAborted();
    const res = await waitForAgentTask(apiFetch(`${API_BASE}/api/v1/agents/${encodeURIComponent(id)}/messages`, {
      method: "POST", headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({ content, session, stream: true }), signal: task.signal,
    }), task.signal);
    await waitForAgentTask(checkAgentResponse(res), task.signal);
    if (!res.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      const body = await waitForAgentTask(res.json(), task.signal);
      const reply = body?.choices?.[0]?.message?.content;
      if (typeof reply !== "string") throw new Error("Agent returned an invalid reply.");
      onText(reply, "replace"); return;
    }
    if (!res.body) throw new Error("Agent stream has no body.");
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await waitForAgentTask(reader.read(), task.signal);
      buffer += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const lines = event.split(/\r?\n/);
        const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        if (data === "[DONE]") return;
        let payload;
        try { payload = JSON.parse(data); }
        catch { throw new AgentApiError("Agent stream returned invalid data. Check progress before sending again.", 502, "invalid_stream"); }
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new AgentApiError("Agent stream returned invalid data. Check progress before sending again.", 502, "invalid_stream");
        if (lines.some((line) => /^event:\s*error\s*$/.test(line)) || payload.error != null || payload.detail != null) {
          const failure = agentErrorDetails(payload, "Agent stream failed", "stream_error", 502);
          throw new AgentApiError(failure.message, failure.status, failure.code);
        }
        const final = payload.choices?.[0]?.message?.content;
        const text = payload.choices?.[0]?.delta?.content;
        if (typeof final === "string") onText(final, "replace");
        else if (typeof text === "string") onText(text, "append");
      }
      if (done) throw new Error("Stream interrupted; the task may still be running. Check progress before sending again.");
    }
  } catch (error) {
    if (timedOut) throw new AgentApiError("Agent response timed out; the task may still be running. Check workspace files, status and logs before sending again.", 504, "task_timeout");
    throw error;
  } finally {
    clearTimeout(deadline); signal?.removeEventListener("abort", cancel);
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

export class JobTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobTerminalError";
  }
}

// ── Companies & Projects ──────────────────────────────────────────────
// A project is a saved Studio session owned by a wallet or shared company.
// Authorization for company projects is enforced by the Pioneer API.
export type Company = {
  companyAddress: string;
  role: string;
  owner: string | null;
  slug: string | null;
  name: string | null;
  plan: string | null;
};
export type ProjectSummary = {
  id: string;
  ownerType: "personal" | "company";
  owner: string;
  title: string;
  rev: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};
export type Project = ProjectSummary & { doc: Storyboard | null };

export async function listMyCompanies(apiKey: string): Promise<Company[]> {
  const res = await apiFetch(`${API_BASE}/api/v1/account/companies`, { headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`companies: ${res.status}`);
  return (await res.json()).companies ?? [];
}

export type CompanyLeaderboardEntry = {
  companyAddress: string;
  memberCount: number;
  owner: string;
  createdAt: number;
  slug: string | null;
  name: string | null;
  plan: string | null;
  openInvite: boolean;
};

// Public — no auth needed. Ranked by member count.
export async function fetchCompanyLeaderboard(): Promise<CompanyLeaderboardEntry[]> {
  const res = await apiFetch(`${API_BASE}/api/v1/companies/leaderboard`);
  if (!res.ok) throw new Error(`leaderboard: ${res.status}`);
  return (await res.json()).companies ?? [];
}

// Request to join — creates a pending request the owner must approve.
export async function joinCompany(apiKey: string, companyAddress: string): Promise<{ status: string }> {
  const res = await apiFetch(`${API_BASE}/api/v1/companies/join`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), "content-type": "application/json" },
    body: JSON.stringify({ companyAddress }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `join: ${res.status}`);
  return body;
}

// Owner-only: toggle public invites on/off.
export async function setCompanyInvite(apiKey: string, companyAddress: string, openInvite: boolean): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/v1/companies/${companyAddress}/settings`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), "content-type": "application/json" },
    body: JSON.stringify({ openInvite }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `settings: ${res.status}`);
}

export async function listProjects(apiKey: string): Promise<ProjectSummary[]> {
  const res = await apiFetch(`${API_BASE}/api/v1/projects`, { headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`projects: ${res.status}`);
  return (await res.json()).projects ?? [];
}

export async function createProject(apiKey: string, title: string, companyAddress?: string): Promise<Project> {
  const res = await apiFetch(`${API_BASE}/api/v1/projects`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), "content-type": "application/json" },
    body: JSON.stringify({ title, companyAddress }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `create project: ${res.status}`);
  return body;
}

export async function deleteProject(apiKey: string, id: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/v1/projects/${id}`, { method: "DELETE", headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`delete project: ${res.status}`);
}

export type EthProvider = { request(a: { method: string; params?: unknown[] }): Promise<any> };
export type WalletChoice = "auto" | "keepkey" | "browser";
export type WalletProgress = "connecting" | "signing" | "verifying";

function injectedProvider(choice: WalletChoice = "auto"): EthProvider | undefined {
  const wallets = window as unknown as { ethereum?: EthProvider; keepkey?: { ethereum?: EthProvider } };
  const keepkey = typeof wallets.keepkey?.ethereum?.request === "function" ? wallets.keepkey.ethereum : undefined;
  const browser = typeof wallets.ethereum?.request === "function" ? wallets.ethereum : undefined;
  return choice === "keepkey" ? keepkey : choice === "browser" ? browser : keepkey ?? browser;
}

// Mobile Safari and Chrome never expose an injected provider — MetaMask only
// injects inside its own in-app browser.
export function needsMetaMaskHandoff(): boolean {
  return !injectedProvider() && window.matchMedia("(pointer: coarse)").matches;
}

// On mobile the SDK, not a deeplink, is what makes signing work. A deeplink is
// one-way: it can open MetaMask but has no channel to return a signature, so
// the best it could ever do was strand the user in a second browser. The SDK
// holds a session with the app, so the user signs in MetaMask and comes back
// here with the result.
//
// Imported on demand. The desktop extension path never loads it, and Vite
// keeps it in its own chunk.
let session: Promise<EthProvider> | null = null;

function metaMaskSession(): Promise<EthProvider> {
  if (!session) {
    session = (async () => {
      const { MetaMaskSDK } = await import("@metamask/sdk");
      const sdk = new MetaMaskSDK({
        dappMetadata: { name: "Pioneer Studio", url: location.origin },
        // deeplink straight into the app; the QR modal is a desktop affordance
        useDeeplink: true,
        checkInstallationImmediately: false,
      });
      await sdk.init();
      const provider = sdk.getProvider();
      if (!provider) throw new Error("Could not start a MetaMask session");
      return provider as unknown as EthProvider;
    })();
    // a failed init must not poison every later attempt
    session.catch(() => {
      session = null;
    });
  }
  return session;
}

// Warm the session before the user taps. Starting it costs a dynamic import
// and a handshake, and spending the tap on that is what loses iOS's user
// gesture — the tap needs to reach MetaMask, not a loading spinner.
export function primeMetaMaskSession(): void {
  if (needsMetaMaskHandoff()) void metaMaskSession().catch(() => {});
}

// Wallet login: challenge → personal_sign → short-lived bearer token. The exact
// message format is part of the public API contract and must remain stable.
export async function connectWallet(options: {
  choice?: WalletChoice;
  wallet?: WalletOption;
  signal?: AbortSignal;
  onProgress?: (progress: WalletProgress) => void;
  onAccount?: (account: { address: string; provider: string }) => void;
} = {}): Promise<WalletSession> {
  const { signal, onProgress } = options;
  const cancelled = () => signal?.throwIfAborted();
  cancelled();
  onProgress?.("connecting");
  const injected = options.wallet ? options.wallet.provider : injectedProvider(options.choice);
  if (!injected && (options.wallet ? options.wallet.kind === "keepkey" : options.choice === "keepkey")) {
    throw new Error("KeepKey extension not found. Open the KeepKey extension, then retry.");
  }
  if (!injected && options.wallet?.kind !== "metamask" && !needsMetaMaskHandoff()) {
    throw new Error("No browser wallet found. Open your wallet extension, or sign in with a Pioneer key.");
  }
  // Keep this provider for the entire challenge, even if another extension injects later.
  const eth = injected ?? (await metaMaskSession());
  cancelled();
  const providerName = options.wallet?.name || (eth === injectedProvider("keepkey") ? "KeepKey" : injected ? "Browser wallet" : "MetaMask");
  const accounts: unknown = await eth.request({ method: "eth_requestAccounts" });
  cancelled();
  const address = Array.isArray(accounts) ? accounts[0] : null;
  if (typeof address !== "string" || !/^0x[\da-f]{40}$/i.test(address)) throw new Error("Wallet returned no valid Ethereum account.");
  options.onAccount?.({ address, provider: providerName });
  const challengeResponse = await apiFetch(`${API_BASE}/auth/challenge`, { signal });
  const ch = await challengeResponse.json();
  if (!challengeResponse.ok) throw new Error(ch?.error || `Could not request a sign-in challenge (${challengeResponse.status}).`);
  if (typeof ch?.challenge !== "string" || typeof ch?.nonce !== "string" || !Number.isFinite(ch?.expiresAt) || ch.expiresAt * 1000 <= Date.now()) {
    throw new Error("Pioneer returned an invalid or expired sign-in challenge. Please retry.");
  }
  cancelled();
  onProgress?.("signing");
  const message = `Pioneer API\nChallenge: ${ch.challenge}\nNonce: ${ch.nonce}\nAddress: ${address}`;
  const signature: unknown = await eth.request({ method: "personal_sign", params: [message, address] });
  cancelled();
  if (typeof signature !== "string" || !/^0x[\da-f]{130}$/i.test(signature)) throw new Error("Wallet returned an invalid signature. Please retry.");
  onProgress?.("verifying");
  const res = await apiFetch(`${API_BASE}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, signature, challenge: ch.challenge, nonce: ch.nonce }),
    signal,
  });
  const body = await res.json();
  cancelled();
  if (!res.ok) throw new Error(body?.error || `Sign-in verification failed (${res.status}).`);
  const session = walletSessionFromResponse(body);
  if (session.address.toLowerCase() !== address.toLowerCase()) throw new Error("Pioneer returned a different wallet account. Please retry.");
  return session;
}

export async function fetchModels(apiKey: string): Promise<ModelsResponse> {
  const res = await apiFetch(`${API_BASE}/api/v1/jobs/models`, { headers: authHeaders(apiKey) });
  if (!res.ok) throw new ApiError(`models: ${res.status}`, res.status);
  return res.json();
}

export async function fetchAccount(apiKey: string): Promise<Record<string, unknown>> {
  const res = await apiFetch(`${API_BASE}/api/v1/account`, { headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`account: ${res.status}`);
  return res.json();
}

export async function submitJob(
  apiKey: string,
  model: string,
  endpoint: string,
  params: unknown,
): Promise<SubmitResponse> {
  const res = await apiFetch(`${API_BASE}/api/v1/jobs`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), "content-type": "application/json" },
    body: JSON.stringify({ model, endpoint, params }),
  });
  const body = await res.json();
  if (!res.ok) {
    if (res.status === 404 && typeof window !== "undefined") window.dispatchEvent(new Event("pioneer:catalog-stale"));
    throw new ApiError(body?.error || `submit: ${res.status}`, res.status);
  }
  return body;
}

export async function pollJob(apiKey: string, jobId: string): Promise<JobStatus> {
  const res = await apiFetch(`${API_BASE}/api/v1/jobs/${jobId}`, { headers: authHeaders(apiKey) });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `status: ${res.status}`);
  return body;
}

// format=url persists the result to R2 (content-addressed, billed storage)
// and hands back the public URL — the same URL Media lists.
export async function fetchResultUrl(apiKey: string, jobId: string): Promise<{ url: string; contentType: string }> {
  const res = await apiFetch(`${API_BASE}/api/v1/jobs/${jobId}/result?format=url`, { headers: authHeaders(apiKey) });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) {
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || `result: ${res.status}`);
    if (body.url) return { url: body.url, contentType: body.content_type || "" };
    // Accounts without hosted storage receive the result as inline base64.
    // Turn it into a data: URL so it renders; it won't appear in Media (not persisted).
    if (typeof body.image === "string") {
      const type = body.content_type || (body.image.startsWith("/9j/") ? "image/jpeg" : "image/png");
      return { url: `data:${type};base64,${body.image}`, contentType: type };
    }
    // A JSON body with no url or image is a server error (e.g. the content
    // gate rejected the result). Surface its message instead of the opaque
    // `result: 200`, which is what made a failed job read as "just JSON".
    throw new Error(body?.error || `result: ${res.status}`);
  }
  if (!res.ok) throw new Error(`result: ${res.status}`);
  // no R2 on this account → raw bytes come back inline; the result URL itself
  // needs auth so it can't feed an <img>/<video> — inline it as a data: URL
  if (/^(image|video|audio)\//.test(ct)) return { url: await blobToDataUrl(await res.blob()), contentType: ct };
  if (/^model\//.test(ct) || /(?:gltf|glb)/i.test(ct)) {
    return { url: URL.createObjectURL(await res.blob()), contentType: ct || "model/gltf-binary" };
  }
  return { url: res.url, contentType: ct }; // followed a redirect to R2
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

export async function fetchMedia(apiKey: string): Promise<MediaList> {
  const res = await apiFetch(`${API_BASE}/api/v1/media`, { headers: authHeaders(apiKey) });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `media: ${res.status}`);
  return body;
}

export async function uploadMedia(apiKey: string, file: File): Promise<UploadResponse> {
  const form = new FormData();
  form.append("file", file);
  const res = await apiFetch(`${API_BASE}/api/v1/media`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: form,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `upload: ${res.status}`);
  return body;
}

// ── Storyboard — one document per address, rev-based CAS ──
export type ShotStatus = "empty" | "queued" | "starting" | "running" | "ready" | "failed";
export type Shot = {
  id: string;
  order: number;
  prompt: string;
  model: string | null;
  endpoint: string | null;
  refs: { url: string; key: string; content_type: string }[];
  jobId: string | null;
  status: ShotStatus;
  result: { url: string; key: string; content_type: string; bytes: number } | null;
  trackKind: string | null;
  sourceDuration: number | null;
  createdAt: number;
  updatedAt: number;
};
export type Clip = { id: string; shotId: string; start: number; duration: number; trimIn: number; trimOut: number };
export type Track = { kind: string; name: string; clips: Clip[] };
export type Storyboard = {
  id: string;
  address: string;
  title: string;
  rev: number;
  shots: Shot[];
  tracks: Track[];
  playhead: number;
  studioTimeline?: unknown;
  pipeline?: unknown;
  createdAt: number;
  updatedAt: number;
};

// Storyboards remain local when no server project is open. The API-compatible
// function shapes let call sites use either storage mode without branching.
const SB_KEY = "ps_storyboard";
let sbMem: Storyboard | null = null; // full doc incl. data: results too big for localStorage

// Active project: when set, the storyboard store mirrors saves to the server
// project (personal or company-shared) instead of only localStorage. Null =
// the legacy local-only personal doc. Set via openProject/newLocalProject.
let activeProject: { id: string; apiKey: string } | null = null;
let projectGeneration = 0;

export function activeProjectId(): string | null {
  return activeProject?.id ?? null;
}

export function activeProjectStudioTimeline(projectId: string): unknown {
  return activeProject && (activeProject.id === projectId || sbMem?.id === projectId) ? sbMem?.studioTimeline : undefined;
}

export function activeProjectPipeline(projectId: string): unknown {
  return activeProject && (activeProject.id === projectId || sbMem?.id === projectId) ? sbMem?.pipeline : undefined;
}

let pipelineSync: Promise<void> = Promise.resolve();

export function flushActiveProjectPipeline(): Promise<void> {
  return pipelineSync;
}

/** Mirror cast, beat assignments, tracers, and final assets into the same
 * canonical project document as the storyboard. Local-only boards keep using
 * pipeline.ts's localStorage fallback. */
export function saveActiveProjectPipeline(projectId: string, pipeline: unknown): boolean {
  if (!activeProject || !sbMem || (activeProject.id !== projectId && sbMem.id !== projectId)) return false;
  sbMem = { ...sbMem, pipeline: structuredClone(pipeline), rev: sbMem.rev + 1, updatedAt: Date.now() };
  const target = { ...activeProject };
  const snapshot = structuredClone(sbMem);
  // Serialize snapshots in authored order. Hosted project writes replace the
  // whole document, so allowing a slow earlier request to finish last would
  // silently roll the cast registry back to a prefix of the user's edits.
  pipelineSync = pipelineSync.then(async () => {
    if (activeProject?.id !== target.id || activeProject.apiKey !== target.apiKey) return;
    try {
      const res = await apiFetch(`${API_BASE}/api/v1/projects/${target.id}`, {
        method: "PUT",
        headers: { ...authHeaders(target.apiKey), "content-type": "application/json" },
        body: JSON.stringify({ doc: snapshot, title: snapshot.title }),
      });
      if (!res.ok) onSyncError?.(`pipeline sync failed (${res.status}) — the local pipeline is still safe`);
    } catch {
      onSyncError?.("pipeline sync failed — offline? The local pipeline is still safe");
    }
  });
  return true;
}

/** Mirror the cut into the same server project document as the board. Studio
 * debounces this function; local-only projects continue using localStorage. */
export function saveActiveProjectStudioTimeline(projectId: string, timeline: unknown): boolean {
  if (!activeProject || !sbMem || (activeProject.id !== projectId && sbMem.id !== projectId)) return false;
  sbMem = { ...sbMem, studioTimeline: timeline, rev: sbMem.rev + 1, updatedAt: Date.now() };
  apiFetch(`${API_BASE}/api/v1/projects/${activeProject.id}`, {
    method: "PUT",
    headers: { ...authHeaders(activeProject.apiKey), "content-type": "application/json" },
    body: JSON.stringify({ doc: sbMem, title: sbMem.title }),
  })
    .then((res) => {
      if (!res.ok) onSyncError?.(`timeline sync failed (${res.status}) — the local cut is still safe`);
    })
    .catch(() => onSyncError?.("timeline sync failed — offline? The local cut is still safe"));
  return true;
}

// Load a server project's doc into the working storyboard and make it active.
export async function openProject(apiKey: string, id: string): Promise<Storyboard> {
  const generation = projectGeneration;
  const res = await apiFetch(`${API_BASE}/api/v1/projects/${id}`, { headers: authHeaders(apiKey) });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `open project: ${res.status}`);
  if (generation !== projectGeneration) throw new Error("Sign-in changed while opening the project. Please open it again.");
  const doc: Storyboard = body.doc ?? {
    id, address: body.owner, title: body.title, rev: body.rev,
    shots: [], tracks: [], playhead: 0, createdAt: body.createdAt, updatedAt: body.updatedAt,
  };
  doc.rev = body.rev; // server rev is source of truth for CAS
  activeProject = { id, apiKey };
  localStorage.setItem("ps_active_project", id); // survive reloads — else edits silently fork to the local doc
  sbMem = doc;
  return structuredClone(doc);
}

/** Open the editor containing authored work; storyboard projects keep their usual landing. */
export function projectOpeningMode(doc: Pick<Storyboard, "shots" | "studioTimeline">): "board" | "studio" {
  const timeline = doc.studioTimeline as { clips?: unknown } | null | undefined;
  return !doc.shots.length && Array.isArray(timeline?.clips) && timeline.clips.length > 0 ? "studio" : "board";
}

// Re-open the project that was active before a reload and return its document.
export async function restoreActiveProject(apiKey: string): Promise<Storyboard | null> {
  const id = localStorage.getItem("ps_active_project");
  const generation = projectGeneration;
  if (!id || activeProject) return null;
  try {
    return await openProject(apiKey, id);
  } catch {
    // A stale rejection must not clear the selection made by the new account.
    if (generation === projectGeneration && localStorage.getItem("ps_active_project") === id) localStorage.removeItem("ps_active_project");
    return null;
  }
}

// Drop back to the local-only personal doc (the pre-projects behavior).
export function closeProject(preserveSelection = false): void {
  projectGeneration++;
  activeProject = null;
  if (!preserveSelection) localStorage.removeItem("ps_active_project");
  sbMem = null;
}

// Project-mirror saves are fire-and-forget; the shell registers a handler so
// failures surface as a toast instead of silently dropping edits.
let onSyncError: ((msg: string) => void) | null = null;
export function setSyncErrorHandler(fn: (msg: string) => void): void {
  onSyncError = fn;
}

function sbLoad(): Storyboard {
  if (sbMem) return sbMem;
  try {
    const raw = localStorage.getItem(SB_KEY);
    if (raw) return (sbMem = JSON.parse(raw));
  } catch {
    /* corrupt → fresh */
  }
  sbMem = {
    id: "local",
    address: "local",
    title: "Untitled Storyboard",
    rev: 0,
    shots: [],
    tracks: [],
    playhead: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return sbMem;
}

function sbSave(sb: Storyboard): Storyboard {
  sb.rev++;
  sb.updatedAt = Date.now();
  sbMem = sb;
  // data: URLs (accounts without R2) blow the localStorage quota — persist without them
  const slim = {
    ...sb,
    shots: sb.shots.map((s) => (s.result?.url.startsWith("data:") ? { ...s, result: null, status: "empty" as ShotStatus } : s)),
  };
  if (activeProject) {
    // Mirror to the server project. Fire-and-forget; the server owns revision
    // checks. A sync failure is surfaced so collaborators can reload safely.
    apiFetch(`${API_BASE}/api/v1/projects/${activeProject.id}`, {
      method: "PUT",
      headers: { ...authHeaders(activeProject.apiKey), "content-type": "application/json" },
      body: JSON.stringify({ doc: slim, title: sb.title }),
    })
      .then((res) => {
        if (!res.ok) onSyncError?.(`project sync failed (${res.status}) — recent edits may not be saved`);
      })
      .catch(() => onSyncError?.("project sync failed — offline? Recent edits may not be saved"));
    return sb;
  }
  try {
    localStorage.setItem(SB_KEY, JSON.stringify(slim));
  } catch {
    /* quota — in-memory copy stays live for this session */
  }
  return sb;
}

const sbEdit = (fn: (sb: Storyboard) => void): Storyboard => {
  const sb = structuredClone(sbLoad());
  fn(sb);
  return sbSave(sb);
};
const sbShot = (sb: Storyboard, id: string): Shot => {
  const s = sb.shots.find((x) => x.id === id);
  if (!s) throw new Error("shot not found");
  return s;
};
const sbId = () => Math.random().toString(36).slice(2, 10);

export const fetchStoryboard = async (_k: string): Promise<Storyboard> => structuredClone(sbLoad());

export const addShot = async (
  _k: string,
  _rev: number | undefined,
  shot: { prompt?: string; model?: string; endpoint?: string },
): Promise<Storyboard> =>
  sbEdit((sb) => {
    sb.shots.push({
      id: sbId(),
      order: sb.shots.length,
      prompt: shot.prompt || "",
      model: shot.model || null,
      endpoint: shot.endpoint || null,
      refs: [],
      jobId: null,
      status: "empty",
      result: null,
      trackKind: null,
      sourceDuration: 10,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

export const patchShot = async (
  _k: string,
  _rev: number | undefined,
  id: string,
  patch: {
    prompt?: string;
    model?: string;
    endpoint?: string;
    status?: ShotStatus;
    sourceDuration?: number;
    result?: Shot["result"];
  },
): Promise<Storyboard> =>
  sbEdit((sb) => {
    Object.assign(sbShot(sb, id), patch, { updatedAt: Date.now() });
  });

/** Move a beat. `before` is the insert slot in the CURRENT list (0..length);
 *  `order` is re-derived so beat numbers always follow position. */
export const moveShot = async (_k: string, _rev: number | undefined, id: string, before: number): Promise<Storyboard> =>
  sbEdit((sb) => {
    const from = sb.shots.findIndex((s) => s.id === id);
    if (from < 0) throw new Error("shot not found");
    const [s] = sb.shots.splice(from, 1);
    sb.shots.splice(before > from ? before - 1 : before, 0, s);
    sb.shots.forEach((x, i) => (x.order = i));
  });

export const deleteShot = async (_k: string, _rev: number | undefined, id: string): Promise<Storyboard> =>
  sbEdit((sb) => {
    sb.shots = sb.shots.filter((s) => s.id !== id).map((s, i) => ({ ...s, order: i }));
  });

export const generateShot = async (k: string, id: string, params?: Record<string, unknown>): Promise<Storyboard> => {
  const shot = sbShot(sbLoad(), id);
  if (!shot.model || !shot.endpoint) throw new Error("shot has no model — pick one first");
  const sub = await submitJob(k, shot.model, shot.endpoint, { prompt: shot.prompt, ...(params || {}) });
  return sbEdit((sb) => {
    Object.assign(sbShot(sb, id), { jobId: sub.job_id, status: "queued" as ShotStatus, updatedAt: Date.now() });
  });
};

export const attachShotResult = async (
  _k: string,
  _rev: number | undefined,
  id: string,
  result: { url: string; key: string; content_type: string; bytes: number },
): Promise<Storyboard> =>
  sbEdit((sb) => {
    Object.assign(sbShot(sb, id), { result, status: "ready" as ShotStatus, jobId: null, updatedAt: Date.now() });
  });

export type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export type ChatTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string; name: string };
export type ChatAssistantMessage = Extract<ChatMessage, { role: "assistant" }>;

export async function chatCompletionMessage(
  apiKey: string,
  messages: ChatMessage[],
  options: { tools?: ChatTool[]; toolChoice?: "auto" | "none" } = {},
): Promise<ChatAssistantMessage> {
  const payload: Record<string, unknown> = { model: "auto", messages, temperature: 0.2 };
  if (options.tools?.length) payload.tools = options.tools;
  if (options.toolChoice) payload.tool_choice = options.toolChoice;
  const res = await apiFetch(`${API_BASE}/api/v1/chat/completions`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `chat: ${res.status}`);
  const message = body?.choices?.[0]?.message;
  if (!message || (typeof message.content !== "string" && !Array.isArray(message.tool_calls)))
    throw new Error("chat: empty completion");
  return {
    role: "assistant",
    content: typeof message.content === "string" ? message.content : null,
    tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : undefined,
  };
}

/** Describe an image in one line — what a dropped still is *about*, so a beat
 *  can write its own text.
 *
 *  Vision needs a named model: `model:"auto"` routes to text-only backends and
 *  fails with "image input is not supported". These two are the ones on the
 *  account that actually take an image, tried in order. */
const VISION_MODELS = ["gemini-3-6-flash", "z-ai-glm-5v-turbo"];
export async function captionImage(apiKey: string, imageUrl: string, instruction?: string): Promise<string> {
  const content = [
    {
      type: "text",
      text:
        instruction ||
        "Describe this image in one vivid sentence for a storyboard beat: who or what is in frame, what they are doing, and the setting. No preamble, no quotes.",
    },
    { type: "image_url", image_url: { url: imageUrl } },
  ];
  let lastError = "";
  for (const model of VISION_MODELS) {
    try {
      const res = await apiFetch(`${API_BASE}/api/v1/chat/completions`, {
        method: "POST",
        headers: { ...authHeaders(apiKey), "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content }], temperature: 0.3 }),
      });
      const body = await res.json();
      const text = body?.choices?.[0]?.message?.content;
      if (res.ok && typeof text === "string" && text.trim()) return text.trim();
      lastError = body?.error || `caption: ${res.status}`;
    } catch (e: any) {
      lastError = String(e.message || e);
    }
  }
  throw new Error(lastError || "no vision model answered");
}

export async function chatCompletion(apiKey: string, messages: ChatMessage[]): Promise<string> {
  const message = await chatCompletionMessage(apiKey, messages);
  if (typeof message.content !== "string") throw new Error("chat: completion returned a tool call");
  return message.content;
}

/* ── Voice in / lore out ──────────────────────────────────────────────────────
 * The other two thirds of the AI-services trio TTS already uses (pipeline.ts
 * ttsLine). Same auth, same base URL:
 *   POST /api/v1/stt   multipart {audio}          → {text}
 *   POST /api/v1/lore  {question, context?}       → {answer, sources?}
 * Lore runs a small non-reasoning model with an in-character system prompt, so
 * it answers as the character rather than as an assistant — which is exactly
 * what a head you talk to wants. `context` carries the persona.
 */
export async function transcribe(apiKey: string, audio: Blob): Promise<string> {
  const form = new FormData();
  form.append("audio", audio, "take.webm");
  const res = await apiFetch(`${API_BASE}/api/v1/stt`, { method: "POST", headers: authHeaders(apiKey), body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `stt: ${res.status}`);
  return (body?.text || "").trim();
}

export async function askLore(apiKey: string, question: string, context?: string): Promise<string> {
  const res = await apiFetch(`${API_BASE}/api/v1/lore`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), "content-type": "application/json" },
    body: JSON.stringify({ question, context }),
  });
  const body = await res.json().catch(() => ({}));
  // the route answers {answer:""} with a non-200 when the backend is down
  if (!res.ok) throw new Error(body?.error || `lore: ${res.status}`);
  const answer = (body?.answer || "").trim();
  if (!answer) throw new Error("lore: empty answer");
  return answer;
}

/* ── Motion: ARDY text-to-animation ───────────────────────────────────────────
 * Motion is exposed through the authenticated Pioneer API. The returned
 * skeleton matches `ardySkeleton.ts`, so its output applies without retargeting.
 * Conventions (echoed by the API): +Y up, right-handed, metres, initial facing
 * +Z, quats [x,y,z,w], joint_rotations_quat are LOCAL to the parent.
 */
export type MotionConstraint = {
  type: "root2d";
  frame_indices: number[];
  root_2d: [number, number][];
  heading_rad?: number[];
};

export type Motion = {
  model: string;
  skeleton: string;
  fps: number;
  num_frames: number;
  num_joints: number;
  prompt: string;
  seed: number | null;
  generation_seconds: number;
  constraints_applied: number;
  data: {
    root_positions: [number, number, number][];
    joint_rotations_quat: [number, number, number, number][][];
    joint_positions: [number, number, number][][];
    foot_contacts: boolean[][];
  };
};

export type MotionModel = { nickname: string; name: string; loaded: boolean; fps?: number; skeleton?: string };

/** Which ARDY checkpoints the service has. Used to detect motion being live. */
export async function fetchMotionModels(apiKey: string): Promise<MotionModel[]> {
  const res = await apiFetch(`${API_BASE}/api/v1/motion/models`, { headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`motion/models: ${res.status}`);
  return (await res.json())?.models ?? [];
}

export async function generateMotion(
  apiKey: string,
  params: { prompt: string; duration_s: number; model?: string; seed?: number; constraints?: MotionConstraint[] },
): Promise<Motion> {
  const res = await apiFetch(`${API_BASE}/api/v1/motion/generate`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), "content-type": "application/json" },
    body: JSON.stringify({ model: "core", format: "json", ...params }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    let msg = txt.slice(0, 160);
    try {
      msg = JSON.parse(txt)?.error ?? JSON.parse(txt)?.detail ?? msg;
    } catch {}
    throw new Error(`motion ${res.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg).slice(0, 160)}`);
  }
  return res.json();
}

/* ── Character creation flow ──────────────────────────────────────────────────
 * text → concept cluster → portrait → voice → talking-head → VRM, using the
 * live jobs models on alpha (flux-schnell / flux2-dev / voxcpm2-tts / wan-s2v)
 * plus an authenticated VRM-generation route for the last step. A shared
 * concept image anchors the 3D model, voice, and talking head.
 */
export type FlowModels = {
  image: JobModel | null; // flux-schnell (cluster) — fast text→image
  imageHi: JobModel | null; // flux2-dev — hi-res + edit (portrait refine)
  imageEdit: JobModel | null; // flux2-dev edit — reference-image edit
  tts: JobModel | null; // voxcpm2-tts — voice
  lipsync: JobModel | null; // wan-s2v — audio+portrait → talking head
  vrm: boolean; // /api/v1/vrm reachable (server Meshy proxy configured)
};

/** Pick the flow's models out of the jobs list by capability, not by exact name,
 *  so the flow keeps working if a model is swapped for a newer one. */
export function pickFlowModels(models: JobModel[]): Omit<FlowModels, "vrm"> {
  const find = (re: RegExp, ep?: RegExp) =>
    models.find((m) => re.test(m.model) && (!ep || ep.test(m.endpoint))) ?? null;
  return {
    image: find(/flux|image|sdxl|schnell/i, /generate|batch/i),
    imageHi: find(/flux2|flux-2|dev/i, /generate/i),
    imageEdit: find(/flux2|flux-2|dev|edit/i, /edit/i),
    tts: find(/tts|voice|speech|voxcpm|kokoro/i, /tts|generate/i),
    lipsync: find(/wan|s2v|lipsync|talk|portrait/i, /lipsync|generate/i),
  };
}

/** Is VRM generation currently available through the Pioneer API? */
export async function fetchVrmStatus(apiKey: string): Promise<boolean> {
  try {
    const res = await apiFetch(`${API_BASE}/api/v1/vrm/health`, { headers: authHeaders(apiKey) });
    if (!res.ok) return false;
    const b = await res.json();
    return !!b?.ok;
  } catch {
    return false;
  }
}

export type VrmJob = { job_id: string };

/** Kick off a Meshy→VRM generation from a portrait image URL. Long-running
 *  (Meshy image-to-3d + rig ≈ minutes) → returns a job id to poll. */
export async function generateVrm(apiKey: string, params: { image?: string; prompt?: string; name?: string }): Promise<VrmJob> {
  const res = await apiFetch(`${API_BASE}/api/v1/vrm/generate`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `vrm: ${res.status}`);
  return body;
}

export type VrmStatus = { status: "pending" | "running" | "done" | "error"; stage?: string; url?: string; error?: string; credits?: number };

export async function pollVrm(apiKey: string, jobId: string): Promise<VrmStatus> {
  const res = await apiFetch(`${API_BASE}/api/v1/vrm/${jobId}`, { headers: authHeaders(apiKey) });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `vrm status: ${res.status}`);
  return body;
}
