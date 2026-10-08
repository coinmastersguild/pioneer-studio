import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import AgentTaskArtifacts from "./AgentTaskArtifacts";
const prefix = "studio-00000000-0000-4000-8000-000000000001";
async function fixture(kind: "old" | "fake" | "abort" | "video") {
  const browser = new Window({ url: "http://localhost" }); const descriptors = new Map<string, PropertyDescriptor | undefined>(); const oldFetch = globalThis.fetch;
  const created: string[] = []; const revoked: string[] = []; let downloads = 0; let aborted = false;
  const oldCreate = URL.createObjectURL; const oldRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => { const url = `blob:synthetic/${created.length}`; created.push(url); return url; }; URL.revokeObjectURL = (url) => { revoked.push(url); };
  globalThis.fetch = (async (_input, init = {}) => {
    const url = new URL(String(_input));
    if (url.searchParams.get("download") !== "true") return Response.json({ entries: [{ name: kind === "old" ? "old.mp4" : `${prefix}.mp4`, dir: false, size: 32 }] });
    downloads++;
    if (kind === "abort") return await new Promise<Response>((_resolve, reject) => { init.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("Aborted", "AbortError")); }, { once: true }); });
    if (kind === "fake") return new Response("0000ftypisom0000");
    const bytes = new Uint8Array(32); new DataView(bytes.buffer).setUint32(0,24); bytes.set(new TextEncoder().encode("ftypisom"),4); new DataView(bytes.buffer).setUint32(24,8); bytes.set(new TextEncoder().encode("mdat"),28); return new Response(bytes);
  }) as typeof fetch;
  for (const [name, value] of Object.entries({ window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })) { descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis,name)); Object.defineProperty(globalThis,name,{value,configurable:true,writable:true}); }
  const container = browser.document.createElement("div"); const root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root.render(createElement(AgentTaskArtifacts,{apiKey:"synthetic-owner",agentId:"synthetic-agent",prefix})); await new Promise((r)=>setTimeout(r,10)); });
  const unmount = async () => { await act(async () => root.unmount()); };
  const cleanup = async () => { await unmount(); browser.happyDOM.abort(); globalThis.fetch=oldFetch; URL.createObjectURL=oldCreate; URL.revokeObjectURL=oldRevoke; for(const [name,descriptor] of descriptors) { if(descriptor) Object.defineProperty(globalThis,name,descriptor); else Reflect.deleteProperty(globalThis,name); } };
  return {container,created,revoked,downloads,aborted:()=>aborted,unmount,cleanup};
}
test("old files and fake ftyp bytes never create a task video preview or success claim",async()=> {
  for (const kind of ["old","fake"] as const) { const view=await fixture(kind); try { expect(view.container.querySelector("video")).toBeNull(); expect(view.container.textContent).not.toContain("Playable"); expect(view.created).toHaveLength(0); if(kind==="old") expect(view.downloads).toBe(0); } finally {await view.cleanup();} }
});
test("unmount aborts owner file downloads and disposes every local preview URL",async()=> {
  const pending=await fixture("abort"); try { await pending.unmount(); expect(pending.aborted()).toBe(true); expect(pending.created).toHaveLength(0); } finally {await pending.cleanup();}
  const view=await fixture("video"); try { expect(view.created).toHaveLength(1); expect(view.container.textContent).not.toContain("Playable video"); const video=view.container.querySelector("video")!; Object.defineProperty(video,"duration",{value:3,configurable:true}); Object.defineProperty(video,"videoWidth",{value:0,configurable:true}); Object.defineProperty(video,"videoHeight",{value:0,configurable:true}); await act(async()=>video.dispatchEvent(new view.container.ownerDocument.defaultView!.Event("canplay"))); expect(view.container.textContent).not.toContain("Playable video"); await view.unmount(); expect(view.revoked).toEqual(view.created); } finally {await view.cleanup();}
});
