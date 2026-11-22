import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

/**
 * Binary frames exchanged between gateway instances over Redis pub/sub (one channel per room).
 * Redis delivers a publisher's own messages back to it, so every frame carries the sender's
 * instance id and receivers drop their own.
 */
export const FrameKind = {
  /** A Yjs document update. */
  Update: 0,
  /** A y-protocols awareness update (cursors, user names). */
  Awareness: 1,
  /** "I just loaded this doc; send me what I'm missing." Payload = Yjs state vector. */
  SyncRequest: 2,
} as const;
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

export interface BusFrame {
  origin: string;
  kind: FrameKind;
  payload: Uint8Array;
}

export const docChannel = (roomId: string) => `yjs:${roomId}`;
export const DOC_CHANNEL_PREFIX = "yjs:";

export function encodeFrame(frame: BusFrame): Buffer {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, frame.origin);
  encoding.writeVarUint(encoder, frame.kind);
  encoding.writeVarUint8Array(encoder, frame.payload);
  return Buffer.from(encoding.toUint8Array(encoder));
}

export function decodeFrame(data: Uint8Array): BusFrame {
  const decoder = decoding.createDecoder(data);
  const origin = decoding.readVarString(decoder);
  const kind = decoding.readVarUint(decoder);
  if (kind !== FrameKind.Update && kind !== FrameKind.Awareness && kind !== FrameKind.SyncRequest) {
    throw new Error(`unknown frame kind ${kind}`);
  }
  const payload = decoding.readVarUint8Array(decoder);
  return { origin, kind, payload };
}
