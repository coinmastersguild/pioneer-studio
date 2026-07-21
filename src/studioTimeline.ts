export type StudioClipKind = "image" | "video" | "audio";
export type StudioClipOrigin = "storyboard" | "library" | "soundtrack" | "upload";
export type StudioTrackKind = "video" | "audio";

export type StudioTrack = {
  id: string;
  kind: StudioTrackKind;
  name: string;
  muted: boolean;
  locked: boolean;
};

export type StudioClip = {
  id: string;
  origin: StudioClipOrigin;
  sourceId: string;
  name: string;
  url?: string;
  contentType: string;
  kind: StudioClipKind;
  trackId: string;
  start: number;
  duration: number;
  trimIn: number;
  sourceDuration?: number;
  volume: number;
  muted: boolean;
  edited?: boolean;
};

export type StudioTimeline = {
  version: 2;
  masterVolume: number;
  tracks: StudioTrack[];
  clips: StudioClip[];
  suppressedSourceIds: string[];
};

export type CanonicalStudioSource = Omit<StudioClip, "id" | "volume" | "muted" | "trimIn" | "trackId"> & {
  canonicalId: string;
  trackId?: string;
};

const keyOf = (projectId: string) => `ps_studio_timeline_${projectId}`;
const finite = (n: unknown, fallback: number) => (typeof n === "number" && Number.isFinite(n) ? n : fallback);
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const MIN_CLIP_DURATION = 0.25;
const EXPORT_EPSILON = 0.05;
const timelineMem = new Map<string, StudioTimeline>();

export const DEFAULT_VIDEO_TRACK_ID = "video-1";
export const DEFAULT_AUDIO_TRACK_ID = "audio-1";

function defaultTracks(): StudioTrack[] {
  return [
    { id: DEFAULT_VIDEO_TRACK_ID, kind: "video", name: "Video 1", muted: false, locked: false },
    { id: DEFAULT_AUDIO_TRACK_ID, kind: "audio", name: "Audio 1", muted: false, locked: false },
  ];
}

export function trackKindForClip(kind: StudioClipKind): StudioTrackKind {
  return kind === "audio" ? "audio" : "video";
}

export function emptyStudioTimeline(): StudioTimeline {
  return { version: 2, masterVolume: 1, tracks: defaultTracks(), clips: [], suppressedSourceIds: [] };
}

export function normalizeStudioTimeline(value: unknown): StudioTimeline {
  if (!value || typeof value !== "object") return emptyStudioTimeline();
  const raw = value as Partial<StudioTimeline> & { version?: number };
  const rawTracks = Array.isArray(raw.tracks) ? raw.tracks : [];
  const seenTrackIds = new Set<string>();
  const tracks = rawTracks
    .filter((track): track is StudioTrack => {
      if (!track || typeof track.id !== "string" || seenTrackIds.has(track.id)) return false;
      if (track.kind !== "video" && track.kind !== "audio") return false;
      seenTrackIds.add(track.id);
      return true;
    })
    .map((track, index) => ({
      id: track.id,
      kind: track.kind,
      name: typeof track.name === "string" && track.name.trim() ? track.name.trim().slice(0, 60) : `${track.kind === "audio" ? "Audio" : "Video"} ${index + 1}`,
      muted: !!track.muted,
      locked: !!track.locked,
    }));
  if (!tracks.some((track) => track.kind === "video")) tracks.unshift(defaultTracks()[0]);
  if (!tracks.some((track) => track.kind === "audio")) tracks.push(defaultTracks()[1]);
  const trackIds = new Set(tracks.map((track) => track.id));
  const firstTrack = (kind: StudioClipKind) => tracks.find((track) => track.kind === trackKindForClip(kind))!.id;
  const clips = Array.isArray(raw.clips)
    ? raw.clips
        .filter((c): c is StudioClip => !!c && typeof c.id === "string" && typeof c.sourceId === "string")
        .map((c) => ({
          ...c,
          start: Math.max(0, finite(c.start, 0)),
          duration: Math.max(MIN_CLIP_DURATION, finite(c.duration, 5)),
          trimIn: Math.max(0, finite(c.trimIn, 0)),
          volume: clamp01(finite(c.volume, 1)),
          muted: !!c.muted,
          trackId:
            typeof c.trackId === "string" && trackIds.has(c.trackId) &&
            tracks.find((track) => track.id === c.trackId)?.kind === trackKindForClip(c.kind)
              ? c.trackId
              : firstTrack(c.kind),
        }))
    : [];
  return {
    version: 2,
    masterVolume: clamp01(finite(raw.masterVolume, 1)),
    tracks,
    clips,
    suppressedSourceIds: Array.isArray(raw.suppressedSourceIds)
      ? raw.suppressedSourceIds.filter((id): id is string => typeof id === "string")
      : [],
  };
}

export function loadStudioTimeline(projectId: string): StudioTimeline {
  const memory = timelineMem.get(projectId);
  if (memory) return structuredClone(memory);
  try {
    const raw = localStorage.getItem(keyOf(projectId));
    const timeline = raw ? normalizeStudioTimeline(JSON.parse(raw)) : emptyStudioTimeline();
    timelineMem.set(projectId, structuredClone(timeline));
    return timeline;
  } catch {
    return emptyStudioTimeline();
  }
}

export function saveStudioTimeline(projectId: string, timeline: StudioTimeline): void {
  const normalized = normalizeStudioTimeline(timeline);
  timelineMem.set(projectId, structuredClone(normalized));
  try {
    // Canonical sources are rehydrated from the board/pipeline on load. Keeping
    // inline data: media here can blow the browser's storage quota and would
    // prevent otherwise tiny move/trim/gain edits from persisting.
    const persisted = studioTimelineForPersistence(normalized);
    localStorage.setItem(keyOf(projectId), JSON.stringify(persisted));
  } catch {
    // Timeline documents contain URLs and edit metadata only. If storage is
    // unavailable, keep the live React state useful for the current session.
  }
}

export function studioTimelineForPersistence(timeline: StudioTimeline): StudioTimeline {
  const persisted = structuredClone(normalizeStudioTimeline(timeline));
  persisted.clips.forEach((clip) => {
    if (clip.url?.startsWith("data:")) clip.url = undefined;
  });
  return persisted;
}

export function reconcileStudioTimeline(
  timeline: StudioTimeline,
  canonicalSources: CanonicalStudioSource[],
): StudioTimeline {
  const doc = normalizeStudioTimeline(timeline);
  const sourceIds = new Set(canonicalSources.map((s) => s.sourceId));
  const sourceById = new Map(canonicalSources.map((source) => [source.sourceId, source]));
  const sourceTrack = (source: CanonicalStudioSource) => {
    const kind = trackKindForClip(source.kind);
    return (
      doc.tracks.find((track) => track.id === source.trackId && track.kind === kind)?.id ??
      doc.tracks.find((track) => track.kind === kind)!.id
    );
  };
  const kept = doc.clips
    .filter(
      (clip) =>
        !((clip.origin === "storyboard" || clip.origin === "soundtrack") && !sourceIds.has(clip.sourceId)) &&
        !((clip.origin === "storyboard" || clip.origin === "soundtrack") && doc.suppressedSourceIds.includes(clip.sourceId)),
    )
    .map((clip) => {
      const source = sourceById.get(clip.sourceId);
      return source && (clip.origin === "storyboard" || clip.origin === "soundtrack")
        ? {
            ...clip,
            name: source.name,
            url: source.url,
            contentType: source.contentType,
            kind: source.kind,
            sourceDuration: source.sourceDuration,
          }
        : clip;
    });

  for (const source of canonicalSources) {
    if (doc.suppressedSourceIds.includes(source.sourceId)) continue;
    const at = kept.findIndex((clip) => clip.id === source.canonicalId);
    if (at < 0) {
      kept.push({
        ...source,
        id: source.canonicalId,
        trackId: sourceTrack(source),
        trimIn: 0,
        volume: 1,
        muted: false,
      });
      continue;
    }
    const current = kept[at];
    kept[at] = {
      ...current,
      name: source.name,
      url: source.url,
      contentType: source.contentType,
      kind: source.kind,
      sourceDuration: source.sourceDuration,
      start: current.edited ? current.start : source.start,
      duration: current.edited ? current.duration : source.duration,
    };
  }

  return { ...doc, clips: kept };
}

export function studioTimelineEnd(timeline: StudioTimeline): number {
  return timeline.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
}

export function activeVisualClip(clips: StudioClip[], time: number, tracks?: StudioTrack[]): StudioClip | undefined {
  const candidates = clips.filter(
    (clip) => clip.kind !== "audio" && time >= clip.start && time < clip.start + clip.duration,
  );
  if (!tracks?.length) return candidates.at(-1);
  const order = new Map(tracks.map((track, index) => [track.id, index]));
  return candidates.sort((a, b) => {
    const trackOrder = (order.get(a.trackId) ?? tracks.length) - (order.get(b.trackId) ?? tracks.length);
    if (trackOrder) return trackOrder;
    return clips.indexOf(b) - clips.indexOf(a);
  })[0];
}

export function createStudioClip(
  source: Pick<StudioClip, "origin" | "sourceId" | "name" | "url" | "contentType" | "kind">,
  start: number,
  duration: number,
  trackId = trackKindForClip(source.kind) === "audio" ? DEFAULT_AUDIO_TRACK_ID : DEFAULT_VIDEO_TRACK_ID,
): StudioClip {
  return {
    ...source,
    id: `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    trackId,
    start: Math.max(0, start),
    duration: Math.max(MIN_CLIP_DURATION, duration),
    trimIn: 0,
    sourceDuration: source.kind === "image" ? undefined : Math.max(MIN_CLIP_DURATION, duration),
    volume: 1,
    muted: false,
    edited: true,
  };
}

export function addTrack(timeline: StudioTimeline, kind: StudioTrackKind, name?: string): StudioTimeline {
  const doc = normalizeStudioTimeline(timeline);
  let number = doc.tracks.filter((track) => track.kind === kind).length + 1;
  let id = `${kind}-${number}`;
  while (doc.tracks.some((track) => track.id === id)) id = `${kind}-${++number}`;
  const tracks = [...doc.tracks];
  const after = tracks.reduce((index, track, current) => (track.kind === kind ? current + 1 : index), tracks.length);
  tracks.splice(after, 0, {
    id,
    kind,
    name: name?.trim() || `${kind === "audio" ? "Audio" : "Video"} ${number}`,
    muted: false,
    locked: false,
  });
  return normalizeStudioTimeline({
    ...doc,
    tracks,
  });
}

export function patchTrack(timeline: StudioTimeline, id: string, patch: Partial<StudioTrack>): StudioTimeline {
  const track = timeline.tracks.find((item) => item.id === id);
  if (!track) return timeline;
  return normalizeStudioTimeline({
    ...timeline,
    tracks: timeline.tracks.map((item) =>
      item.id === id
        ? { ...item, ...patch, id: item.id, kind: item.kind, name: patch.name?.trim().slice(0, 60) || item.name }
        : item,
    ),
  });
}

export function reorderTrack(timeline: StudioTimeline, id: string, direction: -1 | 1): StudioTimeline {
  const index = timeline.tracks.findIndex((track) => track.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= timeline.tracks.length) return timeline;
  const tracks = [...timeline.tracks];
  [tracks[index], tracks[target]] = [tracks[target], tracks[index]];
  return { ...timeline, tracks };
}

export function removeTrack(timeline: StudioTimeline, id: string): StudioTimeline {
  const track = timeline.tracks.find((item) => item.id === id);
  if (!track || timeline.tracks.filter((item) => item.kind === track.kind).length <= 1) return timeline;
  const fallback = timeline.tracks.find((item) => item.kind === track.kind && item.id !== id)!;
  return normalizeStudioTimeline({
    ...timeline,
    tracks: timeline.tracks.filter((item) => item.id !== id),
    clips: timeline.clips.map((clip) => (clip.trackId === id ? { ...clip, trackId: fallback.id, edited: true } : clip)),
  });
}

function clipTrack(timeline: StudioTimeline, id: string): StudioTrack | undefined {
  const clip = timeline.clips.find((item) => item.id === id);
  return clip ? timeline.tracks.find((track) => track.id === clip.trackId) : undefined;
}

/** Pure timeline mutations. Keep editing rules here so UI gestures, inputs,
 * keyboard commands, and agent actions all exercise the same tested code. */
export function patchClip(timeline: StudioTimeline, id: string, patch: Partial<StudioClip>): StudioTimeline {
  if (!timeline.clips.some((clip) => clip.id === id) || clipTrack(timeline, id)?.locked) return timeline;
  return normalizeStudioTimeline({
    ...timeline,
    clips: timeline.clips.map((clip) => (clip.id === id ? { ...clip, ...patch, id: clip.id, edited: true } : clip)),
  });
}

export function moveClip(timeline: StudioTimeline, id: string, start: number): StudioTimeline {
  return patchClip(timeline, id, { start: Math.max(0, finite(start, 0)) });
}

export function moveClipToTrack(timeline: StudioTimeline, id: string, trackId: string): StudioTimeline {
  const clip = timeline.clips.find((item) => item.id === id);
  const target = timeline.tracks.find((track) => track.id === trackId);
  if (
    !clip ||
    !target ||
    target.locked ||
    clipTrack(timeline, id)?.locked ||
    target.kind !== trackKindForClip(clip.kind)
  ) return timeline;
  return patchClip(timeline, id, { trackId });
}

export function trimClip(
  timeline: StudioTimeline,
  id: string,
  edge: "in" | "out",
  boundary: number,
): StudioTimeline {
  const clip = timeline.clips.find((item) => item.id === id);
  if (!clip || !Number.isFinite(boundary)) return timeline;
  if (edge === "in") {
    let delta = boundary - clip.start;
    delta = Math.max(-clip.trimIn, Math.min(clip.duration - MIN_CLIP_DURATION, delta));
    return patchClip(timeline, id, {
      start: clip.start + delta,
      duration: clip.duration - delta,
      trimIn: clip.trimIn + delta,
    });
  }
  const available = clip.sourceDuration == null ? Number.POSITIVE_INFINITY : clip.sourceDuration - clip.trimIn;
  const duration = Math.max(MIN_CLIP_DURATION, Math.min(available, boundary - clip.start));
  return patchClip(timeline, id, { duration });
}

export function addClip(timeline: StudioTimeline, clip: StudioClip): StudioTimeline {
  const track = timeline.tracks.find((item) => item.id === clip.trackId);
  if (!track || track.locked || track.kind !== trackKindForClip(clip.kind)) return timeline;
  return normalizeStudioTimeline({ ...timeline, clips: [...timeline.clips, clip] });
}

export function removeClip(timeline: StudioTimeline, id: string): StudioTimeline {
  const clip = timeline.clips.find((item) => item.id === id);
  if (!clip || clipTrack(timeline, id)?.locked) return timeline;
  let clips = timeline.clips.filter((item) => item.id !== id);
  const isLinked = clip.origin === "storyboard" || clip.origin === "soundtrack";
  const linkedSibling = isLinked ? clips.find((item) => item.sourceId === clip.sourceId) : undefined;
  // Canonical linked clips use sourceId as their id. If that half of a split
  // is deleted, promote the surviving half so reconciliation does not seed a
  // second full-length copy beside it.
  if (linkedSibling && clip.id === clip.sourceId) {
    clips = clips.map((item) => (item.id === linkedSibling.id ? { ...item, id: clip.id } : item));
  }
  return {
    ...timeline,
    clips,
    suppressedSourceIds:
      isLinked && !linkedSibling
        ? [...new Set([...timeline.suppressedSourceIds, clip.sourceId])]
        : timeline.suppressedSourceIds,
  };
}

export function splitClip(timeline: StudioTimeline, id: string, at: number): StudioTimeline {
  const clipIndex = timeline.clips.findIndex((item) => item.id === id);
  const clip = timeline.clips[clipIndex];
  if (
    !clip ||
    clipTrack(timeline, id)?.locked ||
    !Number.isFinite(at) ||
    at < clip.start + MIN_CLIP_DURATION ||
    at > clip.start + clip.duration - MIN_CLIP_DURATION
  ) return timeline;

  const leftDuration = at - clip.start;
  const baseId = `${clip.id}:split`;
  let nextId = baseId;
  let suffix = 2;
  const ids = new Set(timeline.clips.map((item) => item.id));
  while (ids.has(nextId)) nextId = `${baseId}:${suffix++}`;
  const left = { ...clip, duration: leftDuration, edited: true };
  const right = {
    ...clip,
    id: nextId,
    start: at,
    duration: clip.duration - leftDuration,
    trimIn: clip.trimIn + leftDuration,
    edited: true,
  };
  const clips = [...timeline.clips];
  clips.splice(clipIndex, 1, left, right);
  return normalizeStudioTimeline({ ...timeline, clips });
}

export function duplicateClip(timeline: StudioTimeline, id: string): StudioTimeline {
  const clip = timeline.clips.find((item) => item.id === id);
  if (!clip || clipTrack(timeline, id)?.locked) return timeline;
  const ids = new Set(timeline.clips.map((item) => item.id));
  const base = `${clip.id}:copy`;
  let nextId = base;
  let suffix = 2;
  while (ids.has(nextId)) nextId = `${base}:${suffix++}`;
  return addClip(timeline, {
    ...clip,
    id: nextId,
    origin: clip.origin === "storyboard" || clip.origin === "soundtrack" ? "library" : clip.origin,
    start: clip.start + clip.duration,
    edited: true,
  });
}

export function rippleRemoveClip(timeline: StudioTimeline, id: string): StudioTimeline {
  const clip = timeline.clips.find((item) => item.id === id);
  if (!clip || clipTrack(timeline, id)?.locked) return timeline;
  const end = clip.start + clip.duration;
  const removed = removeClip(timeline, id);
  return normalizeStudioTimeline({
    ...removed,
    clips: removed.clips.map((item) =>
      item.trackId === clip.trackId && item.start >= end - EXPORT_EPSILON
        ? { ...item, start: Math.max(0, item.start - clip.duration), edited: true }
        : item,
    ),
  });
}

export function nudgeClip(timeline: StudioTimeline, id: string, delta: number): StudioTimeline {
  const clip = timeline.clips.find((item) => item.id === id);
  return clip && Number.isFinite(delta) ? moveClip(timeline, id, clip.start + delta) : timeline;
}

export type StudioExportPlan = {
  version: 2;
  clips: Array<{
    url: string;
    kind: StudioClipKind;
    start: number;
    duration: number;
    trimIn: number;
    volume: number;
    muted: boolean;
  }>;
  duration: number;
};

export type StudioExportCheck =
  | { ok: true; plan: StudioExportPlan; issues: [] }
  | { ok: false; plan: null; issues: string[] };

/** Compile the canonical cut to assemble v2. Track order is converted to
 * bottom-to-top visual input order so sequential server overlays preserve the
 * monitor's z-order. Track/master gain and mute are flattened into each clip. */
export function buildStudioExportPlan(timeline: StudioTimeline): StudioExportCheck {
  const doc = normalizeStudioTimeline(timeline);
  const issues: string[] = [];
  const trackById = new Map(doc.tracks.map((track) => [track.id, track]));
  const trackOrder = new Map(doc.tracks.map((track, index) => [track.id, index]));
  const visuals = doc.clips
    .filter((clip) => clip.kind !== "audio")
    .sort(
      (a, b) =>
        (trackOrder.get(b.trackId) ?? 0) - (trackOrder.get(a.trackId) ?? 0) ||
        doc.clips.indexOf(a) - doc.clips.indexOf(b),
    );
  if (!visuals.length) issues.push("the timeline has no visual clips");
  for (const clip of doc.clips) if (!clip.url) issues.push(`${clip.name} has no rendered media URL`);
  const duration = studioTimelineEnd(doc);
  if (duration > 600 + EXPORT_EPSILON) issues.push("the timeline is longer than the 10 minute export limit");
  if (doc.clips.length > 120) issues.push("the timeline has more than the 120 clip export limit");

  if (issues.length) return { ok: false, plan: null, issues: [...new Set(issues)] };
  const ordered = [...visuals, ...doc.clips.filter((clip) => clip.kind === "audio")];
  return {
    ok: true,
    plan: {
      version: 2,
      duration,
      clips: ordered.map((clip) => ({
        url: clip.url!,
        kind: clip.kind,
        start: clip.start,
        duration: clip.duration,
        trimIn: clip.trimIn,
        volume: clip.volume * doc.masterVolume,
        muted: clip.muted || !!trackById.get(clip.trackId)?.muted || clip.kind === "image",
      })),
    },
    issues: [],
  };
}
