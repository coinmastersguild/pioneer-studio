import type { Mode } from "./shared";

export const WORKSPACE_GROUPS: { label: string; modes: { mode: Mode; label: string }[] }[] = [
  { label: "Plan", modes: [{ mode: "board", label: "Storyboard" }, { mode: "script", label: "Script" }] },
  { label: "Create", modes: [{ mode: "create", label: "Characters & assets" }, { mode: "head", label: "Talking heads" }, { mode: "animate", label: "3D scenes & animation" }] },
  { label: "Library", modes: [{ mode: "media", label: "Media" }, { mode: "models", label: "Models & endpoints" }, { mode: "projects", label: "Projects" }, { mode: "companies", label: "Team" }] },
];
