import { useEffect, useMemo, useState } from "react";
import type { JobModel, JobParamSchema, MediaObject } from "./api";
import { runGenerationJob } from "./generationJob";
import { compatibleMedia } from "./jobCatalog";
import type { PS } from "./shared";

type Values = Record<string, unknown>;

function initialValues(entry: JobModel, mediaKey?: string, media?: MediaObject[]): Values {
  const values: Values = {};
  for (const [name, schema] of Object.entries(entry.params || {})) {
    if (schema.default !== undefined) values[name] = schema.default;
  }
  if (mediaKey) {
    const source = media?.find((item) => item.key === mediaKey);
    if (source) {
      const compatible = Object.entries(entry.params || {}).filter(([name, schema]) =>
        (schema.type === "path-or-url" || schema.type === "list-of-path-or-url") && compatibleMedia(name, source),
      );
      if (compatible.length === 1) {
        const [name, schema] = compatible[0];
        values[name] = schema.type === "list-of-path-or-url" ? [source.key] : source.key;
      }
    }
  }
  return values;
}

function initialTouched(entry: JobModel, mediaKey?: string, media?: MediaObject[]): Set<string> {
  const touched = new Set<string>();
  const source = mediaKey ? media?.find((item) => item.key === mediaKey) : undefined;
  if (!source) return touched;
  const compatible = Object.entries(entry.params || {}).filter(([name, schema]) =>
    (schema.type === "path-or-url" || schema.type === "list-of-path-or-url") && compatibleMedia(name, source),
  );
  if (compatible.length === 1) touched.add(compatible[0][0]);
  return touched;
}

function Field({
  name,
  schema,
  value,
  media,
  error,
  onChange,
}: {
  name: string;
  schema: JobParamSchema;
  value: unknown;
  media: MediaObject[];
  error?: string;
  onChange(value: unknown): void;
}) {
  const id = `job-param-${name}`;
  const required = schema.required && schema.default === undefined;
  const label = <label htmlFor={id}>{name}{required ? " *" : ""}</label>;
  if (schema.type === "bool") {
    return <div className="job-field job-check">{label}<input id={id} type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />{error && <small className="job-error">{error}</small>}</div>;
  }
  if (schema.type === "path-or-url") {
    const options = media.filter((item) => compatibleMedia(name, item));
    return <div className="job-field">{label}<select id={id} value={String(value || "")} onChange={(event) => onChange(event.target.value || undefined)}><option value="">Choose Media…</option>{options.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}</select>{error && <small className="job-error">{error}</small>}</div>;
  }
  if (schema.type === "list-of-path-or-url") {
    const selected = Array.isArray(value) ? value.map(String) : [];
    const options = media.filter((item) => compatibleMedia(name, item));
    return <div className="job-field">{label}<select id={id} multiple value={selected} onChange={(event) => onChange(Array.from(event.target.selectedOptions, (option) => option.value).slice(0, schema.max))}>{options.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}</select><small>Selections keep Media order{schema.max === undefined ? "." : ` · maximum ${schema.max}.`}</small>{error && <small className="job-error">{error}</small>}</div>;
  }
  if (schema.enum) {
    return <div className="job-field">{label}<select id={id} value={String(value ?? "")} onChange={(event) => {
      const selected = schema.enum?.find((option) => String(option) === event.target.value);
      onChange(selected);
    }}><option value="">Server default</option>{schema.enum.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}</select>{error && <small className="job-error">{error}</small>}</div>;
  }
  if (schema.type === "int" || schema.type === "float") {
    return <div className="job-field">{label}<input id={id} type="number" step={schema.type === "int" ? 1 : "any"} min={schema.min} max={schema.max} value={value === undefined ? "" : String(value)} placeholder={schema.default === undefined ? "Server default" : String(schema.default)} onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))} />{error && <small className="job-error">{error}</small>}</div>;
  }
  if (schema.type === "list") {
    return <div className="job-field">{label}<textarea id={id} value={Array.isArray(value) ? value.join("\n") : ""} placeholder="One value per line" onChange={(event) => onChange(event.target.value.split("\n").map((item) => item.trim()).filter(Boolean))} />{error && <small className="job-error">{error}</small>}</div>;
  }
  return <div className="job-field">{label}<textarea id={id} value={String(value ?? "")} placeholder={schema.default === undefined ? "" : String(schema.default)} onChange={(event) => onChange(event.target.value || undefined)} />{error && <small className="job-error">{error}</small>}</div>;
}

export default function JobForm({ entry, ps, mediaKey, onClose }: { entry: JobModel; ps: PS; mediaKey?: string; onClose(): void }) {
  const media = useMemo(() => ps.media?.objects || [], [ps.media]);
  const [values, setValues] = useState<Values>(() => initialValues(entry, mediaKey, media));
  const [touched, setTouched] = useState<Set<string>>(() => initialTouched(entry, mediaKey, media));
  const [status, setStatus] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  useEffect(() => {
    setValues(initialValues(entry, mediaKey, media));
    setTouched(initialTouched(entry, mediaKey, media));
  }, [entry, mediaKey, media]);

  async function submit() {
    setRunning(true);
    setErrors({});
    setStatus("Submitting…");
    try {
      const params = Object.fromEntries(Object.entries(values).filter(([name]) => touched.has(name)));
      const result = await runGenerationJob(ps, { model: entry.model, endpoint: entry.endpoint, params }, `${entry.model}.${entry.endpoint}`, (submission) => setStatus(`${submission.status || "queued"} · ${submission.job_id}`));
      setStatus(`Done · ${result.contentType || entry.result_ext || "result"}`);
      ps.refreshMedia();
      ps.toast(`${entry.model}.${entry.endpoint} finished`, "gold");
    } catch (error: any) {
      const message = String(error?.message || error);
      setStatus(message);
      const field = Object.keys(entry.params || {}).find((name) => new RegExp(`(?:^|[^a-z0-9_])${name}(?:$|[^a-z0-9_])`, "i").test(message));
      if (field) setErrors({ [field]: message });
    } finally {
      setRunning(false);
    }
  }

  return <div className="media-lightbox" onClick={onClose}>
    <div className="ml-card job-card" onClick={(event) => event.stopPropagation()}>
      <div className="ml-head"><b>{entry.model}.{entry.endpoint}</b><span className="ml-meta">live price · {entry.credits.toLocaleString()} credits</span><button type="button" className="mini-btn" onClick={onClose}>✕</button></div>
      <div className="job-fields">
        {entry.pricing && <div className="job-pricing">Reserved {entry.pricing.reserved_gpu_gb} GPU GB for {entry.pricing.reserved_seconds}s · {entry.pricing.credits_per_gpu_gb_hour} cr/GPU-GB-hour. The server's {entry.credits.toLocaleString()} credit price is authoritative.</div>}
        {Object.entries(entry.params || {}).map(([name, schema]) => <Field key={name} name={name} schema={schema} value={values[name]} media={media} error={errors[name]} onChange={(value) => { setErrors((current) => { const next = { ...current }; delete next[name]; return next; }); setTouched((current) => new Set(current).add(name)); setValues((current) => ({ ...current, [name]: value })); }} />)}
        {!Object.keys(entry.params || {}).length && <div className="ml-none">This catalog entry has no parameter schema, so Studio will not submit it.</div>}
      </div>
      <div className="ml-foot job-foot"><span>{status || "Defaults shown here come from the live catalog."}</span><div className="grow" /><button type="button" className="mini-btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={running || !ps.catalogAvailable || !Object.keys(entry.params || {}).length} onClick={() => void submit()}>{running ? "Running…" : `Confirm & spend ${entry.credits.toLocaleString()} cr`}</button></div>
    </div>
  </div>;
}
