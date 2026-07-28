import type { FastifyBaseLogger } from "fastify";
import { getEnabledReposForProject, runAnalysis } from "../analysis-runner.js";
import { userCanAccessProjectForFeishu } from "./access.js";
import {
  deliverFeishuText,
  deliverFeishuInteractiveCard,
  sendFeishuInteractiveCardToChat,
  sendFeishuInteractiveCardToOpenId,
  sendFeishuTextToChat,
  sendFeishuTextToOpenId,
} from "./api.js";
import { appendFeishuChatMessage, getFeishuChatSession } from "./chat-store.js";
import {
  extractLogFilenameHint,
  feishuSessionHasUploads,
  ingestFeishuIncomingAttachments,
  prepareFeishuAttachmentsForAnalysis,
  resolveFeishuAnalysisSessionKey,
} from "./files.js";
import { FeishuProgressReporter } from "./progress.js";
import { FeishuStreamingAnalysisCard, formatFeishuAnalysisIntro } from "./streaming.js";
import type { AnalysisStreamCallbacks } from "../ai.js";
import type { FeishuBotMenuHandleResult, FeishuMessageHandleResult } from "./webhook.js";

const inFlightSessionIds = new Set<string>();

function questionExpectsLogAnalysis(question: string): boolean {
  return /日志|\.log\b|log-\d{6,8}|掉线|异常|报错|附件|分析.*文件/i.test(question);
}

function missingLogAttachmentMessage(job: NonNullable<FeishuMessageHandleResult["enqueueAnalysis"]>): string {
  const isP2p = job.chatType === "p2p";
  if (job.parentMessageId) {
    if (isP2p) {
      return [
        "未能从引用消息中解析到日志文件。",
        "常见原因：",
        "· 飞书应用未开通「获取单聊、群组消息」(im:message:readonly) 权限，无法读取被引用的文件消息；",
        "· 被引用的文件消息在机器人收到之前发送（机器人未缓存到该条消息）。",
        "请任选其一：",
        "1) 先发送 .log，等机器人确认收到后再发分析问题；",
        "2) 将 .log 与问题写在同一条消息里发送。",
      ].join("\n");
    }
    return [
      "未能从引用消息中解析到日志文件。",
      "请任选其一：",
      "1) 发送 .log 时同时 @机器人，再发分析问题；",
      "2) 将 .log 与问题写在同一条消息里并 @机器人；",
      "3) 若仍失败，请让管理员为机器人开通「获取群组中所有消息」(im:message.group_msg) 权限。",
    ].join("\n");
  }
  if (isP2p) {
    return [
      "未收到可分析的日志文件。",
      "请先直接发送 .log 文件，再发送分析问题；",
      "或将 .log 与问题放在同一条消息中发送（单聊无需 @机器人）。",
    ].join("\n");
  }
  return [
    "未收到可分析的日志文件。",
    "请先 @机器人 发送 .log 文件（仅发文件也需 @机器人），再 @机器人 提问；",
    "或将 .log 与问题放在同一条消息中发送。",
  ].join("\n");
}

function resolveRepoIds(projectId: number, sessionId: string): number[] {
  const session = getFeishuChatSession(sessionId);
  const fromSession = (session?.repo_ids || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (fromSession.length) return fromSession;
  return getEnabledReposForProject(projectId).map((repo) => repo.id);
}

export async function runFeishuAnalysisJob(
  logger: FastifyBaseLogger,
  job: NonNullable<FeishuMessageHandleResult["enqueueAnalysis"]>,
  messageId?: string,
  existingStreamingCard: FeishuStreamingAnalysisCard | null = null,
): Promise<void> {
  if (inFlightSessionIds.has(job.sessionId)) {
    await deliverFeishuText({
      chatId: job.chatId,
      messageId,
      text: "上一条分析仍在进行中，请稍候完成后再提问。",
    });
    return;
  }

  inFlightSessionIds.add(job.sessionId);
  const progress = new FeishuProgressReporter(job.chatId);
  const streamingCard = existingStreamingCard
    ?? await FeishuStreamingAnalysisCard.tryCreate(job.chatId, formatFeishuAnalysisIntro(job));
  const useStreamingCard = streamingCard !== null;

  const buildStreamCallbacks = (): AnalysisStreamCallbacks => ({
    onStatus: (message) => {
      logger.info({ sessionId: job.sessionId, message }, "feishu analysis status");
      if (useStreamingCard) {
        void streamingCard!.setStatus(message).catch((error) => {
          logger.warn({ err: error, sessionId: job.sessionId }, "feishu streaming status update failed");
        });
        return;
      }
      void progress.maybeSend(message);
    },
    onDelta: (delta) => {
      if (useStreamingCard) {
        void streamingCard!.appendDelta(delta).catch((error) => {
          logger.warn({ err: error, sessionId: job.sessionId }, "feishu streaming delta update failed");
        });
      }
    },
  });

  try {
    const repoIds = resolveRepoIds(job.projectId, job.sessionId);
    if (!repoIds.length) {
      throw new Error("当前项目没有可分析的仓库，请联系管理员配置。");
    }

    let logText = "";
    let attachmentImages: { url: string }[] = [];
    let focusLogNames: string[] = [];
    let focusDir: string | null = null;
    const logHint = extractLogFilenameHint(job.question);
    const hasNewAttachments = Boolean(job.attachments?.length);
    const expectsLog = questionExpectsLogAnalysis(job.question);
    const shouldPrepareAttachments = hasNewAttachments
      || Boolean(job.parentMessageId)
      || Boolean(logHint)
      || feishuSessionHasUploads(job.projectId, job.sessionId)
      || expectsLog;

    if (shouldPrepareAttachments) {
      if (hasNewAttachments || job.parentMessageId) {
        if (hasNewAttachments && !job.messageId) {
          throw new Error("无法下载附件：缺少 message_id。");
        }
        if (useStreamingCard) {
          await streamingCard!.setStatus("正在下载并合并会话附件…");
        } else {
          await progress.maybeSend("正在下载并合并会话附件…");
        }
      }
      const prepared = await prepareFeishuAttachmentsForAnalysis({
        projectId: job.projectId,
        sessionId: job.sessionId,
        messageId: job.messageId ?? "",
        attachments: job.attachments ?? [],
        question: job.question,
        openId: job.openId,
        mode: job.mode,
        parentMessageId: job.parentMessageId,
        log: logger,
      });
      if (expectsLog && !prepared.log_text.trim() && (job.parentMessageId || job.attachments?.length)) {
        logger.warn({
          sessionId: job.sessionId,
          parentMessageId: job.parentMessageId,
          hasAttachments: Boolean(job.attachments?.length),
        }, "feishu log analysis had no attachment content after prepare");
      }
      logText = prepared.log_text;
      attachmentImages = prepared.attachment_images;
      focusLogNames = prepared.focus_log_names;
      focusDir = prepared.focus_dir;
    }

    if (expectsLog && !logText.trim()) {
      throw new Error(missingLogAttachmentMessage(job));
    }

    const cursorSessionKey = resolveFeishuAnalysisSessionKey(job.sessionId, logHint, focusLogNames);

    const { analysis } = await runAnalysis(
      {
        project_id: job.projectId,
        repo_ids: repoIds,
        question: job.question,
        log_text: logText || undefined,
        attachment_images: attachmentImages.length ? attachmentImages : undefined,
        chat_session_id: cursorSessionKey,
        feishu_focus_dir: focusDir ?? undefined,
        output_mode: "non_developer",
        user_id: job.appUserId,
        source: "feishu",
        feishu_chat_id: job.chatId,
        feishu_open_id: job.openId,
        feishu_session_id: job.sessionId,
      },
      buildStreamCallbacks(),
      {
        assertProjectAccess: (userId, projectId) => userCanAccessProjectForFeishu(
          userId,
          job.chatId,
          projectId,
          job.chatType || "group",
        ),
      },
    );

    appendFeishuChatMessage(job.sessionId, "assistant", analysis.text, "", JSON.stringify({ mode: job.mode }));
    if (useStreamingCard) {
      await streamingCard!.finalize(analysis.text || "分析完成，但未返回文本结果。");
      if (streamingCard!.isBroken()) {
        await sendFeishuTextToChat(job.chatId, analysis.text || "分析完成，但未返回文本结果。");
      }
    } else {
      await sendFeishuTextToChat(job.chatId, analysis.text || "分析完成，但未返回文本结果。");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, sessionId: job.sessionId }, "feishu analysis failed");
    appendFeishuChatMessage(job.sessionId, "assistant", `分析失败：${message}`, job.openId, JSON.stringify({ error: true }));
    if (useStreamingCard) {
      await streamingCard!.fail(message);
      if (streamingCard!.isBroken()) {
        await sendFeishuTextToChat(job.chatId, `分析失败：${message}`);
      }
    } else {
      await sendFeishuTextToChat(job.chatId, `分析失败：${message}`);
    }
  } finally {
    inFlightSessionIds.delete(job.sessionId);
  }
}

export async function deliverFeishuWebhookResult(
  logger: FastifyBaseLogger,
  input: {
    result: FeishuMessageHandleResult;
    chatId?: string;
    messageId?: string;
  },
): Promise<void> {
  const chatId = input.chatId?.trim() ?? "";
  if (!chatId) return;

  if (input.result.stageAttachments) {
    const stage = input.result.stageAttachments;
    try {
      const ingested = await ingestFeishuIncomingAttachments({
        projectId: stage.projectId,
        sessionId: stage.sessionId,
        messageId: stage.messageId,
        attachments: stage.attachments,
        openId: stage.openId,
        parentMessageId: stage.parentMessageId,
        log: logger,
      });
      logger.info({
        sessionId: stage.sessionId,
        saved: ingested.displayNames,
      }, "feishu attachments staged");
    } catch (error) {
      logger.error({ err: error, sessionId: stage.sessionId }, "feishu attachment staging failed");
      input.result.replyText = `附件保存失败：${error instanceof Error ? error.message : String(error)}`;
      input.result.stageAttachments = undefined;
    }
  }

  if (input.result.replyCard) {
    try {
      await deliverFeishuInteractiveCard({
        chatId,
        messageId: input.result.replyCardAsNewMessage ? undefined : input.messageId,
        card: input.result.replyCard,
      });
    } catch (error) {
      logger.error({ err: error, chatId }, "feishu card reply failed");
    }
  }

  if (input.result.replyText && !input.result.enqueueAnalysis) {
    try {
      await deliverFeishuText({
        chatId,
        messageId: input.messageId,
        text: input.result.replyText,
      });
    } catch (error) {
      logger.error({ err: error, chatId }, "feishu immediate reply failed");
    }
  }

  if (input.result.enqueueAnalysis) {
    const job = input.result.enqueueAnalysis;
    let streamingCard: FeishuStreamingAnalysisCard | null = null;
    try {
      streamingCard = await FeishuStreamingAnalysisCard.tryCreate(job.chatId, formatFeishuAnalysisIntro(job));
    } catch (error) {
      logger.error({ err: error, chatId }, "feishu streaming card create failed");
    }

    if (!streamingCard && input.result.replyText) {
      try {
        await deliverFeishuText({
          chatId,
          messageId: input.messageId,
          text: input.result.replyText,
        });
      } catch (error) {
        logger.error({ err: error, chatId }, "feishu analysis ack failed");
      }
    }

    void runFeishuAnalysisJob(logger, job, input.messageId, streamingCard).catch((error) => {
      logger.error({ err: error, sessionId: job.sessionId }, "feishu analysis job crashed");
    });
  }
}

export async function deliverFeishuBotMenuResult(
  logger: FastifyBaseLogger,
  result: FeishuBotMenuHandleResult,
): Promise<void> {
  try {
    if (result.replyCard) {
      if (result.chatId) {
        await sendFeishuInteractiveCardToChat(result.chatId, result.replyCard);
      } else if (result.openId) {
        await sendFeishuInteractiveCardToOpenId(result.openId, result.replyCard);
      }
    }
    if (result.replyText?.trim()) {
      if (result.chatId) {
        await sendFeishuTextToChat(result.chatId, result.replyText);
      } else if (result.openId) {
        await sendFeishuTextToOpenId(result.openId, result.replyText);
      }
    }
  } catch (error) {
    logger.error({ err: error, openId: result.openId, chatId: result.chatId }, "feishu bot menu reply failed");
  }
}
