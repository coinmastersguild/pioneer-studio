#!/usr/bin/env bun
// Debug the public-surface audit: replicate the audit logic but print findings.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const tracked = spawnSync("git", ["ls-files", "-z"], { encoding: "buffer" });
console.error("git exit:", tracked.status, "stderr:", tracked.stderr.toString("utf8"));
const paths = tracked.stdout.toString("utf8").split("\0").filter(Boolean);
console.error("paths:", paths.length);
const findings = [];
const contentRules = [
  ["developer home path", /\/(?:Users|home)\/[A-Za-z0-9._-]+\//g],
  ["private project identifier", new RegExp("Degen" + "Quest", "gi")],
  ["private server identifier", new RegExp("pioneer" + "-server", "gi")],
  ["private inference hostname", new RegExp("inference\\." + "pioneers\\.dev", "gi")],
  ["private configuration name", new RegExp("MESHY" + "_API", "g")],
  ["private test route", new RegExp("/api/v1/companies/create" + "-test", "g")],
  ["private planning identifier", /\b(?:SPEC|EPIC)-\d+\b/g],
  ["private development shorthand", new RegExp("pony" + "tail", "gi")],
  ["private key", new RegExp("-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE" + " KEY-----", "g")],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["Pioneer API key", /\bsk-pioneer-[A-Za-z0-9_-]{16,}\b/g],
  ["provider API key", /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{24,}\b/g],
];
for (const path of paths) {
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  for (const [rule, pattern] of contentRules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split("\n").length;
      findings.push(`${path}:${line}: ${rule}`);
    }
  }
}
console.error("findings:", findings.length);
for (const f of findings.slice(0, 40)) console.error("-", f);
process.exit(findings.length ? 1 : 0);
