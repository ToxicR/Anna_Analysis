import { sendFeishuTextToChat } from "./api.js";

export class FeishuProgressReporter {
  private lastSentAt = 0;
  private lastMessage = "";

  constructor(
    private chatId: string,
    private minIntervalMs = 20_000,
  ) {}

  async maybeSend(message: string): Promise<void> {
    const normalized = message.trim();
    if (!normalized || normalized === this.lastMessage) return;

    const now = Date.now();
    if (now - this.lastSentAt < this.minIntervalMs) return;

    this.lastSentAt = now;
    this.lastMessage = normalized;
    try {
      await sendFeishuTextToChat(this.chatId, `⏳ ${normalized}`);
    } catch {
      // 进度推送失败不影响主分析流程
    }
  }
}
