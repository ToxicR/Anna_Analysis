import { randomUUID } from "crypto";
import { getFeishuTenantAccessToken } from "./api.js";

const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";
export const FEISHU_STREAMING_ELEMENT_ID = "anna_analysis_md";

export interface FeishuStreamingCardTemplate {
  title: string;
  initialContent: string;
}

function buildStreamingCardJson(input: FeishuStreamingCardTemplate): string {
  return JSON.stringify({
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: true,
      summary: { content: "Anna 分析中…" },
      streaming_config: {
        print_frequency_ms: { default: 70, android: 70, ios: 70, pc: 70 },
        print_step: { default: 2, android: 2, ios: 2, pc: 2 },
        print_strategy: "fast",
      },
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: input.title },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: input.initialContent,
          element_id: FEISHU_STREAMING_ELEMENT_ID,
        },
      ],
    },
  });
}

async function feishuCardkitRequest<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T & { code?: number; msg?: string }> {
  const token = await getFeishuTenantAccessToken();
  const response = await fetch(`${FEISHU_API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json() as T & { code?: number; msg?: string };
  if (!response.ok || (typeof data.code === "number" && data.code !== 0)) {
    throw new Error(`飞书 CardKit 失败：${data.msg || response.statusText || response.status}`);
  }
  return data;
}

export async function createFeishuStreamingCardEntity(
  template: FeishuStreamingCardTemplate = { title: "Anna Analysis", initialContent: "正在准备分析…" },
): Promise<string> {
  const data = await feishuCardkitRequest<{ data?: { card_id?: string } }>("POST", "/cardkit/v1/cards", {
    type: "card_json",
    data: buildStreamingCardJson(template),
  });
  const cardId = data.data?.card_id?.trim();
  if (!cardId) throw new Error("飞书 CardKit 未返回 card_id");
  return cardId;
}

export async function sendFeishuCardEntityToChat(chatId: string, cardId: string): Promise<void> {
  await feishuCardkitRequest("POST", "/im/v1/messages?receive_id_type=chat_id", {
    receive_id: chatId,
    msg_type: "interactive",
    content: JSON.stringify({
      type: "card",
      data: { card_id: cardId },
    }),
  });
}

export async function updateFeishuStreamingCardContent(input: {
  cardId: string;
  content: string;
  sequence: number;
}): Promise<void> {
  await feishuCardkitRequest(
    "PUT",
    `/cardkit/v1/cards/${encodeURIComponent(input.cardId)}/elements/${encodeURIComponent(FEISHU_STREAMING_ELEMENT_ID)}/content`,
    {
      uuid: randomUUID(),
      content: input.content,
      sequence: input.sequence,
    },
  );
}

export async function closeFeishuStreamingCard(input: {
  cardId: string;
  sequence: number;
  summary?: string;
}): Promise<void> {
  const config: Record<string, unknown> = { streaming_mode: false };
  if (input.summary?.trim()) {
    config.summary = { content: input.summary.trim().slice(0, 80) };
  }
  await feishuCardkitRequest(
    "PATCH",
    `/cardkit/v1/cards/${encodeURIComponent(input.cardId)}/settings`,
    {
      uuid: randomUUID(),
      settings: JSON.stringify({ config }),
      sequence: input.sequence,
    },
  );
}
