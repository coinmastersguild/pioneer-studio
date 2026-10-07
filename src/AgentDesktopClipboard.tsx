import { useState } from "react";
import { desktopClipboardText } from "./desktopClipboard";

export default function AgentDesktopClipboard({ connected, onSend, receivedText }: {
  connected: boolean; onSend(text: string): void; receivedText: string | null;
}) {
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState("");
  function send() {
    try {
      onSend(desktopClipboardText(draft));
      setMessage("Text sent to the desktop clipboard. Press Ctrl+V inside the desktop to paste.");
    } catch {
      setMessage("Clipboard text was not sent. Reconnect if needed and use at most 16 KiB of text without null characters.");
    } finally { setDraft(""); }
  }
  async function copy() {
    try {
      const text = desktopClipboardText(receivedText);
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(text);
      setMessage("Desktop text copied to your clipboard.");
    } catch {
      setMessage("Browser copying is unavailable. Select the desktop text below and copy it manually.");
    }
  }
  return <section className="agent-desktop-clipboard" aria-label="Desktop clipboard">
    <div><label>Paste into desktop<textarea aria-label="Text to send to desktop" value={draft} maxLength={16384}
      onInput={(event) => setDraft(event.currentTarget.value)} rows={3} /></label>
      <button className="btn" disabled={!connected || !draft.length} onClick={send}>Send to desktop</button></div>
    <div><label>Copied on desktop<textarea aria-label="Text copied on desktop" readOnly value={receivedText || ""} rows={3} /></label>
      <button className="btn" disabled={!receivedText} onClick={() => void copy()}>Copy from desktop</button></div>
    <p>Text only, up to 16 KiB. Clipboard access is explicit; text is kept only in this open viewer.</p>
    {message && <p role="status">{message}</p>}
  </section>;
}
