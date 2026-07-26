// One media object, handed from anywhere to Chat. Same shape as the Studio and
// character handoffs: localStorage, written by the sender, drained by Chat on
// arrival, so neither view needs a reference to the other.
export type PendingChatMedia = { url: string; name: string; contentType: string; key: string };

const KEY = "pioneer_studio_pending_chat_media";

export function sendToChat(media: PendingChatMedia): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(media));
  } catch {
    /* private mode — the mode switch still happens, just without the reference */
  }
}

export function consumeChatMedia(): PendingChatMedia | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    localStorage.removeItem(KEY);
    const v = JSON.parse(raw);
    return v?.url && v?.name ? (v as PendingChatMedia) : null;
  } catch {
    localStorage.removeItem(KEY);
    return null;
  }
}
