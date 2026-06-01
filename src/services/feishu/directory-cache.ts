export interface CachedFeishuDirectoryEntry {
  open_id: string;
  union_id: string;
  name: string;
  user_id?: string;
}

let cachedUsers: { fetchedAt: number; users: CachedFeishuDirectoryEntry[]; truncated?: boolean } | null = null;

export function getFeishuDirectoryCache(): typeof cachedUsers {
  return cachedUsers;
}

export function setFeishuDirectoryCache(value: typeof cachedUsers): void {
  cachedUsers = value;
}

export function invalidateFeishuDirectoryCache(): void {
  cachedUsers = null;
}
