# Working with coding agents

These instructions apply to the entire repository. They are written for coding
agents and for people using LLMs to contribute.

## Non-negotiable repository rules

- A clean clone must run with `bun install --frozen-lockfile` and `bun run dev`.
  Do not make `.env` files, private infrastructure, or maintainer credentials part
  of the application path.
- Put research, prompts, handoffs, implementation plans, scratch notes, and
  exploratory documentation under `.work/`. That directory is intentionally
  untracked. Never commit chain-of-thought, model transcripts, or private context.
- Durable public documentation is limited to the root project/community files,
  GitHub templates, legal notices, and focused comments next to the code they
  explain. Do not add a tracked `docs/` tree.
- Never commit API keys, wallet material, customer content, generated media,
  provider credentials, local configuration, or copied private-repository text.
- Preserve unrelated local changes. Inspect `git status` and the relevant diff
  before staging or editing.

## How to work

1. Read `README.md`, `CONTRIBUTING.md`, and the nearby source before changing it.
2. Keep changes scoped and make assumptions visible in the PR description.
3. Use the shared API helpers in `src/api.ts`; never bypass server-side billing or
   authorization, and never introduce a privileged browser credential.
4. Route automated actions through the same handlers as UI actions. Spending,
   deletion, publication, and other consequential operations require an explicit
   user confirmation.
5. Add or update focused tests for behavioral changes. Use `bun run test`, not a
   repository-wide test discovery command that may enter ignored vendor trees.
6. Run `bun run check` before handing work back.
7. Review the final diff as if the model were an untrusted contributor. Remove
   speculative comments, dead code, generated noise, and accidental disclosures.

## LLM safety and provenance

- Do not send secrets, unreleased customer assets, private incident details, or
  other people's proprietary code to a model.
- Treat generated code as a suggestion: verify APIs, edge cases, security
  boundaries, licenses, and tests yourself.
- If code or an algorithm comes from another project, verify its license, record
  attribution in `THIRD_PARTY_NOTICES.md`, and identify meaningful modifications.
- Summarize material LLM assistance in the pull request. Do not paste prompts or
  hidden reasoning; explain what changed, why, and how it was verified.
- Do not weaken tests, access controls, credit confirmations, or integrity checks
  merely to make generated code pass.

## Architecture boundaries

- The frontend is public and untrusted. Pioneer API enforcement belongs on the
  server; client-side checks are user experience, not security controls.
- The application has a zero-env, Pioneer-hosted default. Forks may modify source,
  but upstream code must not grow environment-specific branches.
- Browser credentials are memory-only. Never log them, place them in URLs, send
  them to third parties, or persist them in browser storage.
- Large generated files stay out of git. The only tracked runtime model is the
  verified GNM head documented in `THIRD_PARTY_NOTICES.md`.
