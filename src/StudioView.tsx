import { useEffect, useMemo, useRef, useState } from "react";
import { activeProjectStudioTimeline, patchShot, saveActiveProjectStudioTimeline, uploadMedia, type MediaObject, type Shot, type ShotStatus } from "./api";
import { fmtTime, kindOf, PH, type PS } from "./shared";
import { isShotRunning, renderShot } from "./shots";
import { assembleRelease, BEAT_SECONDS, extOf, loadPipeline, pickModel, savePipeline, type Pipeline } from "./pipeline";
import { registerActions } from "./control";
import AudioWaveform from "./AudioWaveform";
import { consumeStudioAssets } from "./studioHandoff";
import {
  activeVisualClip,
  addClip,
  addTrack,
  buildStudioExportPlan,
  createStudioClip,
  duplicateClip,
  loadStudioTimeline,
  moveClip,
  moveClipToTrack,
  nudgeClip,
  normalizeStudioTimeline,
  patchClip,
  patchTrack,
  reconcileStudioTimeline,
  removeClip,
  removeTrack,
  reorderTrack,
  rippleRemoveClip,
  saveStudioTimeline,
  splitClip,
  studioTimelineEnd,
  studioTimelineForPersistence,
  trimClip,
  type CanonicalStudioSource,
  type StudioClip,
  type StudioClipKind,
  type StudioTimeline,
  type StudioTrack,
  type StudioTrackKind,
} from "./studioTimeline";

const W = 1180;
const DRAG_TYPE = "application/x-pioneer-studio-asset";

type EShot = {
  id: string;
  n: string;
  title: string;
  a: number;
  b: number;
  status: ShotStatus;
  prompt: string;
  mediaUrl?: string;
  mediaKind?: "image" | "audio" | "video";
  isFinal: boolean;
  fillStyle: React.CSSProperties;
};

type DragAsset = {
  origin: "library" | "upload";
  sourceId: string;
  name: string;
  url?: string;
  contentType: string;
  kind: StudioClipKind;
  duration: number;
};

type TimelineState = { projectId: string; doc: StudioTimeline };

const statusMeta = (status: ShotStatus): { cls: string; label: string } =>
  status === "ready"
    ? { cls: "st-ready", label: "Ready" }
    : status === "failed"
      ? { cls: "st-review", label: "Needs Review" }
      : status === "empty"
        ? { cls: "st-draft", label: "Draft" }
        : { cls: "st-gen", label: "Generating" };

const fmt = (time: number) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(time / 60))}:${pad(Math.floor(time % 60))}.${Math.floor((time * 10) % 10)}`;
};

function toEShots(shots: Shot[], pipe: Pipeline): EShot[] {
  let cursor = 0;
  return shots.map((shot, index) => {
    const duration = shot.sourceDuration ?? BEAT_SECONDS;
    const start = cursor;
    cursor += duration;
    const final = extOf(pipe, shot.id).finalClip;
    const url = final?.url ?? shot.result?.url;
    const detectedKind = final
      ? kindOf(final.content_type, final.url)
      : shot.result
        ? kindOf(shot.result.content_type, shot.result.url)
        : undefined;
    const kind = detectedKind === "model" ? undefined : detectedKind;
    return {
      id: shot.id,
      n: String(index + 1).padStart(2, "0"),
      title: shot.prompt ? shot.prompt.split(/[,—.]/)[0].slice(0, 28) : "New beat",
      a: start,
      b: cursor,
      status: shot.status,
      prompt: shot.prompt,
      mediaUrl: url,
      mediaKind: kind,
      isFinal: !!final,
      fillStyle:
        url && kind === "image"
          ? { backgroundImage: `url(${url})`, backgroundSize: "cover", backgroundPosition: "center" }
          : { background: PH[index % PH.length] },
    };
  });
}

function visualStyle(clip?: StudioClip): React.CSSProperties {
  if (clip?.url && clip.kind === "image") {
    return { backgroundImage: `url(${clip.url})`, backgroundSize: "cover", backgroundPosition: "center" };
  }
  return { background: "radial-gradient(60% 45% at 48% 58%,rgba(74,222,128,.2),transparent 70%),linear-gradient(180deg,#0a1508,#05080a)" };
}

function defaultDuration(kind: StudioClipKind): number {
  return kind === "image" ? 5 : 10;
}

function probeDuration(url: string, kind: StudioClipKind): Promise<number | null> {
  if (kind === "image") return Promise.resolve(null);
  return new Promise((resolve) => {
    const media = document.createElement(kind === "audio" ? "audio" : "video");
    let settled = false;
    let timer = 0;
    const done = (value: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      media.onloadedmetadata = null;
      media.onerror = null;
      media.removeAttribute("src");
      media.load();
      resolve(value);
    };
    timer = window.setTimeout(() => done(null), 8000);
    media.preload = "metadata";
    media.onloadedmetadata = () => {
      done(Number.isFinite(media.duration) && media.duration > 0 ? media.duration : null);
    };
    media.onerror = () => done(null);
    media.src = url;
  });
}

function mediaAsset(object: MediaObject): DragAsset | null {
  const kind = kindOf(object.content_type, object.url);
  if (kind === "model") return null;
  return {
    origin: "library",
    sourceId: `media:${object.key}`,
    name: object.name,
    url: object.url,
    contentType: object.content_type,
    kind,
    duration: defaultDuration(kind),
  };
}

export default function StudioView({ ps }: { ps: PS }) {
  const projectId = ps.board?.id || "default";
  const [pipe, setPipe] = useState<Pipeline>(() => loadPipeline(projectId));
  const [sel, setSel] = useState(0);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [playT, setPlayT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fs, setFs] = useState(false);
  const [magnetic, setMagnetic] = useState(true);
  const [ov, setOv] = useState({ Grid: true, Safe: true });
  const [menu, setMenu] = useState<null | "model">(null);
  const [curModel, setCurModel] = useState(() => pickModel(ps.models, "image")?.model || "");
  const [exporting, setExporting] = useState(false);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const [assetCat, setAssetCat] = useState("All");
  const [assetQuery, setAssetQuery] = useState("");
  const [assetLimit, setAssetLimit] = useState(24);
  const [dropLane, setDropLane] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [showExportReadiness, setShowExportReadiness] = useState(false);

  const psRef = useRef(ps);
  psRef.current = ps;
  const root = useRef<HTMLDivElement>(null);
  const monitorRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const monVideoRef = useRef<HTMLVideoElement>(null);
  const audioEls = useRef(new Map<string, HTMLAudioElement>());
  const audioCallbacks = useRef(new Map<string, (el: HTMLAudioElement | null) => void>());
  const audioErrors = useRef(new Set<string>());
  const lastMaster = useRef(1);
  const historyRef = useRef<{ projectId: string; past: StudioTimeline[]; future: StudioTimeline[] }>({
    projectId,
    past: [],
    future: [],
  });

  useEffect(() => {
    if (ps.mode !== "studio") return;
    setPipe(loadPipeline(projectId));
  }, [ps.mode, ps.board?.rev, projectId]);

  useEffect(() => {
    setCurModel((current) =>
      current && ps.models.some((model) => model.model === current)
        ? current
        : pickModel(ps.models, "image")?.model || "",
    );
  }, [ps.models]);

  const boardShots = ps.board?.shots;
  const shots = useMemo(() => toEShots(boardShots || [], pipe), [boardShots, pipe]);
  const shotsRef = useRef(shots);
  shotsRef.current = shots;
  const storyEnd = shots.at(-1)?.b ?? 0;
  const soundtrack = pipe.mix || pipe.music;

  const canonicalSources = useMemo<CanonicalStudioSource[]>(() => {
    const sources: CanonicalStudioSource[] = shots.map((shot) => ({
      canonicalId: `beat:${shot.id}`,
      origin: "storyboard",
      sourceId: `beat:${shot.id}`,
      name: `${shot.n} · ${shot.title}`,
      url: shot.mediaUrl,
      contentType:
        shot.mediaKind === "video" ? "video/*" : shot.mediaKind === "audio" ? "audio/*" : "image/*",
      kind: shot.mediaKind === "video" ? "video" : "image",
      start: shot.a,
      duration: shot.b - shot.a,
      sourceDuration: shot.mediaKind === "video" ? shot.b - shot.a : undefined,
    }));
    if (soundtrack?.url) {
      sources.push({
        canonicalId: "soundtrack:main",
        origin: "soundtrack",
        sourceId: "soundtrack:main",
        name: pipe.mix ? "Storyboard mix" : "Music bed",
        url: soundtrack.url,
        contentType: soundtrack.content_type || "audio/*",
        kind: "audio",
        start: 0,
        duration: Math.max(storyEnd, 10),
        sourceDuration: undefined,
      });
    }
    return sources;
  }, [shots, soundtrack?.url, soundtrack?.content_type, pipe.mix, storyEnd]);

  const storedProjectTimeline = useMemo(() => {
    const serverTimeline = activeProjectStudioTimeline(projectId) ?? ps.board?.studioTimeline;
    return serverTimeline ? normalizeStudioTimeline(serverTimeline) : loadStudioTimeline(projectId);
  }, [projectId, ps.board?.studioTimeline]);

  const [timelineState, setTimelineState] = useState<TimelineState>(() => ({
    projectId,
    doc: reconcileStudioTimeline(storedProjectTimeline, canonicalSources),
  }));
  const fallbackTimeline = useMemo(
    () => reconcileStudioTimeline(storedProjectTimeline, canonicalSources),
    [storedProjectTimeline, canonicalSources],
  );
  const timeline = timelineState.projectId === projectId ? timelineState.doc : fallbackTimeline;
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;

  useEffect(() => {
    setTimelineState((current) => ({
      projectId,
      doc: reconcileStudioTimeline(current.projectId === projectId ? current.doc : storedProjectTimeline, canonicalSources),
    }));
  }, [projectId, canonicalSources, storedProjectTimeline]);

  useEffect(() => {
    saveStudioTimeline(timelineState.projectId, timelineState.doc);
    const timer = window.setTimeout(() => {
      saveActiveProjectStudioTimeline(
        timelineState.projectId,
        studioTimelineForPersistence(timelineState.doc),
      );
    }, 700);
    return () => window.clearTimeout(timer);
  }, [timelineState]);

  function updateTimeline(change: (doc: StudioTimeline) => StudioTimeline, recordHistory = true) {
    setTimelineState((current) => {
      const base = current.projectId === projectId ? current.doc : fallbackTimeline;
      const next = change(base);
      if (next === base) return current.projectId === projectId ? current : { projectId, doc: base };
      if (recordHistory) {
        const history = historyRef.current;
        if (history.projectId !== projectId) historyRef.current = { projectId, past: [], future: [] };
        historyRef.current.past.push(structuredClone(base));
        historyRef.current.past = historyRef.current.past.slice(-60);
        historyRef.current.future = [];
      }
      return { projectId, doc: next };
    });
  }

  function undoTimeline() {
    setTimelineState((current) => {
      const history = historyRef.current;
      if (history.projectId !== projectId || !history.past.length) return current;
      const previous = history.past.pop()!;
      history.future.push(structuredClone(current.doc));
      return { projectId, doc: previous };
    });
  }

  function redoTimeline() {
    setTimelineState((current) => {
      const history = historyRef.current;
      if (history.projectId !== projectId || !history.future.length) return current;
      const next = history.future.pop()!;
      history.past.push(structuredClone(current.doc));
      return { projectId, doc: next };
    });
  }

  const clips = timeline.clips;
  const tracks = timeline.tracks;
  const trackById = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks]);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const selectedClip = clips.find((clip) => clip.id === selectedClipId);
  const selectedClipRef = useRef(selectedClipId);
  selectedClipRef.current = selectedClipId;
  const cur = shots[sel] as EShot | undefined;
  const END = Math.max(studioTimelineEnd(timeline), storyEnd);
  const TL = Math.max(24, Math.ceil((END || 24) / 4) * 4);
  const timelineWidth = Math.round(W * zoom);
  const px = (seconds: number) => (seconds / TL) * timelineWidth;
  const mon = activeVisualClip(clips, playT, timeline.tracks);
  const monShot = mon?.sourceId.startsWith("beat:") ? shots.find((shot) => `beat:${shot.id}` === mon.sourceId) : undefined;
  const monFrac = mon ? Math.max(0, Math.min(1, (playT - mon.start) / Math.max(0.1, mon.duration))) : 0;
  const playRef = useRef(playT);
  playRef.current = playT;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const selRef = useRef(sel);
  selRef.current = sel;
  const endRef = useRef(END);
  endRef.current = END;
  const tlRef = useRef(TL);
  tlRef.current = TL;
  const timelineWidthRef = useRef(timelineWidth);
  timelineWidthRef.current = timelineWidth;
  const magneticRef = useRef(magnetic);
  magneticRef.current = magnetic;

  useEffect(() => {
    if (playT > END) setPlayT(END);
  }, [END, playT]);

  useEffect(() => {
    const next = clips.find((clip) => clip.kind === "image" && clip.start > playT);
    if (next?.url) {
      const image = new Image();
      image.src = next.url;
    }
  }, [clips, playT]);

  function seekTo(time: number) {
    setPlayT(Math.max(0, Math.min(endRef.current || tlRef.current, time)));
  }

  function togglePlayback(force?: boolean) {
    const next = force ?? !playingRef.current;
    if (next && playRef.current >= endRef.current - 0.02) seekTo(0);
    setPlaying(next);
  }

  function dragSeek(map: (fraction: number) => number) {
    return (event: React.PointerEvent) => {
      const element = event.currentTarget as HTMLElement;
      const go = (clientX: number) => {
        const rect = element.getBoundingClientRect();
        seekTo(map(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))));
      };
      go(event.clientX);
      const move = (e: PointerEvent) => go(e.clientX);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.style.cursor = "";
      };
      document.body.style.cursor = "ew-resize";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      event.preventDefault();
      event.stopPropagation();
    };
  }

  const scrubStart = dragSeek((fraction) => fraction * TL);

  useEffect(() => {
    if (!playing || END <= 0) return;
    let frame = 0;
    let last = 0;
    const tick = (timestamp: number) => {
      if (!last) last = timestamp;
      const delta = (timestamp - last) / 1000;
      last = timestamp;
      setPlayT((time) => {
        const next = time + delta;
        if (next >= END) {
          setPlaying(false);
          return END;
        }
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, END]);

  useEffect(() => {
    const video = monVideoRef.current;
    if (!video || !mon || mon.kind !== "video") return;
    const local = mon.trimIn + Math.max(0, playT - mon.start);
    if (Math.abs(video.currentTime - local) > 0.3) video.currentTime = local;
    video.volume = Math.max(0, Math.min(1, mon.volume * timeline.masterVolume));
    video.muted = mon.muted || !!trackById.get(mon.trackId)?.muted || timeline.masterVolume === 0;
    if (playing) {
      if (video.paused) video.play().catch(() => {
        video.muted = true;
        void video.play().catch(() => {});
      });
    } else video.pause();
  }, [playT, playing, mon, timeline.masterVolume, trackById]);

  useEffect(() => {
    for (const clip of clips) {
      if (clip.kind !== "audio") continue;
      const audio = audioEls.current.get(clip.id);
      if (!audio) continue;
      const active = playT >= clip.start && playT < clip.start + clip.duration;
      audio.volume = Math.max(0, Math.min(1, clip.volume * timeline.masterVolume));
      audio.muted = clip.muted || !!trackById.get(clip.trackId)?.muted || timeline.masterVolume === 0;
      if (active) {
        const local = clip.trimIn + playT - clip.start;
        if (Math.abs(audio.currentTime - local) > 0.3) audio.currentTime = local;
        if (playing && audio.paused) {
          void audio.play().catch((error) => {
            if (audioErrors.current.has(clip.id)) return;
            audioErrors.current.add(clip.id);
            psRef.current.toast(`Could not play ${clip.name}: ${String(error?.message || error)}`);
          });
        } else if (!playing) audio.pause();
      } else audio.pause();
    }
  }, [clips, playT, playing, timeline.masterVolume, trackById]);

  function audioRef(id: string) {
    let callback = audioCallbacks.current.get(id);
    if (!callback) {
      callback = (element) => {
        if (element) audioEls.current.set(id, element);
        else audioEls.current.delete(id);
      };
      audioCallbacks.current.set(id, callback);
    }
    return callback;
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (psRef.current.mode !== "studio") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoTimeline();
        else undoTimeline();
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        togglePlayback();
        return;
      }
      if (event.key.toLowerCase() === "s" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        splitSelectedClip();
        return;
      }
      if (event.key.toLowerCase() === "d" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        duplicateSelectedClip();
        return;
      }
      if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        nudgeSelectedClip((event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 1 : 0.1));
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedClipId) {
        event.preventDefault();
        if (event.shiftKey) rippleDeleteSelectedClip();
        else removeSelectedClip();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (ps.mode !== "studio" && playing) setPlaying(false);
  }, [ps.mode, playing]);

  useEffect(() => {
    const update = () => setFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  function toggleFullscreen() {
    const element = monitorRef.current;
    if (!element) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void element.requestFullscreen?.().catch(() => {});
  }

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if ((event.target as HTMLElement)?.closest?.(".selctl")) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  const clipDrag = useRef<null | {
    id: string;
    mode: "move" | "left" | "right";
    clientX: number;
    start: number;
    duration: number;
    trimIn: number;
    timelineLength: number;
    timelineWidth: number;
    recorded: boolean;
  }>(null);
  const [snapT, setSnapT] = useState<number | null>(null);

  function snap(value: number, excludeId: string): number {
    const max = Math.max(tlRef.current, value);
    const safe = Math.max(0, Math.min(max, value));
    if (!magneticRef.current) return safe;
    const targets = clipsRef.current
      .filter((clip) => clip.id !== excludeId)
      .flatMap((clip) => [clip.start, clip.start + clip.duration]);
    let best = Math.round(safe);
    let distance = 0.45;
    for (const target of targets) {
      if (Math.abs(target - safe) < distance) {
        distance = Math.abs(target - safe);
        best = target;
      }
    }
    return Math.max(0, best);
  }

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = clipDrag.current;
      if (!drag) return;
      const delta = ((event.clientX - drag.clientX) * drag.timelineLength) / drag.timelineWidth;
      if (drag.mode === "move") {
        const start = snap(drag.start + delta, drag.id);
        setSnapT(start);
        updateTimeline((doc) => moveClip(doc, drag.id, start), !drag.recorded);
        drag.recorded = true;
        return;
      }
      const boundary =
        drag.mode === "left"
          ? snap(drag.start + delta, drag.id)
          : snap(drag.start + drag.duration + delta, drag.id);
      updateTimeline((doc) => {
        const next = trimClip(doc, drag.id, drag.mode === "left" ? "in" : "out", boundary);
        const changed = next.clips.find((clip) => clip.id === drag.id);
        setSnapT(drag.mode === "left" ? changed?.start ?? boundary : (changed?.start ?? drag.start) + (changed?.duration ?? drag.duration));
        return next;
      }, !drag.recorded);
      drag.recorded = true;
    };
    const up = () => {
      clipDrag.current = null;
      setSnapT(null);
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  });

  function startClipDrag(event: React.PointerEvent, clip: StudioClip, mode: "move" | "left" | "right") {
    if (tracksRef.current.find((track) => track.id === clip.trackId)?.locked) {
      psRef.current.toast("Unlock the track before editing its clips");
      return;
    }
    setSelectedClipId(clip.id);
    seekTo(clip.start);
    const shotIndex = shots.findIndex((shot) => `beat:${shot.id}` === clip.sourceId);
    if (shotIndex >= 0) setSel(shotIndex);
    clipDrag.current = {
      id: clip.id,
      mode,
      clientX: event.clientX,
      start: clip.start,
      duration: clip.duration,
      trimIn: clip.trimIn,
      timelineLength: tlRef.current,
      timelineWidth: timelineWidthRef.current,
      recorded: false,
    };
    document.body.style.cursor = mode === "move" ? "grabbing" : "col-resize";
    event.preventDefault();
    event.stopPropagation();
  }

  function selectShot(index: number) {
    setSel(index);
    setPromptDraft(null);
    const shot = shotsRef.current[index];
    if (!shot) return;
    const linked = clipsRef.current.find((clip) => clip.id === `beat:${shot.id}`);
    setSelectedClipId(linked?.id || null);
    seekTo(linked?.start ?? shot.a);
  }

  function selectTimelineClip(clip: StudioClip) {
    setSelectedClipId(clip.id);
    const shotIndex = shots.findIndex((shot) => `beat:${shot.id}` === clip.sourceId);
    if (shotIndex >= 0) setSel(shotIndex);
    seekTo(clip.start);
  }

  function updateClip(id: string, patch: Partial<StudioClip>) {
    updateTimeline((doc) => patchClip(doc, id, patch));
  }

  function clipIsLocked(clip: StudioClip): boolean {
    return !!tracksRef.current.find((track) => track.id === clip.trackId)?.locked;
  }

  function removeSelectedClip() {
    if (!selectedClipId) return;
    const clip = clipsRef.current.find((item) => item.id === selectedClipId);
    if (!clip) return;
    if (clipIsLocked(clip)) return psRef.current.toast("Unlock the track before removing this clip");
    updateTimeline((doc) => removeClip(doc, clip.id));
    setSelectedClipId(null);
    psRef.current.toast(`${clip.name} removed from timeline`, "ok");
  }

  function splitSelectedClip() {
    const id = selectedClipRef.current;
    const clip = clipsRef.current.find((item) => item.id === id);
    if (!id || !clip) return psRef.current.toast("Select a clip first");
    if (clipIsLocked(clip)) return psRef.current.toast("Unlock the track before splitting this clip");
    const at = playRef.current;
    if (at <= clip.start + 0.25 || at >= clip.start + clip.duration - 0.25)
      return psRef.current.toast("Place the playhead at least 0.25s inside the selected clip");
    updateTimeline((doc) => splitClip(doc, id, at));
    psRef.current.toast(`${clip.name} split at ${fmt(at)}`, "ok");
  }

  function duplicateSelectedClip() {
    const id = selectedClipRef.current;
    const clip = clipsRef.current.find((item) => item.id === id);
    if (!id || !clip) return psRef.current.toast("Select a clip first");
    if (clipIsLocked(clip)) return psRef.current.toast("Unlock the track before duplicating this clip");
    const snapshot = timelineRef.current;
    const next = duplicateClip(snapshot, id);
    const copyId = next.clips.find((item) => !snapshot.clips.some((before) => before.id === item.id))?.id;
    updateTimeline(() => next);
    if (copyId) setSelectedClipId(copyId);
    psRef.current.toast(`${clip.name} duplicated`, "ok");
  }

  function rippleDeleteSelectedClip() {
    const id = selectedClipRef.current;
    const clip = clipsRef.current.find((item) => item.id === id);
    if (!id || !clip) return psRef.current.toast("Select a clip first");
    if (clipIsLocked(clip)) return psRef.current.toast("Unlock the track before ripple deleting this clip");
    updateTimeline((doc) => rippleRemoveClip(doc, id));
    setSelectedClipId(null);
    psRef.current.toast(`${clip.name} removed and the track gap closed`, "ok");
  }

  function nudgeSelectedClip(delta: number) {
    const id = selectedClipRef.current;
    const clip = clipsRef.current.find((item) => item.id === id);
    if (!id || !clip) return;
    if (clipIsLocked(clip)) return psRef.current.toast("Unlock the track before nudging this clip");
    updateTimeline((doc) => nudgeClip(doc, id, delta));
  }

  function restoreLinkedClips() {
    updateTimeline((doc) => reconcileStudioTimeline({ ...doc, suppressedSourceIds: [] }, canonicalSources));
    psRef.current.toast("Linked storyboard media restored", "ok");
  }

  function createTrack(kind: StudioTrackKind) {
    updateTimeline((doc) => addTrack(doc, kind));
    psRef.current.toast(`${kind === "audio" ? "Audio" : "Video"} track added`, "ok");
  }

  function moveSelectedToTrack(trackId: string) {
    const id = selectedClipRef.current;
    if (!id) return psRef.current.toast("Select a clip first");
    updateTimeline((doc) => moveClipToTrack(doc, id, trackId));
  }

  function targetTrack(kind: StudioClipKind, preferredId?: string): StudioTrack | undefined {
    const trackKind: StudioTrackKind = kind === "audio" ? "audio" : "video";
    return (
      tracksRef.current.find((track) => track.id === preferredId && track.kind === trackKind && !track.locked) ||
      tracksRef.current.find((track) => track.kind === trackKind && !track.locked)
    );
  }

  function addAsset(asset: DragAsset, start: number, preferredTrackId?: string): StudioClip | null {
    const track = targetTrack(asset.kind, preferredTrackId);
    if (!track) {
      psRef.current.toast(`Unlock a ${asset.kind === "audio" ? "audio" : "video"} track before adding media`);
      return null;
    }
    const clip = createStudioClip(asset, start, asset.duration, track.id);
    updateTimeline((doc) => addClip(doc, clip));
    setSelectedClipId(clip.id);
    seekTo(clip.start);
    if (clip.url && clip.kind !== "image") {
      void probeDuration(clip.url, clip.kind).then((duration) => {
        if (!duration) return;
        updateTimeline((doc) => patchClip(doc, clip.id, { duration, sourceDuration: duration }));
      });
    }
    return clip;
  }

  function trackEnd(kind: StudioClipKind, trackId?: string): number {
    const target = targetTrack(kind, trackId);
    return clipsRef.current
      .filter((clip) => clip.trackId === target?.id)
      .reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
  }

  useEffect(() => {
    if (ps.mode !== "studio") return;
    const pending = consumeStudioAssets(projectId);
    if (!pending.length) return;
    let cursor = trackEnd("video");
    let added = 0;
    for (const asset of pending) {
      if (clipsRef.current.some((clip) => clip.sourceId === asset.sourceId)) continue;
      const clip = addAsset({ ...asset, origin: "library" }, cursor);
      if (!clip) continue;
      cursor += clip.duration;
      added++;
    }
    if (added) psRef.current.toast(`${added} Animation take${added === 1 ? "" : "s"} placed on the Studio timeline`, "ok");
    // addAsset and trackEnd intentionally route through the same editing paths
    // as drag/drop. Pending handoffs are consumed exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ps.mode, projectId]);

  function startAssetDrag(event: React.DragEvent, asset: DragAsset) {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(asset));
    event.dataTransfer.setData("text/plain", asset.name);
  }

  async function uploadFilesToTimeline(files: FileList | File[], start: number, preferredTrackId?: string) {
    const p = psRef.current;
    if (!p.apiKey) return p.toast("Paste your sk-pioneer key first (Settings)");
    let visualAt = start;
    let audioAt = start;
    for (const file of Array.from(files)) {
      if (!/^(image|video|audio)\//.test(file.type)) {
        p.toast(`${file.name} is not previewable media`);
        continue;
      }
      try {
        const uploaded = await uploadMedia(p.apiKey, file);
        p.charge(uploaded.credits_remaining);
        const kind = kindOf(uploaded.content_type, uploaded.url);
        if (kind === "model") {
          p.toast(`${file.name} is a character model; choose it in Create, Head, or Animation`);
          continue;
        }
        const at = kind === "audio" ? audioAt : visualAt;
        const clip = addAsset(
          {
            origin: "upload",
            sourceId: `upload:${uploaded.key}`,
            name: file.name,
            url: uploaded.url,
            contentType: uploaded.content_type,
            kind,
            duration: defaultDuration(kind),
          },
          at,
          preferredTrackId,
        );
        if (!clip) continue;
        if (kind === "audio") audioAt += clip.duration;
        else visualAt += clip.duration;
        p.toast(`${file.name} added to ${kind === "audio" ? "Audio" : "Video"}`, "ok");
      } catch (error: any) {
        p.toast(String(error.message || error));
      }
    }
    p.refreshMedia();
  }

  function timelinePosition(event: React.DragEvent): number {
    const rect = event.currentTarget.getBoundingClientRect();
    return snap(((event.clientX - rect.left) / rect.width) * TL, "__drop__");
  }

  function onLaneDrop(event: React.DragEvent, track: StudioTrack) {
    event.preventDefault();
    const start = timelinePosition(event);
    setDropLane(null);
    if (track.locked) return psRef.current.toast(`Unlock ${track.name} before dropping media`);
    if (event.dataTransfer.files?.length) {
      void uploadFilesToTimeline(event.dataTransfer.files, start, track.id);
      return;
    }
    try {
      const asset = JSON.parse(event.dataTransfer.getData(DRAG_TYPE)) as DragAsset;
      if (!asset?.kind || !asset.name) throw new Error("bad drag payload");
      const expectedKind = asset.kind === "audio" ? "audio" : "video";
      if (track.kind !== expectedKind) return psRef.current.toast(`${asset.name} belongs on a ${expectedKind} track`);
      addAsset(asset, start, track.id);
      psRef.current.toast(`${asset.name} added at ${fmt(start)}`, "ok");
    } catch {
      psRef.current.toast("Drag a project asset, beat, or media file onto a timeline lane");
    }
  }

  async function regenSel() {
    const p = psRef.current;
    if (!curModel) return p.toast("No image model is available for regeneration");
    const editorShot = shotsRef.current[selRef.current];
    const shot = p.board?.shots.find((item) => item.id === editorShot?.id);
    if (!shot) return p.toast("Select a storyboard beat first");
    p.toast(`Regenerating beat ${editorShot.n} · ${curModel}`);
    try {
      await renderShot(p, shot, { model: curModel });
    } catch (error: any) {
      p.toast(String(error.message || error));
    }
  }

  async function renderDrafts() {
    const p = psRef.current;
    if (!p.apiKey) return p.toast("Paste your sk-pioneer key first (Settings)");
    if (!curModel) return p.toast("No image model is available for draft rendering");
    const drafts = p.board?.shots.filter((shot) => shot.status === "empty" || shot.status === "failed") || [];
    if (!drafts.length) return p.toast("Every beat has a render — re-render from the transport");
    p.toast(`Rendering ${drafts.length} beats · ${curModel}`);
    for (const shot of drafts) await renderShot(p, shot, { model: curModel }).catch((error: any) => p.toast(String(error.message || error)));
  }

  async function exportTimeline() {
    const p = psRef.current;
    if (!p.apiKey) return p.toast("Paste your sk-pioneer key first (Settings)");
    const check = buildStudioExportPlan(timelineRef.current);
    if (!check.ok) {
      const more = check.issues.length > 1 ? ` (+${check.issues.length - 1} more)` : "";
      return p.toast(`Can't export this cut yet: ${check.issues[0]}${more}`);
    }
    setExporting(true);
    p.toast(`Exporting ${check.plan.clips.length} timeline clip${check.plan.clips.length === 1 ? "" : "s"}…`);
    try {
      const result = await assembleRelease(p.apiKey, check.plan);
      if (!result) return p.toast("The release export service is unavailable");
      const url = result.job_id ? (await p.waitForJob(result.job_id)).url : result.url;
      if (!url) return p.toast("The export completed without a release URL");
      const next = loadPipeline(projectId);
      next.release = { url, duration: check.plan.duration, createdAt: new Date().toISOString() };
      savePipeline(projectId, next);
      setPipe(next);
      if (typeof result.credits_remaining === "number") p.charge(result.credits_remaining);
      else p.refreshCredits();
      p.refreshMedia();
      p.toast("Timeline export ready — the master is in Project Media", "ok");
    } catch (error: any) {
      p.toast(String(error.message || error));
    } finally {
      setExporting(false);
    }
  }

  async function savePrompt() {
    const p = psRef.current;
    const editorShot = shotsRef.current[selRef.current];
    if (!editorShot || promptDraft === null || promptDraft === editorShot.prompt) return setPromptDraft(null);
    setPromptDraft(null);
    p.setBoard(await patchShot(p.apiKey, undefined, editorShot.id, { prompt: promptDraft }));
    p.toast("Prompt saved", "ok");
  }

  async function onUploadAsset(event: React.ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    event.target.value = "";
    if (!files?.length) return;
    const p = psRef.current;
    if (!p.apiKey) return p.toast("Paste your sk-pioneer key first (Settings)");
    for (const file of Array.from(files)) {
      try {
        const uploaded = await uploadMedia(p.apiKey, file);
        p.charge(uploaded.credits_remaining);
        p.toast(`Uploaded ${file.name}`, "ok");
      } catch (error: any) {
        p.toast(String(error.message || error));
      }
    }
    p.refreshMedia();
  }

  const fnsRef = useRef({ regenSel, renderDrafts, exportTimeline, seekTo, toggleFullscreen, togglePlayback, removeSelectedClip, splitSelectedClip, duplicateSelectedClip, rippleDeleteSelectedClip, nudgeSelectedClip, undoTimeline, redoTimeline, createTrack, moveSelectedToTrack });
  fnsRef.current = { regenSel, renderDrafts, exportTimeline, seekTo, toggleFullscreen, togglePlayback, removeSelectedClip, splitSelectedClip, duplicateSelectedClip, rippleDeleteSelectedClip, nudgeSelectedClip, undoTimeline, redoTimeline, createTrack, moveSelectedToTrack };
  useEffect(() => {
    ps.registerSuggestions("studio", [
      { label: "Play the sequence", run: () => fnsRef.current.togglePlayback(true) },
      { label: "Export the timeline", run: () => fnsRef.current.exportTimeline() },
      { label: "Render draft beats", run: () => fnsRef.current.renderDrafts() },
      { label: "Regenerate this beat", run: () => fnsRef.current.regenSel() },
    ]);
    registerActions([
      {
        name: "studio.get_state",
        description: "Timeline snapshot: playhead, playback, selected clip, end, clips, and master volume",
        run: () => ({
          playhead: playRef.current,
          playing: playingRef.current,
          selectedClipId: selectedClipRef.current,
          end: endRef.current,
          tracks: timelineRef.current.tracks,
          clips: clipsRef.current.map(({ id, name, kind, trackId, start, duration, volume, muted }) => ({ id, name, kind, trackId, start, duration, volume, muted })),
          masterVolume: timelineRef.current.masterVolume,
        }),
      },
      { name: "studio.play", description: "Start timeline playback", run: () => fnsRef.current.togglePlayback(true) },
      { name: "studio.pause", description: "Pause timeline playback", run: () => fnsRef.current.togglePlayback(false) },
      {
        name: "studio.seek",
        description: "Seek to a time in seconds",
        parameters: {
          type: "object",
          properties: { t: { type: "number", minimum: 0, description: "Timeline time in seconds" } },
          required: ["t"],
          additionalProperties: false,
        },
        run: (params) => fnsRef.current.seekTo(Number(params?.t) || 0),
      },
      { name: "studio.fullscreen", description: "Toggle monitor fullscreen", run: () => fnsRef.current.toggleFullscreen() },
      { name: "studio.export", description: "Export the exact Studio timeline as a release file (costs 25 credits)", confirmation: "Spends 25 credits on release assembly", run: () => fnsRef.current.exportTimeline() },
      { name: "studio.render_drafts", description: "Render every draft storyboard beat", confirmation: "Starts paid image generation jobs", run: () => fnsRef.current.renderDrafts() },
      { name: "studio.regenerate_selected", description: "Re-render the selected storyboard beat", confirmation: "Starts a paid image generation job", run: () => fnsRef.current.regenSel() },
      { name: "studio.split_selected_clip", description: "Split the selected clip at the current playhead", run: () => fnsRef.current.splitSelectedClip() },
      { name: "studio.duplicate_selected_clip", description: "Duplicate the selected clip immediately after itself", run: () => fnsRef.current.duplicateSelectedClip() },
      { name: "studio.ripple_delete_selected_clip", description: "Remove the selected clip and close the resulting gap on its track", confirmation: "Removes a clip and shifts later clips on that track", run: () => fnsRef.current.rippleDeleteSelectedClip() },
      {
        name: "studio.nudge_selected_clip",
        description: "Move the selected clip left or right by a number of seconds",
        parameters: { type: "object", properties: { delta: { type: "number", description: "Signed seconds; negative moves left" } }, required: ["delta"], additionalProperties: false },
        run: (params) => fnsRef.current.nudgeSelectedClip(Number(params?.delta) || 0),
      },
      { name: "studio.undo", description: "Undo the most recent timeline edit", run: () => fnsRef.current.undoTimeline() },
      { name: "studio.redo", description: "Redo the most recently undone timeline edit", run: () => fnsRef.current.redoTimeline() },
      {
        name: "studio.add_track",
        description: "Add a video or audio track to the timeline",
        parameters: { type: "object", properties: { kind: { type: "string", enum: ["video", "audio"] } }, required: ["kind"], additionalProperties: false },
        run: (params) => fnsRef.current.createTrack(params?.kind === "audio" ? "audio" : "video"),
      },
      {
        name: "studio.move_selected_to_track",
        description: "Move the selected clip to a compatible unlocked track id from studio.get_state",
        parameters: { type: "object", properties: { track_id: { type: "string" } }, required: ["track_id"], additionalProperties: false },
        run: (params) => fnsRef.current.moveSelectedToTrack(String(params?.track_id || "")),
      },
      { name: "studio.remove_selected_clip", description: "Remove the selected edit clip", confirmation: "Removes a clip from the timeline", run: () => fnsRef.current.removeSelectedClip() },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const normalizedAssetQuery = assetQuery.trim().toLowerCase();
  const matchingAssets = (ps.media?.objects || [])
    .filter((object) => {
      const kind = kindOf(object.content_type, object.url);
      return (
        kind !== "model" &&
        (!normalizedAssetQuery || `${object.name} ${object.key} ${object.type}`.toLowerCase().includes(normalizedAssetQuery)) &&
        (assetCat === "All" ||
          (assetCat === "Images" && kind === "image") ||
          (assetCat === "Clips" && kind === "video") ||
          (assetCat === "Audio" && kind === "audio"))
      );
    });
  const assets = matchingAssets.slice(0, assetLimit);
  const visibleShots = shots.filter(
    (shot) => !normalizedAssetQuery || `${shot.n} ${shot.title} ${shot.prompt}`.toLowerCase().includes(normalizedAssetQuery),
  );
  useEffect(() => setAssetLimit(24), [assetCat, normalizedAssetQuery]);
  const ticks = useMemo(() => {
    const values: number[] = [];
    for (let seconds = 0; seconds <= TL; seconds += 4) values.push(seconds);
    return values;
  }, [TL]);
  const modelOpts = [...new Set(ps.models.map((model) => model.model))];
  const linkedMeta = cur ? statusMeta(cur.status) : { cls: "st-draft", label: "—" };
  const clipBoundaries = [...new Set(clips.flatMap((clip) => [clip.start, clip.start + clip.duration]))].sort((a, b) => a - b);
  const exportCheck = useMemo(() => buildStudioExportPlan(timeline), [timeline]);

  return (
    <div className="st-app" ref={root}>
      <div className="st-bar">
        <div className="proj">
          <div className="t">{ps.board?.title || "Untitled Storyboard"}</div>
          <div className="s">
            16:9 · 00:00–{fmtTime(END || 0)} · {pipe.release
              ? <a href={pipe.release.url} target="_blank" rel="noreferrer">last export ↗</a>
              : "edit saved locally"}
          </div>
        </div>
        <div className="st-modes">
          <button type="button" className="st-mode" onClick={() => psRef.current.setMode("board")}>Storyboard</button>
          <span className="st-mode active" aria-current="page">Timeline</span>
        </div>
        <div className="spacer" />
        <div className="selctl" style={{ position: "relative" }} onClick={() => setMenu(menu === "model" ? null : "model")}>
          <span className="dot" />
          <span className="k">Model</span> {curModel || "No model"}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M6 9l6 6 6-6" /></svg>
          {menu === "model" && (
            <div className="menu" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0 }}>
              {modelOpts.map((model) => (
                <div key={model} className={`mi${model === curModel ? " on" : ""}`} onClick={() => { setCurModel(model); psRef.current.toast(`Model · ${model}`); }}>
                  {model}
                </div>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="btn" onClick={renderDrafts} disabled={!curModel || exporting}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M5 3l14 9-14 9V3z" /></svg>
          Render beats
        </button>
        <button
          type="button"
          className={`btn export-check${exportCheck.ok ? " ready" : ""}`}
          onClick={() => setShowExportReadiness((value) => !value)}
          title={exportCheck.ok ? "This cut can be exported by the current service" : `${exportCheck.issues.length} export issue${exportCheck.issues.length === 1 ? "" : "s"}`}
        >
          {exportCheck.ok ? "Ready" : `${exportCheck.issues.length} issue${exportCheck.issues.length === 1 ? "" : "s"}`}
        </button>
        <button type="button" className="btn primary" onClick={exportTimeline} disabled={exporting}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
          {exporting ? "Exporting…" : "Export"}
        </button>
      </div>
      {showExportReadiness && (
        <div className={`export-readiness${exportCheck.ok ? " ready" : ""}`}>
          <b>{exportCheck.ok ? "Export ready" : "Export preflight"}</b>
          {exportCheck.ok
            ? <span>{exportCheck.plan.clips.filter((clip) => clip.kind !== "audio").length} visual clip{exportCheck.plan.clips.filter((clip) => clip.kind !== "audio").length === 1 ? "" : "s"} · {fmt(exportCheck.plan.duration)} · {exportCheck.plan.clips.filter((clip) => clip.kind === "audio" && !clip.muted).length} audio layer{exportCheck.plan.clips.filter((clip) => clip.kind === "audio" && !clip.muted).length === 1 ? "" : "s"}</span>
            : <ol>{exportCheck.issues.map((issue) => <li key={issue}>{issue}</li>)}</ol>}
        </div>
      )}

      <div className="st-mid">
        <aside className="st-panel st-left st-scroll">
          <div className="sec-h">
            <span className="lbl">Project Assets</span>
            <label className="add" title="Upload images, video, or audio" style={{ cursor: "pointer" }}>
              <input type="file" multiple accept="image/*,video/*,audio/*" style={{ display: "none" }} onChange={onUploadAsset} />
              <svg className="ic" viewBox="0 0 24 24" style={{ width: 14, height: 14 }}><path d="M12 5v14M5 12h14" /></svg>
            </label>
          </div>
          <div className="asset-help">Drag media onto Video or Audio. Double-click to append.</div>
          <input
            className="asset-search"
            type="search"
            value={assetQuery}
            onChange={(event) => setAssetQuery(event.target.value)}
            placeholder="Search project media and beats…"
            aria-label="Search project assets"
          />
          <div className="catrow">
            {["All", "Images", "Clips", "Audio"].map((category) => (
              <button key={category} type="button" className={`cat${assetCat === category ? " on" : ""}`} onClick={() => setAssetCat(category)}>
                {category}
              </button>
            ))}
          </div>
          <div className="assets">
            {!assets.length && <div className="asset-empty">no matching media — upload or generate</div>}
            {assets.map((object) => {
              const asset = mediaAsset(object);
              if (!asset) return null;
              return (
                <div
                  key={object.key}
                  className="asset"
                  title={`${object.name} · drag to timeline`}
                  draggable
                  onDragStart={(event) => startAssetDrag(event, asset)}
                  onDoubleClick={() => addAsset(asset, trackEnd(asset.kind))}
                >
                  <div className={`th ${asset.kind}`} style={asset.kind === "image" ? { backgroundImage: `url(${object.url})`, backgroundSize: "cover", backgroundPosition: "center" } : {}}>
                    {asset.kind === "video" && <video src={object.url} muted preload="metadata" />}
                    {asset.kind === "audio" && <AudioWaveform url={asset.url} muted={false} />}
                    <span className="asset-kind">{asset.kind}</span>
                    <div className="grain" />
                  </div>
                  <div className="nm">{object.name}</div>
                  <div className="mt">{object.type}</div>
                </div>
              );
            })}
          </div>
          {assets.length < matchingAssets.length && (
            <button type="button" className="load-more-assets" onClick={() => setAssetLimit((value) => value + 24)}>
              Show 24 more · {matchingAssets.length - assets.length} remaining
            </button>
          )}
          <div className="sec-h" style={{ marginTop: 6 }}>
            <span className="lbl">Scenes / Beats</span>
            <span className="add mono" style={{ fontSize: 10, color: "var(--fg4)" }}>{visibleShots.length}</span>
          </div>
          <div className="assets">
            {visibleShots.map((shot) => {
              const index = shots.indexOf(shot);
              const asset: DragAsset = {
                origin: "library",
                sourceId: `beat:${shot.id}`,
                name: `${shot.n} · ${shot.title}`,
                url: shot.mediaUrl,
                contentType: shot.mediaKind === "video" ? "video/*" : "image/*",
                kind: shot.mediaKind === "video" ? "video" : "image",
                duration: shot.b - shot.a,
              };
              return (
                <div
                  key={shot.id}
                  className="asset"
                  draggable
                  onDragStart={(event) => startAssetDrag(event, asset)}
                  onClick={() => selectShot(index)}
                  onDoubleClick={() => addAsset(asset, trackEnd(asset.kind))}
                >
                  <div className="th" style={shot.fillStyle}><div className="grain" /><span className="asset-kind">scene</span></div>
                  <div className="nm">{shot.n} · {shot.title}</div>
                  <div className="mt">{(shot.b - shot.a).toFixed(0)}s · {shot.isFinal ? "final" : statusMeta(shot.status).label.toLowerCase()}</div>
                </div>
              );
            })}
          </div>
        </aside>

        <main className="canvas">
          <div className="cbar">
            {(Object.keys(ov) as (keyof typeof ov)[]).map((key) => (
              <button key={key} type="button" className={`toggle${ov[key] ? " on" : ""}`} onClick={() => setOv((value) => ({ ...value, [key]: !value[key] }))}>
                <span className="sw" />{key}
              </button>
            ))}
            <div className="rt">
              <span>{mon ? mon.name : "Timeline gap"}</span>
              <span className="qsep" style={{ height: 14 }} />
              <span>{mon ? mon.kind : "black"}</span>
            </div>
          </div>
          <div className="stagewrap">
            <div className="monitor" ref={monitorRef}>
              <div className="frame-bg" style={visualStyle(mon)} />
              {mon?.kind === "video" && mon.url && (
                <video key={mon.id} ref={monVideoRef} className="frame-bg" src={mon.url} muted={mon.muted} playsInline preload="auto" />
              )}
              {!mon && <div className="monitor-empty"><b>No visual at {fmt(playT)}</b><span>Drop an image, scene, or clip on the Video lane.</span></div>}
              <div className="grainfx" />
              {ov.Grid && (
                <div className="ov">
                  <svg className="thirds" width="100%" height="100%" preserveAspectRatio="none">
                    <line x1="33.33%" y1="0" x2="33.33%" y2="100%" /><line x1="66.66%" y1="0" x2="66.66%" y2="100%" />
                    <line x1="0" y1="33.33%" x2="100%" y2="33.33%" /><line x1="0" y1="66.66%" x2="100%" y2="66.66%" />
                  </svg>
                </div>
              )}
              {ov.Safe && <div className="safe" />}
              <div className="badges">
                {monShot && isShotRunning({ status: monShot.status } as Shot) && <span className="rec"><span className="d" />GENERATING</span>}
              </div>
              <div className="fscrub">
                <div className="bar" onPointerDown={scrubStart}><div className="fill" style={{ width: `${END ? (playT / END) * 100 : 0}%` }} /></div>
                <div className="tc"><span>{fmt(playT)}</span><span>{mon ? `${mon.name} · ${(monFrac * 100).toFixed(0)}%` : "GAP"}</span><span>{fmt(END)}</span></div>
              </div>
            </div>
            <div className="audio-rack" aria-hidden="true">
              {clips.filter((clip) => clip.kind === "audio" && clip.url).map((clip) => <audio key={clip.id} ref={audioRef(clip.id)} src={clip.url} preload="auto" />)}
            </div>
          </div>
          <div className="transport">
            <button type="button" className="tbtn play" title="Play / pause (space)" onClick={() => togglePlayback()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d={playing ? "M7 4h4v16H7zM13 4h4v16h-4z" : "M6 4l14 8-14 8V4z"} /></svg>
            </button>
            <button type="button" className="tbtn" title="Previous edit" onClick={() => seekTo([...clipBoundaries].reverse().find((time) => time < playT - 0.05) ?? 0)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M4 20V4M20 4L9 12l11 8V4z" /></svg>
            </button>
            <button type="button" className="tbtn" title="Next edit" onClick={() => seekTo(clipBoundaries.find((time) => time > playT + 0.05) ?? END)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M20 20V4M4 4l11 8L4 20V4z" /></svg>
            </button>
            <span className="mono transport-time">{fmt(playT)}<span> / {fmt(END)}</span></span>
            <button type="button" className="tbtn" title="Fullscreen playback" onClick={toggleFullscreen}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
              {fs ? "Exit fullscreen" : "Fullscreen"}
            </button>
            <div className="gap" />
            <div className="master-level" title="Master output level">
              <button
                type="button"
                className={`sound-btn${timeline.masterVolume === 0 ? " muted" : ""}`}
                aria-label={timeline.masterVolume === 0 ? "Unmute master" : "Mute master"}
                onClick={() => {
                  if (timeline.masterVolume > 0) lastMaster.current = timeline.masterVolume;
                  updateTimeline((doc) => ({ ...doc, masterVolume: doc.masterVolume > 0 ? 0 : lastMaster.current || 1 }));
                }}
              >
                <svg viewBox="0 0 24 24"><path d="M4 10v4h4l5 4V6L8 10H4zM17 9c1 1 1 5 0 6M20 6c3 3 3 9 0 12" /></svg>
              </button>
              <input
                aria-label="Master volume"
                type="range"
                min="0"
                max="100"
                value={Math.round(timeline.masterVolume * 100)}
                onChange={(event) => updateTimeline((doc) => ({ ...doc, masterVolume: Number(event.target.value) / 100 }))}
              />
              <span className="mono">{Math.round(timeline.masterVolume * 100)}%</span>
            </div>
            <button type="button" className="tbtn" onClick={regenSel} disabled={!cur}>Regenerate</button>
          </div>
        </main>

        <aside className="st-panel st-insp">
          <div className="insp-h">
            <div className="nm">{selectedClip?.name || cur?.title || "Nothing selected"}</div>
            <div className="mt">
              {selectedClip ? <><span>{selectedClip.kind}</span> · <span>{fmt(selectedClip.start)}–{fmt(selectedClip.start + selectedClip.duration)}</span><span className="badge gen">{selectedClip.origin}</span></> : <><span>Beat {cur?.n || "—"}</span><span className="badge gen">{cur?.isFinal ? "Final" : linkedMeta.label}</span></>}
            </div>
          </div>
          <div className="st-scroll" style={{ flex: 1 }}>
            {selectedClip ? (
              <>
                <div className={`igroup${closed.Clip ? " closed" : ""}`}>
                  <div className="igh" onClick={() => setClosed((value) => ({ ...value, Clip: !value.Clip }))}>
                    <svg className="ic cv" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg><span className="gt">Clip</span>
                  </div>
                  <div className="igbody">
                    <div className="row2">
                      <div className="field"><div className="fl">Start</div><input className="inp mono" type="number" min="0" step="0.1" disabled={clipIsLocked(selectedClip)} value={Number(selectedClip.start.toFixed(2))} onChange={(event) => updateTimeline((doc) => moveClip(doc, selectedClip.id, Number(event.target.value) || 0))} /></div>
                      <div className="field"><div className="fl">Duration</div><input className="inp mono" type="number" min="0.25" step="0.1" disabled={clipIsLocked(selectedClip)} value={Number(selectedClip.duration.toFixed(2))} onChange={(event) => updateTimeline((doc) => trimClip(doc, selectedClip.id, "out", selectedClip.start + (Number(event.target.value) || 0.25)))} /></div>
                    </div>
                    <div className="field">
                      <div className="fl">Track</div>
                      <select className="inp" value={selectedClip.trackId} disabled={clipIsLocked(selectedClip)} onChange={(event) => updateTimeline((doc) => moveClipToTrack(doc, selectedClip.id, event.target.value))}>
                        {tracks.filter((track) => track.kind === (selectedClip.kind === "audio" ? "audio" : "video")).map((track) => <option key={track.id} value={track.id} disabled={track.locked}>{track.name}{track.locked ? " · locked" : ""}</option>)}
                      </select>
                    </div>
                    <div className="field"><div className="fl">Source</div><input className="inp" readOnly value={selectedClip.origin === "storyboard" ? "Linked storyboard beat" : selectedClip.origin === "soundtrack" ? "Storyboard sound mix" : "Project media"} /></div>
                  </div>
                </div>
                {(selectedClip.kind === "audio" || selectedClip.kind === "video") && (
                  <div className={`igroup${closed.Sound ? " closed" : ""}`}>
                    <div className="igh" onClick={() => setClosed((value) => ({ ...value, Sound: !value.Sound }))}>
                      <svg className="ic cv" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg><span className="gt">Sound</span><span className="gm">{selectedClip.muted ? "muted" : `${Math.round(selectedClip.volume * 100)}%`}</span>
                    </div>
                    <div className="igbody">
                      <div className="field">
                        <div className="fl"><span>Clip level</span><span className="v">{Math.round(selectedClip.volume * 100)}%</span></div>
                        <input className="level-slider" type="range" min="0" max="100" disabled={clipIsLocked(selectedClip)} value={Math.round(selectedClip.volume * 100)} onChange={(event) => updateClip(selectedClip.id, { volume: Number(event.target.value) / 100 })} />
                      </div>
                      <button type="button" className={`clip-action${selectedClip.muted ? " active" : ""}`} onClick={() => updateClip(selectedClip.id, { muted: !selectedClip.muted })}>{selectedClip.muted ? "Unmute clip" : "Mute clip"}</button>
                    </div>
                  </div>
                )}
                <div className="inspector-actions">
                  <button type="button" className="clip-action" onClick={splitSelectedClip}>Split at playhead · S</button>
                  <button type="button" className="clip-action" onClick={duplicateSelectedClip}>Duplicate · D</button>
                  <button type="button" className="clip-action" onClick={rippleDeleteSelectedClip}>Ripple delete · ⇧⌫</button>
                  <button type="button" className="clip-action danger" onClick={removeSelectedClip}>Remove from timeline</button>
                  <span>⌥←/→ nudge · ⇧⌥←/→ one second</span>
                </div>
              </>
            ) : (
              <div className={`igroup${closed.Details ? " closed" : ""}`}>
                <div className="igh" onClick={() => setClosed((value) => ({ ...value, Details: !value.Details }))}>
                  <svg className="ic cv" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg><span className="gt">Beat Details</span>
                </div>
                <div className="igbody">
                  <div className="row2">
                    <div className="field"><div className="fl">Duration</div><input className="inp mono" readOnly value={cur ? `${(cur.b - cur.a).toFixed(1)}s` : "—"} /></div>
                    <div className="field"><div className="fl">Media</div><input className="inp" readOnly value={cur ? (cur.isFinal ? "final clip" : cur.mediaUrl ? "placeholder" : "none") : "—"} /></div>
                  </div>
                  <div className="field"><div className="fl">Prompt</div><textarea className="inp" rows={3} value={promptDraft ?? cur?.prompt ?? ""} placeholder="Describe this beat…" onChange={(event) => setPromptDraft(event.target.value)} onBlur={savePrompt} /></div>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>

      <section className="timeboard">
        <div className="tb-h">
          <div className="tt"><span className="dot" />Timeline</div>
          <span className="timeline-hint">Drop media · drag to move · pull edges to trim · S split</span>
          <div className="tb-tools">
            {!!timeline.suppressedSourceIds.length && <button type="button" className="ttool" onClick={restoreLinkedClips}>Restore linked media</button>}
            <button type="button" className="ttool" onClick={undoTimeline} disabled={!historyRef.current.past.length} title="Undo (⌘Z)">↶ Undo</button>
            <button type="button" className="ttool" onClick={redoTimeline} disabled={!historyRef.current.future.length} title="Redo (⇧⌘Z)">↷ Redo</button>
            <button type="button" className="ttool" onClick={() => createTrack("video")}>+ Video</button>
            <button type="button" className="ttool" onClick={() => createTrack("audio")}>+ Audio</button>
            <button type="button" className={`ttool${magnetic ? " on" : ""}`} onClick={() => setMagnetic((value) => !value)}>
              <svg className="ic" viewBox="0 0 24 24" style={{ width: 12, height: 12 }}><path d="M12 3v18M3 12h18" /></svg>Magnetic
            </button>
            <div className="qsep" />
            <label className="zoom" title="Timeline zoom">
              <span>{Math.round(zoom * 100)}%</span>
              <input type="range" min="50" max="400" step="25" value={Math.round(zoom * 100)} onChange={(event) => setZoom(Number(event.target.value) / 100)} />
            </label>
          </div>
        </div>
        <div className="tb-body">
          <div className="gutter" ref={gutterRef} onScroll={(event) => { if (lanesRef.current) lanesRef.current.scrollTop = event.currentTarget.scrollTop; }}>
            <div className="g-ruler">TRACKS</div>
            <div className="g-lane story"><span className="sw" style={{ background: "var(--grad)" }} /><span className="gn">Storyboard</span></div>
            {tracks.map((track, index) => (
              <div key={track.id} className={`g-lane media-lane track-head${dropLane === track.id ? " drop" : ""}${track.muted ? " muted" : ""}${track.locked ? " locked" : ""}`}>
                <span className="sw" style={{ background: track.kind === "audio" ? "var(--t-audio)" : "var(--t-video)" }} />
                <input className="track-name" value={track.name} aria-label={`Rename ${track.name}`} onChange={(event) => updateTimeline((doc) => patchTrack(doc, track.id, { name: event.target.value }))} />
                <span className="track-count">{clips.filter((clip) => clip.trackId === track.id).length}</span>
                <span className="track-controls">
                  <button type="button" disabled={index === 0} title="Move track up" onClick={() => updateTimeline((doc) => reorderTrack(doc, track.id, -1))}>↑</button>
                  <button type="button" disabled={index === tracks.length - 1} title="Move track down" onClick={() => updateTimeline((doc) => reorderTrack(doc, track.id, 1))}>↓</button>
                  <button type="button" className={track.muted ? "on" : ""} title={track.muted ? "Unmute track" : "Mute track"} onClick={() => updateTimeline((doc) => patchTrack(doc, track.id, { muted: !track.muted }))}>M</button>
                  <button type="button" className={track.locked ? "on" : ""} title={track.locked ? "Unlock track" : "Lock track"} onClick={() => updateTimeline((doc) => patchTrack(doc, track.id, { locked: !track.locked }))}>L</button>
                  {tracks.filter((item) => item.kind === track.kind).length > 1 && <button type="button" title="Remove track and move its clips" onClick={() => updateTimeline((doc) => removeTrack(doc, track.id))}>×</button>}
                </span>
              </div>
            ))}
          </div>
          <div className="lanes" ref={lanesRef} onScroll={(event) => { if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop; }}>
            <div className="lanes-inner" style={{ width: timelineWidth }}>
              <div className="ruler" onPointerDown={scrubStart}>
                {ticks.map((seconds) => <div key={seconds} className="tick" style={{ left: `${(seconds / TL) * 100}%` }}><span>{fmtTime(seconds)}</span></div>)}
              </div>
              <div className="lane story">
                <div className="story-track">
                  {shots.map((shot, index) => (
                    <div key={shot.id} className={`scard${index === sel ? " sel" : ""}`} style={{ left: px(shot.a) + 3, width: Math.max(px(shot.b - shot.a) - 6, 20) }} onClick={() => selectShot(index)}>
                      <div className="sth" style={shot.fillStyle}><div className="grain" /><span className="sn mono">{shot.n}</span></div>
                      <div className="sinfo"><div className="stl">{shot.title}</div><div className="srow"><span className="sdur mono">{(shot.b - shot.a).toFixed(0)}s</span><span className={`sstat ${shot.isFinal ? "st-ready" : statusMeta(shot.status).cls}`}>{shot.isFinal ? "Final" : statusMeta(shot.status).label}</span></div></div>
                    </div>
                  ))}
                  {!shots.length && <div className="story-empty">No storyboard beats yet. You can still build an edit from project media.</div>}
                </div>
              </div>
              {tracks.map((track) => (
                <div
                  key={track.id}
                  className={`lane media-lane drop-lane${dropLane === track.id ? " drop" : ""}${track.muted ? " track-muted" : ""}${track.locked ? " track-locked" : ""}`}
                  onDragEnter={(event) => { event.preventDefault(); setDropLane(track.id); }}
                  onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = track.locked ? "none" : "copy"; setDropLane(track.id); }}
                  onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropLane(null); }}
                  onDrop={(event) => onLaneDrop(event, track)}
                >
                  {clips.filter((clip) => clip.trackId === track.id).map((clip, index) => {
                    const running = clip.origin === "storyboard" && isShotRunning({ status: shots.find((shot) => `beat:${shot.id}` === clip.sourceId)?.status || "ready" } as Shot);
                    return (
                      <div
                        key={clip.id}
                        className={`clip drg ${clip.kind}${clip.id === selectedClipId ? " selected" : ""}${clip.muted || track.muted ? " muted" : ""}${track.locked ? " locked" : ""}`}
                        style={{ left: px(clip.start) + 2, width: Math.max(px(clip.duration) - 4, 18), zIndex: index + 1, borderColor: running ? "var(--gen)" : clip.kind === "audio" ? "var(--t-audio)" : "var(--t-video)" }}
                        title={`${clip.name} · ${clip.duration.toFixed(1)}s`}
                        onPointerDown={(event) => {
                          const resize = (event.target as HTMLElement).closest(".rz") as HTMLElement | null;
                          startClipDrag(event, clip, resize?.dataset.side === "left" ? "left" : resize?.dataset.side === "right" ? "right" : "move");
                        }}
                        onDoubleClick={() => selectTimelineClip(clip)}
                      >
                        <span className="rz l" data-side="left" title="Trim start" />
                        <span className="body"><span className="clip-type">{clip.kind === "audio" ? "♪" : clip.kind === "video" ? "▶" : "▧"}</span>{clip.name}</span>
                        {clip.kind === "audio" && <AudioWaveform url={clip.url} muted={clip.muted || track.muted} />}
                        {(clip.kind === "audio" || clip.kind === "video") && <span className="clip-gain" style={{ width: `${clip.muted ? 0 : clip.volume * 100}%` }} />}
                        <span className="rz r" data-side="right" title="Trim end" />
                      </div>
                    );
                  })}
                  {!clips.some((clip) => clip.trackId === track.id) && <div className="lane-empty">{track.locked ? "Track locked" : `Drop ${track.kind === "audio" ? "sounds or music" : "scenes, images, or clips"} here`}</div>}
                </div>
              ))}
              {snapT !== null && <div className="snapline" style={{ display: "block", left: px(snapT) }} />}
              <div className="playhead" style={{ left: px(playT) }}><div className="ph-hit" onPointerDown={scrubStart} /><div className="ph-h" /><div className="ph-t mono">{fmt(playT)}</div></div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
