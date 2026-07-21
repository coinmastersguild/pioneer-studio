# Pioneer Studio

Pioneer Studio is an open-source production desk for AI-assisted storyboards,
characters, animation, talking heads, media, and final timeline assembly. The
client is free software; generation runs through the paid, metered Pioneer API.

[Open Pioneer Studio](https://studio.pioneers.dev) ·
[Get a Pioneer key](https://alpha.pioneers.dev/keys) ·
[Fork the repository](https://github.com/coinmastersguild/pioneer-studio/fork)

## What it does

- Turn a prompt into an image, video, audio, or 3D generation job.
- Build a cast-first storyboard and carry approved assets across shots.
- Create characters, voices, talking heads, and VRM actors.
- Stage 3D scenes, author ARDY motion, and finish takes with Pioneer models.
- Edit a multi-track production timeline and assemble a release.
- Use the in-app copilot to operate the same guarded actions as the UI.

## Run it locally

Pioneer Studio requires [Bun](https://bun.sh/) 1.3.14 or newer. It does not
require a `.env` file, provider credentials, a local GPU, or a private service.

```bash
git clone https://github.com/coinmastersguild/pioneer-studio.git
cd pioneer-studio
bun install --frozen-lockfile
bun run dev
```

Open `http://localhost:5173`, then connect a browser wallet or paste your own
Pioneer API key. Credentials are entered at runtime and kept in session storage;
they are never bundled into the application.

`bun run setup` verifies the bundled GNM head and copies the Draco/KTX2 runtime
decoders from the locked `three` dependency. The normal dev, test, and build
commands run this automatically.

## Development

```bash
bun run dev       # local Vite server
bun run lint      # Oxlint
bun run test      # project tests only
bun run build     # typecheck and production build
bun run check     # lint, test, and build
```

The browser always targets `https://alpha.pioneers.dev`. Users bring their own
wallet session or API key, and Pioneer performs authentication, authorization,
rate limiting, credit metering, storage, and inference on the server. Never add
a provider or infrastructure secret to this repository or to a `VITE_*` value.

## Repository policy

Public product and contributor documentation lives in the root files such as
this README, `CONTRIBUTING.md`, `SECURITY.md`, and `AGENTS.md`. Research notes,
prompts, handoffs, implementation plans, and exploratory documentation belong in
the ignored `.work/` directory. The repository intentionally ignores common
`docs/`, `planning/`, `thinking/`, and agent-tool directories so internal working
material cannot be published accidentally.

If you use an LLM or coding agent here, read [AGENTS.md](AGENTS.md) before making
changes. Contributors remain responsible for every submitted line and must not
place credentials, customer data, private prompts, or hidden reasoning in a PR.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow. Please send
security reports through GitHub's private security-advisory flow as described in
[SECURITY.md](SECURITY.md), not through a public issue.

## License

Pioneer Studio is licensed under the GNU Affero General Public License v3.0 only.
The license covers this client, not Pioneer API credits, hosted services,
trademarks, or third-party assets. See [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
