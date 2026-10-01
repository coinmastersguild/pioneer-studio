const waveformCache = new Map<string, Promise<number[]>>();

// A timeline with dozens of audio clips used to open one AudioContext per clip, all at once; browsers cap live
// contexts and the page stalled. Decode on one shared offline context (it never opens the audio device), two at a time.
let offline: OfflineAudioContext | null = null;
const decoder = () => (offline ??= new OfflineAudioContext(1, 1, 44100));
const DECODES_AT_ONCE = 2;
let running = 0;
const waiting: (() => void)[] = [];
async function queued<T>(work: () => Promise<T>): Promise<T> {
  if (running >= DECODES_AT_ONCE) await new Promise<void>((go) => waiting.push(go));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

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
  const pending = queued(async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`waveform fetch failed (${response.status})`);
    const bytes = await response.arrayBuffer();
    return samplePeaks(await decoder().decodeAudioData(bytes.slice(0)), sampleCount);
  });
  waveformCache.set(key, pending);
  pending.catch(() => waveformCache.delete(key));
  return pending;
}
