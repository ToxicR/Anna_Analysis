import { getFeishuTenantAccessToken } from "./api.js";
import { db } from "../../db.js";
import { invalidateFeishuDirectoryCache } from "./directory-cache.js";

const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";

export interface CachedFeishuContact {
  open_id: string;
  union_id: string;
  user_id: string;
  name: string;
  source: string;
  last_seen_at: string;
}

export function listCachedFeishuContacts(limit = 100): CachedFeishuContact[] {
  return db.prepare(`
    SELECT open_id, union_id, user_id, name, source, last_seen_at
    FROM feishu_contacts
    ORDER BY last_seen_at DESC
    LIMIT ?
  `).all(limit) as CachedFeishuContact[];
}

export function touchFeishuContact(input: {
  open_id: string;
  union_id?: string;
  user_id?: string;
  name?: string;
  source: string;
}): void {
  const openId = input.open_id.trim();
  if (!openId) return;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO feishu_contacts(open_id, union_id, user_id, name, source, last_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(open_id) DO UPDATE SET
      union_id = CASE WHEN excluded.union_id != '' THEN excluded.union_id ELSE feishu_contacts.union_id END,
      user_id = CASE WHEN excluded.user_id != '' THEN excluded.user_id ELSE feishu_contacts.user_id END,
      name = CASE WHEN excluded.name != '' THEN excluded.name ELSE feishu_contacts.name END,
      source = excluded.source,
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at
  `).run(
    openId,
    input.union_id?.trim() ?? "",
    input.user_id?.trim() ?? "",
    input.name?.trim() ?? "",
    input.source,
    now,
    now,
  );
  invalidateFeishuDirectoryCache();
}

async function fetchFeishuUserProfile(openId: string): Promise<{
  open_id: string;
  union_id: string;
  user_id: string;
  name: string;
} | null> {
  const token = await getFeishuTenantAccessToken();
  const params = new URLSearchParams({ user_id_type: "open_id" });
  params.append("user_ids", openId);
  const response = await fetch(`${FEISHU_API_BASE}/contact/v3/users/batch?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await response.json() as {
    code?: number;
    data?: { items?: Array<{ open_id?: string; union_id?: string; user_id?: string; name?: string }> };
  };
  if (!response.ok || payload.code !== 0) return null;
  const user = payload.data?.items?.[0];
  if (!user?.open_id?.trim()) return null;
  return {
    open_id: user.open_id.trim(),
    union_id: user.union_id?.trim() ?? "",
    user_id: user.user_id?.trim() ?? "",
    name: user.name?.trim() ?? "",
  };
}

export async function enrichFeishuContactFromApi(openId: string, unionId = ""): Promise<void> {
  const profile = await fetchFeishuUserProfile(openId);
  touchFeishuContact({
    open_id: openId,
    union_id: profile?.union_id || unionId,
    user_id: profile?.user_id,
    name: profile?.name,
    source: "api",
  });
}

export function recordFeishuContactFromWebhook(openId: string, unionId = ""): void {
  touchFeishuContact({ open_id: openId, union_id: unionId, source: "webhook" });
  void enrichFeishuContactFromApi(openId, unionId).catch(() => {
    // 无通讯录权限或用户不在授权范围时忽略。
  });
}
