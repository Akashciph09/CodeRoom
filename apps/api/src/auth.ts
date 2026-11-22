import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { and, eq, roomParticipants } from "@coderoom/db";
import type { Role } from "@coderoom/shared";
import { config } from "./config.js";
import { db } from "./db.js";
import { Forbidden, Unauthorized } from "./errors.js";

export interface AuthUser {
  userId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const issuer = `${config.SUPABASE_URL}/auth/v1`;
// Supabase signs access tokens with an asymmetric key; the public keys are published here.
// jose caches the key set and refetches on unknown `kid`, so this is one fetch per key rotation.
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

/** Verify the Supabase access token locally (no round trip to Supabase per request). */
export async function verifyAccessToken(token: string): Promise<AuthUser> {
  const { payload } = await jwtVerify(token, jwks, { issuer, audience: "authenticated" });
  if (!payload.sub) throw new Unauthorized();
  return { userId: payload.sub };
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) return next(new Unauthorized());
  verifyAccessToken(token)
    .then((user) => {
      req.user = user;
      next();
    })
    .catch(() => next(new Unauthorized("Invalid or expired token")));
}

/** A user's role is per room, not global: the same person can interview in one room and be a candidate in another. */
export async function getRoomRole(roomId: string, userId: string): Promise<Role | null> {
  const [row] = await db
    .select({ role: roomParticipants.role })
    .from(roomParticipants)
    .where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

/** Throws unless the user is a participant (optionally with one of `roles`). Returns their role. */
export async function requireRoomRole(roomId: string, userId: string, ...roles: Role[]): Promise<Role> {
  const role = await getRoomRole(roomId, userId);
  // Same error for "room doesn't exist" and "not a participant", so room ids can't be probed.
  if (!role) throw new Forbidden("Not a participant of this room");
  if (roles.length > 0 && !roles.includes(role)) throw new Forbidden();
  return role;
}
