import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getFeishuSettings, saveFeishuSettings } from "./config.js";
import { unwrapFeishuWebhookBody } from "./crypto.js";
import { listFeishuUsers, upsertFeishuUser, deleteFeishuUser, provisionFeishuUser } from "./users.js";
import { listFeishuChats, upsertFeishuChat, deleteFeishuChat } from "./chats.js";
import { feishuWebhookAck, handleFeishuIncomingMessage, handleFeishuCardAction, buildFeishuCardCallbackResponse, verifyFeishuEventToken, type FeishuWebhookEvent } from "./webhook.js";
import { deliverFeishuWebhookResult } from "./deliver.js";
import { recordFeishuContactFromWebhook } from "./contacts-cache.js";
import { invalidateFeishuDirectoryCache, listFeishuDirectoryUsers, listRecentFeishuDirectoryUsers } from "./directory.js";
import { fetchFeishuChatInfo } from "./api.js";

function badRequest(reply: FastifyReply, detail: string) {
  return reply.status(400).send({ detail });
}

export function registerFeishuRoutes(app: FastifyInstance, requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>) {
  app.post("/api/feishu/webhook", async (request, reply) => {
    let body: FeishuWebhookEvent;
    try {
      body = unwrapFeishuWebhookBody(request.body as Record<string, unknown>) as FeishuWebhookEvent;
    } catch (error) {
      request.log.error({ err: error }, "feishu webhook decrypt failed");
      return reply.status(400).send({ detail: error instanceof Error ? error.message : String(error) });
    }

    const verification = body.type === "url_verification" && body.challenge;
    if (verification) return reply.send({ challenge: body.challenge });

    if (!verifyFeishuEventToken(body)) {
      return reply.status(401).send({ detail: "飞书事件 token 校验失败" });
    }

    const eventType = body.header?.event_type ?? "";
    if (eventType === "im.message.receive_v1") {
      try {
        const openId = body.event?.sender?.sender_id?.open_id?.trim() ?? "";
        const unionId = body.event?.sender?.sender_id?.union_id?.trim() ?? "";
        if (openId) recordFeishuContactFromWebhook(openId, unionId);
        const result = handleFeishuIncomingMessage(body);
        const chatId = body.event?.message?.chat_id;
        const messageId = body.event?.message?.message_id;
        request.log.info({
          chatId,
          eventType,
          remoteAddress: request.ip,
          openId: body.event?.sender?.sender_id?.open_id,
          hasAnalysis: Boolean(result.enqueueAnalysis),
          hasReply: Boolean(result.replyText),
          hasCard: Boolean(result.replyCard),
        }, "feishu webhook event");
        void deliverFeishuWebhookResult(request.log, { result, chatId, messageId }).catch((error) => {
          request.log.error({ err: error, chatId }, "feishu delivery failed");
        });
      } catch (error) {
        request.log.error({ err: error }, "feishu message handle failed");
      }
    } else if (eventType === "card.action.trigger") {
      try {
        const result = handleFeishuCardAction(body);
        const chatId = body.event?.context?.open_chat_id;
        request.log.info({
          chatId,
          eventType,
          remoteAddress: request.ip,
          openId: body.event?.operator?.open_id,
          hasAnalysis: Boolean(result.enqueueAnalysis),
        }, "feishu card action");
        reply.send(buildFeishuCardCallbackResponse(
          result.enqueueAnalysis
            ? "已选择项目，开始分析…"
            : (result.replyText || "已执行"),
          result.replyCardUpdate,
        ));
        if (result.enqueueAnalysis && chatId) {
          void deliverFeishuWebhookResult(request.log, { result: { enqueueAnalysis: result.enqueueAnalysis }, chatId }).catch((error) => {
            request.log.error({ err: error, chatId }, "feishu card analysis delivery failed");
          });
        } else if (result.replyText && chatId) {
          void deliverFeishuWebhookResult(request.log, { result: { replyText: result.replyText }, chatId }).catch((error) => {
            request.log.error({ err: error, chatId }, "feishu card reply delivery failed");
          });
        }
        return;
      } catch (error) {
        request.log.error({ err: error }, "feishu card action handle failed");
        return reply.send(buildFeishuCardCallbackResponse("处理失败，请稍后重试。"));
      }
    } else if (eventType) {
      request.log.info({ eventType, remoteAddress: request.ip }, "feishu webhook ignored event");
    }

    return feishuWebhookAck(reply, body);
  });

  app.get("/api/admin/feishu/settings", { preHandler: requireAdmin }, async () => getFeishuSettings());

  app.put("/api/admin/feishu/settings", { preHandler: requireAdmin }, async (request) => {
    const payload = request.body as {
      app_id?: string;
      app_secret?: string;
      verification_token?: string;
      encrypt_key?: string;
    };
    return saveFeishuSettings(payload);
  });

  app.get("/api/admin/feishu/directory/users", { preHandler: requireAdmin }, async (request, reply) => {
    const query = request.query as { q?: string; page_token?: string; page_size?: string; refresh?: string };
    try {
      if (query.refresh === "1") invalidateFeishuDirectoryCache();
      const pageSize = query.page_size ? Number.parseInt(query.page_size, 10) : undefined;
      const result = await listFeishuDirectoryUsers({
        query: query.q?.trim(),
        pageToken: query.page_token?.trim(),
        pageSize: Number.isFinite(pageSize) ? pageSize : undefined,
      });
      return {
        users: result.users,
        has_more: result.hasMore,
        page_token: result.pageToken,
        meta: result.meta,
      };
    } catch (error) {
      return reply.status(502).send({
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/api/admin/feishu/directory/recent", { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const result = await listRecentFeishuDirectoryUsers(30);
      return { users: result.users, meta: result.meta };
    } catch (error) {
      return reply.status(502).send({
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/api/admin/feishu/users", { preHandler: requireAdmin }, async () => listFeishuUsers());

  app.post("/api/admin/feishu/users", { preHandler: requireAdmin }, async (request, reply) => {
    const payload = request.body as {
      open_id?: string;
      app_user_id?: number;
      union_id?: string;
      display_name?: string;
      enabled?: boolean;
    };
    try {
      if (!payload.open_id?.trim()) return badRequest(reply, "请填写 open_id");
      if (payload.app_user_id) {
        return upsertFeishuUser({
          open_id: payload.open_id,
          app_user_id: Number(payload.app_user_id),
          union_id: payload.union_id,
          display_name: payload.display_name,
          enabled: payload.enabled,
        });
      }
      return provisionFeishuUser({
        open_id: payload.open_id,
        union_id: payload.union_id,
        display_name: payload.display_name,
        enabled: payload.enabled,
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.delete("/api/admin/feishu/users/:openId", { preHandler: requireAdmin }, async (request, reply) => {
    const openId = decodeURIComponent((request.params as { openId: string }).openId);
    if (!deleteFeishuUser(openId)) return reply.status(404).send({ detail: "绑定不存在" });
    return { ok: true };
  });

  app.get("/api/admin/feishu/chats", { preHandler: requireAdmin }, async () => listFeishuChats());

  app.get("/api/admin/feishu/chats/:chatId/info", { preHandler: requireAdmin }, async (request, reply) => {
    const chatId = decodeURIComponent((request.params as { chatId: string }).chatId).trim();
    if (!chatId) return badRequest(reply, "请填写 chat_id");
    try {
      return await fetchFeishuChatInfo(chatId);
    } catch (error) {
      return reply.status(502).send({
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/admin/feishu/chats", { preHandler: requireAdmin }, async (request, reply) => {
    const payload = request.body as {
      chat_id?: string;
      chat_type?: string;
      name?: string;
      enabled?: boolean;
      allow_shared_mode?: boolean;
      project_ids?: number[];
    };
    try {
      if (!payload.chat_id?.trim()) return badRequest(reply, "请填写 chat_id");
      return upsertFeishuChat({
        chat_id: payload.chat_id,
        chat_type: payload.chat_type,
        name: payload.name,
        enabled: payload.enabled,
        allow_shared_mode: payload.allow_shared_mode,
        project_ids: payload.project_ids,
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.delete("/api/admin/feishu/chats/:chatId", { preHandler: requireAdmin }, async (request, reply) => {
    const chatId = decodeURIComponent((request.params as { chatId: string }).chatId);
    if (!deleteFeishuChat(chatId)) return reply.status(404).send({ detail: "群绑定不存在" });
    return { ok: true };
  });
}
