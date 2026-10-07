import { expect, test } from "bun:test";
import { desktopSocket, unlockKey } from "./agentRuntime";

const id = "10000000-0000-4000-8000-000000000001";
const hex = "a".repeat(63) + "B";

test("unlock key accepts the bare key or the .env.keys line, nothing else", () => {
  expect(unlockKey(` ${hex}\n`)).toBe(hex.toLowerCase());
  expect(unlockKey(`DOTENV_PRIVATE_KEY="${hex}"`)).toBe(hex.toLowerCase());
  for (const bad of ["", "a".repeat(63), "g".repeat(64), `${hex} extra`, "sk-pioneer-abc"]) expect(() => unlockKey(bad)).toThrow();
});

test("desktop sockets go only to Alpha's relay for this agent, ticket outside the URL", () => {
  const url = `wss://alpha.pioneers.dev/api/v1/agents/${id}/desktop/websocket`;
  const ticket = "t".repeat(40);
  expect(desktopSocket({ websocket_url: url, ticket }, id)).toEqual({ url, protocols: ["binary", `pioneer-ticket.${ticket}`] });
  for (const bad of [
    { websocket_url: url.replace("alpha.pioneers.dev", "evil.example"), ticket },
    { websocket_url: url.replace(id, "20000000-0000-4000-8000-000000000002"), ticket },
    { websocket_url: `${url}?ticket=${ticket}`, ticket },
    { websocket_url: url.replace("wss:", "ws:"), ticket },
    { websocket_url: url.replace("wss://", "wss://user:pw@"), ticket },
    { websocket_url: url, ticket: "short" },
    { websocket_url: url, ticket: "has space".padEnd(40, "x") },
  ]) expect(() => desktopSocket(bad, id)).toThrow();
});
