import { db, nowIso } from "../../db.js";
import type { FeishuSessionLink, FeishuSessionMode } from "../../types.js";
import { releaseCursorSessionsForChat } from "../ai.js";
import { createFeishuChatSession, getFeishuChatSession, getFeishuSessionLastActivityMs } from "./chat-store.js";
import { getFeishuChat } from "./chats.js";

/** 飞书会话无新消息后自动结束并下次重建的间隔 */
export const FEISHU_SESSION_IDLE_MS = 5 * 60 * 1000;
const FEISHU_IDLE_CHECK_MS = 60 * 1000;
let feishuIdleMaintenanceStarted = false;

function linkOpenId(mode: FeishuSessionMode, openId: string): string {
  return mode === "shared" ? "" : openId;
}

export function getFeishuSessionLink(chatId: string, openId: string, mode: FeishuSessionMode): FeishuSessionLink | undefined {
  const row = db.prepare(`
    SELECT * FROM feishu_session_links
    WHERE chat_id = ? AND open_id = ? AND mode = ?
  `).get(chatId, linkOpenId(mode, openId), mode) as FeishuSessionLink | undefined;
  return row ?? undefined;
}

export function getActiveFeishuMode(chatId: string, _openId: string): FeishuSessionMode {
  const shared = getFeishuSessionLink(chatId, "", "shared");
  if (shared) return "shared";
  return "personal";
}

export function setActiveFeishuMode(chatId: string, openId: string, mode: FeishuSessionMode): FeishuSessionMode {
  if (mode === "shared") {
    const chat = getFeishuChat(chatId);
    if (chat && !chat.allow_shared_mode) throw new Error("此群未开启协作会话");
  }
  return mode;
}

export function isFeishuSessionIdle(sessionId: string): boolean {
  const lastActivityMs = getFeishuSessionLastActivityMs(sessionId);
  if (lastActivityMs <= 0) return false;
  return Date.now() - lastActivityMs >= FEISHU_SESSION_IDLE_MS;
}

function feishuCursorChatSessionId(feishuSessionId: string): string {
  return `feishu:${feishuSessionId}`;
}

/** 若会话已超过空闲时限，解除 link 并释放 Cursor Agent（不立即创建新会话） */
export function expireIdleFeishuSessionLink(input: {
  chatId: string;
  openId: string;
  mode: FeishuSessionMode;
}): boolean {
  const existing = getFeishuSessionLink(input.chatId, input.openId, input.mode);
  if (!existing || !getFeishuChatSession(existing.session_id)) return false;
  if (!isFeishuSessionIdle(existing.session_id)) return false;
  db.prepare("DELETE FROM feishu_session_links WHERE id = ?").run(existing.id);
  releaseCursorSessionsForChat(feishuCursorChatSessionId(existing.session_id));
  return true;
}

function expireAllIdleFeishuSessionLinks(): void {
  const links = db.prepare("SELECT * FROM feishu_session_links").all() as FeishuSessionLink[];
  for (const link of links) {
    if (!getFeishuChatSession(link.session_id)) {
      db.prepare("DELETE FROM feishu_session_links WHERE id = ?").run(link.id);
      continue;
    }
    if (!isFeishuSessionIdle(link.session_id)) continue;
    db.prepare("DELETE FROM feishu_session_links WHERE id = ?").run(link.id);
    releaseCursorSessionsForChat(feishuCursorChatSessionId(link.session_id));
  }
}

export function startFeishuSessionIdleMaintenance(): void {
  if (feishuIdleMaintenanceStarted) return;
  feishuIdleMaintenanceStarted = true;
  setInterval(() => {
    expireAllIdleFeishuSessionLinks();
  }, FEISHU_IDLE_CHECK_MS).unref?.();
}

export function ensureFeishuSessionLinkForIncoming(input: {
  chatId: string;
  openId: string;
  mode: FeishuSessionMode;
  appUserId: number;
  projectId: number;
  repoIds?: number[];
  sharedStartedByOpenId?: string;
}): { link: FeishuSessionLink; renewed: boolean } {
  const renewed = expireIdleFeishuSessionLink({
    chatId: input.chatId,
    openId: input.openId,
    mode: input.mode,
  });
  return { link: ensureFeishuSessionLink(input), renewed };
}

export function ensureFeishuSessionLink(input: {
  chatId: string;
  openId: string;
  mode: FeishuSessionMode;
  appUserId: number;
  projectId: number;
  repoIds?: number[];
  sharedStartedByOpenId?: string;
}): FeishuSessionLink {
  const existing = getFeishuSessionLink(input.chatId, input.openId, input.mode);
  if (existing && getFeishuChatSession(existing.session_id)) {
    db.prepare(`
      UPDATE feishu_session_links
      SET current_project_id = ?, last_open_id = ?, updated_at = ?
      WHERE id = ?
    `).run(input.projectId, input.openId, nowIso(), existing.id);
    return getFeishuSessionLink(input.chatId, input.openId, input.mode)!;
  }

  const session = createFeishuChatSession({
    chatId: input.chatId,
    appUserId: input.mode === "shared" ? input.appUserId : input.appUserId,
    projectId: input.projectId,
    mode: input.mode,
    repoIds: input.repoIds,
    title: input.mode === "shared" ? "群协作会话" : "个人会话",
  });

  db.prepare(`
    INSERT INTO feishu_session_links(
      chat_id, open_id, mode, session_id, current_project_id, shared_started_by_open_id, last_open_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, open_id, mode) DO UPDATE SET
      session_id = excluded.session_id,
      current_project_id = excluded.current_project_id,
      shared_started_by_open_id = excluded.shared_started_by_open_id,
      last_open_id = excluded.last_open_id,
      updated_at = excluded.updated_at
  `).run(
    input.chatId,
    linkOpenId(input.mode, input.openId),
    input.mode,
    session.id,
    input.projectId,
    input.mode === "shared" ? (input.sharedStartedByOpenId ?? input.openId) : "",
    input.openId,
    nowIso(),
  );

  return getFeishuSessionLink(input.chatId, input.openId, input.mode)!;
}

export function resetFeishuSession(input: {
  chatId: string;
  openId: string;
  mode: FeishuSessionMode;
  appUserId: number;
  projectId: number;
  repoIds?: number[];
}): FeishuSessionLink {
  const existing = getFeishuSessionLink(input.chatId, input.openId, input.mode);
  if (existing) {
    db.prepare("DELETE FROM feishu_session_links WHERE id = ?").run(existing.id);
  }
  return ensureFeishuSessionLink({
    ...input,
    sharedStartedByOpenId: input.mode === "shared" ? input.openId : undefined,
  });
}

export function clearSharedSession(chatId: string): void {
  db.prepare("DELETE FROM feishu_session_links WHERE chat_id = ? AND mode = 'shared'").run(chatId);
}

export function resolveFeishuSessionContext(input: {
  chatId: string;
  openId: string;
  preferredMode?: FeishuSessionMode;
}): { mode: FeishuSessionMode; link?: FeishuSessionLink } {
  const mode = input.preferredMode ?? getActiveFeishuMode(input.chatId, input.openId);
  const link = getFeishuSessionLink(input.chatId, input.openId, mode);
  return { mode, link };
}

/** 私聊菜单等场景：从最近会话 link / 会话记录反查 chat_id（菜单事件体不含 chat_id）。 */
export function resolveFeishuPersonalChatIdForUser(openId: string, appUserId?: number): string | null {
  const trimmed = openId.trim();
  if (!trimmed) return null;
  const fromLink = db.prepare(`
    SELECT chat_id FROM feishu_session_links
    WHERE open_id = ? AND mode = 'personal'
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(trimmed) as { chat_id?: string } | undefined;
  const linkChatId = fromLink?.chat_id?.trim();
  if (linkChatId) return linkChatId;

  if (appUserId && appUserId > 0) {
    const fromSession = db.prepare(`
      SELECT chat_id FROM feishu_chat_sessions
      WHERE app_user_id = ? AND mode = 'personal' AND chat_id != ''
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(appUserId) as { chat_id?: string } | undefined;
    const sessionChatId = fromSession?.chat_id?.trim();
    if (sessionChatId) return sessionChatId;
  }
  return null;
}
