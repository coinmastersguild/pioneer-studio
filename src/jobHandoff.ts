import type { JobCapability } from "./jobCatalog";

export type PendingJobForm = {
  capability: JobCapability;
  mediaKey?: string;
};

const KEY = "pioneer_studio_pending_job_form";

export function openJobForm(request: PendingJobForm): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(request));
  } catch {
    /* the Models page can still be opened and configured by hand */
  }
}

export function consumeJobForm(): PendingJobForm | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    localStorage.removeItem(KEY);
    const value = JSON.parse(raw);
    return value?.capability ? (value as PendingJobForm) : null;
  } catch {
    localStorage.removeItem(KEY);
    return null;
  }
}
