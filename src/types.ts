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
  created_at: string;
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

export interface ModelInput {
  name: string;
  provider?: string;
  base_url?: string;
  api_key?: string;
  model_name?: string;
  enabled?: boolean;
  is_default?: boolean;
}
