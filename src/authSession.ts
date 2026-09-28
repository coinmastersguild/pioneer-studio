export const WALLET_SESSION_KEY = "pioneer_studio_wallet_session";
const REMEMBER_KEY = "pioneer_studio_remember_wallet";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type SessionStores = { local?: Store; tab?: Store };
export type WalletSession = { version: 2; token: string; address: string; expiresAt: number };

function browserStores(): SessionStores {
  const stores: SessionStores = {};
  try { stores.local = localStorage; } catch { /* storage disabled */ }
  try { stores.tab = sessionStorage; } catch { /* storage disabled */ }
  return stores;
}
function read(store: Store | undefined, key: string): string | null {
  try { return store?.getItem(key) ?? null; } catch { return null; }
}
function remove(store: Store | undefined, key: string) {
  try { store?.removeItem(key); } catch { /* storage disabled */ }
}

// Decoding is only a cache/schema check. Pioneer verifies the JWT on requests.
export function validateWalletSession(value: unknown, now = Date.now()): WalletSession | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<WalletSession>;
  if (raw.version !== undefined && raw.version !== 2) return null;
  if (typeof raw.token !== "string" || typeof raw.address !== "string" || !/^0x[\da-f]{40}$/i.test(raw.address)) return null;
  if (!Number.isFinite(raw.expiresAt) || raw.expiresAt! <= now) return null;
  const parts = raw.token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[\w-]+$/.test(part))) return null;
  try {
    const encoded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")));
    if (claims.type !== "pioneer-api" || typeof claims.address !== "string" || claims.address.toLowerCase() !== raw.address.toLowerCase()) return null;
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now) return null;
    return { version: 2, token: raw.token, address: raw.address, expiresAt: Math.min(raw.expiresAt!, claims.exp * 1000) };
  } catch { return null; }
}

export function walletSessionFromResponse(value: unknown, now = Date.now()): WalletSession {
  const raw = value as { token?: unknown; address?: unknown; expiresAt?: unknown } | null;
  const session = validateWalletSession({ ...raw, version: 2, expiresAt: typeof raw?.expiresAt === "number" ? raw.expiresAt * 1000 : NaN }, now);
  if (!session) throw new Error("Pioneer returned an invalid wallet session. Please try signing in again.");
  return session;
}

export function rememberWalletPreference(stores = browserStores()): boolean {
  return read(stores.local, REMEMBER_KEY) !== "false";
}
export function setRememberWalletPreference(remember: boolean, stores = browserStores()): void {
  try { stores.local?.setItem(REMEMBER_KEY, String(remember)); } catch { /* storage disabled */ }
}
export function clearWalletSession(stores = browserStores()): void {
  for (const store of [stores.local, stores.tab]) {
    remove(store, WALLET_SESSION_KEY);
    remove(store, "pioneer_studio_api_key");
    remove(store, "pioneer_studio_wallet");
  }
}

export function saveWalletSession(session: WalletSession, remember: boolean, stores = browserStores()): void {
  clearWalletSession(stores);
  const valid = validateWalletSession(session);
  if (!valid) return;
  setRememberWalletPreference(remember, stores);
  try {
    const target = remember ? stores.local : stores.tab;
    if (target) { target.setItem(WALLET_SESSION_KEY, JSON.stringify(valid)); return; }
  } catch { /* try tab storage if persistent storage is unavailable */ }
  if (remember) {
    try { stores.tab?.setItem(WALLET_SESSION_KEY, JSON.stringify(valid)); } catch { /* memory-only session */ }
  }
}

export function restoreWalletSession(stores = browserStores(), now = Date.now()): { session: WalletSession; remember: boolean } | null {
  for (const store of [stores.local, stores.tab]) {
    remove(store, "pioneer_studio_api_key");
    remove(store, "pioneer_studio_wallet");
  }
  for (const [store, persistent] of [[stores.local, true], [stores.tab, false]] as const) {
    const raw = read(store, WALLET_SESSION_KEY);
    if (!raw) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { /* malformed cache */ }
    let session = validateWalletSession(parsed, now);
    if (!session) { remove(store, WALLET_SESSION_KEY); continue; }
    const legacy = !(parsed as { version?: number }).version;
    // Older Studio capped tab sessions at twelve hours despite a longer server JWT.
    if (legacy) session = validateWalletSession({ ...session, expiresAt: Number.MAX_SAFE_INTEGER }, now)!;
    const remember = legacy ? rememberWalletPreference(stores) : persistent;
    if (legacy) saveWalletSession(session, remember, stores);
    else remove(persistent ? stores.tab : stores.local, WALLET_SESSION_KEY);
    return { session, remember };
  }
  return null;
}
