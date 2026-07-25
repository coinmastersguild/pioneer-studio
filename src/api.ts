/** Public, metered Pioneer API. Users provide their own credential at runtime. */
export const API_BASE = "https://alpha.pioneers.dev";

export type JobModel = { model: string; endpoint: string; credits: number | string; note: string };
export type ModelsResponse = { jobs: JobModel[]; usage: string; limits: Record<string, number> };
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
  const res = await fetch(`${API_BASE}/api/v1/account/companies`, { headers: authHeaders(apiKey) });
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
  const res = await fetch(`${API_BASE}/api/v1/companies/leaderboard`);
  if (!res.ok) throw new Error(`leaderboard: ${res.status}`);
  return (await res.json()).companies ?? [];
}

// Request to join — creates a pending request the owner must approve.
export async function joinCompany(apiKey: string, companyAddress: string): Promise<{ status: string }> {
  const res = await fetch(`${API_BASE}/api/v1/companies/join`, {
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
  const res = await fetch(`${API_BASE}/api/v1/companies/${companyAddress}/settings`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), "content-type": "application/json" },
    body: JSON.stringify({ openInvite }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `settings: ${res.status}`);
}

export async function listProjects(apiKey: string): Promise<ProjectSummary[]> {
  const res = await fetch(`${API_BASE}/api/v1/projects`, { headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`projects: ${res.status}`);
  return (await res.json()).projects ?? [];
}

export async function createProject(apiKey: string, title: string, companyAddress?: string): Promise<Project> {
  const res = await fetch(`${API_BASE}/api/v1/projects`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), "content-type": "application/json" },
    body: JSON.stringify({ title, companyAddress }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `create project: ${res.status}`);
  return body;
}

export async function deleteProject(apiKey: string, id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/projects/${id}`, { method: "DELETE", headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`delete project: ${res.status}`);
}

type EthProvider = { request(a: { method: string; params?: unknown[] }): Promise<any> };

function injectedProvider(): EthProvider | undefined {
  return (window as unknown as { ethereum?: EthProvider }).ethereum;
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
export async function connectWallet(): Promise<{ token: string; address: string }> {
  const injected = injectedProvider();
  if (!injected && !needsMetaMaskHandoff()) {
    throw new Error("No browser wallet found — install MetaMask/KeepKey, or paste an sk-pioneer key");
  }
  const eth = injected ?? (await metaMaskSession());
  const accounts: string[] = await eth.request({ method: "eth_requestAccounts" });
  const address = accounts[0];
  if (!address) throw new Error("Wallet returned no account");
  const ch = await fetch(`${API_BASE}/auth/challenge`).then((r) => r.json());
  const message = `Pioneer API\nChallenge: ${ch.challenge}\nNonce: ${ch.nonce}\nAddress: ${address}`;
  const signature: string = await eth.request({ method: "personal_sign", params: [message, address] });
  const res = await fetch(`${API_BASE}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, signature, challenge: ch.challenge, nonce: ch.nonce }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `verify: ${res.status}`);
  return { token: body.token, address };
}

export async function fetchModels(apiKey: string): Promise<ModelsResponse> {
  const res = await fetch(`${API_BASE}/api/v1/jobs/models`, { headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`models: ${res.status}`);
  return res.json();
}

export async function fetchAccount(apiKey: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/api/v1/account`, { headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`account: ${res.status}`);
  return res.json();
}

export async function submitJob(
  apiKey: string,
  model: string,
  endpoint: string,
  params: unknown,
): Promise<SubmitResponse> {
  const res = await fetch(`${API_BASE}/api/v1/jobs`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), "content-type": "application/json" },
    body: JSON.stringify({ model, endpoint, params }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `submit: ${res.status}`);
  return body;
}

export async function pollJob(apiKey: string, jobId: string): Promise<JobStatus> {
  const res = await fetch(`${API_BASE}/api/v1/jobs/${jobId}`, { headers: authHeaders(apiKey) });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `status: ${res.status}`);
  return body;
}

// format=url persists the result to R2 (content-addressed, billed storage)
// and hands back the public URL — the same URL Media lists.
export async function fetchResultUrl(apiKey: string, jobId: string): Promise<{ url: string; contentType: string }> {
  const res = await fetch(`${API_BASE}/api/v1/jobs/${jobId}/result?format=url`, { headers: authHeaders(apiKey) });
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
    throw new Error(`result: ${res.status}`);
  }
  if (!res.ok) throw new Error(`result: ${res.status}`);
  // no R2 on this account → raw bytes come back inline; the result URL itself
  // needs auth so it can't feed an <img>/<video> — inline it as a data: URL
  if (/^(image|video|audio)\//.test(ct)) return { url: await blobToDataUrl(await res.blob()), contentType: ct };
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
  const res = await fetch(`${API_BASE}/api/v1/media`, { headers: authHeaders(apiKey) });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `media: ${res.status}`);
  return body;
}

export async function uploadMedia(apiKey: string, file: File): Promise<UploadResponse> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/api/v1/media`, {
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

export function activeProjectId(): string | null {
  return activeProject?.id ?? null;
}

export function activeProjectStudioTimeline(projectId: string): unknown {
  return activeProject && (activeProject.id === projectId || sbMem?.id === projectId) ? sbMem?.studioTimeline : undefined;
}

/** Mirror the cut into the same server project document as the board. Studio
 * debounces this function; local-only projects continue using localStorage. */
export function saveActiveProjectStudioTimeline(projectId: string, timeline: unknown): boolean {
  if (!activeProject || !sbMem || (activeProject.id !== projectId && sbMem.id !== projectId)) return false;
  sbMem = { ...sbMem, studioTimeline: timeline, rev: sbMem.rev + 1, updatedAt: Date.now() };
  fetch(`${API_BASE}/api/v1/projects/${activeProject.id}`, {
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
  const res = await fetch(`${API_BASE}/api/v1/projects/${id}`, { headers: authHeaders(apiKey) });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `open project: ${res.status}`);
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

// Re-open the project that was active before a reload. True when restored.
export async function restoreActiveProject(apiKey: string): Promise<boolean> {
  const id = localStorage.getItem("ps_active_project");
  if (!id || activeProject) return false;
  try {
    await openProject(apiKey, id);
    return true;
  } catch {
    localStorage.removeItem("ps_active_project"); // gone/denied — fall back to the local doc
    return false;
  }
}

// Drop back to the local-only personal doc (the pre-projects behavior).
export function closeProject(): void {
  activeProject = null;
  localStorage.removeItem("ps_active_project");
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
    fetch(`${API_BASE}/api/v1/projects/${activeProject.id}`, {
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
  patch: { prompt?: string; model?: string; endpoint?: string; status?: ShotStatus; sourceDuration?: number },
): Promise<Storyboard> =>
  sbEdit((sb) => {
    Object.assign(sbShot(sb, id), patch, { updatedAt: Date.now() });
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
  const res = await fetch(`${API_BASE}/api/v1/chat/completions`, {
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
  const res = await fetch(`${API_BASE}/api/v1/stt`, { method: "POST", headers: authHeaders(apiKey), body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `stt: ${res.status}`);
  return (body?.text || "").trim();
}

export async function askLore(apiKey: string, question: string, context?: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/v1/lore`, {
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
  const res = await fetch(`${API_BASE}/api/v1/motion/models`, { headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`motion/models: ${res.status}`);
  return (await res.json())?.models ?? [];
}

export async function generateMotion(
  apiKey: string,
  params: { prompt: string; duration_s: number; model?: string; seed?: number; constraints?: MotionConstraint[] },
): Promise<Motion> {
  const res = await fetch(`${API_BASE}/api/v1/motion/generate`, {
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
    const res = await fetch(`${API_BASE}/api/v1/vrm/health`, { headers: authHeaders(apiKey) });
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
  const res = await fetch(`${API_BASE}/api/v1/vrm/generate`, {
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
  const res = await fetch(`${API_BASE}/api/v1/vrm/${jobId}`, { headers: authHeaders(apiKey) });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `vrm status: ${res.status}`);
  return body;
}
