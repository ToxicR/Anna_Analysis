import { db, flagToBoolean, normalizeRow, normalizeRows } from "../../db.js";
import { getAppUserById } from "../app-users.js";
import type { FeishuAvailableProject } from "../../types.js";

export function getUserProjectIds(userId: number): { all: boolean; projectIds: number[] } {
  const user = getAppUserById(userId);
  if (!user || flagToBoolean(user.project_access_all)) return { all: true, projectIds: [] };
  const rows = db.prepare("SELECT project_id FROM app_user_projects WHERE user_id = ? ORDER BY project_id ASC").all(userId) as Array<{ project_id: number }>;
  return { all: false, projectIds: rows.map((row) => Number(row.project_id)) };
}

export function getChatProjectIds(chatId: string): number[] {
  const rows = db.prepare(`
    SELECT cp.project_id
    FROM feishu_chat_projects cp
    INNER JOIN feishu_chats c ON c.chat_id = cp.chat_id
    WHERE cp.chat_id = ? AND c.enabled = 1
    ORDER BY cp.project_id ASC
  `).all(chatId) as Array<{ project_id: number }>;
  return rows.map((row) => Number(row.project_id));
}

function listEnabledProjects(): FeishuAvailableProject[] {
  return normalizeRows(db.prepare(`
    SELECT id, name, code FROM projects WHERE enabled = 1 ORDER BY id ASC
  `).all() as FeishuAvailableProject[]);
}

function filterProjectsByUserAccess(
  projects: FeishuAvailableProject[],
  userAccess: { all: boolean; projectIds: number[] },
): FeishuAvailableProject[] {
  if (userAccess.all) return projects;
  const allowed = new Set(userAccess.projectIds);
  return projects.filter((project) => allowed.has(project.id));
}

export function resolveAvailableProjects(input: {
  chatId: string;
  appUserId: number;
  chatType?: string;
}): FeishuAvailableProject[] {
  const chatType = input.chatType?.trim() || "group";
  const userAccess = getUserProjectIds(input.appUserId);
  const allProjects = listEnabledProjects();

  if (chatType === "p2p") {
    return filterProjectsByUserAccess(allProjects, userAccess);
  }

  const chatProjectIds = getChatProjectIds(input.chatId);
  if (!chatProjectIds.length) return [];

  const chatProjects = allProjects.filter((project) => chatProjectIds.includes(project.id));
  return filterProjectsByUserAccess(chatProjects, userAccess);
}

export function userCanAccessProjectForFeishu(appUserId: number, chatId: string, projectId: number, chatType = "group"): boolean {
  const available = resolveAvailableProjects({ chatId, appUserId, chatType });
  return available.some((project) => project.id === projectId);
}

export function getFeishuBinding(appUserId: number): { open_id: string; display_name: string } | undefined {
  const row = db.prepare(`
    SELECT open_id, display_name FROM feishu_users
    WHERE app_user_id = ? AND enabled = 1
    LIMIT 1
  `).get(appUserId) as { open_id: string; display_name: string } | undefined;
  return row ? normalizeRow(row) : undefined;
}
