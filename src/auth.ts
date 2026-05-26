import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const ADMIN_ACCOUNT = process.env.ADMIN_ACCOUNT?.trim() || "13473458864";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1qaz2wsx";
const SESSION_COOKIE = "anna_admin_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24;

interface AdminSession {
  account: string;
  expiresAt: number;
}

const sessions = new Map<string, AdminSession>();

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map((part) => {
      const [key, ...rest] = part.trim().split("=");
      return [key, decodeURIComponent(rest.join("="))];
    }).filter(([key]) => key),
  );
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

export function verifyAdminCredentials(account: string, password: string): boolean {
  return account.trim() === ADMIN_ACCOUNT && password === ADMIN_PASSWORD;
}

export function createAdminSession(account: string): string {
  cleanupExpiredSessions();
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { account, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export function destroyAdminSession(token: string | undefined) {
  if (token) sessions.delete(token);
}

export function getAdminSessionToken(request: FastifyRequest): string | undefined {
  const cookies = parseCookies(request.headers.cookie);
  return cookies[SESSION_COOKIE];
}

export function getAdminSession(request: FastifyRequest): AdminSession | undefined {
  const token = getAdminSessionToken(request);
  if (!token) return undefined;
  const session = sessions.get(token);
  if (!session) return undefined;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return undefined;
  }
  return session;
}

export function isAdminAuthenticated(request: FastifyRequest): boolean {
  return Boolean(getAdminSession(request));
}

export function setAdminSessionCookie(reply: FastifyReply, token: string) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  reply.header(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
  );
}

export function clearAdminSessionCookie(reply: FastifyReply) {
  reply.header("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!isAdminAuthenticated(request)) {
    return reply.status(401).send({ detail: "未登录或会话已过期" });
  }
}
