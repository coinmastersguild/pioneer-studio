const waveformCache = new Map<string, Promise<number[]>>();

function samplePeaks(buffer: AudioBuffer, sampleCount: number): number[] {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const block = Math.max(1, Math.floor(buffer.length / sampleCount));
  const peaks = Array.from({ length: sampleCount }, (_, sample) => {
    const from = sample * block;
    const to = Math.min(buffer.length, from + block);
    let peak = 0;
    for (const channel of channels) {
      for (let index = from; index < to; index += Math.max(1, Math.floor(block / 48))) {
        peak = Math.max(peak, Math.abs(channel[index] || 0));
      }
    }
    return peak;
  });
  const max = Math.max(0.01, ...peaks);
  return peaks.map((peak) => Math.max(0.05, peak / max));
}

/** Fetch and decode an audio source once per session, then keep small normalized
 * peak arrays for every clip that references it. CORS or decode failures are
 * allowed to reject so the editor can retain its lightweight placeholder. */
export function loadAudioPeaks(url: string, sampleCount = 48): Promise<number[]> {
  const key = `${sampleCount}:${url}`;
  const cached = waveformCache.get(key);
  if (cached) return cached;
  const pending = (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`waveform fetch failed (${response.status})`);
    const bytes = await response.arrayBuffer();
    const Context = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) throw new Error("Web Audio is unavailable");
    const context = new Context();
    try {
      return samplePeaks(await context.decodeAudioData(bytes.slice(0)), sampleCount);
    } finally {
      void context.close();
    }
  })();
  waveformCache.set(key, pending);
  pending.catch(() => waveformCache.delete(key));
  return pending;
}
