import crypto from "node:crypto";
import { getFeishuEncryptKeyRaw } from "./config.js";

export function decryptFeishuPayload(encryptKey: string, encryptedBase64: string): string {
  const key = crypto.createHash("sha256").update(encryptKey).digest();
  const encrypted = Buffer.from(encryptedBase64, "base64");
  const iv = encrypted.subarray(0, 16);
  const data = encrypted.subarray(16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function unwrapFeishuWebhookBody(body: Record<string, unknown>): Record<string, unknown> {
  const encrypt = typeof body.encrypt === "string" ? body.encrypt.trim() : "";
  if (!encrypt) return body;

  const encryptKey = getFeishuEncryptKeyRaw();
  if (!encryptKey) {
    throw new Error("收到加密飞书事件，但未配置 Encrypt Key");
  }

  const decrypted = decryptFeishuPayload(encryptKey, encrypt);
  return JSON.parse(decrypted) as Record<string, unknown>;
}
