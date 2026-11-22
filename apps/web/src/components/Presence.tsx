import { useEffect, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import type { RoomUser } from "../lib/realtime";

interface Peer {
  clientId: number;
  user: RoomUser;
  isSelf: boolean;
}

function usePeers(awareness: Awareness): Peer[] {
  const read = () =>
    [...awareness.getStates().entries()]
      .filter(([, state]) => state.user)
      .map(([clientId, state]) => ({
        clientId,
        user: state.user as RoomUser,
        isSelf: clientId === awareness.clientID,
      }));
  const [peers, setPeers] = useState<Peer[]>(read);
  useEffect(() => {
    const update = () => setPeers(read());
    awareness.on("change", update);
    update();
    return () => awareness.off("change", update);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awareness]);
  return peers;
}

/** Avatars for everyone currently in the editor. Names/colors are client-reported (cosmetic only). */
export function Presence({ awareness }: { awareness: Awareness }) {
  const peers = usePeers(awareness);
  return (
    <div className="presence">
      {peers.map((p) => (
        <span
          key={p.clientId}
          className="avatar"
          style={{ background: p.user.color }}
          title={`${p.user.name} (${p.user.role})${p.isSelf ? " — you" : ""}`}
        >
          {p.user.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
    </div>
  );
}

/** y-monaco tags remote selections with per-client classes; give each one its user's color and name. */
export function RemoteCursorStyles({ awareness }: { awareness: Awareness }) {
  const peers = usePeers(awareness).filter((p) => !p.isSelf);
  const css = peers
    .map(({ clientId, user }) => {
      const color = /^#[0-9a-f]{6}$/i.test(user.color) ? user.color : "#888888";
      const name = JSON.stringify(user.name.slice(0, 40));
      return `
.yRemoteSelection-${clientId} { background-color: ${color}40; }
.yRemoteSelectionHead-${clientId} { position: absolute; border-left: 2px solid ${color}; height: 100%; box-sizing: border-box; }
.yRemoteSelectionHead-${clientId}::after { content: ${name}; position: absolute; top: 0; left: 3px; background: ${color}; color: #fff; font-size: 10px; line-height: 14px; padding: 0 4px; border-radius: 0 3px 3px 0; white-space: nowrap; pointer-events: none; opacity: 0.85; z-index: 10; }`;
    })
    .join("\n");
  return <style>{css}</style>;
}
