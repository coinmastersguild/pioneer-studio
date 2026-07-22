export type PendingStudioAsset = {
  projectId: string;
  sourceId: string;
  name: string;
  url: string;
  contentType: string;
  kind: "video" | "audio";
  duration: number;
};

const KEY = "pioneer_studio_pending_timeline_assets";

export function queueStudioAsset(asset: PendingStudioAsset): void {
  try {
    const current = JSON.parse(localStorage.getItem(KEY) || "[]");
    const assets = Array.isArray(current) ? current.filter((item) => item?.sourceId !== asset.sourceId) : [];
    localStorage.setItem(KEY, JSON.stringify([...assets, asset].slice(-20)));
  } catch {
    localStorage.setItem(KEY, JSON.stringify([asset]));
  }
}

export function consumeStudioAssets(projectId: string): PendingStudioAsset[] {
  try {
    const current = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(current)) return [];
    const matches = current.filter((item): item is PendingStudioAsset =>
      item?.projectId === projectId && typeof item?.sourceId === "string" && typeof item?.url === "string",
    );
    const remaining = current.filter((item) => item?.projectId !== projectId);
    if (remaining.length) localStorage.setItem(KEY, JSON.stringify(remaining));
    else localStorage.removeItem(KEY);
    return matches;
  } catch {
    localStorage.removeItem(KEY);
    return [];
  }
}
