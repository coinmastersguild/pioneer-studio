// The work loop: gather, reason, act, verify, repeat.
//
// A render is a subjective artifact, so the loop only works if taste is written
// down before any credits are spent. The contract is that writing-down: a set of
// testable assertions plus weighted axes, agreed with the user up front, and the
// only thing the evaluator is allowed to grade against.
//
// State lives in localStorage rather than in the chat transcript, because a
// transcript compacts and a run has to survive a reload to be worth trusting.
export type Axis = { name: string; weight: number };
export type Contract = {
  goal: string;
  /** concrete, checkable claims about the finished artifact */
  assertions: string[];
  axes: Axis[];
  /** weighted score at or above which the loop stops */
  target: number;
  maxAttempts: number;
  /** hard ceiling in credits, so a loop can never quietly drain an account */
  creditCeiling: number;
};
export type Attempt = {
  n: number;
  url: string;
  score: number;
  perAxis: Record<string, number>;
  notes: string;
  fix: string;
  creditsSpent: number;
  at: number;
};
export type RunLog = { id: string; contract: Contract; attempts: Attempt[]; done: boolean; stopped: string };

export const DEFAULT_AXES: Axis[] = [
  { name: "subject", weight: 0.4 },
  { name: "composition", weight: 0.2 },
  { name: "look", weight: 0.25 },
  { name: "craft", weight: 0.15 },
];

/** Weighted sum, normalised by the weights actually present — a rubric that
 *  loses an axis should not silently score everything lower. */
export function scoreOf(perAxis: Record<string, number>, axes: Axis[]): number {
  let sum = 0;
  let weight = 0;
  for (const a of axes) {
    const v = perAxis[a.name];
    if (typeof v !== "number" || Number.isNaN(v)) continue;
    sum += Math.max(0, Math.min(1, v)) * a.weight;
    weight += a.weight;
  }
  return weight ? Number((sum / weight).toFixed(3)) : 0;
}

export type Decision =
  | { action: "stop"; why: string }
  | { action: "fix"; instruction: string }
  | { action: "restart"; why: string };

/** What the loop does next. Three ways out, and every one of them is a stop
 *  condition someone can read afterwards — a loop with no visible exit is how
 *  an account gets drained overnight. */
export function decide(run: RunLog, nextJobCost: number): Decision {
  const { contract: c, attempts } = run;
  const last = attempts[attempts.length - 1];
  if (!last) return { action: "stop", why: "nothing rendered yet" };
  if (last.score >= c.target) return { action: "stop", why: `hit the bar — ${last.score} ≥ ${c.target}` };
  if (attempts.length >= c.maxAttempts) return { action: "stop", why: `out of attempts (${c.maxAttempts})` };
  const spent = attempts.reduce((s, a) => s + a.creditsSpent, 0);
  if (spent + nextJobCost > c.creditCeiling)
    return { action: "stop", why: `would pass the ${c.creditCeiling} cr ceiling (spent ${spent})` };

  // Patching a thing that is not converging is how a run turns into archaeology.
  // Two attempts that did not move the number mean the approach is wrong, not
  // the details — throw it away and generate again from the contract.
  const prev = attempts[attempts.length - 2];
  if (prev && last.score - prev.score < 0.05)
    return { action: "restart", why: `two passes moved it ${(last.score - prev.score).toFixed(3)} — starting over` };

  if (!last.fix) return { action: "stop", why: "the evaluator had no repair to suggest" };
  return { action: "fix", instruction: last.fix };
}

/** The one line a human reads to know what happened, per attempt. */
export const traceLine = (a: Attempt): string =>
  `#${a.n} score ${a.score.toFixed(2)} · ${Object.entries(a.perAxis)
    .map(([k, v]) => `${k} ${Number(v).toFixed(2)}`)
    .join(" ")} · ${a.creditsSpent} cr — ${a.notes}`;

const KEY = "pioneer_studio_runs";

export function saveRun(run: RunLog): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || "[]");
    const list = Array.isArray(all) ? all.filter((r) => r?.id !== run.id) : [];
    localStorage.setItem(KEY, JSON.stringify([...list, run].slice(-10)));
  } catch {
    /* a run that cannot be persisted still runs — it just is not resumable */
  }
}

export function loadRuns(): RunLog[] {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(all) ? all : [];
  } catch {
    return [];
  }
}
