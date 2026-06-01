import { FEISHU_SETTING_KEYS, getFeishuAppSecretRaw } from "./config.js";
import { getSetting } from "../../db.js";
import type { FeishuInteractiveCard } from "./cards.js";

const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";

interface TenantTokenCache {
  token: string;
  expiresAt: number;
}

let tenantTokenCache: TenantTokenCache | null = null;

function getFeishuAppIdRaw(): string {
  return getSetting(FEISHU_SETTING_KEYS.appId).trim();
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json() as T & { code?: number; msg?: string };
  if (!response.ok || (typeof data.code === "number" && data.code !== 0)) {
    throw new Error(`飞书 API 失败：${data.msg || response.statusText || response.status}`);
  }
  return data;
}

export async function getFeishuTenantAccessToken(): Promise<string> {
  const now = Date.now();
  if (tenantTokenCache && tenantTokenCache.expiresAt > now + 60_000) {
    return tenantTokenCache.token;
  }

  const appId = getFeishuAppIdRaw();
  const appSecret = getFeishuAppSecretRaw();
  if (!appId || !appSecret) {
    throw new Error("未配置飞书 App ID / App Secret");
  }

  const data = await fetchJson<{
    code: number;
    msg: string;
    tenant_access_token: string;
    expire: number;
  }>(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });

  tenantTokenCache = {
    token: data.tenant_access_token,
    expiresAt: now + Math.max(60, Number(data.expire || 7200)) * 1000,
  };
  return tenantTokenCache.token;
}

export function splitFeishuText(text: string, maxLen = 3500): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= maxLen) return [normalized];
  const chunks: string[] = [];
  let rest = normalized;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendFeishuMessageRequest(path: string, body: Record<string, unknown>): Promise<void> {
  const token = await getFeishuTenantAccessToken();
  await fetchJson(`${FEISHU_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

export async function sendFeishuTextToChat(chatId: string, text: string): Promise<void> {
  const chunks = splitFeishuText(text);
  for (const chunk of chunks) {
    await sendFeishuMessageRequest("/im/v1/messages?receive_id_type=chat_id", {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text: chunk }),
    });
  }
}

export async function replyFeishuText(messageId: string, text: string): Promise<void> {
  const chunks = splitFeishuText(text);
  for (const chunk of chunks) {
    await sendFeishuMessageRequest(`/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: "text",
      content: JSON.stringify({ text: chunk }),
    });
  }
}

export async function deliverFeishuText(input: { chatId: string; messageId?: string; text: string }): Promise<void> {
  if (!input.text.trim()) return;
  if (input.messageId) {
    await replyFeishuText(input.messageId, input.text);
    return;
  }
  await sendFeishuTextToChat(input.chatId, input.text);
}

export async function sendFeishuInteractiveCardToChat(chatId: string, card: FeishuInteractiveCard): Promise<void> {
  await sendFeishuMessageRequest("/im/v1/messages?receive_id_type=chat_id", {
    receive_id: chatId,
    msg_type: "interactive",
    content: JSON.stringify(card),
  });
}

export async function replyFeishuInteractiveCard(messageId: string, card: FeishuInteractiveCard): Promise<void> {
  await sendFeishuMessageRequest(`/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
    msg_type: "interactive",
    content: JSON.stringify(card),
  });
}

export async function deliverFeishuInteractiveCard(input: {
  chatId: string;
  messageId?: string;
  card: FeishuInteractiveCard;
}): Promise<void> {
  if (input.messageId) {
    await replyFeishuInteractiveCard(input.messageId, input.card);
    return;
  }
  await sendFeishuInteractiveCardToChat(input.chatId, input.card);
}

export interface FeishuChatInfo {
  chat_id: string;
  name: string;
  description: string;
  chat_type: "group" | "p2p";
}

function resolveFeishuChatName(data: {
  name?: string;
  i18n_names?: { zh_cn?: string; en_us?: string; ja_jp?: string };
}): string {
  return data.name?.trim()
    || data.i18n_names?.zh_cn?.trim()
    || data.i18n_names?.en_us?.trim()
    || data.i18n_names?.ja_jp?.trim()
    || "";
}

export async function fetchFeishuChatInfo(chatId: string): Promise<FeishuChatInfo> {
  const trimmed = chatId.trim();
  if (!trimmed) throw new Error("请填写 chat_id");
  const token = await getFeishuTenantAccessToken();
  const data = await fetchJson<{
    data?: {
      name?: string;
      description?: string;
      chat_mode?: string;
      i18n_names?: { zh_cn?: string; en_us?: string; ja_jp?: string };
    };
  }>(`${FEISHU_API_BASE}/im/v1/chats/${encodeURIComponent(trimmed)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = data.data ?? {};
  const chatMode = payload.chat_mode?.trim().toLowerCase() ?? "";
  return {
    chat_id: trimmed,
    name: resolveFeishuChatName(payload),
    description: payload.description?.trim() ?? "",
    chat_type: chatMode === "p2p" ? "p2p" : "group",
  };
}
