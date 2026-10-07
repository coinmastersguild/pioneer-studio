import { useEffect, useRef, useState } from "react";
import type { DesktopSocket } from "./agentRuntime";
import { requestDesktopFullscreen } from "./agentDesktopFullscreen";

/**
 * The agent's desktop, drawn by noVNC from Studio's own bundle. Alpha relays only the
 * VNC byte stream: no agent-controlled page ever runs in a Pioneer origin.
 */
export default function AgentDesktop({ socket, title, onReconnect, onClose, busy }: {
  socket: DesktopSocket; title: string; onReconnect: () => void; onClose: () => void; busy: boolean;
}) {
  const shell = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const [state, setState] = useState("Connecting…");
  const [fullscreenMessage, setFullscreenMessage] = useState<string | null>(null);
  useEffect(() => {
    let rfb: { disconnect(): void; focus(): void } | null = null;
    let cancelled = false;
    setState("Connecting…");
    void import("@novnc/novnc").then(({ default: RFB }) => {
      if (cancelled || !screen.current) return;
      const client = new RFB(screen.current, socket.url, { wsProtocols: socket.protocols });
      client.scaleViewport = true; client.resizeSession = true; client.focusOnClick = true;
      client.addEventListener("connect", () => { setState(""); client.focus(); });
      client.addEventListener("disconnect", () => setState("Disconnected. Reconnect to open a new session."));
      client.addEventListener("credentialsrequired", () => { setState("The desktop asked for a password; Alpha should authenticate it."); client.disconnect(); });
      rfb = client;
    }).catch(() => { if (!cancelled) setState("The desktop viewer failed to load."); });
    return () => { cancelled = true; rfb?.disconnect(); };
  }, [socket]);
  return <div className="agent-desktop" ref={shell} role="dialog" aria-label={`${title} desktop`}>
    <div className="agent-desktop-bar">
      <strong>{title}</strong>{state && <span role="status">{state}</span>}
      {fullscreenMessage && <span role="status">{fullscreenMessage}</span>}
      <span className="agent-desktop-actions">
        <button className="btn" disabled={busy} onClick={onReconnect}>Reconnect</button>
        <button className="btn" onClick={() => void requestDesktopFullscreen(shell.current).then(setFullscreenMessage)}>Full screen</button>
        <button className="btn" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); onClose(); }}>Close</button>
      </span>
    </div>
    <div className="agent-desktop-screen" ref={screen} />
  </div>;
}
