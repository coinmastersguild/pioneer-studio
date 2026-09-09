# Handoff — a character keeps one voice

Shipped 2026-09-09. Gateway on `pioneer-platform` master (`b41aa05`), studio on
`studio.pioneers.dev`, inference on the GPU box.

## The problem

`/api/v1/tts` designs a voice from `voice_description` on **every call**. The
description is a prompt, not a profile: nothing in the pipeline represents "this
speaker" independent of the text being spoken, so each request draws a new one.

Measured (Resemblyzer, cosine similarity):

| pair | score |
|---|---|
| same `voice_id`, different text | **0.85–0.87** |
| same `voice_description`, different text | 0.62–0.74 |
| genuinely different speakers (control) | 0.50–0.52 |

Description-only sits nearer the different-speaker floor than the same-speaker
cluster. That is why the talking head changed voice between turns and why a
20-line scene had no vocal continuity.

## The fix

Mint a voice once from reference audio, reuse its id forever.

```
POST /api/v1/voice          (auth + credit gated, same as /tts)
{ "voice_description": "older man, gravelly and unhurried" }
   — or —
{ "reference_audio": "<base64 clip from an earlier mint>" }
→ { "voice_id": "...", "reference_audio": "<base64>", "sample_rate": 48000 }

POST /api/v1/tts  |  /api/v1/tts/stream
{ "text": "...", "voice_id": "..." }        // instead of voice_description
{ "text": "...", "voice_id": "...", "seed": 8412337 }   // seed = QA repro only
```

- `voice_id` and `voice_description` are mutually exclusive → 400.
- Unknown or evicted `voice_id` → **404, never a silent fallback**.
- `X-Seed` is echoed and CORS-exposed, alongside `X-Sample-Rate` / `X-Channels`
  / `X-Sample-Format`.
- Server cache is an LRU (256 / 2h). It is **not** durable.

**Store the clip, not just the id.** The id is a sha256 of the reference audio,
so re-POSTing the stored clip to `/voice` returns *the same id*. That is the
entire restart story: a 404 is recoverable, and a saved cast outlives the
container.

## Using it from a client

`src/pipeline.ts`:

- `mintVoice(apiKey, {voice_description} | {reference_audio})` → `{voice_id, reference_audio}`
- `speakAs(ps, pipeline, characterId, text, mut)` — mints on first use, stores
  `{voiceId, voiceClip}` on the character, speaks, and on a 404 re-mints from
  the stored clip and retries once. Three call sites use it (`AssetsPanel`,
  `ScriptView`, `BeatDialog`).
- `voiceFor(pipeline, characterId)` → `VoiceRef` for a direct `ttsLine` call.
- `isVoiceGone(err)` — the recoverable 404.

`Character` gained `voice` (the authored description), `voiceId`, `voiceClip`.
Editing `voice` in the Assets panel clears the other two so the next line
re-mints.

The talking head (`src/HeadView.tsx`) keeps its minted voice in
`localStorage["pioneer_studio_head_voice_id"]`, keyed by the design text.

## Two rules worth keeping

**Never fall back to `voice_description`.** If a mint fails or the field is
stripped in transit, fall back to the *model default*. A default voice is
obviously not the character; a description sounds nearly right and drifts, which
is invisible until someone listens to a whole scene.

**No new env vars.** `VOICE_UPSTREAM` derives from `TTS_UPSTREAM_URL`
(`https://inference.pioneers.dev/tts` → `/voice`), the same way `/tts/stream`
has since July. Nothing to set in Pulumi; don't open that repo for this.

## Not done

- Per-project cast UI — voices are per character, minted lazily on first line.
- Nobody has exercised `/api/v1/voice` through the CF tunnel end to end. If it
  404s from the tunnel rather than the gateway, the tunnel ingress is
  path-scoped and needs `/voice` added.
