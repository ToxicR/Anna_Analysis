import { db, flagToBoolean, normalizeRow, normalizeRows, nowIso } from "../db.js";
import { hashPassword, verifyPassword } from "../password.js";
import type { AppUser, AppUserLoginRecord, AppUserPublic } from "../types.js";

export const DEFAULT_APP_USER_PASSWORD = "123456";
const MIN_PASSWORD_LENGTH = 6;

export function toPublicUser(row: AppUser): AppUserPublic {
  const normalized = normalizeRow(row);
  return {
    id: normalized.id,
    account: normalized.account,
    display_name: normalized.display_name || normalized.account,
    enabled: Boolean(normalized.enabled),
    must_change_password: flagToBoolean(normalized.must_change_password),
    project_access_all: flagToBoolean(normalized.project_access_all ?? true),
    allowed_project_ids: listAppUserProjectIds(normalized.id),
    created_at: normalized.created_at,
  };
}

export function listAppUsers(): AppUserPublic[] {
  const rows = db.prepare(`
    SELECT id, account, display_name, enabled, must_change_password, project_access_all, created_at
    FROM app_users ORDER BY id DESC
  `).all() as AppUserPublic[];
  return normalizeRows(rows).map((row) => ({
    ...row,
    enabled: Boolean(row.enabled),
    must_change_password: flagToBoolean(row.must_change_password),
    project_access_all: flagToBoolean(row.project_access_all),
    allowed_project_ids: listAppUserProjectIds(row.id),
  }));
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
  if (!row || !row.enabled) return null;
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
  const hash = hashPassword(DEFAULT_APP_USER_PASSWORD);
  const displayName = input.display_name?.trim() || account;
  const enabled = input.enabled === false ? 0 : 1;
  const projectAccessAll = input.project_access_all === false ? 0 : 1;
  const result = db.prepare(`
    INSERT INTO app_users(account, password_hash, display_name, enabled, must_change_password, project_access_all, created_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(account, hash, displayName, enabled, projectAccessAll, nowIso());
  const userId = Number(result.lastInsertRowid);
  setAppUserProjectAccess(userId, Boolean(projectAccessAll), input.allowed_project_ids ?? []);
  return toPublicUser(getAppUserById(userId)!);
}

export function updateAppUser(
  id: number,
  input: { display_name?: string; enabled?: boolean; password?: string; project_access_all?: boolean; allowed_project_ids?: number[] },
): AppUserPublic | null {
  const row = getAppUserById(id);
  if (!row) return null;
  const displayName = input.display_name !== undefined ? input.display_name.trim() || row.account : row.display_name;
  const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : Number(row.enabled);
  const projectAccessAll = input.project_access_all !== undefined
    ? (input.project_access_all ? 1 : 0)
    : Number(row.project_access_all ?? 1);
  if (input.password?.trim()) {
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
      COALESCE(NULLIF(u.display_name, ''), u.account) AS user_display_name
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
