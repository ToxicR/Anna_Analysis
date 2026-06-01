import { getSetting, setSetting } from "../../db.js";
import type { FeishuSettingsPublic } from "../../types.js";

export const FEISHU_SETTING_KEYS = {
  appId: "feishu_app_id",
  appSecret: "feishu_app_secret",
  verificationToken: "feishu_verification_token",
  encryptKey: "feishu_encrypt_key",
} as const;

export const FEISHU_WEBHOOK_PATH = "/api/feishu/webhook";

export function getFeishuSettings(): FeishuSettingsPublic {
  const appId = getSetting(FEISHU_SETTING_KEYS.appId).trim();
  const appSecret = getSetting(FEISHU_SETTING_KEYS.appSecret).trim();
  const verificationToken = getSetting(FEISHU_SETTING_KEYS.verificationToken).trim();
  const encryptKey = getSetting(FEISHU_SETTING_KEYS.encryptKey).trim();
  return {
    configured: Boolean(appId && appSecret),
    app_id: appId,
    app_secret: maskSecret(appSecret),
    verification_token: maskSecret(verificationToken),
    encrypt_key: maskSecret(encryptKey),
    webhook_path: FEISHU_WEBHOOK_PATH,
  };
}

export function saveFeishuSettings(input: {
  app_id?: string;
  app_secret?: string;
  verification_token?: string;
  encrypt_key?: string;
}): FeishuSettingsPublic {
  if (input.app_id !== undefined) setSetting(FEISHU_SETTING_KEYS.appId, input.app_id.trim());
  if (input.app_secret !== undefined && input.app_secret.trim()) {
    setSetting(FEISHU_SETTING_KEYS.appSecret, input.app_secret.trim());
  }
  if (input.verification_token !== undefined && input.verification_token.trim()) {
    setSetting(FEISHU_SETTING_KEYS.verificationToken, input.verification_token.trim());
  }
  if (input.encrypt_key !== undefined && input.encrypt_key.trim()) {
    setSetting(FEISHU_SETTING_KEYS.encryptKey, input.encrypt_key.trim());
  }
  return getFeishuSettings();
}

export function getFeishuAppSecretRaw(): string {
  return getSetting(FEISHU_SETTING_KEYS.appSecret).trim();
}

export function getFeishuVerificationTokenRaw(): string {
  return getSetting(FEISHU_SETTING_KEYS.verificationToken).trim();
}

export function getFeishuEncryptKeyRaw(): string {
  return getSetting(FEISHU_SETTING_KEYS.encryptKey).trim();
}

function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 6) return "******";
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}
