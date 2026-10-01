import { describe, expect, test } from "bun:test";
import { exportBundle, importBundle, readBundle, sha256Hex, toPortable, verifyBundle, withProjectId } from "./projectBundle";

const enc = (s: string) => new TextEncoder().encode(s);
async function hosted(host: string, body: string, ext: string) {
  const bytes = enc(body);
  return { url: `https://${host}/media/0xOWNER/${await sha256Hex(bytes)}.${ext}`, bytes };
}

async function fixture() {
  const clip = await hosted("pub.example.dev", "fake mp4 bytes", "mp4");
  const still = await hosted("pub.example.dev", "fake png bytes", "png");
  const doc = {
    id: "local", title: "Test film", rev: 7,
    shots: [{ id: "s1", result: { url: clip.url }, refs: [{ url: still.url }] }, { id: "s2", result: { url: clip.url } }],
    inline: "data:image/png;base64,AAAA",
    elsewhere: "https://example.com/not-hosted.mp4",
  };
  const store = new Map([[clip.url, clip.bytes], [still.url, still.bytes]]);
  return { doc, store };
}

async function toZip(doc: unknown, store: Map<string, Uint8Array>) {
  const parts: Uint8Array[] = [];
  const manifest = await exportBundle({ id: "p1", title: "Test film", rev: 7, doc }, {
    api: "https://api.example.dev",
    fetchBytes: async (url) => store.get(url)!,
    write: (chunk) => void parts.push(chunk),
  });
  return { manifest, parts };
}

async function* stream(parts: Uint8Array[]) {
  for (const p of parts) yield p;
}

describe("project bundles", () => {
  test("portable form swaps hosted URLs for asset refs and keeps the rest", async () => {
    const { doc } = await fixture();
    const p = toPortable(doc);
    expect(p.assets.size).toBe(2);
    expect(p.json).not.toContain("pub.example.dev");
    expect(p.json).toContain("data:image/png;base64,AAAA");
    expect(p.external).toEqual(["https://example.com/not-hosted.mp4"]);
  });

  test("export -> import -> export is lossless", async () => {
    const { doc, store } = await fixture();
    const first = await toZip(doc, store);
    expect(first.manifest.assets.length).toBe(2);
    const bundle = await readBundle(stream(first.parts));
    expect(await verifyBundle(bundle)).toEqual([]);

    // Re-host on another "account": new URLs, same content.
    const rehosted = new Map<string, Uint8Array>();
    const restored = await importBundle(bundle, {
      upload: async (bytes, name) => {
        const sha256 = await sha256Hex(bytes);
        const url = `https://other.example.dev/media/0xNEW/${sha256}.${name.endsWith(".png") ? "jpeg" : name.split(".").pop()}`;
        rehosted.set(url, bytes);
        return { url, sha256 };
      },
    });
    expect(JSON.stringify(restored.doc)).toContain("other.example.dev");
    expect(JSON.stringify(restored.doc)).toContain(".jpeg"); // the new host chose another extension

    const second = await toZip(restored.doc, rehosted);
    expect(second.manifest.projectSha256).toBe(first.manifest.projectSha256);
    expect(second.manifest.assets.map((a) => a.sha256).sort()).toEqual(first.manifest.assets.map((a) => a.sha256).sort());
  });

  test("a download that does not match its sha256 aborts the export", async () => {
    const { doc, store } = await fixture();
    for (const k of store.keys()) store.set(k, enc("tampered"));
    await expect(toZip(doc, store)).rejects.toThrow(/does not match its sha256/);
  });

  test("import refuses a server that stored different bytes", async () => {
    const { doc, store } = await fixture();
    const bundle = await readBundle(stream((await toZip(doc, store)).parts));
    await expect(importBundle(bundle, { upload: async () => ({ url: "https://x/media/o/abc.mp4", sha256: "0".repeat(64) }) })).rejects.toThrow(/different bytes/);
  });
});

test("the document id is identity, not content: bundles blank it and an import takes the new project's id", async () => {
  const { doc } = await fixture();
  expect(JSON.parse(toPortable(doc).json).id).toBe("");
  expect(toPortable({ ...doc, id: "a" }).json).toBe(toPortable({ ...doc, id: "b" }).json);
  expect((withProjectId({ id: "", x: 1 }, "p2") as { id: string }).id).toBe("p2");
});
