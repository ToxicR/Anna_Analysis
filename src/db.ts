import fs from "node:fs";
import Database from "better-sqlite3";
import { DATA_DIR, DB_PATH, REPO_DIR, UPLOAD_DIR, WORKSPACE_DIR } from "./paths.js";

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(REPO_DIR, { recursive: true });
fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function nowIso(): string {
  return new Date().toISOString();
}

export function boolToInt(value: unknown, fallback = true): number {
  if (value === undefined || value === null) return fallback ? 1 : 0;
  return value ? 1 : 0;
}

export function normalizeRow<T extends object>(row: T): T {
  const clone = { ...(row as Record<string, unknown>) };
  for (const key of ["enabled", "is_default"]) {
    if (key in clone) clone[key] = Boolean(clone[key]);
  }
  return clone as T;
}

export function normalizeRows<T extends object>(rows: T[]): T[] {
  return rows.map(normalizeRow);
}

export function initDb(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY,
      name VARCHAR(120) UNIQUE NOT NULL,
      code VARCHAR(80) UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      enabled BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS ix_projects_name ON projects(name);
    CREATE INDEX IF NOT EXISTS ix_projects_code ON projects(code);

    CREATE TABLE IF NOT EXISTS git_repos (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name VARCHAR(160) NOT NULL,
      git_url TEXT NOT NULL,
      branch VARCHAR(120) DEFAULT 'main',
      access_token TEXT DEFAULT '',
      enabled BOOLEAN DEFAULT 1,
      local_path TEXT DEFAULT '',
      last_sync_at DATETIME
    );

    CREATE INDEX IF NOT EXISTS ix_git_repos_project_id ON git_repos(project_id);

    CREATE TABLE IF NOT EXISTS ai_models (
      id INTEGER PRIMARY KEY,
      name VARCHAR(120) UNIQUE NOT NULL,
      provider VARCHAR(80) DEFAULT 'openai-compatible',
      base_url TEXT DEFAULT '',
      api_key TEXT DEFAULT '',
      model_name VARCHAR(160) DEFAULT '',
      enabled BOOLEAN DEFAULT 1,
      is_default BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key VARCHAR(120) PRIMARY KEY,
      value TEXT DEFAULT '',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS code_chunks (
      id INTEGER PRIMARY KEY,
      repo_id INTEGER NOT NULL REFERENCES git_repos(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      language VARCHAR(40) DEFAULT '',
      content TEXT NOT NULL,
      content_hash VARCHAR(64) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS ix_code_chunks_repo_id ON code_chunks(repo_id);
    CREATE INDEX IF NOT EXISTS ix_code_chunks_file_path ON code_chunks(file_path);
    CREATE INDEX IF NOT EXISTS ix_code_chunks_content_hash ON code_chunks(content_hash);

    CREATE TABLE IF NOT EXISTS analysis_tasks (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      model_id INTEGER REFERENCES ai_models(id),
      analysis_type VARCHAR(40) NOT NULL,
      question TEXT NOT NULL,
      log_text TEXT DEFAULT '',
      selected_repo_ids VARCHAR(240) DEFAULT '',
      status VARCHAR(40) DEFAULT 'completed',
      result TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS ix_analysis_tasks_project_id ON analysis_tasks(project_id);

    CREATE TABLE IF NOT EXISTS cursor_agent_sessions (
      session_key TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      updated_at DATETIME NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT DEFAULT '新会话',
      model_id INTEGER REFERENCES ai_models(id),
      output_mode VARCHAR(40) DEFAULT 'non_developer',
      analysis_scope TEXT DEFAULT '',
      repo_ids TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS ix_chat_sessions_project_id ON chat_sessions(project_id);
    CREATE INDEX IF NOT EXISTS ix_chat_sessions_updated_at ON chat_sessions(updated_at);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL,
      meta TEXT DEFAULT '',
      body TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS ix_chat_messages_session_id ON chat_messages(session_id);

    CREATE TABLE IF NOT EXISTS app_users (
      id INTEGER PRIMARY KEY,
      account VARCHAR(80) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name VARCHAR(120) DEFAULT '',
      enabled BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS ix_app_users_account ON app_users(account);
  `);
  migrateAnalysisTaskColumns();
  migrateChatSessionUserColumn();
}

function migrateChatSessionUserColumn(): void {
  const columns = db.prepare("PRAGMA table_info(chat_sessions)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("user_id")) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN user_id INTEGER REFERENCES app_users(id) ON DELETE CASCADE");
    db.exec("CREATE INDEX IF NOT EXISTS ix_chat_sessions_user_id ON chat_sessions(user_id)");
    db.exec(`
      DELETE FROM chat_messages
      WHERE session_id IN (SELECT id FROM chat_sessions WHERE user_id IS NULL)
    `);
    db.exec("DELETE FROM chat_sessions WHERE user_id IS NULL");
  }
}

function migrateAnalysisTaskColumns(): void {
  const columns = db.prepare("PRAGMA table_info(analysis_tasks)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("agent_id")) db.exec("ALTER TABLE analysis_tasks ADD COLUMN agent_id TEXT DEFAULT ''");
  if (!names.has("run_id")) db.exec("ALTER TABLE analysis_tasks ADD COLUMN run_id TEXT DEFAULT ''");
  if (!names.has("workspace_path")) db.exec("ALTER TABLE analysis_tasks ADD COLUMN workspace_path TEXT DEFAULT ''");
  if (!names.has("analysis_scope")) db.exec("ALTER TABLE analysis_tasks ADD COLUMN analysis_scope TEXT DEFAULT ''");
}

export function getSetting(key: string): string {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? "";
}

export function setSetting(key: string, value: string): void {
  db.prepare(`
    INSERT INTO app_settings(key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, nowIso());
}
