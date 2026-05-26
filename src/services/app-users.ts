import { db, normalizeRow, normalizeRows, nowIso } from "../db.js";
import { hashPassword, verifyPassword } from "../password.js";
import type { AppUser, AppUserPublic } from "../types.js";

export function toPublicUser(row: AppUser): AppUserPublic {
  const normalized = normalizeRow(row);
  return {
    id: normalized.id,
    account: normalized.account,
    display_name: normalized.display_name || normalized.account,
    enabled: Boolean(normalized.enabled),
    created_at: normalized.created_at,
  };
}

export function listAppUsers(): AppUserPublic[] {
  const rows = db.prepare(`
    SELECT id, account, display_name, enabled, created_at
    FROM app_users ORDER BY id DESC
  `).all() as AppUserPublic[];
  return normalizeRows(rows).map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
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
  password: string;
  display_name?: string;
  enabled?: boolean;
}): AppUserPublic {
  const account = input.account.trim();
  if (!account) throw new Error("请填写账号");
  if (!input.password) throw new Error("请填写密码");
  const hash = hashPassword(input.password);
  const displayName = input.display_name?.trim() || account;
  const enabled = input.enabled === false ? 0 : 1;
  const result = db.prepare(`
    INSERT INTO app_users(account, password_hash, display_name, enabled, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(account, hash, displayName, enabled, nowIso());
  return toPublicUser(getAppUserById(Number(result.lastInsertRowid))!);
}

export function updateAppUser(
  id: number,
  input: { display_name?: string; enabled?: boolean; password?: string },
): AppUserPublic | null {
  const row = getAppUserById(id);
  if (!row) return null;
  const displayName = input.display_name !== undefined ? input.display_name.trim() || row.account : row.display_name;
  const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : Number(row.enabled);
  if (input.password?.trim()) {
    db.prepare("UPDATE app_users SET display_name = ?, enabled = ?, password_hash = ? WHERE id = ?").run(
      displayName,
      enabled,
      hashPassword(input.password),
      id,
    );
  } else {
    db.prepare("UPDATE app_users SET display_name = ?, enabled = ? WHERE id = ?").run(displayName, enabled, id);
  }
  return toPublicUser(getAppUserById(id)!);
}

export function deleteAppUser(id: number): boolean {
  const result = db.prepare("DELETE FROM app_users WHERE id = ?").run(id);
  return result.changes > 0;
}
