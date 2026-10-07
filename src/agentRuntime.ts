import { API_BASE } from "./api";

/** Public template every agent repository starts from. GitHub creates the repo under the user's own account. */
export const AGENT_TEMPLATE_URL = "https://github.com/new?template_owner=coinmastersguild&template_name=agent-template";

/** The dotenvx private key (`make key` in the template). Held in memory only; never stored or logged. */
export function unlockKey(value: string): string {
  const key = value.trim().replace(/^DOTENV_PRIVATE_KEY=/, "").replace(/^"|"$/g, "");
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("Paste the 64-character key from `make key` in your agent repository.");
  return key.toLowerCase();
}

export type DesktopSocket = { url: string; protocols: string[] };

/**
 * Desktop sessions are a VNC WebSocket relayed by Alpha for this agent only. The
 * single-use ticket travels as a WebSocket subprotocol, never in a URL.
 */
export function desktopSocket(session: { websocket_url: string; ticket: string }, agentId: string): DesktopSocket {
  const url = new URL(session.websocket_url);
  if (url.href !== `${API_BASE.replace("https:", "wss:")}/api/v1/agents/${agentId}/desktop/websocket` ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(session.ticket))
    throw new Error("Alpha returned an invalid desktop session.");
  return { url: url.href, protocols: ["binary", `pioneer-ticket.${session.ticket}`] };
}
