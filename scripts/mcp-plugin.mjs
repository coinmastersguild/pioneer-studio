// Dev-only MCP endpoint: POST /mcp speaks JSON-RPC, and every tool call is
// forwarded to the open browser tab over Vite's own HMR socket. The studio's
// actions live in the page (window.__studio), so the page is the only thing
// that can actually run them — this plugin is just the transport the control
// registry never had.
//
// Dev server only. `vite build` never sees it, so nothing is exposed in prod.
const PROTOCOL_VERSION = "2024-11-05";
// Listing is a synchronous read of the registry, so a page that has not answered
// in a few seconds is not going to. Running an action is a different animal: a
// bulk pass is one chat completion per beat and a final clip is minutes of GPU
// (minimax-h3 is ~13.5 min for 5s). The old single 30s budget silently abandoned
// every one of those while the page kept working — the caller saw a timeout and
// could not tell it from a failure, and re-running would double-charge.
const LIST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 45 * 60_000;

export function studioMcp() {
  /** id → {resolve, reject, timer} for calls awaiting the page's reply */
  const pending = new Map();
  let nextId = 1;
  let sendToPage = null;
  let tabCount = () => 0;

  const ask = (kind, payload, timeoutMs = CALL_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      // failing fast on "nobody is listening" beats waiting out the timeout for
      // an answer that was never coming
      if (!sendToPage || tabCount() === 0)
        return reject(new Error("no studio tab is connected — open http://localhost:5173/ in a browser first"));
      // The send below is a broadcast — every connected tab runs the
      // action and only the first reply is kept. With two tabs open, reads come
      // from whichever document answered fastest and writes land in BOTH, so a
      // paid render fires once per tab. Refusing beats guessing; addressing a
      // specific tab is the real fix if anyone ever needs concurrent tabs.
      if (tabCount() > 1)
        return reject(
          new Error(`${tabCount()} studio tabs are connected — close all but one. Tool calls broadcast to every tab, so reads are non-deterministic and writes would apply more than once.`),
        );
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`the page did not answer in ${Math.round(timeoutMs / 1000)}s — it may still be working; re-read state before retrying`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      sendToPage(kind, { id, ...payload });
    });

  const settle = ({ id, ok, value, error }) => {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
    ok ? p.resolve(value) : p.reject(new Error(error || "action failed"));
  };

  return {
    name: "studio-mcp",
    apply: "serve",
    configureServer(server) {
      sendToPage = (event, data) => server.ws.send(event, data);
      tabCount = () => server.ws.clients?.size ?? 1; // older vite: assume connected
      server.ws.on("studio:result", settle);
      // the page shouts its console into the terminal, so a failing action is
      // debuggable from the same place the request was made
      server.ws.on("studio:log", ({ level, text }) => {
        server.config.logger.info(`[studio ${level}] ${text}`);
      });

      server.middlewares.use("/mcp", async (req, res) => {
        const reply = (status, body) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(body === undefined ? "" : JSON.stringify(body));
        };
        if (req.method !== "POST") return reply(405, { error: "POST JSON-RPC to this endpoint" });

        let msg;
        try {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          msg = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          return reply(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "bad JSON" } });
        }

        const { id, method, params } = msg;
        const ok = (result) => reply(200, { jsonrpc: "2.0", id, result });
        const fail = (message) => reply(200, { jsonrpc: "2.0", id, error: { code: -32000, message } });
        if (id === undefined) return reply(202); // a notification wants no answer

        try {
          if (method === "initialize")
            return ok({
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "pioneer-studio", version: "1.0.0" },
            });
          if (method === "ping") return ok({});
          if (method === "tools/list") {
            const actions = await ask("studio:list", {}, LIST_TIMEOUT_MS);
            return ok({
              tools: actions.map((a) => ({
                name: a.name.replace(/[^a-zA-Z0-9_-]/g, "_"),
                description: a.confirmation ? `${a.description} (normally confirmed: ${a.confirmation})` : a.description,
                inputSchema: a.parameters || { type: "object", properties: {} },
              })),
            });
          }
          if (method === "tools/call") {
            const value = await ask("studio:call", { name: params?.name, params: params?.arguments || {} });
            return ok({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2) }] });
          }
          return fail(`unknown method "${method}"`);
        } catch (e) {
          return fail(String(e?.message || e));
        }
      });

      server.config.logger.info("  ➜  MCP:      http://localhost:5173/mcp (dev only)");
    },
  };
}
