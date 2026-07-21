// Shared bits between the shell and the four views.
import type { JobModel, MediaList, Storyboard } from "./api";

export type Mode = "chat" | "board" | "create" | "animate" | "head" | "studio" | "media" | "models" | "projects" | "companies" | "settings";

export type Suggestion = { label: string; run: () => void };

// The contract App hands every view — mirrors the prototype's window.PS.
export type PS = {
  apiKey: string;
  models: JobModel[];
  media: MediaList | null;
  refreshMedia(): void;
  board: Storyboard | null;
  setBoard(sb: Storyboard): void;
  refreshBoard(): void;
  mode: Mode;
  setMode(m: Mode): void;
  charge(remaining: number | null): void;
  refreshCredits(): void;
  toast(msg: string, kind?: "ok" | "gold"): void;
  // copilot rail
  addMsg(who: "You" | "Copilot", text: string): void;
  streamMsg(text: string): Promise<void>;
  setAiState(state: string, working: boolean): void;
  registerSuggestions(mode: Mode, arr: Suggestion[]): void;
  setInputHandler(mode: Mode, fn: (text: string) => void): void;
  isBusy(): boolean;
  setBusy(b: boolean): void;
  // shared job helper: poll a job until done, persist result to R2, return its URL
  waitForJob(jobId: string): Promise<{ url: string; contentType: string }>;
};

export const GB = 1024 ** 3;
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function fmtBytes(n: number): string {
  if (n >= GB) return (n / GB).toFixed(2) + " GB";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MB";
  return Math.max(1, Math.round(n / 1024)) + " KB";
}

export function relTime(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return "just now";
  if (s < 5400) return Math.round(s / 60) + "m ago";
  if (s < 129600) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

export function kindOf(contentType: string, url = ""): "image" | "audio" | "video" | "model" {
  const s = contentType + " " + url;
  if (/model\/vrm|\.vrm(?:$|[?#])/i.test(s)) return "model";
  if (/audio|\.mp3|\.wav|\.m4a/i.test(s)) return "audio";
  if (/video|\.mp4|\.webm/i.test(s)) return "video";
  return "image";
}

export function fmtTime(s: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return p(Math.floor(s / 60)) + ":" + p(Math.floor(s % 60));
}

/* forest-palette placeholder gradients (prototype ph-a…ph-g) */
export const PH = [
  "linear-gradient(135deg,#123024,#0a1f2e 60%,#1c1408)",
  "linear-gradient(160deg,#0e2418,#232012 70%,#0a1a0a)",
  "linear-gradient(120deg,#0a1a2a,#122a1a 55%,#241a08)",
  "linear-gradient(150deg,#1a1208,#0f2a1c 65%,#08131f)",
  "linear-gradient(140deg,#0d2035,#0f2a0f 60%,#2a1f0c)",
  "radial-gradient(70% 60% at 45% 55%,#1c3a2a,#0a1508 72%)",
];

/* ── icons (Lucide strokes, per the design system) ── */
export const IcChat = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
);
export const IcBoard = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M3 9h18M9 4v14" /></svg>
);
export const IcStudio = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16v4H4zM4 12h10v8H4zM17 12h3v8h-3z" /></svg>
);
export const IcCreate = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5" /><circle cx="15" cy="9" r="1" /></svg>
);
export const IcAnimate = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M4 11h16v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" /><path d="M4 11l16-4-1-3.8L3 7.2zM8 10.2l2.5-4.4M13.5 8.8l2.5-4.4" /></svg>
);
export const IcHead = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M19 10a7 7 0 1 0-11.5 5.4V21h8v-3h2a1 1 0 0 0 1-1v-3z" /><path d="M9 10h.01M14 10h.01M10 14.5a3 3 0 0 0 4 0" /></svg>
);
export const IcImage = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15l-5-5L5 21" /><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /></svg>
);
export const IcJobs = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="9" /></svg>
);
export const IcModels = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></svg>
);
export const IcSpark = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l2.2 5.5L20 10l-5.8 1.5L12 17l-2.2-5.5L4 10l5.8-1.5z" /></svg>
);
export const IcMusic = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
);
export const IcPlay = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><polygon points="6 3 20 12 6 21 6 3" /></svg>;
export const IcCopy = () => (
  <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
);
export const IcSend = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>
);
export const IcUsers = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
);
export const IcFolder = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.5l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z" /></svg>
);
export const IcSettings = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
);
