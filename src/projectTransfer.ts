// Browser side of project bundles and checkpoints: Studio's Export / Import buttons and checkpoint list.
// The bundle format and its integrity checks live in projectBundle.ts (shared with scripts/project-bundle.ts).
import { API_BASE, apiFetch, authHeaders, type Project } from "./api";
import { exportBundle, importBundle, readBundle, shaOfUrl, withProjectId, type BundleManifest } from "./projectBundle";

async function json(res: Response, what: string) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `${what}: ${res.status}`);
  return body;
}

type Progress = (done: number, total: number, name: string) => void;
type SaveTarget = { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> };

/** Where the zip goes: a file the user picks (streamed to disk), else an in-memory download. */
async function saveTarget(filename: string): Promise<SaveTarget> {
  const pick = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<{ createWritable(): Promise<SaveTarget> }> }).showSaveFilePicker;
  if (pick) return (await pick({ suggestedName: filename, types: [{ description: "Pioneer project", accept: { "application/zip": [".pstudio"] } }] })).createWritable();
  const parts: BlobPart[] = []; // browsers without the file picker hold the whole bundle in memory
  return {
    write: async (chunk) => void parts.push(chunk as BlobPart),
    close: async () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(parts, { type: "application/zip" }));
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    },
  };
}

export async function exportProjectToFile(apiKey: string, id: string, onProgress?: Progress): Promise<BundleManifest> {
  const project: Project = await json(await apiFetch(`${API_BASE}/api/v1/projects/${id}`, { headers: authHeaders(apiKey) }), "project");
  const out = await saveTarget(`${project.title.replace(/[^\w.-]+/g, "_").slice(0, 60) || "project"}.pstudio`);
  const manifest = await exportBundle(project, {
    api: API_BASE,
    fetchBytes: async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download ${url}: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    write: (chunk) => out.write(chunk),
    onProgress,
  });
  await out.close();
  return manifest;
}

/** Media this account already stores, by sha256. A server without the check just means everything is uploaded. */
async function alreadyStored(apiKey: string, shas: string[]): Promise<Record<string, string>> {
  if (!shas.length) return {};
  const res = await apiFetch(`${API_BASE}/api/v1/media/have`, { method: "POST", headers: { ...authHeaders(apiKey), "content-type": "application/json" }, body: JSON.stringify({ sha256: shas }) });
  if (res.status === 404) return {};
  return (await json(res, "media/have")).have ?? {};
}

/**
 * Imports a .pstudio file as a new project. Assets this account already stores are not uploaded again. Uploads
 * spend intake credits, so `confirm` is shown the count first and the import stops if it returns false.
 */
export async function importProjectFile(apiKey: string, file: File, confirm: (uploads: number, bytes: number, title: string) => boolean, onProgress?: Progress): Promise<Project | null> {
  const bundle = await readBundle(file.stream() as unknown as AsyncIterable<Uint8Array>);
  const have = await alreadyStored(apiKey, bundle.manifest.assets.map((a) => a.sha256));
  const fresh = bundle.manifest.assets.filter((a) => !have[a.sha256]);
  if (!confirm(fresh.length, fresh.reduce((n, a) => n + a.bytes, 0), bundle.manifest.source.title)) return null;
  const restored = await importBundle(bundle, {
    onProgress,
    upload: async (bytes, name) => {
      const sha = name.split(".")[0];
      if (have[sha]) return { url: have[sha], sha256: sha };
      const form = new FormData();
      form.append("file", new File([bytes as BlobPart], name));
      const body = await json(await apiFetch(`${API_BASE}/api/v1/media`, { method: "POST", headers: authHeaders(apiKey), body: form }), "upload");
      return { url: body.url, sha256: shaOfUrl(body.url) ?? shaOfUrl(body.key ?? "") ?? "" };
    },
  });
  // Create first, then save the document under the new project's id (Studio keys its caches by doc.id).
  const created: Project = await json(
    await apiFetch(`${API_BASE}/api/v1/projects`, { method: "POST", headers: { ...authHeaders(apiKey), "content-type": "application/json" }, body: JSON.stringify({ title: restored.title }) }),
    "create project",
  );
  return json(
    await apiFetch(`${API_BASE}/api/v1/projects/${created.id}`, { method: "PUT", headers: { ...authHeaders(apiKey), "content-type": "application/json" }, body: JSON.stringify({ doc: withProjectId(restored.doc, created.id), rev: created.rev }) }),
    "save project",
  );
}

export type Checkpoint = { id: string; rev: number; title: string; label: string; at: number; by: string; bytes: number };

export async function listCheckpoints(apiKey: string, id: string): Promise<Checkpoint[]> {
  return (await json(await apiFetch(`${API_BASE}/api/v1/projects/${id}/checkpoints`, { headers: authHeaders(apiKey) }), "checkpoints")).checkpoints ?? [];
}

export async function takeCheckpoint(apiKey: string, id: string, label = ""): Promise<Checkpoint> {
  return json(
    await apiFetch(`${API_BASE}/api/v1/projects/${id}/checkpoints`, { method: "POST", headers: { ...authHeaders(apiKey), "content-type": "application/json" }, body: JSON.stringify({ label }) }),
    "checkpoint",
  );
}

/** Restores a checkpoint as the project's new revision (the server checkpoints the current state first). */
export async function restoreCheckpoint(apiKey: string, id: string, cid: string): Promise<Project> {
  return (await json(await apiFetch(`${API_BASE}/api/v1/projects/${id}/checkpoints/${cid}/restore`, { method: "POST", headers: authHeaders(apiKey) }), "restore")).project;
}
