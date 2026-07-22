import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const head = join(root, "public/models/gnm-head.glb");
const expectedHeadSha256 = "ef3aea507a8cc1eef24d9f9f4f5352a70a017faac5c6140f5ca8b72f94b37c81";

if (!existsSync(head)) {
  throw new Error("public/models/gnm-head.glb is missing; restore the tracked asset before running Pioneer Studio");
}

const actualHeadSha256 = createHash("sha256").update(readFileSync(head)).digest("hex");
if (actualHeadSha256 !== expectedHeadSha256) {
  throw new Error(`gnm-head.glb failed its integrity check: ${actualHeadSha256}`);
}

const decoderSource = join(root, "node_modules/three/examples/jsm/libs");
const decoderTarget = join(root, "public/decoders");
for (const name of ["draco", "basis"]) {
  const source = join(decoderSource, name);
  if (!existsSync(source)) throw new Error(`${source} is missing; run bun install --frozen-lockfile first`);
  mkdirSync(decoderTarget, { recursive: true });
  cpSync(source, join(decoderTarget, name), { recursive: true, force: true });
}
