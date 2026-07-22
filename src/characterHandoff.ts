export type CharacterHandoff = {
  id: string;
  name: string;
  vrmUrl: string;
  portraitUrl?: string;
  persona?: string;
  voice?: string;
  ephemeral?: boolean;
};

type CharacterTarget = "head" | "animate";

const HANDOFF_KEYS: Record<CharacterTarget, string> = {
  head: "pioneer_studio_pending_head",
  // Keep the old key so an in-flight Create → Animation handoff survives this
  // upgrade. The value migrates from {url,name} to the full character record.
  animate: "pioneer_studio_pending_skin",
};
const HEAD_CHARACTER_KEY = "pioneer_studio_head_character";

function parseCharacter(raw: string | null): CharacterHandoff | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<CharacterHandoff> & { url?: string };
    const vrmUrl = value.vrmUrl || value.url;
    if (!vrmUrl || typeof vrmUrl !== "string") return null;
    return {
      id: typeof value.id === "string" ? value.id : `legacy:${vrmUrl}`,
      name: typeof value.name === "string" && value.name ? value.name : "Character",
      vrmUrl,
      portraitUrl: typeof value.portraitUrl === "string" ? value.portraitUrl : undefined,
      persona: typeof value.persona === "string" ? value.persona : undefined,
      voice: typeof value.voice === "string" ? value.voice : undefined,
      ephemeral: value.ephemeral === true || undefined,
    };
  } catch {
    return null;
  }
}

export function sendCharacter(target: CharacterTarget, character: CharacterHandoff): void {
  localStorage.setItem(HANDOFF_KEYS[target], JSON.stringify(character));
}

export function consumeCharacter(target: CharacterTarget): CharacterHandoff | null {
  const key = HANDOFF_KEYS[target];
  const character = parseCharacter(localStorage.getItem(key));
  if (character) localStorage.removeItem(key);
  return character;
}

export function rememberHeadCharacter(character: CharacterHandoff): void {
  localStorage.setItem(HEAD_CHARACTER_KEY, JSON.stringify(character));
}

export function loadHeadCharacter(): CharacterHandoff | null {
  return parseCharacter(localStorage.getItem(HEAD_CHARACTER_KEY));
}

export function forgetHeadCharacter(): void {
  localStorage.removeItem(HEAD_CHARACTER_KEY);
}
