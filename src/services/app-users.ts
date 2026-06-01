import crypto from "node:crypto";
import { db, flagToBoolean, normalizeRow, normalizeRows, nowIso } from "../db.js";
import { hashPassword, verifyPassword } from "../password.js";
import type { AppUser, AppUserLoginRecord, AppUserPublic } from "../types.js";

export const DEFAULT_APP_USER_PASSWORD = "123456";
const MIN_PASSWORD_LENGTH = 6;
const FEISHU_PLACEHOLDER_ACCOUNT_PREFIX = "fs_";

export function isFeishuPlaceholderAccount(account: string): boolean {
  return account.startsWith(FEISHU_PLACEHOLDER_ACCOUNT_PREFIX);
}

export function feishuPlaceholderAccount(openId: string): string {
  return `${FEISHU_PLACEHOLDER_ACCOUNT_PREFIX}${openId.trim()}`;
}

function unusablePasswordHash(): string {
  return hashPassword(crypto.randomBytes(32).toString("hex"));
}

export function toPublicUser(row: AppUser, feishuOpenId?: string): AppUserPublic {
  const normalized = normalizeRow(row);
  const webLoginEnabled = flagToBoolean(normalized.web_login_enabled);
  const account = webLoginEnabled || !isFeishuPlaceholderAccount(normalized.account)
    ? normalized.account
    : "";
  return {
    id: normalized.id,
    account,
    display_name: normalized.display_name || account || `用户 #${normalized.id}`,
    enabled: Boolean(normalized.enabled),
    must_change_password: flagToBoolean(normalized.must_change_password),
    web_login_enabled: webLoginEnabled,
    project_access_all: flagToBoolean(normalized.project_access_all),
    allowed_project_ids: listAppUserProjectIds(normalized.id),
    feishu_open_id: feishuOpenId,
    created_at: normalized.created_at,
  };
}

export function listAppUsers(): AppUserPublic[] {
  const rows = db.prepare(`
    SELECT
      u.id,
      u.account,
      u.display_name,
      u.enabled,
      u.must_change_password,
      u.web_login_enabled,
      u.project_access_all,
      u.created_at,
      (
        SELECT fu.open_id
        FROM feishu_users fu
        WHERE fu.app_user_id = u.id
        ORDER BY fu.updated_at DESC, fu.open_id ASC
        LIMIT 1
      ) AS feishu_open_id
    FROM app_users u
    ORDER BY u.id DESC
  `).all() as Array<{
    id: number;
    account: string;
    display_name: string;
    enabled: boolean | number;
    must_change_password?: boolean | number;
    web_login_enabled?: boolean | number;
    project_access_all?: boolean | number;
    created_at: string;
    feishu_open_id?: string;
  }>;
  return normalizeRows(rows).map((row) => toPublicUser(row as AppUser, row.feishu_open_id));
}

export function getAppUserById(id: number): AppUser | undefined {
  const row = db.prepare("SELECT * FROM app_users WHERE id = ?").get(id) as AppUser | undefined;
  return row ? normalizeRow(row) : undefined;
}

export function getAppUserByAccount(account: string): AppUser | undefined {
  const row = db.prepare("SELECT * FROM app_users WHERE account = ?").get(account.trim()) as AppUser | undefined;
  return row ? normalizeRow(row) : undefined;
}

export function verifyAppUserCredentials(account: string, password: string): AppUserPublic | null {
  const row = getAppUserByAccount(account);
  if (!row || !row.enabled || !flagToBoolean(row.web_login_enabled)) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return toPublicUser(row);
}

export function createAppUser(input: {
  account: string;
  display_name?: string;
  enabled?: boolean;
  project_access_all?: boolean;
  allowed_project_ids?: number[];
}): AppUserPublic {
  const account = input.account.trim();
  if (!account) throw new Error("请填写账号");
  if (isFeishuPlaceholderAccount(account)) throw new Error("该账号格式不可用");
  const hash = hashPassword(DEFAULT_APP_USER_PASSWORD);
  const displayName = input.display_name?.trim() || account;
  const enabled = input.enabled === false ? 0 : 1;
  const projectAccessAll = input.project_access_all === true ? 1 : 0;
  const result = db.prepare(`
    INSERT INTO app_users(account, password_hash, display_name, enabled, must_change_password, web_login_enabled, project_access_all, created_at)
    VALUES (?, ?, ?, ?, 1, 1, ?, ?)
  `).run(account, hash, displayName, enabled, projectAccessAll, nowIso());
  const userId = Number(result.lastInsertRowid);
  setAppUserProjectAccess(userId, Boolean(projectAccessAll), input.allowed_project_ids ?? []);
  return toPublicUser(getAppUserById(userId)!);
}

export function createFeishuOnlyUser(input: {
  open_id: string;
  display_name?: string;
  enabled?: boolean;
}): AppUserPublic {
  const openId = input.open_id.trim();
  if (!openId) throw new Error("请填写 open_id");
  const account = feishuPlaceholderAccount(openId);
  const displayName = input.display_name?.trim() || `飞书用户 ${openId.slice(-6)}`;
  const enabled = input.enabled === false ? 0 : 1;
  const result = db.prepare(`
    INSERT INTO app_users(account, password_hash, display_name, enabled, must_change_password, web_login_enabled, project_access_all, created_at)
    VALUES (?, ?, ?, ?, 0, 0, 0, ?)
  `).run(account, unusablePasswordHash(), displayName, enabled, nowIso());
  const userId = Number(result.lastInsertRowid);
  setAppUserProjectAccess(userId, false, []);
  return toPublicUser(getAppUserById(userId)!, openId);
}

export function enableWebLoginForUser(userId: number, account: string): AppUserPublic {
  const row = getAppUserById(userId);
  if (!row) throw new Error("用户不存在");
  if (flagToBoolean(row.web_login_enabled)) throw new Error("该用户已开通 Web 登录");
  const nextAccount = account.trim();
  if (!nextAccount) throw new Error("请填写登录账号");
  if (isFeishuPlaceholderAccount(nextAccount)) throw new Error("该账号格式不可用");
  if (getAppUserByAccount(nextAccount)) throw new Error("账号已存在，请换一个账号");
  db.prepare(`
    UPDATE app_users
    SET account = ?, password_hash = ?, must_change_password = 1, web_login_enabled = 1
    WHERE id = ?
  `).run(nextAccount, hashPassword(DEFAULT_APP_USER_PASSWORD), userId);
  return toPublicUser(getAppUserById(userId)!);
}

export function updateAppUser(
  id: number,
  input: { display_name?: string; enabled?: boolean; password?: string; project_access_all?: boolean; allowed_project_ids?: number[] },
): AppUserPublic | null {
  const row = getAppUserById(id);
  if (!row) return null;
  const displayName = input.display_name !== undefined
    ? input.display_name.trim() || row.display_name || `用户 #${id}`
    : row.display_name;
  const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : Number(row.enabled);
  const projectAccessAll = input.project_access_all !== undefined
    ? (input.project_access_all ? 1 : 0)
    : Number(row.project_access_all ?? 0);
  if (input.password?.trim()) {
    if (!flagToBoolean(row.web_login_enabled)) throw new Error("该用户尚未开通 Web 登录，无法重置密码");
    db.prepare(`
      UPDATE app_users
      SET display_name = ?, enabled = ?, password_hash = ?, must_change_password = 1, project_access_all = ?
      WHERE id = ?
    `).run(displayName, enabled, hashPassword(input.password), projectAccessAll, id);
  } else {
    db.prepare("UPDATE app_users SET display_name = ?, enabled = ?, project_access_all = ? WHERE id = ?").run(
      displayName,
      enabled,
      projectAccessAll,
      id,
    );
  }
  if (input.project_access_all !== undefined || input.allowed_project_ids !== undefined) {
    setAppUserProjectAccess(id, Boolean(projectAccessAll), input.allowed_project_ids ?? listAppUserProjectIds(id));
  }
  return toPublicUser(getAppUserById(id)!);
}

export function changeAppUserPassword(userId: number, newPassword: string, currentPassword?: string): AppUserPublic {
  const row = getAppUserById(userId);
  if (!row) throw new Error("账号不存在");
  if (!flagToBoolean(row.web_login_enabled)) throw new Error("该用户尚未开通 Web 登录");
  const nextPassword = newPassword.trim();
  if (nextPassword.length < MIN_PASSWORD_LENGTH) throw new Error(`新密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  if (nextPassword === DEFAULT_APP_USER_PASSWORD) throw new Error("新密码不能与初始密码相同");
  if (currentPassword && !verifyPassword(currentPassword, row.password_hash)) {
    throw new Error("当前密码错误");
  }
  db.prepare("UPDATE app_users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(
    hashPassword(nextPassword),
    userId,
  );
  return toPublicUser(getAppUserById(userId)!);
}

export function deleteAppUser(id: number): boolean {
  const result = db.prepare("DELETE FROM app_users WHERE id = ?").run(id);
  return result.changes > 0;
}

export function recordAppUserLogin(input: {
  userId?: number | null;
  account: string;
  success: boolean;
  ip?: string;
  userAgent?: string;
  failureReason?: string;
}): void {
  db.prepare(`
    INSERT INTO app_user_login_records(user_id, account, success, ip, user_agent, failure_reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.userId ?? null,
    input.account.trim(),
    input.success ? 1 : 0,
    input.ip?.slice(0, 80) ?? "",
    input.userAgent?.slice(0, 500) ?? "",
    input.failureReason?.slice(0, 500) ?? "",
    nowIso(),
  );
}

export function listAppUserLoginRecords(input: { userId?: number; limit?: number } = {}): AppUserLoginRecord[] {
  const limit = Math.min(Math.max(Number(input.limit || 100), 1), 500);
  const params: number[] = [];
  let sql = `
    SELECT
      r.*,
      u.account AS user_account,
      COALESCE(NULLIF(u.display_name, ''), NULLIF(u.account, ''), '用户 #' || u.id) AS user_display_name
    FROM app_user_login_records r
    LEFT JOIN app_users u ON u.id = r.user_id
    WHERE 1=1
  `;
  if (input.userId) {
    sql += " AND r.user_id = ?";
    params.push(input.userId);
  }
  sql += " ORDER BY r.id DESC LIMIT ?";
  params.push(limit);
  return normalizeRows(db.prepare(sql).all(...params) as AppUserLoginRecord[]).map((row) => ({
    ...row,
    user_id: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
    success: flagToBoolean(row.success),
  }));
}

export function listAppUserProjectIds(userId: number): number[] {
  const rows = db.prepare("SELECT project_id FROM app_user_projects WHERE user_id = ? ORDER BY project_id ASC").all(userId) as Array<{ project_id: number }>;
  return rows.map((row) => Number(row.project_id));
}

export function setAppUserProjectAccess(userId: number, accessAll: boolean, projectIds: number[]): void {
  const uniqueProjectIds = [...new Set(projectIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  const existingProjectIds = filterExistingProjectIds(uniqueProjectIds);
  const tx = db.transaction(() => {
    db.prepare("UPDATE app_users SET project_access_all = ? WHERE id = ?").run(accessAll ? 1 : 0, userId);
    db.prepare("DELETE FROM app_user_projects WHERE user_id = ?").run(userId);
    if (!accessAll) {
      const insert = db.prepare("INSERT OR IGNORE INTO app_user_projects(user_id, project_id) VALUES (?, ?)");
      for (const projectId of existingProjectIds) insert.run(userId, projectId);
    }
  });
  tx();
}

function filterExistingProjectIds(projectIds: number[]): number[] {
  if (!projectIds.length) return [];
  const placeholders = projectIds.map(() => "?").join(",");
  const rows = db.prepare(`SELECT id FROM projects WHERE id IN (${placeholders})`).all(...projectIds) as Array<{ id: number }>;
  const existing = new Set(rows.map((row) => Number(row.id)));
  return projectIds.filter((id) => existing.has(id));
}
