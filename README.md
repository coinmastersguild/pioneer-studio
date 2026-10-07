# Pioneer Studio

Pioneer Studio is an open-source production desk for AI-assisted storyboards,
characters, animation, talking heads, media, and final timeline assembly. The
client is free software; generation runs through the paid, metered Pioneer API.

[Open Pioneer Studio](https://studio.pioneers.dev) ·
[Get a Pioneer key](https://alpha.pioneers.dev/keys) ·
[Fork the repository](https://github.com/coinmastersguild/pioneer-studio/fork)

## What it does

- Run persistent OpenHuman agents with prepaid alpha testnet credits through the
  Agents workspace. Claim agents, confirm tasks and top-ups, edit workspace files,
  and monitor status, usage, logs, and network activity.
- Create one personal repository from the public
  [agent template](https://github.com/coinmastersguild/agent-template), author its
  `agent/` files locally, and connect that single repository through Alpha's
  GitHub App. Agents receive read-only access to their repository.
- Unlock encrypted configuration, pull committed updates, and open the agent's
  full live desktop in Studio when Alpha advertises those capabilities.
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
Pioneer API key. Remember me is on by default for wallet sign-in, keeping the
wallet session on this device until its server expiry. Uncheck it to keep the
session in the current tab only. Sign-out clears cached wallet sessions. Pasted
API keys stay in page memory and are discarded on reload; no credentials are
bundled with the application. Choose MetaMask, KeepKey, or another discovered
browser wallet explicitly. KeepKey requires its extension and desktop app.

Agent chat supports `/claim` (or `/new`), `/pair`, `/status`, `/files`, `/edit AGENTS.md`, `/github`,
`/credentials`, `/logs`, `/usage`, `/egress`, `/topup`, `/suspend`, `/resume`, and
`/delete`. Purchases retain their exact request and idempotency key locally for
recovery; those records contain no credentials or workspace contents. Mainnet
purchases and Agent Zero are unavailable. Conversation and media job planning remain in Chat. Agent commands live in
Agents. Saved Media assets can be returned to Chat from the deliverables panel;
workspace files require an explicit save or upload before they appear in Media.

`/pair`, `/github`, and `/credentials` open GitHub connection management in chat.
When Alpha enables connections, users authorize the GitHub App, declare legacy
credential status, select one personal repository created from the template,
confirm read access, and monitor runtime
verification or revoke the binding. Credentials are managed by Alpha and Beast;
Studio never copies its sign-in credential or manual tokens into the runtime.
Previously supplied credentials must be revoked at their issuers; deleting their
files or revoking a new binding does not invalidate them. GitHub writes, approvals
and Pioneer asset delegation are unavailable in this first connection milestone.

Author and test the repository locally, then push your changes using your own
GitHub account. **Pull & restart** accepts a pinned commit and retains its original
request key across navigation or sign-in, so retrying an uncertain result does
not restart twice. Repository files replace their deployed copies; files created
only by the agent remain in its workspace.

**Unlock** accepts the key from `make key` in your repository. Studio clears the
field after every attempt; Alpha forwards the key without storing it. The trusted
runtime keeps it in memory, and restarting the tenant locks the agent again.
Pull & restart retains the in-memory key.

**Desktop** draws a continuous VNC framebuffer stream with noVNC, including the
agent's visible browser and installed desktop applications. Use **Full screen**,
**Reconnect**, or **Close** in the viewer. Alpha issues a single-use connection
ticket for that agent; the ticket never appears in the URL, and no agent-hosted
page runs in Studio's origin. If its inference budget is exhausted, an observed
running desktop remains viewable; tasks still require a top-up.
Use **Clipboard** to paste text into its field and explicitly **Send to desktop**,
then press Ctrl+V in the desktop. Text copied inside the desktop can be copied
back with **Copy from desktop**. Transfers are limited to 16 KiB, kept in the
open viewer's memory, and cleared on reconnect, disconnect or close. Studio
never reads your browser clipboard automatically.

The hosted runtime uses the public
[Pioneer OpenHuman fork](https://github.com/coinmastersguild/openhuman).
Runtime contributions and pull requests target that fork only; never submit them
to upstream. Hosted project access remains read-only, and autonomous runtime PR
submission is not offered.

New Studio claims require GitHub setup: authorization, repository selection and
verified runtime read access. Claims are paused while Alpha's GitHub capability
is unavailable. Setup opens after claiming; tasks stay locked until verified.
Studio uses Alpha's durable `setup_required` and `setup_state` response metadata
across browsers. Older responses fall back to public setup IDs stored under the
verified owner/network. New claims also wait for Alpha's mandatory setup policy
to be enabled. Existing agents explicitly grandfathered by Alpha remain usable.
Use **Refresh agents** or `/status` to reload the signed-in owner's agent list.
An uncertain purchase response does not mean an agent disappeared: check the saved
operation or retry its original request rather than starting another purchase.

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
