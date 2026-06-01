import { db, nowIso } from "../../db.js";
import type { FeishuSessionLink, FeishuSessionMode } from "../../types.js";
import { createFeishuChatSession, getFeishuChatSession } from "./chat-store.js";
import { getFeishuChat } from "./chats.js";

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
