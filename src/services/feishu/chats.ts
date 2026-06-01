import { db, normalizeRow, normalizeRows, nowIso } from "../../db.js";
import type { FeishuChatBinding } from "../../types.js";

function listChatProjectIds(chatId: string): number[] {
  const rows = db.prepare("SELECT project_id FROM feishu_chat_projects WHERE chat_id = ? ORDER BY project_id ASC").all(chatId) as Array<{ project_id: number }>;
  return rows.map((row) => Number(row.project_id));
}

function filterExistingProjectIds(projectIds: number[]): number[] {
  if (!projectIds.length) return [];
  const placeholders = projectIds.map(() => "?").join(",");
  const rows = db.prepare(`SELECT id FROM projects WHERE id IN (${placeholders})`).all(...projectIds) as Array<{ id: number }>;
  const existing = new Set(rows.map((row) => Number(row.id)));
  return projectIds.filter((id) => existing.has(id));
}

export function listFeishuChats(): FeishuChatBinding[] {
  const rows = db.prepare("SELECT * FROM feishu_chats ORDER BY updated_at DESC, chat_id ASC").all() as FeishuChatBinding[];
  return normalizeRows(rows).map((row) => ({
    ...row,
    enabled: Boolean(row.enabled),
    allow_shared_mode: Boolean(row.allow_shared_mode),
    project_ids: listChatProjectIds(row.chat_id),
  }));
}

export function getFeishuChat(chatId: string): FeishuChatBinding | undefined {
  const row = db.prepare("SELECT * FROM feishu_chats WHERE chat_id = ?").get(chatId.trim()) as FeishuChatBinding | undefined;
  if (!row) return undefined;
  const normalized = normalizeRow(row);
  return {
    ...normalized,
    enabled: Boolean(normalized.enabled),
    allow_shared_mode: Boolean(normalized.allow_shared_mode),
    project_ids: listChatProjectIds(normalized.chat_id),
  };
}

export function upsertFeishuChat(input: {
  chat_id: string;
  chat_type?: string;
  name?: string;
  enabled?: boolean;
  allow_shared_mode?: boolean;
  project_ids?: number[];
}): FeishuChatBinding {
  const chatId = input.chat_id.trim();
  if (!chatId) throw new Error("请填写飞书 chat_id");
  const chatType = input.chat_type?.trim() === "p2p" ? "p2p" : "group";
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO feishu_chats(chat_id, chat_type, name, enabled, allow_shared_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      chat_type = excluded.chat_type,
      name = excluded.name,
      enabled = excluded.enabled,
      allow_shared_mode = excluded.allow_shared_mode,
      updated_at = excluded.updated_at
  `).run(
    chatId,
    chatType,
    input.name?.trim() ?? "",
    input.enabled === false ? 0 : 1,
    input.allow_shared_mode === false ? 0 : 1,
    timestamp,
    timestamp,
  );

  if (input.project_ids !== undefined) {
    const projectIds = filterExistingProjectIds([...new Set(input.project_ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]);
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM feishu_chat_projects WHERE chat_id = ?").run(chatId);
      const insert = db.prepare("INSERT OR IGNORE INTO feishu_chat_projects(chat_id, project_id) VALUES (?, ?)");
      for (const projectId of projectIds) insert.run(chatId, projectId);
    });
    tx();
  }

  return getFeishuChat(chatId)!;
}

export function deleteFeishuChat(chatId: string): boolean {
  const result = db.prepare("DELETE FROM feishu_chats WHERE chat_id = ?").run(chatId.trim());
  return result.changes > 0;
}
