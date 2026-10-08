import { afterEach, expect, test } from "bun:test";
import { downloadAgentFile, readAgentFile, writeAgentFile } from "./api";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const id = "00000000-0000-4000-8000-000000000001";
const limit = 10 * 1024 * 1024;

test("project downloads preserve binary bytes and MIME without putting credentials in the URL", async () => {
  const bytes = new Uint8Array([0x42, 0x4c, 0x45, 0x4e, 0x44, 0, 0xff, 0x80, 0x0a]);
  let calls = 0;
  globalThis.fetch = (async (input, init) => {
    calls++; const url = new URL(String(input));
    expect(url.searchParams.get("area")).toBe("projects");
    expect(url.searchParams.get("path")).toBe("downloads/scene.blend");
    expect(url.searchParams.get("download")).toBe("true");
    expect(url.search).not.toContain("fixture-owner");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-owner");
    return new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } });
  }) as typeof fetch;
  const blob = await downloadAgentFile("fixture-owner", id, "downloads/scene.blend", undefined, "projects");
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  expect(blob.type).toBe("application/octet-stream"); expect(calls).toBe(1);
});

test("both declared and actual oversized downloads are refused, cancelling the stream", async () => {
  globalThis.fetch = (async () => new Response("", { headers: { "Content-Length": String(limit + 1) } })) as typeof fetch;
  await expect(downloadAgentFile("fixture-owner", id, "too-large.bin")).rejects.toThrow("10 MiB");
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(limit)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  }))) as typeof fetch;
  await expect(downloadAgentFile("fixture-owner", id, "too-large.bin")).rejects.toThrow("10 MiB");
  expect(cancelled).toBe(true);
});

test("file areas stay explicit and a 10 MiB project upload remains raw bytes", async () => {
  const observed: { area: string | null; method: string | undefined; body: BodyInit | null | undefined }[] = [];
  globalThis.fetch = (async (input, init) => {
    observed.push({ area: new URL(String(input)).searchParams.get("area"), method: init?.method, body: init?.body });
    return init?.method === "PUT" ? Response.json({ written: true }) : new Response("project text");
  }) as typeof fetch;
  expect(await readAgentFile("fixture-owner", id, "notes.txt", undefined, "projects")).toBe("project text");
  const body = "x".repeat(limit);
  await writeAgentFile("fixture-owner", id, "notes.txt", body, undefined, "projects");
  expect(observed[0].area).toBe("projects");
  expect(observed[1]).toEqual({ area: "projects", method: "PUT", body });
  await expect(writeAgentFile("fixture-owner", id, "notes.txt", body + "x")).rejects.toThrow("10 MiB");
  expect(observed).toHaveLength(2);
});

test("traversal and invalid file areas are rejected before network access", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(""); }) as typeof fetch;
  await expect(downloadAgentFile("fixture-owner", id, "../outside")).rejects.toThrow("relative");
  await expect(downloadAgentFile("fixture-owner", id, "file.txt", undefined, "other" as "workspace")).rejects.toThrow("area");
  expect(calls).toBe(0);
});
