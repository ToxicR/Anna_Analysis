export interface Project {
  id: number;
  name: string;
  code: string;
  description: string;
  enabled: boolean | number;
  created_at: string;
}

export interface GitRepo {
  id: number;
  project_id: number;
  name: string;
  git_url: string;
  branch: string;
  access_token: string;
  enabled: boolean | number;
  local_path: string;
  last_sync_at: string | null;
}

export interface AIModel {
  id: number;
  name: string;
  provider: string;
  base_url: string;
  api_key: string;
  model_name: string;
  enabled: boolean | number;
  is_default: boolean | number;
  created_at: string;
}

export interface CodeChunk {
  id: number;
  repo_id: number;
  file_path: string;
  language: string;
  content: string;
  content_hash: string;
  created_at: string;
}

export interface AnalysisTask {
  id: number;
  project_id: number;
  model_id: number | null;
  analysis_type: string;
  question: string;
  log_text: string;
  selected_repo_ids: string;
  status: string;
  result: string;
  agent_id?: string;
  run_id?: string;
  workspace_path?: string;
  analysis_scope?: string;
  user_id?: number | null;
  chat_session_id?: string;
  source?: string;
  feishu_chat_id?: string;
  feishu_open_id?: string;
  feishu_session_id?: string;
  user_account?: string;
  user_display_name?: string;
  created_at: string;
}

export type FeishuSessionMode = "personal" | "shared";

export interface FeishuUserBinding {
  open_id: string;
  app_user_id: number;
  union_id: string;
  display_name: string;
  enabled: boolean | number;
  created_at: string;
  updated_at: string;
  app_user_account?: string;
  app_user_display_name?: string;
}

export interface FeishuChatBinding {
  chat_id: string;
  chat_type: string;
  name: string;
  enabled: boolean | number;
  allow_shared_mode: boolean | number;
  created_at: string;
  updated_at: string;
  project_ids: number[];
}

export interface FeishuChatSession {
  id: string;
  app_user_id: number | null;
  project_id: number;
  title: string;
  model_id: number | null;
  output_mode: string;
  analysis_scope: string;
  repo_ids: string;
  mode: FeishuSessionMode;
  chat_id: string;
  created_at: string;
  updated_at: string;
}

export interface FeishuChatMessage {
  id: number;
  session_id: string;
  open_id: string;
  role: string;
  meta: string;
  body: string;
  created_at: string;
}

export interface FeishuSessionLink {
  id: number;
  chat_id: string;
  open_id: string;
  mode: FeishuSessionMode;
  session_id: string;
  current_project_id: number | null;
  shared_started_by_open_id: string;
  last_open_id: string;
  updated_at: string;
}

export interface FeishuSettingsPublic {
  configured: boolean;
  app_id: string;
  app_secret: string;
  verification_token: string;
  encrypt_key: string;
  webhook_path: string;
}

export interface FeishuDirectoryUserOption {
  open_id: string;
  union_id: string;
  name: string;
  user_id?: string;
  mobile?: string;
}

export interface FeishuAvailableProject {
  id: number;
  name: string;
  code: string;
}

export interface RepoValidationIssue {
  repo_id: number;
  repo_name: string;
  level: "error" | "warning";
  message: string;
}

export interface RepoValidationResult {
  ok: boolean;
  workspace_path: string;
  file_count: number;
  issues: RepoValidationIssue[];
}

export interface SyncRepoResult {
  repo_id: number;
  repo_name: string;
  local_path: string;
  workspace_slot: string;
  indexed_chunks: number;
  file_count: number;
}

export interface RepoSlotInput {
  git_url?: string;
  branch?: string;
}

export interface ProjectWithReposInput {
  name: string;
  description?: string;
  enabled?: boolean;
  android_repo?: RepoSlotInput;
  cpp_repo?: RepoSlotInput;
}

export interface ChatSession {
  id: string;
  user_id: number;
  project_id: number;
  title: string;
  model_id: number | null;
  third_party_model_id?: number | null;
  model_provider?: string;
  output_mode: string;
  analysis_scope: string;
  repo_ids: string;
  created_at: string;
  updated_at: string;
  message_count?: number;
  last_message_preview?: string;
}

export interface ChatMessage {
  id: number;
  session_id: string;
  role: string;
  meta: string;
  body: string;
  created_at: string;
}

export interface AppUser {
  id: number;
  account: string;
  password_hash: string;
  display_name: string;
  enabled: boolean | number;
  must_change_password?: boolean | number;
  web_login_enabled?: boolean | number;
  project_access_all?: boolean | number;
  created_at: string;
}

export interface AppUserPublic {
  id: number;
  account: string;
  display_name: string;
  enabled: boolean;
  must_change_password: boolean;
  web_login_enabled: boolean;
  project_access_all: boolean;
  allowed_project_ids: number[];
  feishu_open_id?: string;
  created_at: string;
}

export interface AppUserLoginRecord {
  id: number;
  user_id: number | null;
  account: string;
  success: boolean | number;
  ip: string;
  user_agent: string;
  failure_reason: string;
  created_at: string;
  user_account?: string;
  user_display_name?: string;
}
