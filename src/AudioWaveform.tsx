import { useEffect, useState } from "react";
import { loadAudioPeaks } from "./audioPeaks";

export default function AudioWaveform({ url, muted }: { url?: string; muted: boolean }) {
  const [peaks, setPeaks] = useState<number[] | null>(null);

  useEffect(() => {
    let active = true;
    setPeaks(null);
    if (url) void loadAudioPeaks(url).then((values) => active && setPeaks(values)).catch(() => {});
    return () => { active = false; };
  }, [url]);

  const values = peaks || [0.18, 0.55, 0.32, 0.78, 0.5, 0.24, 0.62, 0.4, 0.7, 0.3, 0.52, 0.2];
  return (
    <span className={`waveform${peaks ? " ready" : " loading"}${muted ? " muted" : ""}`} aria-hidden="true">
      {values.map((peak, index) => <i key={index} style={{ height: `${Math.round(peak * 90)}%` }} />)}
    </span>
  );
}
