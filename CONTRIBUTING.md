# Contributing

Thanks for helping improve Pioneer Studio.

## Setup

```bash
git clone https://github.com/coinmastersguild/pioneer-studio.git
cd pioneer-studio
bun install --frozen-lockfile
bun run dev
```

No `.env` file is required. Use your own wallet session or Pioneer key when you
want to exercise paid API operations.

## Pull requests

- Keep each pull request focused and explain the user-visible outcome.
- Add tests for behavioral changes and run `bun run check`.
- Never include credentials, generated media, customer data, internal handoffs,
  planning notes, or model transcripts.
- Put temporary research and planning under `.work/`; it is ignored intentionally.
- Record third-party code or asset provenance in `THIRD_PARTY_NOTICES.md`.
- State whether an LLM materially assisted the change. You remain responsible for
  correctness, security, licensing, and the complete diff.
- Call out operations that spend credits, delete data, publish content, or alter
  authentication. Those flows must retain explicit user confirmation.

By submitting a contribution, you agree that it is licensed under the project's
GNU Affero General Public License v3.0-only and that you have the right to submit
it under those terms.

## Reporting problems

Use a GitHub issue for reproducible bugs and focused feature requests. Use the
private process in `SECURITY.md` for vulnerabilities or accidental disclosures.
