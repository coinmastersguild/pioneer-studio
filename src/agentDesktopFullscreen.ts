type FullscreenTarget = { requestFullscreen?: () => Promise<void> };
const unavailable = "Browser full screen is unavailable. The full desktop remains viewable in this window.";

/** Browser permission or user-activation errors must not interrupt the live viewer. */
export async function requestDesktopFullscreen(target: FullscreenTarget | null): Promise<string | null> {
  try {
    if (!target?.requestFullscreen) return unavailable;
    await target.requestFullscreen();
    return null;
  } catch {
    return unavailable;
  }
}
