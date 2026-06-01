import { getFeishuTenantAccessToken } from "./api.js";
import { listCachedFeishuContacts } from "./contacts-cache.js";
import { getFeishuDirectoryCache, invalidateFeishuDirectoryCache, setFeishuDirectoryCache } from "./directory-cache.js";

export { invalidateFeishuDirectoryCache };

const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";
const MAX_USERS = 800;
const MAX_DEPARTMENTS = 200;
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface FeishuDirectoryUser {
  open_id: string;
  union_id: string;
  name: string;
  user_id?: string;
  mobile?: string;
}

export interface FeishuDirectorySearchResult {
  users: FeishuDirectoryUser[];
  hasMore: boolean;
  pageToken: string;
  meta: {
    totalLoaded: number;
    namedCount: number;
    canSearchByName: boolean;
    hint: string;
  };
}

interface FeishuApiResponse<T> {
  code?: number;
  msg?: string;
  data?: T;
}

interface FeishuUserRecord {
  open_id?: string;
  union_id?: string;
  user_id?: string;
  name?: string;
  mobile?: string;
}

export function normalizeMobileAccount(mobile: string): string {
  const digits = mobile.replace(/\D/g, "");
  if (digits.startsWith("86") && digits.length === 13) return digits.slice(2);
  return digits;
}

export function isValidChinaMobileAccount(value: string): boolean {
  return /^1\d{10}$/.test(value);
}

async function feishuApiGet<T>(path: string): Promise<T> {
  const token = await getFeishuTenantAccessToken();
  const response = await fetch(`${FEISHU_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await response.json() as FeishuApiResponse<T>;
  if (!response.ok || (typeof payload.code === "number" && payload.code !== 0)) {
    throw new Error(`飞书通讯录 API 失败：${payload.msg || response.statusText || response.status}`);
  }
  return payload.data as T;
}

function looksLikeRealName(name: string, openId: string, userId?: string): boolean {
  const normalized = name.trim();
  if (!normalized) return false;
  if (normalized === openId) return false;
  if (userId && normalized === userId) return false;
  return !/^ou_[0-9a-f]+$/i.test(normalized);
}

function normalizeUser(user: FeishuUserRecord): FeishuDirectoryUser | null {
  const open_id = user.open_id?.trim() ?? "";
  if (!open_id) return null;
  const user_id = user.user_id?.trim() ?? "";
  const name = user.name?.trim() || user_id || open_id;
  const mobileRaw = user.mobile?.trim() ?? "";
  const mobile = mobileRaw ? normalizeMobileAccount(mobileRaw) : "";
  return {
    open_id,
    union_id: user.union_id?.trim() ?? "",
    user_id,
    name,
    mobile: isValidChinaMobileAccount(mobile) ? mobile : "",
  };
}

function addUser(map: Map<string, FeishuDirectoryUser>, user: FeishuUserRecord): void {
  const normalized = normalizeUser(user);
  if (normalized) map.set(normalized.open_id, normalized);
}

function mergeCachedContacts(map: Map<string, FeishuDirectoryUser>): void {
  for (const row of listCachedFeishuContacts(2000)) {
    const openId = row.open_id.trim();
    if (!openId) continue;
    const existing = map.get(openId);
    if (existing) {
      if (row.name) existing.name = row.name;
      if (row.union_id) existing.union_id = row.union_id;
      if (row.user_id) existing.user_id = row.user_id;
      continue;
    }
    map.set(openId, {
      open_id: openId,
      union_id: row.union_id || "",
      user_id: row.user_id || "",
      name: row.name || row.user_id || openId,
    });
  }
}

async function listUsersPage(path: string): Promise<{
  items: FeishuUserRecord[];
  hasMore: boolean;
  pageToken: string;
}> {
  const data = await feishuApiGet<{
    items?: FeishuUserRecord[];
    has_more?: boolean;
    page_token?: string;
  }>(path);
  return {
    items: data.items ?? [],
    hasMore: Boolean(data.has_more),
    pageToken: data.page_token?.trim() ?? "",
  };
}

async function fetchScopedDepartmentsAndUsers(): Promise<{ departmentIds: string[]; userIds: string[] }> {
  const departmentIds: string[] = [];
  const userIds: string[] = [];
  let pageToken = "";

  do {
    const params = new URLSearchParams({
      user_id_type: "user_id",
      department_id_type: "open_department_id",
      page_size: "100",
    });
    if (pageToken) params.set("page_token", pageToken);

    const scope = await feishuApiGet<{
      department_ids?: string[];
      user_ids?: string[];
      has_more?: boolean;
      page_token?: string;
    }>(`/contact/v3/scopes?${params}`);

    departmentIds.push(...(scope.department_ids ?? []));
    userIds.push(...(scope.user_ids ?? []));
    pageToken = scope.has_more ? (scope.page_token?.trim() ?? "") : "";
  } while (pageToken);

  return { departmentIds, userIds };
}

async function fetchUsersByUserIds(userIds: string[], map: Map<string, FeishuDirectoryUser>): Promise<void> {
  const uniqueIds = [...new Set(userIds.map((id) => id.trim()).filter(Boolean))];
  for (let index = 0; index < uniqueIds.length; index += 50) {
    if (map.size >= MAX_USERS) return;
    const chunk = uniqueIds.slice(index, index + 50);
    const params = new URLSearchParams({ user_id_type: "user_id" });
    for (const id of chunk) params.append("user_ids", id);
    const batch = await feishuApiGet<{ items?: FeishuUserRecord[] }>(`/contact/v3/users/batch?${params}`);
    for (const user of batch.items ?? []) addUser(map, user);
  }
}

async function fetchAllDepartments(rootDepartmentIds: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const roots = [...new Set(rootDepartmentIds.map((id) => id.trim()).filter(Boolean))];

  for (const rootId of roots) {
    seen.add(rootId);
    let pageToken = "";
    do {
      if (seen.size >= MAX_DEPARTMENTS) break;
      const params = new URLSearchParams({
        department_id_type: "open_department_id",
        page_size: "50",
        fetch_child: "true",
      });
      if (pageToken) params.set("page_token", pageToken);
      try {
        const data = await feishuApiGet<{
          items?: Array<{ open_department_id?: string }>;
          has_more?: boolean;
          page_token?: string;
        }>(`/contact/v3/departments/${encodeURIComponent(rootId)}/children?${params}`);
        for (const item of data.items ?? []) {
          const childId = item.open_department_id?.trim();
          if (childId) seen.add(childId);
          if (seen.size >= MAX_DEPARTMENTS) break;
        }
        pageToken = data.has_more ? (data.page_token?.trim() ?? "") : "";
      } catch {
        pageToken = "";
      }
    } while (pageToken);
    if (seen.size >= MAX_DEPARTMENTS) break;
  }

  return [...seen];
}

async function fetchUsersByDepartment(departmentId: string, map: Map<string, FeishuDirectoryUser>): Promise<void> {
  let pageToken = "";
  do {
    if (map.size >= MAX_USERS) return;
    const params = new URLSearchParams({
      department_id: departmentId,
      department_id_type: "open_department_id",
      user_id_type: "open_id",
      page_size: "50",
    });
    if (pageToken) params.set("page_token", pageToken);
    const page = await listUsersPage(`/contact/v3/users/find_by_department?${params}`);
    for (const user of page.items) {
      addUser(map, user);
      if (map.size >= MAX_USERS) return;
    }
    pageToken = page.hasMore ? page.pageToken : "";
  } while (pageToken);
}

async function collectAuthorizedUsers(): Promise<{ users: FeishuDirectoryUser[]; truncated: boolean }> {
  const map = new Map<string, FeishuDirectoryUser>();
  const { departmentIds, userIds } = await fetchScopedDepartmentsAndUsers();

  await fetchUsersByUserIds(userIds, map);

  const allDepartments = await fetchAllDepartments(departmentIds);
  for (const departmentId of allDepartments) {
    try {
      await fetchUsersByDepartment(departmentId, map);
    } catch {
      // 单个部门失败时跳过。
    }
    if (map.size >= MAX_USERS) break;
  }

  mergeCachedContacts(map);

  return {
    users: [...map.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
    truncated: map.size >= MAX_USERS,
  };
}

function buildDirectoryMeta(users: FeishuDirectoryUser[], truncated = false): FeishuDirectorySearchResult["meta"] {
  const namedCount = users.filter((user) => looksLikeRealName(user.name, user.open_id, user.user_id)).length;
  const canSearchByName = users.length > 0 && namedCount >= Math.min(3, Math.ceil(users.length * 0.2));
  const truncatedNote = truncated ? "（已达加载上限，请在飞书扩大通讯录权限范围）" : "";
  const hint = users.length > 0
    ? canSearchByName
      ? `共 ${users.length} 位联系人，${namedCount} 位有飞书姓名。在筛选框输入中文名（如「韩日日」）即可定位，点击后保存绑定。${truncatedNote}`
      : `共 ${users.length} 位联系人，但飞书尚未返回中文姓名。请确认已开通「获取通讯录基本信息」+「获取用户基本信息」并发布新版本，然后点「重新加载」。${truncatedNote}`
    : "未加载到联系人。需开通「获取通讯录基本信息」(contact:contact.base:readonly) 与「获取用户基本信息」(contact:user.base:readonly)，配置通讯录权限范围并发布应用版本。";
  return { totalLoaded: users.length, namedCount, canSearchByName, hint };
}

function matchesQuery(user: FeishuDirectoryUser, query: string): boolean {
  const haystacks = [user.name, user.open_id, user.user_id ?? ""].map((value) => value.toLowerCase());
  return haystacks.some((value) => value.includes(query));
}

async function getAuthorizedUsers(): Promise<{ users: FeishuDirectoryUser[]; truncated: boolean }> {
  const now = Date.now();
  const cachedUsers = getFeishuDirectoryCache();
  if (cachedUsers && now - cachedUsers.fetchedAt < CACHE_TTL_MS) {
    return { users: cachedUsers.users, truncated: Boolean(cachedUsers.truncated) };
  }
  const collected = await collectAuthorizedUsers();
  setFeishuDirectoryCache({ fetchedAt: now, users: collected.users, truncated: collected.truncated });
  return collected;
}

export async function listFeishuDirectoryUsers(input: {
  query?: string;
  pageToken?: string;
  pageSize?: number;
}): Promise<FeishuDirectorySearchResult> {
  const { users: allUsers, truncated } = await getAuthorizedUsers();
  const meta = buildDirectoryMeta(allUsers, truncated);
  const query = input.query?.trim().toLowerCase() ?? "";
  const filtered = query ? allUsers.filter((user) => matchesQuery(user, query)) : allUsers;
  const pageSize = Math.min(Math.max(input.pageSize ?? 50, 1), 100);
  const offset = Math.max(0, Number.parseInt(input.pageToken?.trim() || "0", 10) || 0);
  const page = filtered.slice(offset, offset + pageSize);
  const nextOffset = offset + pageSize;

  return {
    users: page,
    hasMore: nextOffset < filtered.length,
    pageToken: nextOffset < filtered.length ? String(nextOffset) : "",
    meta: query && !filtered.length
      ? { ...meta, hint: `筛选「${input.query?.trim()}」无结果。${meta.hint}` }
      : meta,
  };
}

export async function fetchFeishuUserProfile(openId: string): Promise<FeishuDirectoryUser | null> {
  const trimmed = openId.trim();
  if (!trimmed) return null;
  try {
    const data = await feishuApiGet<{ user?: FeishuUserRecord }>(
      `/contact/v3/users/${encodeURIComponent(trimmed)}?user_id_type=open_id`,
    );
    return data.user ? normalizeUser(data.user) : null;
  } catch {
    return null;
  }
}

export function suggestWebLoginAccount(input: {
  userId: number;
  displayName: string;
  feishuOpenId?: string;
  feishuUserId?: string;
  feishuMobile?: string;
}): { account: string; source: "mobile" | "employee_id" | "display_name" | "fallback" } {
  const mobile = input.feishuMobile?.trim() ?? "";
  if (isValidChinaMobileAccount(mobile)) {
    return { account: mobile, source: "mobile" };
  }
  const employeeId = input.feishuUserId?.trim() ?? "";
  if (employeeId && !employeeId.startsWith("ou_")) {
    return { account: employeeId, source: "employee_id" };
  }
  const name = input.displayName.trim();
  if (name && !name.startsWith("飞书用户")) {
    return { account: name.replace(/\s+/g, ""), source: "display_name" };
  }
  return { account: `u${input.userId}`, source: "fallback" };
}

export async function resolveWebLoginAccountSuggestion(input: {
  userId: number;
  displayName: string;
  feishuOpenId?: string;
}): Promise<{ account: string; source: string; mobile_available: boolean }> {
  let profile: FeishuDirectoryUser | null = null;
  if (input.feishuOpenId) {
    profile = await fetchFeishuUserProfile(input.feishuOpenId);
  }
  const suggestion = suggestWebLoginAccount({
    userId: input.userId,
    displayName: profile?.name || input.displayName,
    feishuOpenId: input.feishuOpenId,
    feishuUserId: profile?.user_id,
    feishuMobile: profile?.mobile,
  });
  return {
    account: suggestion.account,
    source: suggestion.source,
    mobile_available: Boolean(profile?.mobile),
  };
}

/** @deprecated use listFeishuDirectoryUsers */
export async function searchFeishuDirectoryUsers(input: {
  query: string;
  pageToken?: string;
  pageSize?: number;
}): Promise<FeishuDirectorySearchResult> {
  return listFeishuDirectoryUsers(input);
}

export async function listRecentFeishuDirectoryUsers(limit = 30): Promise<{
  users: FeishuDirectoryUser[];
  meta: FeishuDirectorySearchResult["meta"];
}> {
  const cached = listCachedFeishuContacts(limit).map((row) => ({
    open_id: row.open_id,
    union_id: row.union_id || "",
    user_id: row.user_id || "",
    name: row.name || row.user_id || row.open_id,
  }));
  const { users: allUsers, truncated } = await getAuthorizedUsers();
  return {
    users: cached,
    meta: buildDirectoryMeta(allUsers, truncated),
  };
}
