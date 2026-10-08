import type { AgentFile } from "./api";
const MAX_FILE = 10 * 1024 * 1024;
const PREFIX = /^studio-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function taskArtifactFiles(prefix: string, files: AgentFile[]): { video?: AgentFile; source?: AgentFile } {
  if (!PREFIX.test(prefix) || !Array.isArray(files) || files.length > 1000) throw new Error("Task files could not be verified.");
  const result: { video?: AgentFile; source?: AgentFile } = {};
  for (const file of files) {
    const kind = file.name === `${prefix}.mp4` ? "video" : file.name === `${prefix}.blend` ? "source" : null;
    if (!kind || file.dir) continue;
    if (!Number.isSafeInteger(file.size) || file.size! < 1 || file.size! > MAX_FILE || result[kind]) throw new Error("Task file is missing, ambiguous or exceeds the download limit.");
    result[kind] = file;
  }
  return result;
}
/** Container admission only; playback duration is verified by the video element. */
export async function verifiedVideoBlob(blob: Blob): Promise<Blob> {
  if (blob.size < 24 || blob.size > MAX_FILE) throw new Error("The saved file is not a bounded MP4.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer); const ascii = (start: number) => new TextDecoder().decode(bytes.slice(start, start + 4));
  let offset = 0; let ftyp = false; let media = false;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset); const type = ascii(offset + 4);
    if (size < 8 || offset + size > bytes.length) throw new Error("The saved MP4 is truncated or malformed.");
    if (offset === 0 && type !== "ftyp") throw new Error("The saved file is not an MP4.");
    if (type === "ftyp") { if (offset !== 0 || size < 16) throw new Error("The saved MP4 has an invalid header."); ftyp = true; }
    if (type === "mdat") media = true;
    offset += size;
  }
  if (offset !== bytes.length || !ftyp || !media) throw new Error("The saved MP4 has no verified media container.");
  return new Blob([bytes], { type: "video/mp4" });
}
