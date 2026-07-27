// Prompt-pack export — serialize the whole board (beats, cast, tracers, sound
// plan) to portable markdown + JSON so the storyboard is useful in any tool
// before finals render.
// Pure string/object building — no DOM except the download helper.
import type { Shot, Storyboard } from "./api";
import { buildFinalPrompt, extOf, motionSummary, refIntentOf, type Pipeline } from "./pipeline";
import { fmtTime } from "./shared";

const tc = (shots: Shot[], i: number) => {
  let t = 0;
  for (let k = 0; k < i; k++) t += shots[k].sourceDuration ?? 10;
  return `${fmtTime(t)}–${fmtTime(t + (shots[i].sourceDuration ?? 10))}`;
};

export function shotBible(sb: Storyboard, pipe: Pipeline) {
  return {
    app: "pioneer-studio",
    title: sb.title,
    createdAt: new Date().toISOString(),
    runtimeSeconds: sb.shots.reduce((s, b) => s + (b.sourceDuration ?? 10), 0),
    characters: pipe.characters.map((c) => ({ name: c.name, description: c.description, prompt: c.prompt, hasImage: !!c.image })),
    music: pipe.musicPrompt || null,
    beats: sb.shots.map((s, i) => {
      const ext = extOf(pipe, s.id);
      return {
        index: i + 1,
        timecode: tc(sb.shots, i),
        text: s.prompt,
        cast: ext.characterIds.map((id) => pipe.characters.find((c) => c.id === id)?.name).filter(Boolean),
        refIntent: refIntentOf(ext).id,
        motion: motionSummary(ext.tracers, (id) => pipe.characters.find((c) => c.id === id)?.name || (id ? "subject" : "camera")) || null,
        cameraMove: ext.cameraMove || null,
        finalPrompt: ext.finalPrompt || buildFinalPrompt(s.prompt, ext, pipe.characters),
        speech: ext.tracers.filter((t) => t.kind === "speech" && t.text).map((t) => ({ at: t.path[0]?.t ?? 0, line: t.text })),
      };
    }),
  };
}

export function promptPackMarkdown(sb: Storyboard, pipe: Pipeline): string {
  const bible = shotBible(sb, pipe);
  const L: string[] = [
    `# ${bible.title} — prompt pack`,
    "",
    `Runtime ${fmtTime(bible.runtimeSeconds)} · ${bible.beats.length} beats × ~10s · exported from Pioneer Studio`,
    "",
  ];
  if (bible.characters.length) {
    L.push("## Cast", "");
    for (const c of bible.characters) L.push(`- **${c.name}** — ${c.description}${c.prompt ? ` _(style: ${c.prompt})_` : ""}`);
    L.push("");
  }
  if (bible.music) L.push("## Music", "", bible.music, "");
  L.push("## Beats", "");
  for (const b of bible.beats) {
    L.push(`### Beat ${String(b.index).padStart(2, "0")} · ${b.timecode}`, "");
    L.push(b.text || "_(no description yet)_", "");
    if (b.cast.length) L.push(`- Cast: ${b.cast.join(", ")}`);
    L.push(`- Reference intent: ${b.refIntent}`);
    if (b.motion) L.push(`- Motion: ${b.motion}`);
    if (b.cameraMove) L.push(`- Camera: ${b.cameraMove}`);
    for (const s of b.speech) L.push(`- 🔊 "${s.line}" @ ${Number(s.at).toFixed(1)}s`);
    L.push("", "**Video prompt:**", "", "```", b.finalPrompt, "```", "");
  }
  return L.join("\n");
}

export function downloadText(name: string, text: string, type = "text/plain"): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
