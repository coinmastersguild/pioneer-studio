// Shared shot-render pipeline: generate via the storyboard route (server
// reuses the jobs trust boundary), poll the job, attach the R2 result back
// onto the shot. Used by BoardView and StudioView.
import { attachShotResult, fetchMedia, generateShot, patchShot, type Shot } from "./api";
import { pickModel } from "./pipeline";
import type { PS } from "./shared";

const inFlight = new Set<string>(); // shotIds being polled — shared across views

export async function trackShotJob(ps: PS, shotId: string, jobId: string): Promise<void> {
  if (inFlight.has(shotId)) return;
  inFlight.add(shotId);
  try {
    const { url, contentType } = await ps.waitForJob(jobId);
    // attachResult wants key+bytes — the media index has both for this URL
    // (media API 404s on accounts without R2 — inline results carry no key)
    const media = await fetchMedia(ps.apiKey).catch(() => null);
    const obj = media?.objects.find((o) => o.url === url);
    const sb = await attachShotResult(ps.apiKey, undefined, shotId, {
      url,
      key: obj?.key || (url.startsWith("data:") ? "inline" : url.split("/").slice(-2).join("/")),
      content_type: contentType || obj?.content_type || "image/png",
      bytes: obj?.bytes || 0,
    });
    ps.setBoard(sb);
    ps.toast("Beat rendered — result on the board", "ok");
  } catch (e: any) {
    ps.toast(`Beat failed: ${String(e.message || e)}`);
    try {
      ps.setBoard(await patchShot(ps.apiKey, undefined, shotId, { status: "failed" }));
    } catch {
      ps.refreshBoard();
    }
  } finally {
    inFlight.delete(shotId);
  }
}

export async function renderShot(
  ps: PS,
  shot: Shot,
  opts?: { refs?: string[]; model?: string; endpoint?: string; editFrom?: string; editPrompt?: string },
): Promise<void> {
  if (!ps.apiKey) {
    ps.toast("Paste your sk-pioneer key first");
    return;
  }
  // Editing the still that is already there beats generating a replacement for
  // it: a beat whose image the user chose must keep that image as the subject.
  if (opts?.editFrom) {
    const editModel = pickModel(ps.models, "image_edit");
    if (!editModel) {
      ps.toast("No image-edit model on this account — nothing to edit with");
      return;
    }
    ps.setBoard(await patchShot(ps.apiKey, undefined, shot.id, { model: editModel.model, endpoint: editModel.endpoint }));
    // params override the shot's own prompt server-side, so a repair
    // instruction can drive the edit without rewriting the beat text
    const edited = await generateShot(ps.apiKey, shot.id, {
      image: opts.editFrom,
      ...(opts.editPrompt?.trim() ? { prompt: opts.editPrompt.trim() } : {}),
    });
    ps.setBoard(edited);
    ps.charge(null);
    const running = edited.shots.find((s) => s.id === shot.id);
    if (running?.jobId) void trackShotJob(ps, shot.id, running.jobId);
    return;
  }
  const { model, endpoint } = opts || {};
  // refs (character + location driving images) → render through a
  // multi_reference model so the beat still keeps their identity. No refs →
  // the cheap fast placeholder tier. ≤4 refs (multi_reference limit).
  const refs = (opts?.refs || []).filter(Boolean).slice(0, 4);
  const refModel = refs.length ? pickModel(ps.models, "image_refs") : undefined;
  if (!shot.model || !shot.endpoint || model || refModel) {
    const def =
      (model && ps.models.find((m) => m.model === model && (!endpoint || m.endpoint === endpoint))) ||
      refModel ||
      // Placeholders use the fast, lower-cost tier.
      ps.models.find((m) => m.model === "flux-schnell" && m.endpoint === "generate") ||
      ps.models.find((m) => m.model === "flux2-dev" && m.endpoint === "generate") ||
      ps.models[0];
    if (!def) {
      ps.toast("No models available — check your key");
      return;
    }
    ps.setBoard(await patchShot(ps.apiKey, undefined, shot.id, { model: def.model, endpoint: def.endpoint }));
  }
  const sb = await generateShot(ps.apiKey, shot.id, refs.length && refModel ? { images: refs } : undefined);
  ps.setBoard(sb);
  ps.charge(null); // server charged through the jobs trust boundary
  const fresh = sb.shots.find((s) => s.id === shot.id);
  if (fresh?.jobId) void trackShotJob(ps, shot.id, fresh.jobId);
}

export const isShotRunning = (s: Shot) => s.status === "queued" || s.status === "starting" || s.status === "running";
