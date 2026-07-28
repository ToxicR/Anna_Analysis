import type { FeishuIncomingAttachment } from "./files.js";
import { extractFeishuMessageAttachments } from "./files.js";

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

interface CachedMessage {
  attachments: FeishuIncomingAttachment[];
  expiresAt: number;
}

const cache = new Map<string, CachedMessage>();

function prune(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

/** Cache attachments from a webhook we already received (avoids re-fetching parent via API). */
export function cacheFeishuWebhookMessage(messageId: string, messageType?: string, content?: string): void {
  const trimmed = messageId.trim();
  if (!trimmed) return;
  const attachments = extractFeishuMessageAttachments(messageType, content);
  if (!attachments.length) return;
  prune();
  cache.set(trimmed, { attachments, expiresAt: Date.now() + TTL_MS });
}

export function getCachedFeishuMessageAttachments(messageId: string): FeishuIncomingAttachment[] {
  const trimmed = messageId.trim();
  if (!trimmed) return [];
  const entry = cache.get(trimmed);
  if (!entry) return [];
  if (entry.expiresAt <= Date.now()) {
    cache.delete(trimmed);
    return [];
  }
  return entry.attachments.map((item) => ({ ...item }));
}
