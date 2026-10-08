import { expect, test } from "bun:test";
import { taskArtifactFiles, verifiedVideoBlob } from "./agentTaskArtifacts";

const prefix = "studio-00000000-0000-4000-8000-000000000001";
test("task outputs require exact new names, regular files and bounded actual metadata", () => {
  const old = [{ name: "studio-00000000-0000-4000-8000-000000000002.mp4", dir: false, size: 40 }, { name: "cat.mp4", dir: false, size: 40 }];
  expect(taskArtifactFiles(prefix, old)).toEqual({});
  expect(taskArtifactFiles(prefix, [...old, { name: `${prefix}.mp4`, dir: false, size: 40 }, { name: `${prefix}.blend`, dir: false, size: 50 }])).toMatchObject({ video: { name: `${prefix}.mp4` }, source: { name: `${prefix}.blend` } });
  expect(taskArtifactFiles(prefix, [{ name: `${prefix}.mp4`, dir: true, size: 40 }])).toEqual({});
  expect(() => taskArtifactFiles(prefix, [{ name: `${prefix}.mp4`, dir: false, size: 10485761 }])).toThrow();
  expect(() => taskArtifactFiles("../old", [])).toThrow();
});
test("a fake extension or truncated ftyp cannot be presented as a video deliverable", async () => {
  await expect(verifiedVideoBlob(new Blob([new Uint8Array([137,80,78,71,13,10,26,10])]))).rejects.toThrow();
  await expect(verifiedVideoBlob(new Blob(["0000ftyp"]))).rejects.toThrow();
  await expect(verifiedVideoBlob(new Blob(["0000ftypisom0000"]))).rejects.toThrow();
  const bytes = new Uint8Array(32); new DataView(bytes.buffer).setUint32(0,24); bytes.set(new TextEncoder().encode("ftypisom"),4); new DataView(bytes.buffer).setUint32(24,8); bytes.set(new TextEncoder().encode("mdat"),28);
  const video = await verifiedVideoBlob(new Blob([bytes])); expect(video.type).toBe("video/mp4"); expect(video.size).toBe(32);
});
