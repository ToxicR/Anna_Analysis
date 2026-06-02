import { db, getSetting, normalizeRow, normalizeRows, nowIso, setSetting } from "../db.js";
import type { AIModel } from "../types.js";
function notifyRuntimeChanged(): void {
  void import("./cursor-runtime.js").then((module) => module.invalidateCursorRuntime());
}

export type ThirdPartyProvider = "openai-compatible" | "ai-gateway";

export interface ThirdPartyModel {
  id: number;
  name: string;
  provider: ThirdPartyProvider;
  base_url: string;
  api_key: string;
  model_name: string;
  enabled: boolean | number;
  is_default: boolean | number;
  created_at: string;
}

export interface ThirdPartyModelPublic {
  id: number;
  name: string;
  provider: ThirdPartyProvider;
  base_url: string;
  model_name: string;
  enabled: boolean;
  is_default: boolean;
  configured: boolean;
  created_at: string;
}

export interface ThirdPartyModelsAdminView {
  enabled: boolean;
  active: boolean;
  default_model_id: number | null;
  models: ThirdPartyModelPublic[];
}

const SETTING_ENABLED = "third_party_model_enabled";

function normalizeProvider(value: string): ThirdPartyProvider {
  return value.trim() === "ai-gateway" ? "ai-gateway" : "openai-compatible";
}

function toPublic(model: ThirdPartyModel): ThirdPartyModelPublic {
  const row = normalizeRow(model);
  return {
    id: row.id,
    name: row.name,
    provider: normalizeProvider(row.provider),
    base_url: row.base_url,
    model_name: row.model_name,
    enabled: Boolean(row.enabled),
    is_default: Boolean(row.is_default),
    configured: Boolean(row.api_key?.trim() && row.model_name?.trim()),
    created_at: row.created_at,
  };
}

export function isThirdPartyAnalysisEnabled(): boolean {
  return getSetting(SETTING_ENABLED).trim() === "1";
}

export function setThirdPartyAnalysisEnabled(enabled: boolean): void {
  setSetting(SETTING_ENABLED, enabled ? "1" : "0");
  notifyRuntimeChanged();
}

export function listThirdPartyModels(includeDisabled = true): ThirdPartyModel[] {
  const sql = includeDisabled
    ? "SELECT * FROM third_party_models ORDER BY is_default DESC, id ASC"
    : "SELECT * FROM third_party_models WHERE enabled = 1 ORDER BY is_default DESC, id ASC";
  return normalizeRows(db.prepare(sql).all() as ThirdPartyModel[]);
}

function pickDefaultPublicModel(models: ThirdPartyModelPublic[]): ThirdPartyModelPublic | undefined {
  return models.find((model) => model.is_default && model.enabled && model.configured)
    ?? models.find((model) => model.is_default && model.configured)
    ?? models.find((model) => model.enabled && model.configured)
    ?? models.find((model) => model.configured);
}

export function getThirdPartyModelAdminView(): ThirdPartyModelsAdminView {
  const models = listThirdPartyModels().map(toPublic);
  const defaultModel = pickDefaultPublicModel(models);
  const enabled = isThirdPartyAnalysisEnabled();
  const usable = models.filter((model) => model.enabled && model.configured);
  return {
    enabled,
    active: enabled && usable.length > 0,
    default_model_id: defaultModel?.id ?? null,
    models,
  };
}

export function getThirdPartyModelsForClient(): ThirdPartyModelsAdminView & { active_provider: "third_party" | "cursor" } {
  const view = getThirdPartyModelAdminView();
  return {
    ...view,
    active_provider: view.enabled && view.models.some((model) => model.enabled && model.configured)
      ? "third_party"
      : "cursor",
  };
}

export function getThirdPartyModelById(id: number): ThirdPartyModel | undefined {
  const row = db.prepare("SELECT * FROM third_party_models WHERE id = ?").get(id) as ThirdPartyModel | undefined;
  return row ? normalizeRow(row) : undefined;
}

export function getDefaultThirdPartyModel(): ThirdPartyModel | undefined {
  const preferred = db.prepare(`
    SELECT * FROM third_party_models
    WHERE enabled = 1 AND api_key != '' AND model_name != ''
    ORDER BY is_default DESC, id ASC
    LIMIT 1
  `).get() as ThirdPartyModel | undefined;
  return preferred ? normalizeRow(preferred) : undefined;
}

export function thirdPartyModelToAIModel(model: ThirdPartyModel): AIModel {
  return {
    id: model.id,
    name: model.name,
    provider: normalizeProvider(model.provider),
    base_url: model.base_url,
    api_key: model.api_key,
    model_name: model.model_name,
    enabled: model.enabled,
    is_default: model.is_default,
    created_at: model.created_at,
  };
}

export function resolveThirdPartyAnalysisModel(modelId?: number | null): AIModel | undefined {
  if (!isThirdPartyAnalysisEnabled()) return undefined;
  const picked = modelId ? getThirdPartyModelById(modelId) : getDefaultThirdPartyModel();
  if (!picked || !picked.enabled) return undefined;
  assertThirdPartyModelReady(picked);
  return thirdPartyModelToAIModel(picked);
}

export function assertThirdPartyModelReady(model: ThirdPartyModel): void {
  if (!model.api_key?.trim()) throw new Error(`第三方模型「${model.name}」未配置 API Key。`);
  if (!model.model_name?.trim()) throw new Error(`第三方模型「${model.name}」未配置模型 ID。`);
  const provider = normalizeProvider(model.provider);
  if (provider === "openai-compatible" && !model.base_url?.trim()) {
    throw new Error(`第三方模型「${model.name}」需填写 Base URL。`);
  }
}

export function createThirdPartyModel(input: {
  name: string;
  provider: string;
  base_url?: string;
  api_key: string;
  model_name: string;
  enabled?: boolean;
  is_default?: boolean;
}): ThirdPartyModelPublic {
  const name = input.name.trim() || input.model_name.trim() || "第三方模型";
  const provider = normalizeProvider(input.provider);
  const apiKey = input.api_key.trim();
  const modelName = input.model_name.trim();
  const baseUrl = input.base_url?.trim() ?? "";
  if (!apiKey) throw new Error("请填写 API Key");
  if (!modelName) throw new Error("请填写模型 ID");
  if (provider === "openai-compatible" && !baseUrl) throw new Error("OpenAI 兼容模式需填写 Base URL");

  const makeDefault = input.is_default ?? listThirdPartyModels().length === 0;
  if (makeDefault) {
    db.prepare("UPDATE third_party_models SET is_default = 0").run();
  }

  const result = db.prepare(`
    INSERT INTO third_party_models(name, provider, base_url, api_key, model_name, enabled, is_default, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    provider,
    baseUrl,
    apiKey,
    modelName,
    input.enabled === false ? 0 : 1,
    makeDefault ? 1 : 0,
    nowIso(),
  );

  notifyRuntimeChanged();
  return toPublic(getThirdPartyModelById(Number(result.lastInsertRowid))!);
}

export function updateThirdPartyModel(
  id: number,
  input: {
    name?: string;
    provider?: string;
    base_url?: string;
    api_key?: string;
    model_name?: string;
    enabled?: boolean;
  },
): ThirdPartyModelPublic {
  const current = getThirdPartyModelById(id);
  if (!current) throw new Error("第三方模型不存在");

  const name = input.name !== undefined ? (input.name.trim() || current.name) : current.name;
  const provider = input.provider !== undefined ? normalizeProvider(input.provider) : normalizeProvider(current.provider);
  const baseUrl = input.base_url !== undefined ? input.base_url.trim() : current.base_url;
  const apiKey = input.api_key?.trim() ? input.api_key.trim() : current.api_key;
  const modelName = input.model_name !== undefined ? input.model_name.trim() : current.model_name;
  const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : (current.enabled ? 1 : 0);

  if (!modelName) throw new Error("请填写模型 ID");
  if (!apiKey) throw new Error("请填写 API Key");
  if (provider === "openai-compatible" && !baseUrl) throw new Error("OpenAI 兼容模式需填写 Base URL");

  db.prepare(`
    UPDATE third_party_models
    SET name = ?, provider = ?, base_url = ?, api_key = ?, model_name = ?, enabled = ?
    WHERE id = ?
  `).run(name, provider, baseUrl, apiKey, modelName, enabled, id);

  notifyRuntimeChanged();
  return toPublic(getThirdPartyModelById(id)!);
}

export function deleteThirdPartyModel(id: number): void {
  const current = getThirdPartyModelById(id);
  if (!current) throw new Error("第三方模型不存在");
  const wasDefault = Boolean(current.is_default);
  db.prepare("DELETE FROM third_party_models WHERE id = ?").run(id);
  if (wasDefault) {
    const next = db.prepare(`
      SELECT id FROM third_party_models WHERE enabled = 1 ORDER BY id ASC LIMIT 1
    `).get() as { id: number } | undefined;
    if (next) {
      db.prepare("UPDATE third_party_models SET is_default = 1 WHERE id = ?").run(next.id);
    }
  }
  notifyRuntimeChanged();
}

export function setDefaultThirdPartyModel(id: number): ThirdPartyModelPublic {
  const current = getThirdPartyModelById(id);
  if (!current) throw new Error("第三方模型不存在");
  db.prepare("UPDATE third_party_models SET is_default = 0").run();
  db.prepare("UPDATE third_party_models SET is_default = 1, enabled = 1 WHERE id = ?").run(id);
  notifyRuntimeChanged();
  return toPublic(getThirdPartyModelById(id)!);
}

export function migrateLegacyThirdPartySettings(): void {
  const count = db.prepare("SELECT COUNT(*) AS count FROM third_party_models").get() as { count: number };
  if (count.count > 0) return;

  const legacyKey = getSetting("third_party_api_key").trim();
  const legacyModel = getSetting("third_party_model_name").trim();
  if (!legacyKey && !legacyModel) return;

  const provider = getSetting("third_party_provider").trim() === "ai-gateway" ? "ai-gateway" : "openai-compatible";
  createThirdPartyModel({
    name: legacyModel || "已迁移的第三方模型",
    provider,
    base_url: getSetting("third_party_base_url").trim(),
    api_key: legacyKey || "missing-key",
    model_name: legacyModel || "unknown",
    enabled: true,
    is_default: true,
  });
}
