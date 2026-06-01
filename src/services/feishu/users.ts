import { db, normalizeRow, normalizeRows, nowIso } from "../../db.js";
import { createFeishuOnlyUser, getAppUserById } from "../app-users.js";
import type { FeishuUserBinding } from "../../types.js";
import { touchFeishuContact } from "./contacts-cache.js";

function mapFeishuUserRow(row: FeishuUserBinding): FeishuUserBinding {
  return { ...normalizeRow(row), enabled: Boolean(row.enabled) };
}

export function listFeishuUsers(): FeishuUserBinding[] {
  const rows = db.prepare(`
    SELECT
      fu.*,
      u.account AS app_user_account,
      COALESCE(NULLIF(u.display_name, ''), NULLIF(u.account, ''), '用户 #' || u.id) AS app_user_display_name
    FROM feishu_users fu
    INNER JOIN app_users u ON u.id = fu.app_user_id
    ORDER BY fu.updated_at DESC, fu.open_id ASC
  `).all() as FeishuUserBinding[];
  return normalizeRows(rows).map(mapFeishuUserRow);
}

export function getFeishuUser(openId: string): FeishuUserBinding | undefined {
  const row = db.prepare(`
    SELECT
      fu.*,
      u.account AS app_user_account,
      COALESCE(NULLIF(u.display_name, ''), NULLIF(u.account, ''), '用户 #' || u.id) AS app_user_display_name
    FROM feishu_users fu
    INNER JOIN app_users u ON u.id = fu.app_user_id
    WHERE fu.open_id = ?
  `).get(openId.trim()) as FeishuUserBinding | undefined;
  return row ? mapFeishuUserRow(row) : undefined;
}

export function getFeishuUserByAppUserId(appUserId: number): FeishuUserBinding | undefined {
  const row = db.prepare(`
    SELECT
      fu.*,
      u.account AS app_user_account,
      COALESCE(NULLIF(u.display_name, ''), NULLIF(u.account, ''), '用户 #' || u.id) AS app_user_display_name
    FROM feishu_users fu
    INNER JOIN app_users u ON u.id = fu.app_user_id
    WHERE fu.app_user_id = ?
    LIMIT 1
  `).get(appUserId) as FeishuUserBinding | undefined;
  return row ? mapFeishuUserRow(row) : undefined;
}

export function upsertFeishuUser(input: {
  open_id: string;
  app_user_id: number;
  union_id?: string;
  display_name?: string;
  enabled?: boolean;
}): FeishuUserBinding {
  const openId = input.open_id.trim();
  if (!openId) throw new Error("请填写飞书 open_id");
  const appUser = getAppUserById(input.app_user_id);
  if (!appUser) throw new Error("系统用户不存在");
  const timestamp = nowIso();
  const displayName = input.display_name?.trim() || appUser.display_name || appUser.account;
  db.prepare(`
    INSERT INTO feishu_users(open_id, app_user_id, union_id, display_name, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(open_id) DO UPDATE SET
      app_user_id = excluded.app_user_id,
      union_id = excluded.union_id,
      display_name = excluded.display_name,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(
    openId,
    input.app_user_id,
    input.union_id?.trim() ?? "",
    displayName,
    input.enabled === false ? 0 : 1,
    timestamp,
    timestamp,
  );
  touchFeishuContact({
    open_id: openId,
    union_id: input.union_id,
    name: displayName,
    source: "binding",
  });
  return getFeishuUser(openId)!;
}

export function provisionFeishuUser(input: {
  open_id: string;
  union_id?: string;
  display_name?: string;
  enabled?: boolean;
}): FeishuUserBinding {
  const openId = input.open_id.trim();
  if (!openId) throw new Error("请填写飞书 open_id");
  const existing = getFeishuUser(openId);
  if (existing) {
    return upsertFeishuUser({
      open_id: openId,
      app_user_id: existing.app_user_id,
      union_id: input.union_id ?? existing.union_id,
      display_name: input.display_name ?? existing.display_name,
      enabled: input.enabled ?? Boolean(existing.enabled),
    });
  }
  const user = createFeishuOnlyUser({
    open_id: openId,
    display_name: input.display_name,
    enabled: input.enabled,
  });
  return upsertFeishuUser({
    open_id: openId,
    app_user_id: user.id,
    union_id: input.union_id,
    display_name: input.display_name ?? user.display_name,
    enabled: input.enabled,
  });
}

export function deleteFeishuUser(openId: string): boolean {
  const result = db.prepare("DELETE FROM feishu_users WHERE open_id = ?").run(openId.trim());
  return result.changes > 0;
}
