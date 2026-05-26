import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, "..");
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const REPO_DIR = path.join(DATA_DIR, "repos");
export const WORKSPACE_DIR = path.join(DATA_DIR, "workspaces");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const STATIC_DIR = path.join(ROOT_DIR, "static");
export const DB_PATH = path.join(DATA_DIR, "anna_analysis.db");
