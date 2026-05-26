import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { parseCookies } from "./auth.js";

export const USER_SESSION_COOKIE = "anna_user_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

interface UserSession {
  userId: number;
  account: string;
  expiresAt: number;
}

const sessions = new Map<string, UserSession>();

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

export function createUserSession(userId: number, account: string): string {
  cleanupExpiredSessions();
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { userId, account, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export function destroyUserSession(token: string | undefined) {
  if (token) sessions.delete(token);
}

export function getUserSessionToken(request: FastifyRequest): string | undefined {
  const cookies = parseCookies(request.headers.cookie);
  return cookies[USER_SESSION_COOKIE];
}

export function getUserSession(request: FastifyRequest): UserSession | undefined {
  const token = getUserSessionToken(request);
  if (!token) return undefined;
  const session = sessions.get(token);
  if (!session) return undefined;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return undefined;
  }
  return session;
}

export function isUserAuthenticated(request: FastifyRequest): boolean {
  return Boolean(getUserSession(request));
}

export function setUserSessionCookie(reply: FastifyReply, token: string) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  reply.header(
    "Set-Cookie",
    `${USER_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
  );
}

export function clearUserSessionCookie(reply: FastifyReply) {
  reply.header("Set-Cookie", `${USER_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function getUserIdFromRequest(request: FastifyRequest): number | undefined {
  return getUserSession(request)?.userId;
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  if (!isUserAuthenticated(request)) {
    return reply.status(401).send({ detail: "请先登录" });
  }
}
