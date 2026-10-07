import { afterEach, expect, test } from "bun:test";
import { discoverWallets, legacyWalletOptions, type EthProvider, type WalletOption } from "./wallets";
import { connectWallet } from "./api";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const provider = (flags: Partial<EthProvider> = {}): EthProvider => ({ request: async () => [], ...flags });

test("MetaMask and KeepKey remain separately selectable when both are injected", () => {
  const kk = provider({ isKeepKey: true, isMetaMask: true });
  const mm = provider({ isMetaMask: true });
  const target = { keepkey: { ethereum: kk }, ethereum: { ...mm, providers: [kk, mm] } } as unknown as Window;
  const choices = legacyWalletOptions(target);
  expect(choices.find((c) => c.kind === "keepkey")?.provider).toBe(kk);
  expect(choices.find((c) => c.kind === "metamask")?.provider).toBe(mm);
});
test("EIP-6963 announcements preserve distinct providers and listener cleanup", () => {
  const target = new EventTarget() as unknown as Window;
  let choices: WalletOption[] = [];
  const cleanup = discoverWallets(target, (list) => { choices = list; });
  const mm = provider(); const kk = provider();
  for (const [uuid, name, rdns, wallet] of [["mm", "MetaMask", "io.metamask", mm], ["kk", "KeepKey", "com.keepkey", kk]] as const) {
    target.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid, name, rdns }, provider: wallet } }));
  }
  expect(choices.find((c) => c.kind === "metamask")?.provider).toBe(mm);
  expect(choices.find((c) => c.kind === "keepkey")?.provider).toBe(kk);
  const before = choices;
  cleanup(); target.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "later", name: "Later", rdns: "example.wallet" }, provider: provider() } }));
  expect(choices).toBe(before);
});
test("the selected wallet performs both account access and challenge signing", async () => {
  const requests: { method: string; params?: unknown[] }[] = [];
  const address = "0x" + "ab".repeat(20);
  const selected = provider({ request: async (request) => { requests.push(request); return request.method === "eth_requestAccounts" ? [address] : "0x" + "ab".repeat(65); } });
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const encoded = Buffer.from(JSON.stringify({ type: "pioneer-api", address, exp: expiresAt })).toString("base64url");
  const token = `header.${encoded}.signature`;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/auth/challenge")) return Response.json({ challenge: "challenge", nonce: "nonce", expiresAt });
    expect(JSON.parse(init!.body as string)).toEqual({ address, signature: "0x" + "ab".repeat(65), challenge: "challenge", nonce: "nonce" });
    return Response.json({ token, address, expiresAt });
  }) as typeof fetch;
  const result = await connectWallet({ wallet: { id: "kk", kind: "keepkey", name: "KeepKey", provider: selected } });
  expect(result.address).toBe(address);
  expect(requests.map((r) => r.method)).toEqual(["eth_requestAccounts", "personal_sign"]);
  expect(requests[1].params).toEqual([`Pioneer API\nChallenge: challenge\nNonce: nonce\nAddress: ${address}`, address]);
});
test("an absent KeepKey provider fails without falling back to another wallet", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({}); }) as typeof fetch;
  await expect(connectWallet({ wallet: { id: "missing", kind: "keepkey", name: "KeepKey" } })).rejects.toThrow("KeepKey");
  expect(calls).toBe(0);
});
