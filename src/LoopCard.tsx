// LoopCard — a run you can watch: the contract on top, every attempt scored
// underneath, and a stop button that always works.
//
// The contract is approved before anything is spent, and the credit ceiling is
// set here by the user, never proposed by the model.
import { useRef, useState } from "react";
import { submitJob } from "./api";
import { scoreAgainstContract } from "./copilot";
import { pickModel } from "./pipeline";
import { kindOf, type PS } from "./shared";
import { decide, saveRun, scoreOf, traceLine, type Attempt, type Contract, type RunLog } from "./workLoop";

export default function LoopCard({
  ps,
  contract: initial,
  job,
}: {
  ps: PS;
  contract: Contract;
  job: { model: string; endpoint: string; params: Record<string, unknown> } | null;
}) {
  const [contract, setContract] = useState(initial);
  const [ceiling, setCeiling] = useState("500");
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState("");
  const [stopped, setStopped] = useState("");
  const abort = useRef(false);
  const psRef = useRef(ps);
  psRef.current = ps;

  // what the next attempt would cost, for the ceiling check. Unknown price is
  // assumed expensive rather than free — the ceiling is a safety rail.
  const costOf = (model: string, endpoint: string) => {
    const m = ps.models.find((x) => x.model === model && x.endpoint === endpoint);
    return typeof m?.credits === "number" ? m.credits : 100;
  };

  async function runOnce(
    model: string,
    endpoint: string,
    params: Record<string, unknown>,
  ): Promise<{ url: string; kind: string; credits: number }> {
    const p = psRef.current;
    const res = await submitJob(p.apiKey, model, endpoint, params);
    p.charge(res.credits_remaining);
    const { url, contentType } = await p.waitForJob(res.job_id, (s) =>
      setNote(`${s.status}${s.stage ? ` · ${s.stage}` : ""} · job ${s.job_id}`),
    );
    p.refreshMedia();
    return { url, kind: kindOf(contentType, url), credits: res.credits_charged ?? 0 };
  }

  async function start() {
    const p = psRef.current;
    if (!job) return p.toast("No job on this contract to run");
    if (!p.apiKey) return p.toast("Add your key in Settings to run a loop");
    const cap = Number(ceiling);
    if (!Number.isFinite(cap) || cap <= 0) return p.toast("Set a credit ceiling first");
    const live: RunLog = {
      id: `run-${Date.now()}`,
      contract: { ...contract, creditCeiling: cap },
      attempts: [],
      done: false,
      stopped: "",
    };
    abort.current = false;
    setRunning(true);
    setStopped("");
    setAttempts([]);
    try {
      let next: { model: string; endpoint: string; params: Record<string, unknown> } = { ...job };
      for (;;) {
        if (abort.current) {
          live.stopped = "stopped by you";
          break;
        }
        setNote(`attempt ${live.attempts.length + 1} — rendering`);
        const out = await runOnce(next.model, next.endpoint, next.params);
        setNote(`attempt ${live.attempts.length + 1} — grading`);
        // an evaluator that cannot see the artifact cannot grade it
        const graded =
          out.kind === "image"
            ? await scoreAgainstContract(p.apiKey, live.contract, out.url)
            : { perAxis: {}, notes: "not an image — the evaluator only reads stills", fix: "" };
        const attempt: Attempt = {
          n: live.attempts.length + 1,
          url: out.url,
          perAxis: graded.perAxis,
          score: scoreOf(graded.perAxis, live.contract.axes),
          notes: graded.notes,
          fix: graded.fix,
          creditsSpent: out.credits,
          at: Date.now(),
        };
        live.attempts = [...live.attempts, attempt];
        setAttempts(live.attempts);
        saveRun(live);

        const d = decide(live, costOf(next.model, next.endpoint));
        if (d.action === "stop") {
          live.stopped = d.why;
          live.done = attempt.score >= live.contract.target;
          break;
        }
        if (d.action === "restart") {
          // back to the contract, not to the last render — patching a run that
          // is not converging is how it turns into archaeology
          next = { ...job, params: { ...job.params, prompt: `${live.contract.goal}. ${live.contract.assertions.join(". ")}` } };
          setNote(d.why);
          continue;
        }
        const editModel = pickModel(ps.models, "image_edit");
        if (!editModel) {
          live.stopped = "no edit model to apply the fix with";
          break;
        }
        next = {
          model: editModel.model,
          endpoint: editModel.endpoint,
          params: { prompt: d.instruction, image: attempt.url },
        };
        setNote(`applying: ${d.instruction.slice(0, 80)}`);
      }
    } catch (e: any) {
      live.stopped = `failed: ${String(e.message || e)}`;
    } finally {
      saveRun(live);
      setStopped(live.stopped);
      setRunning(false);
      setNote("");
      psRef.current.setAiState("idle", false);
    }
  }

  const spent = attempts.reduce((s, a) => s + a.creditsSpent, 0);
  const best = attempts.reduce((b, a) => (a.score > (b?.score ?? -1) ? a : b), null as Attempt | null);

  return (
    <div className="flow-card loop-card">
      <div className="fc-head">
        <b>Work loop</b>
        <span className="fc-model">
          target {contract.target} · max {contract.maxAttempts} attempts
        </span>
      </div>
      <p className="fc-blurb">{contract.goal}</p>

      <div className="loop-contract">
        <span className="fc-label">Contract — what done looks like</span>
        <ol>
          {contract.assertions.map((a, i) => (
            <li key={a}>
              <label>
                <input
                  type="checkbox"
                  checked
                  onChange={() => setContract((c) => ({ ...c, assertions: c.assertions.filter((_, j) => j !== i) }))}
                />
                {a}
              </label>
            </li>
          ))}
        </ol>
        <span className="sp-info hint">Untick anything you do not actually want graded.</span>
      </div>

      <label className="fc-choice">
        <span className="fc-label">Credit ceiling</span>
        <input type="number" min={0} step={50} value={ceiling} disabled={running} onChange={(e) => setCeiling(e.target.value)} />
      </label>

      <div className="fc-foot">
        <span className="fc-need">{spent ? `${spent} cr spent` : "nothing spent yet"}</span>
        {running ? (
          <button type="button" className="fc-run" onClick={() => (abort.current = true)}>
            Stop
          </button>
        ) : (
          <button type="button" className="fc-run" disabled={!job || !contract.assertions.length} onClick={start}>
            {attempts.length ? "Run again" : "Approve & run"}
          </button>
        )}
      </div>

      {note && <div className="fc-note">{note}</div>}
      {stopped && <div className={`fc-note${stopped.startsWith("failed") ? " warn" : ""}`}>{stopped}</div>}

      {attempts.map((a) => (
        <div key={a.n} className="loop-attempt">
          <div className="fc-note">{traceLine(a)}</div>
          <img src={a.url} alt={`attempt ${a.n}`} />
        </div>
      ))}
      {best && !running && (
        <div className="fc-need">
          Best: attempt #{best.n} at {best.score.toFixed(2)}
        </div>
      )}
    </div>
  );
}
