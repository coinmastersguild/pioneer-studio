export type EthProvider = {
  request(a: { method: string; params?: unknown[] }): Promise<any>;
  isMetaMask?: boolean; isKeepKey?: boolean; providers?: EthProvider[];
};
export type WalletOption = { id: string; name: string; provider?: EthProvider; kind: "metamask" | "keepkey" | "other" };
type WalletWindow = Window & { ethereum?: EthProvider; keepkey?: { ethereum?: EthProvider } };
type Announcement = { info: { uuid: string; name: string; rdns: string }; provider: EthProvider };

export function legacyWalletOptions(target: WalletWindow): WalletOption[] {
  const result: WalletOption[] = [];
  const kk = target.keepkey?.ethereum;
  if (kk?.request) result.push({ id: "keepkey", name: "KeepKey", provider: kk, kind: "keepkey" });
  for (const provider of [...(target.ethereum?.providers || []), target.ethereum].filter((p): p is EthProvider => !!p?.request)) {
    if (result.some((wallet) => wallet.provider === provider)) continue;
    const kind = provider.isKeepKey ? "keepkey" : provider.isMetaMask ? "metamask" : "other";
    result.push({ id: `legacy-${result.length}`, name: kind === "keepkey" ? "KeepKey" : kind === "metamask" ? "MetaMask" : "Browser wallet", provider, kind });
  }
  return result;
}

/** Discover each provider independently instead of choosing whichever owns window.ethereum. */
export function discoverWallets(target: WalletWindow, onChange: (wallets: WalletOption[]) => void): () => void {
  const announced: WalletOption[] = [];
  function publish() {
    const wallets = [...announced, ...legacyWalletOptions(target).filter((w) => !announced.some((a) => a.provider === w.provider))];
    if (!wallets.some((w) => w.kind === "metamask")) wallets.push({ id: "metamask-sdk", name: "MetaMask", kind: "metamask" });
    if (!wallets.some((w) => w.kind === "keepkey")) wallets.push({ id: "keepkey-unavailable", name: "KeepKey", kind: "keepkey" });
    onChange(wallets);
  }
  function receive(event: Event) {
    const detail = (event as CustomEvent<Announcement>).detail;
    if (!detail || typeof detail.provider?.request !== "function" || typeof detail.info?.uuid !== "string" ||
        typeof detail.info?.name !== "string" || typeof detail.info?.rdns !== "string") return;
    if (announced.some((w) => w.id === detail.info.uuid || w.provider === detail.provider)) return;
    const rdns = detail.info.rdns.toLowerCase();
    const kind = rdns === "io.metamask" ? "metamask" : /^(com|io)\.keepkey(?:\.|$)/.test(rdns) ? "keepkey" : "other";
    announced.push({ id: detail.info.uuid, name: detail.info.name.slice(0, 60), kind, provider: detail.provider });
    publish();
  }
  target.addEventListener("eip6963:announceProvider", receive);
  publish();
  target.dispatchEvent(new Event("eip6963:requestProvider"));
  target.addEventListener("ethereum#initialized", publish);
  return () => {
    target.removeEventListener("eip6963:announceProvider", receive);
    target.removeEventListener("ethereum#initialized", publish);
  };
}
