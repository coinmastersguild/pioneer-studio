import { useEffect, useRef, useState } from "react";
import { uploadMedia, type MediaObject } from "./api";
import { fmtBytes, GB, IcCopy, IcModels, IcMusic, kindOf, relTime, type PS } from "./shared";

type Filter = "all" | "reference" | "result" | "clip" | "model" | "release";

// Server types are reference|result; clips are video results, releases live
// under releases/ when server assembly is available.
function typeOf(o: MediaObject): Exclude<Filter, "all"> {
  if (o.key.startsWith("releases/")) return "release";
  const kind = kindOf(o.content_type, o.url);
  if (kind === "model") return "model";
  if (kind === "video") return "clip";
  return o.type;
}

function CopyBtn({ url, toast }: { url: string; toast: (m: string, k?: "ok" | "gold") => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`mini-btn copy-url${copied ? " copied" : ""}`}
      onClick={() => {
        navigator.clipboard.writeText(url);
        setCopied(true);
        toast("R2 URL copied", "ok");
        setTimeout(() => setCopied(false), 1400);
      }}
    >
      <IcCopy /> {copied ? "Copied" : "Copy"}
    </button>
  );
}

export default function MediaView({ ps }: { ps: PS }) {
  const [filter, setFilter] = useState<Filter>("all");
  const fileInput = useRef<HTMLInputElement>(null);
  const psRef = useRef(ps);
  psRef.current = ps;

  useEffect(() => {
    ps.registerSuggestions("media", [
      {
        label: "What is storage costing me?",
        run: () => {
          const m = psRef.current.media;
          const gb = ((m?.total_bytes || 0) / GB).toFixed(2);
          psRef.current.streamMsg(
            `${gb} GB across ${m?.objects.length || 0} objects → ${m?.monthly_cr ?? 0} cr/month, billed daily from balance. Bandwidth is free — public URLs serve from the R2 edge.`,
          );
        },
      },
    ]);
    ps.setInputHandler("media", (txt) => {
      psRef.current.addMsg("You", txt);
      psRef.current.streamMsg(
        "Every file here has a public R2 URL — copy one straight from the table, or feed it back into any job as a reference.",
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onUpload(files: FileList) {
    const p = psRef.current;
    for (const f of Array.from(files)) {
      try {
        const up = await uploadMedia(p.apiKey, f);
        p.charge(up.credits_remaining);
        p.toast(`${f.name} → R2`, "ok");
      } catch (e: any) {
        p.toast(String(e.message || e));
      }
    }
    p.refreshMedia();
  }

  const objects = ps.media?.objects || [];
  const usedGb = (ps.media?.total_bytes || 0) / GB;
  const hasReleases = objects.some((o) => o.key.startsWith("releases/"));
  const filtered = objects.filter((o) => filter === "all" || typeOf(o) === filter);
  const badgeCls: Record<string, string> = { reference: " ref", release: " release", model: " model", clip: "", result: "" };

  return (
    <div className="media-wrap">
      <div className="media-head">
        <div>
          <h2>Media</h2>
          <div className="sub">
            Everything you upload or generate. Content-addressed on R2 — every file gets a public URL, ready to share
            or feed back into any job.
          </div>
        </div>
        <button type="button" className="btn primary" onClick={() => fileInput.current?.click()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
          </svg>
          Upload
        </button>
      </div>

      <div className="media-billing">
        <div className="bill-card">
          <span className="eyebrow">Storage used</span>
          <div className="stat-value">
            {usedGb.toFixed(2)} <span>GB</span>
          </div>
          <div className="foot-note">{objects.length} objects · deduped by sha256</div>
        </div>
        <div className="bill-card">
          <span className="eyebrow">Monthly cost</span>
          <div className="stat-value">
            {ps.media?.monthly_cr ?? 0} <span>cr / mo</span>
          </div>
          <div className="foot-note">
            metered at <b>{ps.media?.rate || "10 cr / GB / mo"}</b> · billed daily from balance
          </div>
        </div>
        <div className="bill-card">
          <span className="eyebrow">Bandwidth</span>
          <div className="stat-value">
            0 <span>cr</span>
          </div>
          <div className="foot-note">public URLs served free from R2 edge</div>
        </div>
      </div>

      <div className="media-filters" id="mediaFilters">
        {(["all", "reference", "result", "clip", "model", "release"] as Filter[])
          .filter((f) => f !== "release" || hasReleases)
          .map((f) => (
            <button key={f} type="button" className={`mf${filter === f ? " on" : ""}`} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f[0].toUpperCase() + f.slice(1) + "s"}
            </button>
          ))}
      </div>

      {filtered.length === 0 ? (
        <div style={{ border: "1px dashed var(--border-strong)", borderRadius: "var(--radius-lg)", padding: 28, textAlign: "center", color: "var(--fg4)", fontSize: 12.5 }}>
          {objects.length === 0 ? "no media yet — upload a file or generate something in Chat" : "nothing matches this filter"}
        </div>
      ) : (
        <table className="files">
          <thead>
            <tr>
              <th>File</th>
              <th>Type</th>
              <th>Size</th>
              <th>Public URL</th>
              <th>Added</th>
              <th />
            </tr>
          </thead>
          <tbody id="fileRows">
            {filtered.map((o) => {
              const t = typeOf(o);
              const kind = kindOf(o.content_type, o.url);
              return (
                <tr key={o.key}>
                  <td>
                    <div className="fcell">
                      <div
                        className="fthumb"
                        style={
                          o.content_type.startsWith("image/")
                            ? { backgroundImage: `url(${o.url})`, backgroundSize: "cover", backgroundPosition: "center" }
                            : { display: "grid", placeItems: "center", color: "var(--accent-2)" }
                        }
                      >
                        {!o.content_type.startsWith("image/") && (kind === "model" ? <IcModels /> : <IcMusic />)}
                      </div>
                      <div>
                        <div className="fname">{o.name}</div>
                        <div className="fkey">{o.key.length > 34 ? o.key.slice(0, 18) + "…" + o.key.slice(-10) : o.key}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`fbadge${badgeCls[t]}`}>{t}</span>
                  </td>
                  <td className="fsize">{fmtBytes(o.bytes)}</td>
                  <td className="furl">{o.url.replace(/^https?:\/\//, "")}</td>
                  <td className="fdate">{relTime(o.added)}</td>
                  <td>
                    <CopyBtn url={o.url} toast={ps.toast} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <input
        ref={fileInput}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,video/*,audio/*"
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files?.length) onUpload(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
