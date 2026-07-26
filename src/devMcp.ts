// The page half of the dev MCP bridge. Vite's HMR socket carries tool calls in
// and results out, so an agent drives the studio through exactly the registry
// the copilot and the buttons use — no second code path to keep honest.
//
// Dev only: `import.meta.hot` is undefined in a production build, so this file
// does nothing there, and the plugin that talks to it is `apply: "serve"`.
import { actionForTool, callAction, listActions } from "./control";

type Envelope = { id: number };

export function connectDevMcp(): void {
  const hot = import.meta.hot;
  if (!hot) return;

  hot.on("studio:list", ({ id }: Envelope) => {
    hot.send("studio:result", { id, ok: true, value: listActions() });
  });

  hot.on("studio:call", async ({ id, name, params }: Envelope & { name: string; params?: Record<string, unknown> }) => {
    try {
      // MCP tool names cannot contain dots, so "animate.get_state" arrives as
      // "animate_get_state" — map it back before the registry sees it
      const real = actionForTool(name)?.name || name;
      const value = await callAction(real, params);
      // actions return live app objects; only what survives JSON is sendable
      hot.send("studio:result", { id, ok: true, value: JSON.parse(JSON.stringify(value ?? null)) });
    } catch (e: unknown) {
      hot.send("studio:result", { id, ok: false, error: String((e as Error)?.message || e) });
    }
  });

  // mirror the page console into the dev server's terminal — the whole point of
  // driving it from outside is being able to read what went wrong
  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        hot.send("studio:log", { level, text: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ").slice(0, 2000) });
      } catch {
        /* a log that cannot be forwarded is still logged locally */
      }
    };
  }
  window.addEventListener("error", (e) => hot.send("studio:log", { level: "error", text: `uncaught: ${e.message}` }));
  window.addEventListener("unhandledrejection", (e) =>
    hot.send("studio:log", { level: "error", text: `unhandled rejection: ${String((e as PromiseRejectionEvent).reason)}` }),
  );
  console.log("[studio] dev MCP bridge connected");
}
