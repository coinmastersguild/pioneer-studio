// The Head tab writes morph weights by name, and an unknown name is a silent
// no-op — a re-exported GLB that renamed or dropped a target would leave the
// face frozen with no error. Check the shipped asset against the names we drive.
// Run: bun test src/head.test.ts
import { expect, test } from "bun:test";
import { DRIVEN } from "./headMorphs";

const GLB = "public/models/gnm-head.glb";

/** glTF targetNames live in the GLB's first (JSON) chunk: 12-byte header, then
 *  per chunk a 4-byte length + 4-byte type. */
function glbJson(buf: Buffer): any {
  const len = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + len).toString("utf8"));
}

test("the head asset has every morph target HeadView drives", async () => {
  const file = Bun.file(GLB);
  if (!(await file.exists())) throw new Error(`${GLB} missing from the repository`);
  const gltf = glbJson(Buffer.from(await file.arrayBuffer()));
  const names = new Set<string>(gltf.meshes.flatMap((m: any) => m.extras?.targetNames ?? []));
  expect(names.size).toBeGreaterThan(0);
  expect(DRIVEN.filter((n) => !names.has(n))).toEqual([]);
});

import { splitClauses } from "./speech";

test("the opening chunk is short, because it is the only one anyone waits for", () => {
  // the exact reply that exposed this: one 84-char sentence, no split, so the
  // first sound waited on 6.9s of generated audio
  const real = "Beyond the north pass lies a land of ice and fire, where gods fight over the dead.";
  const parts = splitClauses(real);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts[0]).toBe("Beyond the north pass lies a land of ice and fire,");
  expect(parts.join(" ")).toBe(real); // nothing dropped or duplicated

  // a long sentence with no punctuation still gets cut, at a word boundary
  const noPunct = splitClauses("the quick brown fox jumps over the lazy dog and keeps running for a very long time");
  expect(noPunct.length).toBeGreaterThan(1);
  expect(noPunct[0].length).toBeLessThanOrEqual(52);
  expect(noPunct[0].endsWith(" ")).toBe(false);

  // short replies are left alone — nothing to gain, and a cut costs prosody
  expect(splitClauses("Aye. Well met.")).toEqual(["Aye. Well met."]);
  expect(splitClauses("Who are you?")).toEqual(["Who are you?"]);

  // later sentences stay whole: they are voiced under cover of playback
  const multi = splitClauses("I am Finn, a scout. I have walked these hills for thirty years. Ask me anything.");
  expect(multi[multi.length - 1]).toBe("Ask me anything.");
});

import { pcmChunker } from "./speech";

test("PCM framing survives chunk boundaries that land mid-sample", () => {
  // one continuous ramp, split at deliberately awkward points
  const samples = Int16Array.from({ length: 600 }, (_, i) => i * 40 - 12000);
  const all = new Uint8Array(samples.buffer);

  const feed = (sizes: number[]) => {
    const frame = pcmChunker();
    const out: number[] = [];
    let at = 0;
    for (const n of sizes) {
      for (const v of frame(all.subarray(at, at + n))) out.push(v);
      at += n;
    }
    return out;
  };
  const whole = feed([all.length]);
  expect(whole.length).toBe(samples.length);

  // odd-length chunks: every boundary splits a sample. Same samples out.
  const odd = feed([7, 13, 1, 199, 3, all.length - 223]);
  expect(odd.length).toBe(samples.length);
  expect(odd).toEqual(whole);

  // a misaligned view is the other trap — Int16Array over an odd byteOffset
  // throws, so the chunker must copy rather than view in place
  const skewed = new Uint8Array(all.length + 1);
  skewed.set(all, 1);
  const frame = pcmChunker();
  expect(() => frame(skewed.subarray(1, 101))).not.toThrow();

  // values round-trip through the /32768 scaling
  expect(whole[0]).toBeCloseTo(-12000 / 32768, 6);
  expect(whole[599]).toBeCloseTo((599 * 40 - 12000) / 32768, 6);
});

import { vadMachine } from "./speech";

// louder than the plain floor (350/32768 = 0.0107) but under 4x it — exactly
// what the head's own voice sounds like coming back through the mic
const VAD_LEAK = 0.02;

test("a blip is dropped, and only real speech may interrupt", () => {
  const LOUD = 0.05; // well over the 350/32768 floor, and over 4x it too
  const QUIET = 0;
  const run = (frames: [number, boolean][]) => {
    const step = vadMachine();
    return frames.flatMap(([rms, hot]) => step(rms, hot));
  };
  const hold = (rms: number, ms: number, hot = false): [number, boolean][] =>
    Array.from({ length: ms / 50 }, () => [rms, hot] as [number, boolean]);

  // a 100ms tap, then silence: captured, never promoted, thrown away.
  // This is the "Mm-hmm" / "Yeah" / "Oh" case — 100ms of noise sent to STT
  // does not come back empty, it comes back as a plausible filler word.
  const blip = run([...hold(LOUD, 100), ...hold(QUIET, 700)]);
  expect(blip).toEqual(["start", "drop"]);
  expect(blip).not.toContain("speech"); // nothing may be cancelled for a tap

  // a real 1s utterance: promoted once, kept
  const real = run([...hold(LOUD, 1000), ...hold(QUIET, 700)]);
  expect(real).toEqual(["start", "speech", "keep"]);

  // silence alone is not a segment
  expect(run(hold(QUIET, 2000))).toEqual([]);

  // while the head is speaking, its own leakage must not arm the VAD: the
  // same level that starts a turn cold is ignored when we are the noise source
  expect(run(hold(VAD_LEAK, 1000, true))).toEqual([]);
  // but genuinely talking over it still interrupts
  expect(run([...hold(LOUD, 1000, true)])).toContain("speech");

  // the hang is 600ms — a pause shorter than that does not end the utterance
  const pause = run([...hold(LOUD, 500), ...hold(QUIET, 400), ...hold(LOUD, 500), ...hold(QUIET, 700)]);
  expect(pause.filter((e) => e === "start")).toHaveLength(1);
  expect(pause.filter((e) => e === "keep")).toHaveLength(1);
});
