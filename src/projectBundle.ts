// Project bundles (.pstudio): a zip of manifest.json + project.json + assets/<sha256>.<ext>.
//
// project.json is the project document with every hosted media URL replaced by `asset:<sha256>`, so a bundle
// is self-contained and can be re-hosted on any account. Hosted media is content-addressed (the URL carries the
// sha256 of its bytes), which is what makes the round trip checkable: export verifies every downloaded file against
// the sha256 in its URL, and import verifies that the server stored the same sha256 it was given.
// Refs carry no extension: hosts pick the stored extension by sniffing the bytes (a JPEG once saved as .png comes back
// as .jpg), so the hash alone names the content. data: URLs stay inline; other URLs are kept as-is and listed as external.
import { Unzip, UnzipPassThrough, Zip, ZipPassThrough, strFromU8, strToU8 } from "fflate";

export const BUNDLE_FORMAT = "pioneer.project";
export const BUNDLE_VERSION = 1;

/** A hosted, content-addressed object URL: https://<host>/<prefix>/<owner>/<sha256>.<ext> */
const HOSTED_RE = /https:\/\/[^"\s\\]+?\/[a-z]+\/[^"\s\\/]+\/([0-9a-f]{64})\.([a-z0-9]{1,8})(?=["\s\\?#]|$)/g;
const ASSET_RE = /asset:([0-9a-f]{64})(?![0-9a-f])/g;
const OTHER_URL_RE = /(?:https?|blob):[^"\s\\]+/g;

export type BundleAsset = { sha256: string; ext: string; bytes: number; origin: string };
export type BundleManifest = {
  format: typeof BUNDLE_FORMAT;
  version: number;
  exportedAt: string;
  source: { api: string; projectId: string; title: string; rev: number };
  /** sha256 of project.json exactly as stored in the bundle */
  projectSha256: string;
  assets: BundleAsset[];
  /** URLs that are not hosted media: kept verbatim in project.json, not bundled */
  external: string[];
};
export type SourceProject = { id: string; title: string; rev: number; doc: unknown };

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The document with hosted URLs swapped for asset refs, plus what it references. */
export function toPortable(doc: unknown): { json: string; assets: Map<string, { ext: string; url: string }>; external: string[] } {
  const assets = new Map<string, { ext: string; url: string }>();
  const json = JSON.stringify(doc).replace(HOSTED_RE, (url, sha: string, ext: string) => {
    if (!assets.has(sha)) assets.set(sha, { ext, url });
    return `asset:${sha}`;
  });
  const external = [...new Set(json.match(OTHER_URL_RE) ?? [])];
  return { json, assets, external };
}

/** The inverse: asset refs back to hosted URLs. */
export function fromPortable(json: string, urlFor: (sha256: string) => string): unknown {
  return JSON.parse(json.replace(ASSET_RE, (_ref, sha: string) => urlFor(sha)));
}

/**
 * Writes a bundle. `fetchBytes` downloads one hosted file; `write` receives the zip as it is produced (stream it to
 * disk, or collect it). Assets are stored uncompressed: media is already compressed, and storing keeps it fast.
 */
export async function exportBundle(
  project: SourceProject,
  io: { api: string; fetchBytes: (url: string) => Promise<Uint8Array>; write: (chunk: Uint8Array, final: boolean) => void | Promise<void>; onProgress?: (done: number, total: number, name: string) => void },
): Promise<BundleManifest> {
  const { json, assets, external } = toPortable(project.doc);
  const projectBytes = strToU8(json);
  const pending: Promise<void>[] = [];
  let failed: unknown = null;
  const zip = new Zip((err, chunk, final) => {
    if (err) failed = err;
    else pending.push(Promise.resolve(io.write(chunk, final)));
  });
  const add = (name: string, data: Uint8Array) => {
    const entry = new ZipPassThrough(name);
    zip.add(entry);
    entry.push(data, true);
  };
  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    source: { api: io.api, projectId: project.id, title: project.title, rev: project.rev },
    projectSha256: await sha256Hex(projectBytes),
    assets: [],
    external,
  };
  add("project.json", projectBytes);
  let done = 0;
  for (const [sha, { ext, url }] of assets) {
    io.onProgress?.(done, assets.size, `${sha}.${ext}`);
    const bytes = await io.fetchBytes(url);
    const got = await sha256Hex(bytes);
    if (got !== sha) throw new Error(`asset ${url} does not match its sha256 (got ${got})`);
    add(`assets/${sha}.${ext}`, bytes);
    manifest.assets.push({ sha256: sha, ext, bytes: bytes.length, origin: url });
    await Promise.all(pending.splice(0));
    done++;
  }
  add("manifest.json", strToU8(JSON.stringify(manifest, null, 1)));
  zip.end();
  await Promise.all(pending);
  if (failed) throw failed;
  io.onProgress?.(done, assets.size, "");
  return manifest;
}

export type ReadBundle = { manifest: BundleManifest; projectJson: string; asset: (name: string) => Uint8Array | undefined; names: string[] };

/** Reads a whole bundle from a stream of chunks. Holds every asset in memory; stream per entry if bundles outgrow RAM. */
export async function readBundle(chunks: AsyncIterable<Uint8Array>): Promise<ReadBundle> {
  const files = new Map<string, Uint8Array[]>();
  const unzip = new Unzip((file) => {
    const parts: Uint8Array[] = [];
    files.set(file.name, parts);
    file.ondata = (err, data) => {
      if (err) throw err;
      parts.push(data);
    };
    file.start();
  });
  unzip.register(UnzipPassThrough);
  for await (const chunk of chunks) unzip.push(chunk);
  unzip.push(new Uint8Array(0), true);
  const joined = new Map([...files].map(([name, parts]) => [name, concat(parts)]));
  const manifestBytes = joined.get("manifest.json"), projectBytes = joined.get("project.json");
  if (!manifestBytes || !projectBytes) throw new Error("not a project bundle (manifest.json or project.json missing)");
  const manifest = JSON.parse(strFromU8(manifestBytes)) as BundleManifest;
  if (manifest.format !== BUNDLE_FORMAT || manifest.version > BUNDLE_VERSION) throw new Error(`unsupported bundle ${manifest.format} v${manifest.version}`);
  return { manifest, projectJson: strFromU8(projectBytes), asset: (name) => joined.get(name), names: [...joined.keys()] };
}

/** Every check that can be made offline: the project hash, each asset's hash, and that every ref has its file. */
export async function verifyBundle(b: ReadBundle): Promise<string[]> {
  const problems: string[] = [];
  if ((await sha256Hex(strToU8(b.projectJson))) !== b.manifest.projectSha256) problems.push("project.json does not match manifest.projectSha256");
  for (const a of b.manifest.assets) {
    const bytes = b.asset(`assets/${a.sha256}.${a.ext}`);
    if (!bytes) problems.push(`missing assets/${a.sha256}.${a.ext}`);
    else if ((await sha256Hex(bytes)) !== a.sha256) problems.push(`assets/${a.sha256}.${a.ext} is corrupt`);
  }
  const listed = new Set(b.manifest.assets.map((a) => a.sha256));
  for (const m of b.projectJson.matchAll(ASSET_RE)) if (!listed.has(m[1])) problems.push(`project.json references unlisted asset ${m[1]}`);
  return [...new Set(problems)];
}

/**
 * Re-hosts a bundle: uploads each asset (`upload` returns the stored URL and the sha256 the server computed), checks
 * the server kept the same bytes, and returns the restored document ready to save as a new project.
 */
export async function importBundle(
  b: ReadBundle,
  io: { upload: (bytes: Uint8Array, name: string) => Promise<{ url: string; sha256: string }>; onProgress?: (done: number, total: number, name: string) => void },
): Promise<{ doc: unknown; title: string; urls: Map<string, string> }> {
  const problems = await verifyBundle(b);
  if (problems.length) throw new Error(`bundle failed verification:\n${problems.join("\n")}`);
  const urls = new Map<string, string>();
  let done = 0;
  for (const a of b.manifest.assets) {
    const name = `${a.sha256}.${a.ext}`;
    io.onProgress?.(done++, b.manifest.assets.length, name);
    const stored = await io.upload(b.asset(`assets/${name}`)!, name);
    if (stored.sha256 !== a.sha256) throw new Error(`server stored different bytes for ${name} (sha256 ${stored.sha256})`);
    urls.set(a.sha256, stored.url);
  }
  const doc = fromPortable(b.projectJson, (sha) => {
    const url = urls.get(sha);
    if (!url) throw new Error(`no uploaded file for asset ${sha}`);
    return url;
  });
  return { doc, title: b.manifest.source.title, urls };
}

/** The sha256 a hosted URL names (content-addressed keys end in <sha256>.<ext>). */
export function shaOfUrl(url: string): string | null {
  return url.match(/\/([0-9a-f]{64})\.[a-z0-9]{1,8}(?:[?#]|$)/)?.[1] ?? null;
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
