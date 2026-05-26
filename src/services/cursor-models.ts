import { Cursor } from "@cursor/sdk";
import { db, normalizeRow, nowIso } from "../db.js";
import type { AIModel } from "../types.js";
import { getCursorApiKey } from "./ai.js";

interface CursorModelItem {
  id: string;
  displayName?: string;
  aliases?: string[];
}

export async function syncCursorModels(): Promise<AIModel[]> {
  const apiKey = getCursorApiKey();
  if (!apiKey) {
    ensureFallbackModel();
    return listCursorModels();
  }

  const models = await Cursor.models.list({ apiKey }) as CursorModelItem[];
  if (!models.length) {
    ensureFallbackModel();
    return listCursorModels();
  }

  const existingDefault = db.prepare(`
    SELECT model_name FROM ai_models
    WHERE provider = 'cursor' AND is_default = 1
    LIMIT 1
  `).get() as { model_name: string } | undefined;
  const availableIds = new Set(models.map((model) => model.id));
  const preferredDefaultModelId = chooseDefaultModel(models);
  const defaultModelId = existingDefault && availableIds.has(existingDefault.model_name) && existingDefault.model_name === preferredDefaultModelId
    ? existingDefault.model_name
    : preferredDefaultModelId;

  const upsert = db.prepare(`
    INSERT INTO ai_models(name, provider, base_url, api_key, model_name, enabled, is_default, created_at)
    VALUES (?, 'cursor', '', '', ?, 1, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      provider = 'cursor',
      base_url = '',
      api_key = '',
      model_name = excluded.model_name,
      enabled = 1,
      is_default = excluded.is_default
  `);

  const tx = db.transaction(() => {
    db.prepare("UPDATE ai_models SET enabled = 0, is_default = 0 WHERE provider = 'cursor'").run();
    for (const model of models) {
      const name = model.displayName || model.id;
      upsert.run(name, model.id, model.id === defaultModelId ? 1 : 0, nowIso());
    }
  });
  tx();

  return listCursorModels();
}

function listCursorModels(): AIModel[] {
  const rows = db.prepare(`
    SELECT * FROM ai_models
    WHERE provider = 'cursor' AND enabled = 1
    ORDER BY is_default DESC, id DESC
  `).all() as AIModel[];
  return rows.map((row) => normalizeRow(row));
}

function ensureFallbackModel(): void {
  const count = db.prepare("SELECT COUNT(*) AS count FROM ai_models WHERE provider = 'cursor' AND enabled = 1").get() as { count: number };
  if (count.count > 0) return;
  db.prepare(`
    INSERT INTO ai_models(name, provider, base_url, api_key, model_name, enabled, is_default, created_at)
    VALUES ('Cursor Composer', 'cursor', '', '', 'composer-2', 1, 1, ?)
  `).run(nowIso());
}

function chooseDefaultModel(models: CursorModelItem[]): string {
  const composer25 = models.find((model) => model.id === "composer-2.5");
  if (composer25) return composer25.id;
  const composer2 = models.find((model) => model.id === "composer-2");
  if (composer2) return composer2.id;
  const aliasMatch = models.find((model) => model.aliases?.includes("composer-latest"));
  if (aliasMatch) return aliasMatch.id;
  const composer = models.find((model) => model.id.toLowerCase().includes("composer"));
  if (composer) return composer.id;
  const auto = models.find((model) => model.id === "default" || (model.displayName || "").toLowerCase() === "auto");
  if (auto) return auto.id;
  return models[0]!.id;
}
