import type { AIModel } from "../types.js";
import {
  assertThirdPartyModelReady,
  getDefaultThirdPartyModel,
  getThirdPartyModelById,
  isThirdPartyAnalysisEnabled,
  thirdPartyModelToAIModel,
  type ThirdPartyModel,
} from "./third-party-models.js";

let gatewayFingerprint = "";
let agentModulePromise: Promise<typeof import("@cursor/sdk")> | null = null;

export function isThirdPartyModelEnabled(): boolean {
  return isThirdPartyAnalysisEnabled();
}

export function invalidateCursorRuntime(): void {
  gatewayFingerprint = "";
  agentModulePromise = null;
}

function buildGatewayFingerprint(model: ThirdPartyModel): string {
  return JSON.stringify({
    id: model.id,
    provider: model.provider,
    baseURL: model.base_url,
    modelName: model.model_name,
    apiKeyTail: model.api_key.slice(-8),
  });
}

export function isThirdPartyProvider(provider: string): boolean {
  return provider === "openai-compatible" || provider === "ai-gateway";
}

export function resolveEffectiveAnalysisModel(
  cursorModel: AIModel | undefined,
  thirdPartyModelId?: number | null,
): AIModel | undefined {
  if (thirdPartyModelId != null && thirdPartyModelId > 0) {
    const picked = getThirdPartyModelById(thirdPartyModelId);
    if (!picked || !picked.enabled) {
      throw new Error("所选第三方模型不可用，请在管理后台检查配置。");
    }
    assertThirdPartyModelReady(picked);
    return thirdPartyModelToAIModel(picked);
  }
  if (cursorModel) return cursorModel;
  if (isThirdPartyAnalysisEnabled()) {
    const picked = getDefaultThirdPartyModel();
    if (picked?.enabled) {
      assertThirdPartyModelReady(picked);
      return thirdPartyModelToAIModel(picked);
    }
  }
  return cursorModel;
}

export async function loadCursorSdk(thirdPartyModelId?: number | null): Promise<typeof import("@cursor/sdk")> {
  if (!thirdPartyModelId || thirdPartyModelId <= 0) {
    gatewayFingerprint = "cursor-native";
    agentModulePromise = agentModulePromise ?? import("@cursor/sdk");
    return agentModulePromise;
  }

  const model = getThirdPartyModelById(thirdPartyModelId);
  if (!model) throw new Error("未找到所选第三方模型");
  assertThirdPartyModelReady(model);

  const fingerprint = buildGatewayFingerprint(model);
  if (agentModulePromise && gatewayFingerprint === fingerprint) {
    return agentModulePromise;
  }

  gatewayFingerprint = fingerprint;
  agentModulePromise = (async () => {
    const { configureCursorGateway } = await import("cursor-sdk-gateway");
    const provider = model.provider === "ai-gateway" ? "ai-gateway" : "openai-compatible";
    if (provider === "ai-gateway") {
      await configureCursorGateway({
        provider: "ai-gateway",
        apiKey: model.api_key,
        ...(model.base_url ? { baseURL: model.base_url } : {}),
      });
    } else {
      await configureCursorGateway({
        provider: "openai-compatible",
        baseURL: model.base_url,
        apiKey: model.api_key,
      });
    }
    return import("@cursor/sdk");
  })();

  return agentModulePromise;
}

export async function warmupCursorRuntime(): Promise<void> {
  try {
    await loadCursorSdk();
  } catch (error) {
    console.warn("[anna] cursor runtime warmup failed:", error instanceof Error ? error.message : error);
  }
}
