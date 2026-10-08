import { validateAgentPath, type AgentFile } from "./api";

export type AgentFileArea = "workspace" | "projects";
export const TEXT_EDIT_LIMIT = 1_048_576;
const TEXT_EXTENSIONS = /\.(?:txt|md|json|py|js|ts|tsx|jsx|css|html|svg|yaml|yml|toml|sh|csv|xml)$/i;

export function workspaceEntryPath(directory: string, name: string): string {
  validateAgentPath(directory, true);
  validateAgentPath(name);
  if (name.includes("/")) throw new Error("Invalid workspace entry.");
  return validateAgentPath([directory, name].filter(Boolean).join("/"));
}

export function canEditWorkspaceFile(file: AgentFile): boolean {
  return !file.dir && TEXT_EXTENSIONS.test(file.name) &&
    (file.size === undefined || (Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= TEXT_EDIT_LIMIT));
}

export function workspaceText(bytes: Uint8Array): string {
  if (bytes.byteLength > TEXT_EDIT_LIMIT) throw new Error("Text editor limit is 1 MiB. Download larger files instead.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\u0000")) throw new Error("This is a binary file. Download it instead of editing.");
  return text;
}

export function workspaceDownloadName(path: string): string {
  return validateAgentPath(path).split("/").at(-1)!;
}

/** Owner-authenticated bytes only; no remote URL or agent-controlled document is opened. */
export function saveWorkspaceDownload(blob: Blob, path: string): void {
  const filename = workspaceDownloadName(path);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  document.body.append(link);
  try { link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
