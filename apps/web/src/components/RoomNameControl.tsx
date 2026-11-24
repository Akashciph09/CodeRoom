import { useRef, useState, type FormEvent } from "react";
import { MAX_ROOM_NAME } from "@coderoom/shared";
import { api } from "../lib/api";

/**
 * The room's name in the interviewer's top bar, with an inline rename (ADR 0014). Never rendered for
 * candidates — the name is the interviewer's label and the API doesn't send it to them.
 */
export function RoomNameControl({
  roomId,
  name,
  onRenamed,
}: {
  roomId: string;
  name?: string;
  onRenamed: (name: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Which edit a save belongs to (PR #13 review). The form is locked while saving, so a new edit can't
   * normally start mid-save; this also guarantees a late response can never close a newer edit.
   */
  const edit = useRef(0);

  function start() {
    edit.current++;
    setDraft(name ?? "");
    setError(null);
    setEditing(true);
  }

  function cancel() {
    if (saving) return; // can't abandon a save mid-flight: its response would close the next edit
    setEditing(false);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const mine = edit.current;
    setSaving(true);
    setError(null);
    try {
      const res = await api.renameRoom(roomId, draft);
      onRenamed(res.name); // the rename happened, whatever the form is doing now
      if (edit.current === mine) setEditing(false);
    } catch (err) {
      if (edit.current === mine) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <span className="room-name">
        <span className={name ? "room-name-text" : "room-name-text muted"} title={name ?? "Only you see the room's name"}>
          {name ?? "Untitled room"}
        </span>
        <button className="link small" onClick={start} aria-label={name ? "Rename room" : "Name this room"}>
          {name ? "Rename" : "Add name"}
        </button>
      </span>
    );
  }
  return (
    <form className="room-name-form" onSubmit={save} onKeyDown={(e) => e.key === "Escape" && cancel()} aria-busy={saving}>
      <input
        aria-label="Room name"
        value={draft}
        maxLength={MAX_ROOM_NAME}
        placeholder="e.g. Backend interview"
        autoFocus
        readOnly={saving}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button type="submit" className="primary small-btn" disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </button>
      <button type="button" className="ghost small-btn" onClick={cancel} disabled={saving}>
        Cancel
      </button>
      {error && <span className="error small">{error}</span>}
    </form>
  );
}
