import type { FeishuBotIdentity } from "./api.js";

export interface FeishuMessageMention {
  key?: string;
  name?: string;
  tenant_key?: string;
  id?: {
    open_id?: string;
    union_id?: string;
    user_id?: string;
  };
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function mentionRefersToBot(mention: FeishuMessageMention, bot: FeishuBotIdentity): boolean {
  const mentionOpenId = mention.id?.open_id?.trim() ?? "";
  if (mentionOpenId && bot.openId && mentionOpenId === bot.openId) {
    return true;
  }

  const mentionName = normalizeLabel(mention.name ?? "");
  const botName = normalizeLabel(bot.appName);
  if (mentionName && botName) {
    if (mentionName === botName) return true;
    if (mentionName.includes(botName) || botName.includes(mentionName)) return true;
  }

  return false;
}

/** 群聊中是否 @ 了本机器人（私聊始终为 true）。 */
export function isFeishuGroupMessageAddressedToBot(input: {
  chatType: string;
  mentions?: FeishuMessageMention[];
  bot: FeishuBotIdentity;
}): boolean {
  if (input.chatType === "p2p") return true;

  const mentions = input.mentions ?? [];
  if (!mentions.length) return false;

  return mentions.some((mention) => mentionRefersToBot(mention, input.bot));
}
