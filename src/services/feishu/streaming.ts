import {
  closeFeishuStreamingCard,
  createFeishuStreamingCardEntity,
  sendFeishuCardEntityToChat,
  updateFeishuStreamingCardContent,
} from "./cardkit.js";

import type { FeishuMessageHandleResult } from "./webhook.js";

const MAX_STREAM_CONTENT = 98_000;
const UPDATE_INTERVAL_MS = 400;

function normalizeStreamContent(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return " ";
  if (trimmed.length <= MAX_STREAM_CONTENT) return trimmed;
  return `${trimmed.slice(0, MAX_STREAM_CONTENT - 20)}\n\n…（内容过长，已截断）`;
}

function formatStatusContent(status: string): string {
  return `⏳ ${status.trim()}`;
}

export function formatFeishuAnalysisIntro(
  job: NonNullable<FeishuMessageHandleResult["enqueueAnalysis"]>,
): string {
  const attachmentHint = job.attachments?.length
    ? `\n附件：${job.attachments.map((item) => item.file_name || item.resource_type).join("、")}`
    : "";
  return `已收到${job.attachments?.length ? "附件，" : ""}正在分析项目「${job.projectName}」…\n模式：${job.mode === "shared" ? "群协作" : "个人"}${attachmentHint}`;
}

export class FeishuStreamingAnalysisCard {
  private sequence = 0;
  private published = "";
  private accumulated = "";
  private answerStarted = false;
  private lastUpdateAt = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private broken = false;
  private opQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly cardId: string,
    initialStatus: string,
  ) {
    this.accumulated = initialStatus;
  }

  static async tryCreate(chatId: string, initialStatus = "正在准备分析…"): Promise<FeishuStreamingAnalysisCard | null> {
    try {
      const cardId = await createFeishuStreamingCardEntity({
        title: "Anna Analysis",
        initialContent: formatStatusContent(initialStatus),
      });
      await sendFeishuCardEntityToChat(chatId, cardId);
      return new FeishuStreamingAnalysisCard(cardId, initialStatus);
    } catch {
      return null;
    }
  }

  isBroken(): boolean {
    return this.broken;
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(task, task);
    this.opQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private async pushContent(force = false): Promise<void> {
    if (this.closed || this.broken) return;
    const normalized = normalizeStreamContent(this.currentDisplayContent());
    if (!force && normalized === this.published) return;

    const now = Date.now();
    if (!force && now - this.lastUpdateAt < UPDATE_INTERVAL_MS) {
      this.scheduleFlush();
      return;
    }

    await this.runExclusive(async () => {
      if (this.closed || this.broken) return;
      const latest = normalizeStreamContent(this.currentDisplayContent());
      if (!force && latest === this.published) return;

      try {
        await updateFeishuStreamingCardContent({
          cardId: this.cardId,
          content: latest,
          sequence: this.nextSequence(),
        });
        this.published = latest;
        this.lastUpdateAt = Date.now();
      } catch {
        this.broken = true;
      }
    });
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch(() => undefined);
    }, UPDATE_INTERVAL_MS);
  }

  private currentDisplayContent(): string {
    return this.answerStarted ? this.accumulated : formatStatusContent(this.accumulated || "正在准备分析…");
  }

  private async flush(force = false): Promise<void> {
    await this.pushContent(force);
  }

  async setStatus(status: string): Promise<void> {
    if (this.closed || this.answerStarted || this.broken) return;
    const next = status.trim() || "正在分析…";
    if (!this.answerStarted && next === this.accumulated && this.published) return;
    this.accumulated = next;
    await this.flush();
  }

  async appendDelta(delta: string): Promise<void> {
    if (this.closed || this.broken || !delta) return;
    if (!this.answerStarted) {
      this.answerStarted = true;
      this.accumulated = "";
      this.published = "";
    }
    this.accumulated += delta;
    await this.flush();
  }

  async finalize(text: string): Promise<void> {
    if (this.closed) return;
    this.answerStarted = true;
    this.accumulated = text.trim() || this.accumulated.trim() || "分析完成，但未返回文本结果。";
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.broken) return;

    await this.runExclusive(async () => {
      if (this.closed) return;
      const latest = normalizeStreamContent(this.accumulated);
      try {
        await updateFeishuStreamingCardContent({
          cardId: this.cardId,
          content: latest,
          sequence: this.nextSequence(),
        });
        this.published = latest;
        await closeFeishuStreamingCard({
          cardId: this.cardId,
          sequence: this.nextSequence(),
          summary: "Anna 分析完成",
        });
        this.closed = true;
      } catch {
        this.broken = true;
      }
    });
  }

  async fail(message: string): Promise<void> {
    if (this.closed) return;
    this.answerStarted = true;
    this.accumulated = `分析失败：${message.trim() || "未知错误"}`;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.broken) return;

    await this.runExclusive(async () => {
      if (this.closed) return;
      const latest = normalizeStreamContent(this.accumulated);
      try {
        await updateFeishuStreamingCardContent({
          cardId: this.cardId,
          content: latest,
          sequence: this.nextSequence(),
        });
        this.published = latest;
        await closeFeishuStreamingCard({
          cardId: this.cardId,
          sequence: this.nextSequence(),
          summary: "Anna 分析失败",
        });
        this.closed = true;
      } catch {
        this.broken = true;
      }
    });
  }
}
