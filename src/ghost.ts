// Ghost cursor engine — the copilot's visible hand. Ported from the design
// handoff's studio.js: gold pointer travels to a control, applies the gold
// focus glow (distinct from the user's green ring), click-pulses, releases.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let focused: HTMLElement | null = null;

function ensureGhost(): HTMLElement {
  let g = document.getElementById("ghost");
  if (!g) {
    g = document.createElement("div");
    g.id = "ghost";
    g.innerHTML =
      '<svg class="pointer" width="18" height="18" viewBox="0 0 24 24"><path d="M4 2l16 8-7 2-3 7L4 2z" fill="#fbbf24" stroke="#1a1205" stroke-width="1.2"/></svg>' +
      '<span class="tag">Copilot</span>';
    document.body.appendChild(g);
  }
  return g;
}

function moveGhostTo(el: HTMLElement) {
  const ghost = ensureGhost();
  const r = el.getBoundingClientRect();
  ghost.style.left = `${r.left + r.width * 0.55}px`;
  ghost.style.top = `${r.top + r.height * 0.6}px`;
}

export async function aiPress(
  el: HTMLElement,
  { click = true, dwell = 420, scroller = null as HTMLElement | null } = {},
): Promise<void> {
  // keep target visible inside the given scroll area (manual math — never scrollIntoView)
  const main = scroller;
  if (main && main.contains(el)) {
    const r = el.getBoundingClientRect();
    const m = main.getBoundingClientRect();
    if (r.top < m.top + 20 || r.bottom > m.bottom - 20) {
      main.scrollTop += r.top - m.top - m.height / 2 + r.height / 2;
      await sleep(150);
    }
  }
  const ghost = ensureGhost();
  ghost.style.opacity = "1";
  moveGhostTo(el);
  await sleep(580);
  if (focused) focused.classList.remove("ai-focus");
  el.classList.add("ai-focus");
  focused = el;
  if (click) {
    ghost.classList.add("clicking");
    await sleep(260);
    ghost.classList.remove("clicking");
  }
  await sleep(dwell);
}

export function aiRelease() {
  if (focused) {
    focused.classList.remove("ai-focus");
    focused = null;
  }
  ensureGhost().style.opacity = "0";
}

// Types text char-by-char (~14ms/char, 24ms on spaces) through a callback so
// React state stays the source of truth for the textarea value.
export async function aiType(el: HTMLElement, text: string, onText: (partial: string) => void): Promise<void> {
  await aiPress(el, { click: true, dwell: 100 });
  onText("");
  for (let i = 0; i < text.length; i++) {
    onText(text.slice(0, i + 1));
    if (el instanceof HTMLTextAreaElement) el.scrollTop = el.scrollHeight;
    await sleep(text[i] === " " ? 24 : 14);
  }
  await sleep(300);
}

export { sleep };
