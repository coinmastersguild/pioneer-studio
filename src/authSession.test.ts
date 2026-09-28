import { expect, test } from "bun:test";
import { clearWalletSession, rememberWalletPreference, restoreWalletSession, saveWalletSession, setRememberWalletPreference, validateWalletSession, walletSessionFromResponse, WALLET_SESSION_KEY } from "./authSession";

const address = `0x${"a".repeat(40)}`;
const expiresAt = Math.floor(Date.now() / 1000) + 90 * 24 * 3600;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${encode({ alg: "HS256" })}.${encode({ type: "pioneer-api", address, exp: expiresAt })}.signature`;
const session = walletSessionFromResponse({ token, address, expiresAt });
function stores() {
  const store = () => {
    const data = new Map<string, string>();
    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key) };
  };
  return { local: store(), tab: store() };
}

test("remember me defaults on and restores wallet tokens until actual server expiry", () => {
  const cache = stores();
  expect(rememberWalletPreference(cache)).toBe(true);
  saveWalletSession(session, true, cache);
  expect(cache.local.getItem(WALLET_SESSION_KEY)).not.toBeNull();
  expect(cache.tab.getItem(WALLET_SESSION_KEY)).toBeNull();
  expect(restoreWalletSession(cache)).toEqual({ session, remember: true });
  expect(session.expiresAt).toBe(expiresAt * 1000);
});

test("unchecking remember moves a wallet token into tab storage only", () => {
  const cache = stores();
  saveWalletSession(session, true, cache);
  saveWalletSession(session, false, cache);
  expect(cache.local.getItem(WALLET_SESSION_KEY)).toBeNull();
  expect(restoreWalletSession(cache)).toEqual({ session, remember: false });
  expect(rememberWalletPreference(cache)).toBe(false);
});

test("legacy tab sessions migrate to remembered sessions without the old twelve-hour cap", () => {
  const cache = stores();
  cache.tab.setItem(WALLET_SESSION_KEY, JSON.stringify({ token, address, expiresAt: Date.now() + 12 * 3600_000 }));
  expect(restoreWalletSession(cache)).toEqual({ session, remember: true });
  expect(cache.tab.getItem(WALLET_SESSION_KEY)).toBeNull();
  expect(JSON.parse(cache.local.getItem(WALLET_SESSION_KEY)!).expiresAt).toBe(expiresAt * 1000);
});

test("malformed, expired, mismatched, and API-key cache entries are removed", () => {
  for (const value of ["not JSON", "null", JSON.stringify({ ...session, expiresAt: 0 }), JSON.stringify({ ...session, address: `0x${"b".repeat(40)}` }), JSON.stringify({ ...session, token: "sk-pioneer-do-not-persist" })]) {
    const cache = stores();
    cache.local.setItem(WALLET_SESSION_KEY, value);
    expect(restoreWalletSession(cache)).toBeNull();
    expect(cache.local.getItem(WALLET_SESSION_KEY)).toBeNull();
  }
  const cache = stores();
  saveWalletSession(session, true, cache);
  expect(restoreWalletSession(cache, session.expiresAt)).toBeNull();
  expect(cache.local.getItem(WALLET_SESSION_KEY)).toBeNull();
  expect(validateWalletSession({ ...session, expiresAt: session.expiresAt + 3600_000 })?.expiresAt).toBe(session.expiresAt);
});

test("sign-out clears both wallet caches and legacy API keys; API keys cannot be saved as wallet sessions", () => {
  const cache = stores();
  for (const store of [cache.local, cache.tab]) {
    store.setItem(WALLET_SESSION_KEY, JSON.stringify(session));
    store.setItem("pioneer_studio_api_key", "sk-pioneer-old");
  }
  clearWalletSession(cache);
  for (const store of [cache.local, cache.tab]) {
    expect(store.getItem(WALLET_SESSION_KEY)).toBeNull();
    expect(store.getItem("pioneer_studio_api_key")).toBeNull();
  }
  saveWalletSession({ ...session, token: "sk-pioneer-private" }, true, cache);
  expect(cache.local.getItem(WALLET_SESSION_KEY)).toBeNull();
  expect(cache.tab.getItem(WALLET_SESSION_KEY)).toBeNull();
});

test("blocked browser storage leaves a usable memory-only sign-in", () => {
  const blocked = { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); }, removeItem() { throw Error("blocked"); } };
  const cache = { local: blocked, tab: blocked };
  expect(restoreWalletSession(cache)).toBeNull();
  expect(() => { saveWalletSession(session, true, cache); clearWalletSession(cache); setRememberWalletPreference(false, cache); }).not.toThrow();
});
