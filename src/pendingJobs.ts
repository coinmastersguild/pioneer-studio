// In-flight jobs that survive a reload. When ChatView submits a job and the
// browser dies before `waitForJob` resolves, the job is still running
// server-side and its result still lands in Media — only the client's poll
// was lost. Persist the job at submit time, resume polling on mount, clear
// once it has settled.
import { type PS } from "./shared";

const KEY = "pioneer_studio_pending_jobs";

export type PendingJob = {
  id: string; // server job id
  intent: string; // what the user asked for
  model: string;
  endpoint: string;
  at: number;
};

function loadAll(): PendingJob[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeAll(jobs: PendingJob[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(jobs.slice(-10)));
  } catch {
    /* a job that cannot be persisted still runs — it just is not resumable */
  }
}

/** Record a freshly submitted job so a reload mid-render can resume it. */
export function savePendingJob(job: PendingJob): void {
  const all = loadAll().filter((j) => j.id !== job.id);
  writeAll([...all, job]);
}

/** Drop a settled job (done or failed) from the resume list. */
export function clearPendingJob(jobId: string): void {
  writeAll(loadAll().filter((j) => j.id !== jobId));
}

/** Every job submitted but not yet settled — the ones a reload must resume. */
export function loadPendingJobs(): PendingJob[] {
  return loadAll();
}

/** Resume polling for jobs left in flight after a reload or crash. Each one
 *  is re-polled through the shared waitForJob backoff loop; callers get the
 *  final URL (done) or the server's error (failed) and can surface it. */
export async function resumePendingJob(
  ps: PS,
  job: PendingJob,
): Promise<{ ok: boolean; url?: string; contentType?: string; error?: string }> {
  const key = ps.apiKey;
  if (!key) return { ok: false, error: "no api key" };
  // Poll until the server reports done/failed, reusing the shared backoff.
  const { url, contentType } = await ps.waitForJob(job.id);
  clearPendingJob(job.id);
  return { ok: true, url, contentType };
}
