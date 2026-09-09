export type PendingStageProp = { name: string; url: string };

const KEY = "pioneer_studio_pending_stage_prop";

export function sendPropToStage(prop: PendingStageProp): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prop));
  } catch {
    /* the URL remains available in Media for a later retry */
  }
}

export function consumeStageProp(): PendingStageProp | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    localStorage.removeItem(KEY);
    const value = JSON.parse(raw);
    return value?.name && value?.url ? value as PendingStageProp : null;
  } catch {
    localStorage.removeItem(KEY);
    return null;
  }
}
