#!/usr/bin/env bun
// Project bundles from the command line (same code as Studio's Export/Import buttons).
//   bun scripts/project-bundle.ts export <projectId> <out.pstudio>
//   bun scripts/project-bundle.ts import <file.pstudio> [title]      -> creates a new project
//   bun scripts/project-bundle.ts verify <file.pstudio>
//   bun scripts/project-bundle.ts roundtrip <projectId>              -> export, import as a copy, export again, compare, delete the copy
// Auth: PIONEER_API_KEY in the environment. API: PIONEER_API_BASE (default https://alpha.pioneers.dev).
import { createWriteStream } from "node:fs";
import { exportBundle, importBundle, readBundle, shaOfUrl, verifyBundle, type BundleManifest } from "../src/projectBundle";

const API = process.env.PIONEER_API_BASE ?? "https://alpha.pioneers.dev";
const KEY = process.env.PIONEER_API_KEY;
if (!KEY) throw new Error("PIONEER_API_KEY is not set");
const auth = { Authorization: `Bearer ${KEY}` };

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${body?.error ?? ""}`);
  return body;
}
const progress = (verb: string) => (done: number, total: number, name: string) =>
  process.stderr.write(`\r${verb} ${done}/${total} ${name.slice(0, 20)}        ${done === total ? "\n" : ""}`);

async function exportTo(id: string, out: string): Promise<BundleManifest> {
  const project = await api(`/api/v1/projects/${id}`);
  const file = createWriteStream(out);
  const manifest = await exportBundle(project, {
    api: API,
    fetchBytes: async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download ${url}: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    write: (chunk) => new Promise<void>((ok, fail) => file.write(chunk, (e) => (e ? fail(e) : ok()))),
    onProgress: progress("export"),
  });
  await new Promise((ok) => file.end(ok));
  return manifest;
}

async function open(path: string) {
  return readBundle(Bun.file(path).stream() as unknown as AsyncIterable<Uint8Array>);
}

async function importFrom(path: string, title?: string): Promise<string> {
  const bundle = await open(path);
  const restored = await importBundle(bundle, {
    upload: async (bytes, name) => {
      const form = new FormData();
      form.append("file", new File([bytes as BlobPart], name));
      const body = await api("/api/v1/media", { method: "POST", body: form });
      const sha256 = shaOfUrl(body.url) ?? shaOfUrl(body.key ?? "");
      if (!sha256) throw new Error(`upload of ${name} returned no content-addressed key`);
      return { url: body.url, sha256 };
    },
    onProgress: progress("import"),
  });
  const created = await api("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: title ?? restored.title, doc: restored.doc }),
  });
  return created.id;
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "export") {
  const m = await exportTo(a, b);
  console.log(`exported ${m.source.title} rev ${m.source.rev}: ${m.assets.length} assets, ${m.assets.reduce((n, x) => n + x.bytes, 0)} bytes, ${m.external.length} external -> ${b}`);
} else if (cmd === "verify") {
  const bundle = await open(a);
  const problems = await verifyBundle(bundle);
  console.log(problems.length ? `FAILED\n${problems.join("\n")}` : `ok: ${bundle.manifest.assets.length} assets verified, project ${bundle.manifest.projectSha256.slice(0, 12)}`);
  if (problems.length) process.exit(1);
} else if (cmd === "import") {
  console.log(`imported as project ${await importFrom(a, b)}`);
} else if (cmd === "roundtrip") {
  const tmp = `${process.env.TMPDIR ?? "/tmp"}/roundtrip-${a}`;
  const first = await exportTo(a, `${tmp}-1.pstudio`);
  const copy = await importFrom(`${tmp}-1.pstudio`, `${first.source.title} (round-trip test)`);
  try {
    const second = await exportTo(copy, `${tmp}-2.pstudio`);
    const same = (m: BundleManifest) => m.assets.map((x) => `${x.sha256}:${x.bytes}`).sort().join(); // the host picks the extension
    const ok = second.projectSha256 === first.projectSha256 && same(second) === same(first);
    console.log(`${ok ? "LOSSLESS" : "MISMATCH"}: project ${first.projectSha256.slice(0, 12)} vs ${second.projectSha256.slice(0, 12)}, assets ${first.assets.length} vs ${second.assets.length}`);
    if (!ok) process.exit(1);
  } finally {
    await api(`/api/v1/projects/${copy}`, { method: "DELETE" });
    console.log(`deleted test copy ${copy}`);
  }
} else {
  console.log("usage: project-bundle.ts export <id> <out> | import <file> [title] | verify <file> | roundtrip <id>");
  process.exit(2);
}
