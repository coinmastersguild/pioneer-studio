import { expect, test } from "bun:test";
import { API_BASE, apiFetch, closeProject, connectWallet, openProject, activeProjectId, setAuthErrorHandler } from "./api";

const address = `0x${"a".repeat(40)}`;
const expiresAt = Math.floor(Date.now() / 1000) + 3600;
const signature = `0x${"ab".repeat(65)}`;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${encode({ alg: "HS256" })}.${encode({ type: "pioneer-api", address, exp: expiresAt })}.signature`;
function globals(values: Record<string, unknown>) {
  const original = Object.getOwnPropertyDescriptors(globalThis);
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => { for (const name of Object.keys(values)) { if (original[name]) Object.defineProperty(globalThis, name, original[name]); else Reflect.deleteProperty(globalThis, name); } };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

test("KeepKey stays pinned through the challenge and reports sign-in progress", async () => {
  const calls: string[] = [];
  const phases: string[] = [];
  const accounts: unknown[] = [];
  const browser = { keepkey: { ethereum: { request: async ({ method, params }: any) => {
    calls.push(method);
    if (method === "eth_requestAccounts") {
      browser.keepkey.ethereum = { request: async () => { throw Error("replacement provider must not be used"); } };
      return [address];
    }
    expect(params).toEqual([`Pioneer API\nChallenge: challenge\nNonce: nonce\nAddress: ${address}`, address]);
    return signature;
  } } } };
  const restore = globals({ window: browser, fetch: async (url: string, init?: RequestInit) => {
    if (url.endsWith("/challenge")) return json({ challenge: "challenge", nonce: "nonce", expiresAt });
    expect(JSON.parse(init!.body as string)).toEqual({ address, signature, challenge: "challenge", nonce: "nonce" });
    return json({ token, address, expiresAt });
  } });
  try {
    expect((await connectWallet({ onProgress: (phase) => phases.push(phase), onAccount: (account) => accounts.push(account) })).token).toBe(token);
    expect(calls).toEqual(["eth_requestAccounts", "personal_sign"]);
    expect(phases).toEqual(["connecting", "signing", "verifying"]);
    expect(accounts).toHaveLength(1);
  } finally { restore(); }
});

test("cancelled hardware signature cannot reach verification or restore sign-in", async () => {
  const controller = new AbortController();
  const requests: string[] = [];
  const restore = globals({ window: { keepkey: { ethereum: { request: async ({ method }: any) => {
    if (method === "eth_requestAccounts") return [address];
    controller.abort();
    return signature;
  } } } }, fetch: async (url: string) => { requests.push(url); return json({ challenge: "challenge", nonce: "nonce", expiresAt }); } });
  try {
    await expect(connectWallet({ signal: controller.signal })).rejects.toThrow();
    expect(requests).toEqual([`${API_BASE}/auth/challenge`]);
  } finally { restore(); }
});

test("invalid challenge is not signed and signature mismatch stays an explicit login error", async () => {
  const calls: string[] = [];
  let invalidChallenge = true;
  const restore = globals({ window: { keepkey: { ethereum: { request: async ({ method }: any) => { calls.push(method); return method === "eth_requestAccounts" ? [address] : signature; } } } }, fetch: async (url: string) => url.endsWith("/challenge")
    ? invalidChallenge ? json({ error: "Service unavailable" }, 503) : json({ challenge: "challenge", nonce: "nonce", expiresAt })
    : json({ error: "Signature does not match address" }, 401) });
  try {
    await expect(connectWallet()).rejects.toThrow("Service unavailable");
    expect(calls).toEqual(["eth_requestAccounts"]);
    invalidChallenge = false;
    await expect(connectWallet()).rejects.toThrow("Signature does not match address");
  } finally { restore(); }
});

test("401 reports its rejected credential and ignores unauthenticated verification errors", async () => {
  const rejected: string[] = [];
  const restore = globals({ fetch: async () => json({}, 401) });
  setAuthErrorHandler((key) => rejected.push(key));
  try {
    await apiFetch(`${API_BASE}/api/v1/media`, { headers: { Authorization: "Bearer old-credential" } });
    await apiFetch(`${API_BASE}/auth/verify`, { method: "POST" });
    await apiFetch("https://example.invalid/file", { headers: { Authorization: "Bearer unrelated" } });
    expect(rejected).toEqual(["old-credential"]);
  } finally { setAuthErrorHandler(); restore(); }
});

test("closing an old account prevents its pending project request from replacing the new account", async () => {
  let finishOld!: (response: Response) => void;
  const cache = new Map<string, string>();
  const restore = globals({ localStorage: { getItem: (key: string) => cache.get(key) ?? null, setItem: (key: string, value: string) => cache.set(key, value), removeItem: (key: string) => cache.delete(key) }, fetch: (url: string) => url.endsWith("/old") ? new Promise<Response>((resolve) => { finishOld = resolve; }) : Promise.resolve(json({ id: "new", title: "New project", rev: 1, owner: address })) });
  try {
    closeProject();
    const old = openProject("old-key", "old");
    closeProject();
    await openProject("new-key", "new");
    finishOld(json({ id: "old", title: "Old project", rev: 1, owner: address }));
    await expect(old).rejects.toThrow("Sign-in changed");
    expect(activeProjectId()).toBe("new");
  } finally { closeProject(); restore(); }
});
