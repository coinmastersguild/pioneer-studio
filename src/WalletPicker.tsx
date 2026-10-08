import { useEffect, useState } from "react";
import { discoverWallets, type WalletOption } from "./wallets";

export default function WalletPicker({ onConnect, busy = false }: { onConnect: (wallet: WalletOption) => void; busy?: boolean }) {
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  useEffect(() => discoverWallets(window, setWallets), []);
  return (
    <div className="wallet-options" aria-label="Choose a wallet" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {wallets.map((wallet) => <button key={wallet.id} type="button" className="btn" disabled={busy}
        onClick={() => onConnect(wallet)} aria-label={`Connect ${wallet.name}`}>
        {wallet.name}{wallet.kind === "keepkey" && !wallet.provider ? " · install extension" : ""}
      </button>)}
      {busy && <span role="status">Approve sign-in in your wallet…</span>}
    </div>
  );
}
