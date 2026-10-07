import { useEffect, useRef, useState } from "react";
import type { DesktopSocket } from "./agentRuntime";
import { requestDesktopFullscreen } from "./agentDesktopFullscreen";
import AgentDesktopClipboard from "./AgentDesktopClipboard";
import { desktopClipboardText, sendDesktopClipboard } from "./desktopClipboard";
import type RFB from "@novnc/novnc";

/**
 * The agent's desktop, drawn by noVNC from Studio's own bundle. Alpha relays only the
 * VNC byte stream: no agent-controlled page ever runs in a Pioneer origin.
 */
export default function AgentDesktop({ socket, title, onReconnect, onClose, busy }: {
  socket: DesktopSocket; title: string; onReconnect: () => void; onClose: () => void; busy: boolean;
}) {
  const shell = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const client = useRef<RFB | null>(null);
  const [state, setState] = useState("Connecting…");
  const [fullscreenMessage, setFullscreenMessage] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [receivedText, setReceivedText] = useState<string | null>(null);
  useEffect(() => {
    let rfb: { disconnect(): void; focus(): void } | null = null;
    let cancelled = false;
    setState("Connecting…"); setConnected(false); setClipboardOpen(false); setReceivedText(null);
    void import("@novnc/novnc").then(({ default: RFB }) => {
      if (cancelled || !screen.current) return;
      const viewer = new RFB(screen.current, socket.url, { wsProtocols: socket.protocols });
      viewer.scaleViewport = true; viewer.resizeSession = true; viewer.focusOnClick = true;
      viewer.addEventListener("connect", () => { if (!cancelled) { setState(""); setConnected(true); viewer.focus(); } });
      viewer.addEventListener("disconnect", () => {
        if (!cancelled) { setState("Disconnected. Reconnect to open a new session."); setConnected(false); setClipboardOpen(false); setReceivedText(null); }
      });
      viewer.addEventListener("credentialsrequired", () => { if (!cancelled) { setState("The desktop asked for a password; Alpha should authenticate it."); viewer.disconnect(); } });
      viewer.addEventListener("clipboard", (event) => {
        if (cancelled) return;
        try { setReceivedText(desktopClipboardText((event as CustomEvent<{ text: unknown }>).detail?.text)); }
        catch { setReceivedText(null); }
      });
      rfb = viewer; client.current = viewer;
    }).catch(() => { if (!cancelled) setState("The desktop viewer failed to load."); });
    return () => { cancelled = true; if (client.current === rfb) client.current = null; rfb?.disconnect(); };
  }, [socket]);
  return <div className="agent-desktop" ref={shell} role="dialog" aria-label={`${title} desktop`}>
    <div className="agent-desktop-bar">
      <strong>{title}</strong>{state && <span role="status">{state}</span>}
      {fullscreenMessage && <span role="status">{fullscreenMessage}</span>}
      <span className="agent-desktop-actions">
        <button className="btn" aria-expanded={clipboardOpen} onClick={() => { setClipboardOpen(!clipboardOpen); if (clipboardOpen) setReceivedText(null); }}>Clipboard</button>
        <button className="btn" disabled={busy} onClick={() => { setClipboardOpen(false); setReceivedText(null); onReconnect(); }}>Reconnect</button>
        <button className="btn" onClick={() => void requestDesktopFullscreen(shell.current).then(setFullscreenMessage)}>Full screen</button>
        <button className="btn" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); onClose(); }}>Close</button>
      </span>
    </div>
    {clipboardOpen && <AgentDesktopClipboard connected={connected} receivedText={receivedText}
      onSend={(text) => sendDesktopClipboard(client.current, connected, text)} />}
    <div className="agent-desktop-screen" ref={screen} />
  </div>;
}
