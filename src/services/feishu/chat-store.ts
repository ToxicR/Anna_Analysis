import crypto from "node:crypto";
import { db, nowIso } from "../../db.js";
import type { FeishuChatMessage, FeishuChatSession, FeishuSessionMode } from "../../types.js";

export function generateFeishuChatSessionId(): string {
  return `fs_${crypto.randomBytes(12).toString("hex")}`;
}

export function getFeishuChatSession(sessionId: string): FeishuChatSession | undefined {
  const row = db.prepare("SELECT * FROM feishu_chat_sessions WHERE id = ?").get(sessionId) as FeishuChatSession | undefined;
  return row ?? undefined;
}

export function createFeishuChatSession(input: {
  chatId: string;
  appUserId: number | null;
  projectId: number;
  mode: FeishuSessionMode;
  title?: string;
  modelId?: number | null;
  repoIds?: number[];
}): FeishuChatSession {
  const id = generateFeishuChatSessionId();
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO feishu_chat_sessions(
      id, app_user_id, project_id, title, model_id, output_mode, analysis_scope, repo_ids, mode, chat_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'non_developer', '', ?, ?, ?, ?, ?)
  `).run(
    id,
    input.appUserId,
    input.projectId,
    input.title?.trim() || "飞书会话",
    input.modelId ?? null,
    (input.repoIds ?? []).join(","),
    input.mode,
    input.chatId,
    timestamp,
    timestamp,
  );
  return getFeishuChatSession(id)!;
}

export function appendFeishuChatMessage(sessionId: string, role: string, body: string, openId = "", meta = ""): FeishuChatMessage {
  const result = db.prepare(`
    INSERT INTO feishu_chat_messages(session_id, open_id, role, meta, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, openId, role, meta, body, nowIso());
  db.prepare("UPDATE feishu_chat_sessions SET updated_at = ? WHERE id = ?").run(nowIso(), sessionId);
  return db.prepare("SELECT * FROM feishu_chat_messages WHERE id = ?").get(Number(result.lastInsertRowid)) as FeishuChatMessage;
}

export function listFeishuChatMessages(sessionId: string, limit = 200): FeishuChatMessage[] {
  return db.prepare(`
    SELECT * FROM feishu_chat_messages
    WHERE session_id = ?
    ORDER BY id ASC
    LIMIT ?
  `).all(sessionId, limit) as FeishuChatMessage[];
}

export function getFeishuSessionLastActivityMs(sessionId: string): number {
  const session = getFeishuChatSession(sessionId);
  const row = db.prepare(`
    SELECT MAX(created_at) AS last_at FROM feishu_chat_messages WHERE session_id = ?
  `).get(sessionId) as { last_at: string | null } | undefined;
  const messageAt = row?.last_at ? Date.parse(row.last_at) : Number.NaN;
  const sessionAt = session?.updated_at ? Date.parse(session.updated_at) : Number.NaN;
  const candidates = [messageAt, sessionAt].filter((value) => Number.isFinite(value));
  if (!candidates.length) return 0;
  return Math.max(...candidates);
}

export function buildFeishuConversationContext(sessionId: string, excludeLastUserMessage = false): string {
  let messages = listFeishuChatMessages(sessionId, 40);
  if (excludeLastUserMessage) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") {
        messages = messages.slice(0, index);
        break;
      }
    }
  }
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `${message.role === "user" ? "用户" : "助手"}: ${message.body}`)
    .join("\n\n");
}
