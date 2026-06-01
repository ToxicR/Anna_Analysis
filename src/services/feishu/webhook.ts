import type { FastifyReply } from "fastify";
import { getFeishuVerificationTokenRaw } from "./config.js";
import { parseFeishuMessage, stripBotMention, type ParsedFeishuCommand } from "./commands.js";
import { resolveAvailableProjects } from "./access.js";
import { getFeishuUser } from "./users.js";
import { getFeishuChat } from "./chats.js";
import {
  applyHelpCardSelection,
  buildFreshHelpCard,
  buildHelpCard,
  buildProjectPickerCard,
  FEISHU_CARD_ACTION_PICK_PROJECT,
  FEISHU_CARD_ACTION_RUN_COMMAND,
  parseFeishuCardAction,
  parseFeishuHelpCardState,
} from "./cards.js";
import type { FeishuInteractiveCard } from "./cards.js";
import type { FeishuAvailableProject } from "../../types.js";
import {
  clearSharedSession,
  ensureFeishuSessionLink,
  getFeishuSessionLink,
  resetFeishuSession,
  resolveFeishuSessionContext,
} from "./sessions.js";
import { appendFeishuChatMessage } from "./chat-store.js";
import type { FeishuIncomingAttachment } from "./files.js";

export interface FeishuWebhookEvent {
  type?: string;
  challenge?: string;
  token?: string;
  schema?: string;
  header?: {
    event_type?: string;
    token?: string;
    event_id?: string;
  };
  event?: {
    message?: {
      message_id?: string;
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: string;
    };
    sender?: {
      sender_id?: {
        open_id?: string;
        union_id?: string;
      };
    };
    operator?: {
      open_id?: string;
      union_id?: string;
    };
    action?: {
      value?: unknown;
      tag?: string;
    };
    context?: {
      open_chat_id?: string;
      open_message_id?: string;
    };
  };
}

export function handleFeishuUrlVerification(body: FeishuWebhookEvent): { challenge?: string } | null {
  if (body.type === "url_verification" && body.challenge) {
    return { challenge: body.challenge };
  }
  return null;
}

export function verifyFeishuEventToken(body: FeishuWebhookEvent): boolean {
  const configured = getFeishuVerificationTokenRaw();
  if (!configured) return true;
  const token = body.token || body.header?.token || "";
  return token === configured;
}

export interface FeishuMessageHandleResult {
  replyText?: string;
  replyCard?: FeishuInteractiveCard;
  replyCardAsNewMessage?: boolean;
  replyCardUpdate?: FeishuInteractiveCard;
  enqueueAnalysis?: {
    chatId: string;
    openId: string;
    appUserId: number;
    projectId: number;
    projectName: string;
    sessionId: string;
    question: string;
    mode: "personal" | "shared";
    chatType?: string;
    messageId?: string;
    attachments?: FeishuIncomingAttachment[];
  };
}

export function handleFeishuIncomingMessage(body: FeishuWebhookEvent): FeishuMessageHandleResult {
  const message = body.event?.message;
  const openId = body.event?.sender?.sender_id?.open_id?.trim() ?? "";
  const chatId = message?.chat_id?.trim() ?? "";
  const chatType = message?.chat_type?.trim() || "group";

  if (!openId || !chatId) {
    return { replyText: "无法识别飞书用户或会话。" };
  }

  const rawText = extractMessageText(message?.message_type, message?.content);
  const text = stripBotMention(rawText);
  const command = parseFeishuMessage(text);
  const attachments = extractFeishuAttachments(message?.message_type, message?.content);
  const messageId = message?.message_id?.trim() ?? "";

  if (command.name === "help") {
    const binding = getFeishuUser(openId);
    const projects = binding?.enabled
      ? resolveAvailableProjects({ chatId, appUserId: binding.app_user_id, chatType })
      : [];
    return {
      replyCard: buildFreshHelpCard({ chatType, projects }),
      replyCardAsNewMessage: true,
    };
  }

  const binding = getFeishuUser(openId);
  if (!binding || !binding.enabled) {
    return { replyText: "你的飞书账号尚未绑定系统用户，请联系管理员在管理后台完成绑定。" };
  }

  const commandResult = handleFeishuCommand({
    command,
    chatId,
    chatType,
    openId,
    appUserId: binding.app_user_id,
  });
  if (commandResult) return commandResult;

  const question = command.question || text || buildDefaultQuestionFromAttachments(attachments);
  if (!question && !attachments.length) {
    const projects = resolveAvailableProjects({ chatId, appUserId: binding.app_user_id, chatType });
    return {
      replyCard: buildFreshHelpCard({ chatType, projects }),
      replyCardAsNewMessage: true,
    };
  }
  if (!question && attachments.length) {
    return { replyText: "已收到附件，但无法生成分析问题，请补充说明或重新发送。" };
  }

  const projects = resolveAvailableProjects({ chatId, appUserId: binding.app_user_id, chatType });
  if (!projects.length) {
    return { replyText: "当前没有可用项目。请确认群绑定与用户权限，或联系管理员。" };
  }

  let projectId = command.projectId;
  if (projectId && !projects.some((project) => project.id === projectId)) {
    return { replyText: `你没有权限使用项目 ${projectId}，或未在该群绑定此项目。` };
  }
  if (!projectId) {
    const mode = chatType === "p2p" ? "personal" : resolveFeishuSessionContext({ chatId, openId }).mode;
    const link = getFeishuSessionLink(chatId, openId, mode);
    if (link?.current_project_id && projects.some((project) => project.id === link.current_project_id)) {
      projectId = link.current_project_id;
    }
  }
  if (!projectId && projects.length === 1) {
    projectId = projects[0]!.id;
  }
  if (!projectId) {
    return {
      replyCard: buildProjectPickerCard({
        projects,
        question,
        chatType,
      }),
    };
  }

  return enqueueFeishuAnalysis({
    chatId,
    chatType,
    openId,
    appUserId: binding.app_user_id,
    projectId,
    question,
    projects,
    attachments,
    messageId: attachments.length ? messageId : undefined,
  });
}

function enqueueFeishuAnalysis(input: {
  chatId: string;
  chatType: string;
  openId: string;
  appUserId: number;
  projectId: number;
  question: string;
  projects: FeishuAvailableProject[];
  attachments?: FeishuIncomingAttachment[];
  messageId?: string;
}): FeishuMessageHandleResult {
  const {
    chatId,
    chatType,
    openId,
    appUserId,
    projectId,
    question,
    projects,
    attachments = [],
    messageId,
  } = input;

  const mode = chatType === "p2p" ? "personal" : resolveFeishuSessionContext({ chatId, openId }).mode;
  const link = ensureFeishuSessionLink({
    chatId,
    openId,
    mode,
    appUserId,
    projectId,
    sharedStartedByOpenId: mode === "shared" ? openId : undefined,
  });

  appendFeishuChatMessage(link.session_id, "user", question, openId);
  const projectName = projects.find((project) => project.id === projectId)?.name ?? String(projectId);
  const attachmentHint = attachments.length ? `\n附件：${attachments.map((item) => item.file_name || item.resource_type).join("、")}` : "";
  return {
    replyText: `已收到${attachments.length ? "附件，" : ""}正在分析项目「${projectName}」…\n模式：${mode === "shared" ? "群协作" : "个人"}${attachmentHint}`,
    enqueueAnalysis: {
      chatId,
      openId,
      appUserId,
      projectId,
      projectName,
      sessionId: link.session_id,
      question,
      mode,
      chatType,
      messageId: attachments.length ? messageId : undefined,
      attachments: attachments.length ? attachments : undefined,
    },
  };
}

export function handleFeishuCardAction(body: FeishuWebhookEvent): FeishuMessageHandleResult {
  const openId = body.event?.operator?.open_id?.trim() ?? "";
  const chatId = body.event?.context?.open_chat_id?.trim() ?? "";
  const cardAction = parseFeishuCardAction(body.event?.action?.value);
  if (!openId || !chatId || !cardAction) {
    return { replyText: "无法识别卡片操作，请重新发送问题。" };
  }

  const binding = getFeishuUser(openId);
  if (!binding || !binding.enabled) {
    return { replyText: "你的飞书账号尚未绑定系统用户，请联系管理员。" };
  }

  const chatType = cardAction.chat_type?.trim() || "group";
  const projects = resolveAvailableProjects({ chatId, appUserId: binding.app_user_id, chatType });
  const cardState = parseFeishuHelpCardState(body.event?.action?.value);

  if (cardAction.action === FEISHU_CARD_ACTION_RUN_COMMAND) {
    const command: ParsedFeishuCommand = cardAction.command === "select_project"
      ? { name: "select_project", projectId: cardAction.project_id, question: "" }
      : { name: cardAction.command, question: "" };

    if ((cardAction.command === "shared" || cardAction.command === "personal") && cardState.mode) {
      return {
        replyText: "会话模式已设定，不可更改。",
        replyCardUpdate: buildHelpCard({ chatType, projects, state: cardState }),
      };
    }
    if (cardAction.command === "new_session" && cardState.session_reset) {
      return {
        replyText: "新建会话已执行，不可重复点击。",
        replyCardUpdate: buildHelpCard({ chatType, projects, state: cardState }),
      };
    }
    if (cardAction.command === "select_project" && cardState.selected_project_id) {
      return {
        replyText: "默认项目已选定，不可更改。",
        replyCardUpdate: buildHelpCard({ chatType, projects, state: cardState }),
      };
    }

    const commandResult = handleFeishuCommand({
      command,
      chatId,
      chatType,
      openId,
      appUserId: binding.app_user_id,
    }) ?? { replyText: "操作已完成。" };

    const newState = applyHelpCardSelection(cardState, cardAction.command, cardAction.project_id);
    return {
      ...commandResult,
      replyCardUpdate: buildHelpCard({ chatType, projects, state: newState }),
    };
  }

  const pick = cardAction.action === FEISHU_CARD_ACTION_PICK_PROJECT ? cardAction : null;
  if (!pick) {
    return { replyText: "无法识别卡片操作，请重新发送问题。" };
  }

  const project = projects.find((item) => item.id === pick.project_id);
  if (!project) {
    return { replyText: `项目 ${pick.project_id} 不可用，请重新选择。` };
  }

  const question = pick.question.trim() || "请分析当前问题。";
  return {
    ...enqueueFeishuAnalysis({
      chatId,
      chatType,
      openId,
      appUserId: binding.app_user_id,
      projectId: project.id,
      question,
      projects,
    }),
    replyCardUpdate: buildProjectPickerCard({
      projects,
      question: pick.question,
      chatType,
      selectedProjectId: project.id,
    }),
  };
}

export function buildFeishuCardCallbackResponse(toast: string, card?: FeishuInteractiveCard) {
  const response: Record<string, unknown> = {
    toast: {
      type: "success",
      content: toast,
    },
  };
  if (card) {
    response.card = {
      type: "raw",
      data: card,
    };
  }
  return response;
}

function handleFeishuCommand(input: {
  command: ParsedFeishuCommand;
  chatId: string;
  chatType: string;
  openId: string;
  appUserId: number;
}): FeishuMessageHandleResult | null {
  const { command, chatId, chatType, openId, appUserId } = input;
  const projects = resolveAvailableProjects({ chatId, appUserId, chatType });
  const defaultProjectId = projects[0]?.id;

  if (command.name === "message") {
    return null;
  }

  if (command.name === "shared") {
    const chat = getFeishuChat(chatId);
    if (chatType === "p2p") return { replyText: "私聊模式下无需开启群协作。" };
    if (chat && !chat.allow_shared_mode) return { replyText: "此群未开启协作会话，请联系管理员。" };
    if (!defaultProjectId) return { replyText: "当前没有可用项目，无法开启协作会话。" };
    ensureFeishuSessionLink({
      chatId,
      openId,
      mode: "shared",
      appUserId,
      projectId: defaultProjectId,
      sharedStartedByOpenId: openId,
    });
    return { replyText: "已进入群协作模式。本群后续 @机器人 的消息将共用上下文。发送 /私有 可回到个人模式。" };
  }

  if (command.name === "personal") {
    clearSharedSession(chatId);
    return { replyText: "已回到个人会话模式。" };
  }

  if (command.name === "new_session") {
    if (!defaultProjectId) return { replyText: "当前没有可用项目，无法新建会话。" };
    const mode = chatType === "p2p" ? "personal" : resolveFeishuSessionContext({ chatId, openId }).mode;
    resetFeishuSession({
      chatId,
      openId,
      mode,
      appUserId,
      projectId: defaultProjectId,
    });
    return { replyText: "已新建会话，上下文已清空。" };
  }

  if (command.name === "select_project" && command.projectId && !command.question) {
    const project = projects.find((item) => item.id === command.projectId);
    if (!project) return { replyText: `项目 ${command.projectId} 不可用。` };
    const mode = chatType === "p2p" ? "personal" : resolveFeishuSessionContext({ chatId, openId }).mode;
    ensureFeishuSessionLink({
      chatId,
      openId,
      mode,
      appUserId,
      projectId: project.id,
    });
    return { replyText: `已切换到项目：${project.name}。请继续发送你的问题。` };
  }

  return null;
}

function extractMessageText(messageType?: string, content?: string): string {
  if (!content) return "";
  if (messageType === "text") {
    try {
      const parsed = JSON.parse(content) as { text?: string };
      return parsed.text?.trim() ?? "";
    } catch {
      return content.trim();
    }
  }
  if (messageType === "post") {
    return extractPostText(content);
  }
  return "";
}

function extractPostText(content: string): string {
  try {
    const parsed = JSON.parse(content) as {
      title?: string;
      content?: Array<Array<{ tag?: string; text?: string }>>;
    };
    const lines: string[] = [];
    if (parsed.title?.trim()) lines.push(parsed.title.trim());
    for (const row of parsed.content || []) {
      for (const node of row) {
        if (node.tag === "text" && node.text?.trim()) lines.push(node.text.trim());
      }
    }
    return lines.join("\n").trim();
  } catch {
    return "";
  }
}

function extractFeishuAttachments(messageType?: string, content?: string): FeishuIncomingAttachment[] {
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as {
      file_key?: string;
      file_name?: string;
      image_key?: string;
    };
    if (messageType === "file" && parsed.file_key) {
      return [{
        resource_key: parsed.file_key,
        resource_type: "file",
        file_name: parsed.file_name?.trim() || "attachment.bin",
      }];
    }
    if (messageType === "image" && parsed.image_key) {
      return [{
        resource_key: parsed.image_key,
        resource_type: "image",
        file_name: "image.png",
      }];
    }
  } catch {
    return [];
  }
  return [];
}

function buildDefaultQuestionFromAttachments(attachments: FeishuIncomingAttachment[]): string {
  if (!attachments.length) return "";
  const names = attachments
    .map((item) => item.file_name?.trim())
    .filter(Boolean)
    .join("、");
  return names
    ? `请分析附件「${names}」中的内容，定位问题并给出修复建议。`
    : "请分析附件中的内容，定位问题并给出修复建议。";
}

export function feishuWebhookAck(reply: FastifyReply, body: FeishuWebhookEvent) {
  const verification = handleFeishuUrlVerification(body);
  if (verification) return reply.send(verification);
  return reply.send({ ok: true });
}
