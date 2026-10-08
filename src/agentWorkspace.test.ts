import { expect, test } from "bun:test";
import { workspaceEntryPath, canEditWorkspaceFile, workspaceText, workspaceDownloadName } from "./agentWorkspaceFiles";

test("workspace navigation keeps projects and workspace paths relative and rejects traversal names", () => {
  expect(workspaceEntryPath("", "projects")).toBe("projects");
  expect(workspaceEntryPath("projects/demo", "render.png")).toBe("projects/demo/render.png");
  expect(workspaceEntryPath("workspace", "SOUL.md")).toBe("workspace/SOUL.md");
  for (const entry of ["../outside", "..", "a/b", "a\\b", "bad%2fname", "bad\u0000name"])
    expect(() => workspaceEntryPath("projects", entry)).toThrow();
  expect(() => workspaceEntryPath("../outside", "safe.txt")).toThrow();
});

test("binary artifacts and unknown files are download-only, while bounded valid UTF-8 files can be edited", () => {
  for (const name of ["scene.blend", "render.png", "photo.jpg", "clip.mp4", "export.pdf", "archive.zip", "unknown", ".env"])
    expect(canEditWorkspaceFile({ name, dir: false, size: 100 })).toBe(false);
  expect(canEditWorkspaceFile({ name: "notes.md", dir: false, size: 1024 })).toBe(true);
  expect(canEditWorkspaceFile({ name: "scene.py", dir: false, size: 1024 })).toBe(true);
  expect(canEditWorkspaceFile({ name: "notes.md", dir: true, size: 0 })).toBe(false);
  expect(canEditWorkspaceFile({ name: "notes.md", dir: false, size: 1_048_577 })).toBe(false);
  expect(workspaceText(new Uint8Array([104, 105]))).toBe("hi");
  expect(() => workspaceText(new Uint8Array([255, 0]))).toThrow();
  expect(() => workspaceText(new Uint8Array([104, 0, 105]))).toThrow();
  expect(() => workspaceText(new Uint8Array(1_048_577))).toThrow();
});

test("download filenames come from a validated workspace basename, never a server header or URL", () => {
  expect(workspaceDownloadName("projects/demo/scene.blend")).toBe("scene.blend");
  expect(workspaceDownloadName("workspace/notes.md")).toBe("notes.md");
  for (const path of ["", "/host/key", "../secret", "http://evil.example/name", "a/.."]) expect(() => workspaceDownloadName(path)).toThrow();
});
