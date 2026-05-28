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
  user_account?: string;
  user_display_name?: string;
  created_at: string;
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
  project_access_all?: boolean | number;
  created_at: string;
}

export interface AppUserPublic {
  id: number;
  account: string;
  display_name: string;
  enabled: boolean;
  must_change_password: boolean;
  project_access_all: boolean;
  allowed_project_ids: number[];
  created_at: string;
}
