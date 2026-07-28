import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { db } from "../../db.js";
import { UPLOAD_DIR } from "../../paths.js";
import { copyAttachmentsToWorkspace, projectWorkspaceRoot, sessionUploadsDir } from "../workspace.js";
import { fetchFeishuMessageById, getFeishuTenantAccessToken } from "./api.js";
import { getCachedFeishuMessageAttachments } from "./message-cache.js";
import type { FeishuSessionMode } from "../../types.js";

const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";
const MAX_LOG_TEXT = 100_000;
const MAX_PREVIEW_CURRENT = 12_000;
const MAX_PREVIEW_HISTORY = 4_000;
const MAX_FILES_IN_PROMPT = 18;
const MANIFEST_FILE = "_feishu_uploads.json";

export interface FeishuIncomingAttachment {
  resource_key: string;
  resource_type: "file" | "image";
  file_name?: string;
}

interface PreparedFeishuFile {
  file_name: string;
  mime_type: string;
  size: number;
  text: string;
  relative_path: string;
  workspace_path: string;
  /** Absolute path of the file as staged into the isolated focus dir (set after staging). */
  analysis_path?: string;
  image_url?: string;
  uploaded_by: string;
  uploaded_at: string;
  is_current_turn: boolean;
  content_note?: string;
}

export interface FeishuAttachmentAnalysis {
  log_text: string;
  attachment_images: { url: string }[];
  focus_log_names: string[];
  /** Isolated working dir containing only this turn's focus files; used to scope the agent's cwd. */
  focus_dir: string | null;
}

interface UploadManifestEntry {
  stored_name: string;
  display_name: string;
  relative_path: string;
  sha256: string;
  uploaded_by: string;
  message_id: string;
  uploaded_at: string;
  /** 飞书资源 key，用于引用回复时跳过重复下载。 */
  resource_key?: string;
  resource_type?: "file" | "image";
}

type PostContentNode = {
  tag?: string;
  text?: string;
  file_key?: string;
  image_key?: string;
  file_name?: string;
};

function isTextAttachment(fileName: string, mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    mimeType.includes("xml") ||
    /\.(log|txt|json|xml|csv|md|trace|out|err|ini|properties|yaml|yml)$/i.test(fileName)
  );
}

function guessMimeType(fileName: string, resourceType: "file" | "image"): string {
  if (resourceType === "image") return "image/png";
  const ext = path.extname(fileName).toLowerCase();
  const map: Record<string, string> = {
    ".log": "text/plain",
    ".txt": "text/plain",
    ".json": "application/json",
    ".xml": "application/xml",
    ".csv": "text/csv",
    ".md": "text/markdown",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
  };
  return map[ext] || "application/octet-stream";
}

function parseContentDispositionFileName(contentDisposition: string): string {
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const plainMatch = contentDisposition.match(/filename="([^"]+)"/i);
  return plainMatch?.[1]?.trim() || "";
}

function sha256Buffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function feishuWorkspaceSessionId(sessionId: string): string {
  return `feishu:${sessionId}`;
}

const FOCUS_DIR_PARENT = ".focus";

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "_").slice(0, 160) || "default";
}

/**
 * Stage only this turn's focus files into an isolated directory so the analysis agent
 * physically cannot see (and therefore cannot read) other sessions' accumulated uploads.
 * Returns the absolute focus dir, and mutates each file's `analysis_path` to its staged location.
 */
function stageFeishuFocusFiles(
  projectId: number,
  sessionId: string,
  slug: string,
  files: PreparedFeishuFile[],
): string | null {
  if (!files.length) return null;
  const uploadsDir = sessionUploadsDir(projectId, feishuWorkspaceSessionId(sessionId));
  const focusDir = path.join(uploadsDir, FOCUS_DIR_PARENT, slugify(slug));
  try {
    fs.rmSync(focusDir, { recursive: true, force: true });
    fs.mkdirSync(focusDir, { recursive: true });

    const usedNames = new Set<string>();
    for (const file of files) {
      if (!fs.existsSync(file.workspace_path)) continue;
      let stagedName = path.basename(file.file_name) || path.basename(file.workspace_path);
      if (usedNames.has(stagedName)) {
        const ext = path.extname(stagedName);
        stagedName = `${path.basename(stagedName, ext)}-${usedNames.size}${ext}`;
      }
      usedNames.add(stagedName);
      const stagedPath = path.join(focusDir, stagedName);
      fs.copyFileSync(file.workspace_path, stagedPath);
      file.analysis_path = stagedPath;
    }

    fs.writeFileSync(
      path.join(focusDir, "README.md"),
      [
        "# 本轮分析专用目录",
        "",
        "本目录仅包含本次需要分析的日志/附件。",
        "请只读取本目录内的文件，禁止访问或引用其他目录、其他会话的历史日志。",
        "结论必须来自本目录中的文件。",
      ].join("\n"),
      "utf8",
    );
    return focusDir;
  } catch {
    return null;
  }
}

type FeishuLog = { warn: (obj: Record<string, unknown>, msg: string) => void };

/** Resolve the file referenced by a quoted reply (parent/root message) into attachments. */
async function resolveParentMessageAttachments(
  parentMessageId: string,
  log?: FeishuLog,
): Promise<{
  attachments: FeishuIncomingAttachment[];
  sourceMessageId: string;
}> {
  const trimmed = parentMessageId.trim();
  if (!trimmed) return { attachments: [], sourceMessageId: "" };

  const cached = getCachedFeishuMessageAttachments(trimmed);
  if (cached.length) {
    return { attachments: cached, sourceMessageId: trimmed };
  }

  const parent = await fetchFeishuMessageById(trimmed, log);
  if (!parent) return { attachments: [], sourceMessageId: "" };
  const attachments = extractFeishuMessageAttachments(parent.message_type, parent.content);
  return { attachments, sourceMessageId: attachments.length ? parent.message_id || trimmed : "" };
}

/** Download and persist attachments into the Feishu session upload library (no analysis). */
export async function ingestFeishuIncomingAttachments(input: {
  projectId: number;
  sessionId: string;
  messageId: string;
  attachments: FeishuIncomingAttachment[];
  openId?: string;
  parentMessageId?: string;
  log?: FeishuLog;
}): Promise<{ storedKeys: Set<string>; displayNames: string[]; turnNotes: Map<string, string> }> {
  let attachments = input.attachments;
  let downloadMessageId = input.messageId;
  if (!attachments.length && input.parentMessageId) {
    const resolved = await resolveParentMessageAttachments(input.parentMessageId, input.log);
    if (resolved.attachments.length) {
      attachments = resolved.attachments;
      downloadMessageId = resolved.sourceMessageId;
    }
  }
  if (!attachments.length || !downloadMessageId) {
    return { storedKeys: new Set(), displayNames: [], turnNotes: new Map() };
  }

  const uploadsDir = sessionUploadsDir(input.projectId, feishuWorkspaceSessionId(input.sessionId));
  let manifest = readUploadManifest(uploadsDir);
  const currentTurnNotes = new Map<string, string>();
  const storedKeys = new Set<string>();
  const displayNames: string[] = [];

  for (const attachment of attachments) {
    const cached = findCachedManifestEntryForAttachment(
      manifest,
      input.projectId,
      downloadMessageId,
      attachment,
    );
    if (cached) {
      storedKeys.add(cached.stored_name);
      currentTurnNotes.set(
        cached.stored_name,
        `本轮引用已有附件「${cached.display_name}」，未重复下载。`,
      );
      displayNames.push(cached.display_name);
      continue;
    }

    const downloaded = await downloadFeishuMessageResource(
      downloadMessageId,
      attachment.resource_key,
      attachment.resource_type,
      attachment.file_name,
    );
    const displayName = path.basename(downloaded.fileName || attachment.file_name || "attachment.bin");
    const result = ingestDownloadedAttachment({
      projectId: input.projectId,
      sessionId: input.sessionId,
      messageId: downloadMessageId,
      openId: input.openId ?? "",
      buffer: downloaded.buffer,
      displayName,
      manifest,
      resourceKey: attachment.resource_key,
      resourceType: attachment.resource_type,
    }, currentTurnNotes);
    manifest = result.manifest;
    for (const key of result.currentTurnKeys) {
      storedKeys.add(key);
      const entry = manifest.find((item) => item.stored_name === key);
      if (entry?.display_name) displayNames.push(entry.display_name);
    }
  }

  return { storedKeys, displayNames, turnNotes: currentTurnNotes };
}

function resolveUploaderLabel(openId: string): string {
  if (!openId) return "未知用户";
  const row = db.prepare("SELECT name FROM feishu_contacts WHERE open_id = ?").get(openId) as { name?: string } | undefined;
  const name = row?.name?.trim();
  if (name) return name;
  return `用户 ${openId.slice(0, 8)}`;
}

function buildStoredName(openId: string, displayName: string): string {
  const uploaderTag = (openId || "unknown").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "unknown";
  return `${Date.now()}-${uploaderTag}-${Math.random().toString(16).slice(2, 8)}-${path.basename(displayName)}`;
}

function parseDisplayNameFromStored(storedName: string): string {
  const match = storedName.match(/^\d+-[a-z0-9]+-[a-z0-9]+-(.+)$/i);
  return match?.[1] || storedName;
}

function readUploadManifest(uploadsDir: string): UploadManifestEntry[] {
  const manifestPath = path.join(uploadsDir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as UploadManifestEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeUploadManifest(uploadsDir: string, entries: UploadManifestEntry[]): void {
  fs.mkdirSync(uploadsDir, { recursive: true });
  const manifestPath = path.join(uploadsDir, MANIFEST_FILE);
  fs.writeFileSync(manifestPath, JSON.stringify(entries, null, 2), "utf8");
}

function dedupeAttachments(attachments: FeishuIncomingAttachment[]): FeishuIncomingAttachment[] {
  const seen = new Set<string>();
  const result: FeishuIncomingAttachment[] = [];
  for (const item of attachments) {
    const key = `${item.resource_type}:${item.resource_key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function collectPostAttachments(parsed: { content?: PostContentNode[][] }, bucket: FeishuIncomingAttachment[]): void {
  for (const row of parsed.content || []) {
    if (!Array.isArray(row)) continue;
    for (const node of row) {
      if (!node || typeof node !== "object") continue;
      if (node.tag === "img" && node.image_key) {
        bucket.push({
          resource_key: node.image_key,
          resource_type: "image",
          file_name: node.file_name?.trim() || "image.png",
        });
      }
      if ((node.tag === "media" || node.tag === "file") && node.file_key) {
        bucket.push({
          resource_key: node.file_key,
          resource_type: "file",
          file_name: node.file_name?.trim(),
        });
      }
    }
  }
}

/** Extract file/image keys from Feishu message content (file, image, post, etc.). */
export function extractFeishuMessageAttachments(messageType?: string, content?: string): FeishuIncomingAttachment[] {
  if (!content) return [];
  const bucket: FeishuIncomingAttachment[] = [];

  let parsed: {
    file_key?: string;
    file_name?: string;
    image_key?: string;
    content?: PostContentNode[][];
  };
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }

  if ((messageType === "file" || messageType === "media") && parsed.file_key) {
    bucket.push({
      resource_key: parsed.file_key,
      resource_type: "file",
      file_name: parsed.file_name?.trim() || "attachment.bin",
    });
  } else if (messageType === "image" && parsed.image_key) {
    bucket.push({
      resource_key: parsed.image_key,
      resource_type: "image",
      file_name: "image.png",
    });
  } else if (messageType === "post") {
    collectPostAttachments(parsed, bucket);
  }

  // 兜底：不依赖 message_type，只要内容里带 file_key/image_key/富文本附件就识别。
  // 应对飞书实际下发的类型字段与预期不一致（这会导致文件附件被漏掉、退化成空消息走帮助卡）。
  if (!bucket.length) {
    if (parsed.file_key) {
      bucket.push({
        resource_key: parsed.file_key,
        resource_type: "file",
        file_name: parsed.file_name?.trim() || "attachment.bin",
      });
    } else if (parsed.image_key) {
      bucket.push({
        resource_key: parsed.image_key,
        resource_type: "image",
        file_name: "image.png",
      });
    } else if (Array.isArray(parsed.content)) {
      collectPostAttachments(parsed, bucket);
    }
  }

  return dedupeAttachments(bucket);
}

export function extractLogFilenameHint(text: string): string | null {
  const normalized = text.trim();
  if (!normalized) return null;

  const bracketMatches = [...normalized.matchAll(/\[文件\]\s*([^\s\]]+\.log)\b/gi)];
  if (bracketMatches.length) return bracketMatches[bracketMatches.length - 1]![1];

  const replyQuoteMatches = [...normalized.matchAll(/\[回复[^\]]*:\s*\[文件\]\s*([^\s\]]+\.log)\b/gi)];
  if (replyQuoteMatches.length) return replyQuoteMatches[replyQuoteMatches.length - 1]![1];

  const citeQuoteMatches = [...normalized.matchAll(/\[引用[^\]]*:\s*\[文件\]\s*([^\s\]]+\.log)\b/gi)];
  if (citeQuoteMatches.length) return citeQuoteMatches[citeQuoteMatches.length - 1]![1];

  const quotedMatches = [...normalized.matchAll(/[「"']([^「"']+\.log)[」"']/gi)];
  if (quotedMatches.length) return quotedMatches[quotedMatches.length - 1]![1];

  const attachmentMatch = normalized.match(/附件[「「]?([^」"\s]+\.log)/i);
  if (attachmentMatch?.[1]) return attachmentMatch[1];

  const plainMatches = [...normalized.matchAll(/\b([\w.-]+\.log)\b/gi)];
  if (plainMatches.length) return plainMatches[plainMatches.length - 1]![1];

  return null;
}

function fileMatchesLogHint(fileName: string, hintLower: string): boolean {
  const nameLower = fileName.toLowerCase();
  return nameLower.includes(hintLower) || hintLower.includes(nameLower);
}

export function resolveFeishuAnalysisSessionKey(
  sessionId: string,
  logHint: string | null,
  focusLogNames: string[],
): string {
  const base = `feishu:${sessionId}`;
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, "_").slice(0, 160);
  if (logHint?.trim()) return `${base}::${slug(logHint)}`;
  if (focusLogNames.length === 1) return `${base}::${slug(focusLogNames[0]!)}`;
  if (focusLogNames.length > 1) return `${base}::${slug(focusLogNames.slice().sort().join("+"))}`;
  return base;
}

function formatAttachmentForPrompt(file: PreparedFeishuFile, mode: FeishuSessionMode): string {
  const scopeLabel = file.is_current_turn ? "本轮新增" : "历史累积";
  const modeHint = mode === "shared"
    ? "（群协作：附件来自本群各成员，可综合阅读）"
    : "（个人会话：仅你本人上传的附件）";
  const readablePath = file.analysis_path || file.workspace_path;
  const header = [
    `【${scopeLabel}附件${modeHint}】`,
    `文件名：${file.file_name}`,
    `上传者：${file.uploaded_by}`,
    `上传时间：${file.uploaded_at}`,
    `类型：${file.mime_type || "unknown"}`,
    `大小：${file.size} bytes`,
    `分析文件路径（请用 read_file 读取此绝对路径获取完整内容）：${readablePath}`,
    file.content_note ? `说明：${file.content_note}` : "",
  ].filter(Boolean).join("\n");

  const previewLimit = file.is_current_turn ? MAX_PREVIEW_CURRENT : MAX_PREVIEW_HISTORY;
  if (file.text) {
    return `${header}\n内容预览（前 ${previewLimit} 字符，完整内容请读取上述路径）：\n${file.text.slice(0, previewLimit)}`;
  }

  if (file.mime_type.startsWith("image/")) {
    return file.is_current_turn
      ? `${header}\n（图片已随本轮消息注入 Agent）`
      : `${header}\n（历史图片，请用 read_file 读取上述路径）`;
  }

  return `${header}\n请用 read_file 读取上述路径。`;
}

function buildPreparedFileFromManifest(
  projectId: number,
  entry: UploadManifestEntry,
  isCurrentTurn: boolean,
  contentNote?: string,
): PreparedFeishuFile | null {
  const fullPath = path.join(projectWorkspaceRoot(projectId), entry.relative_path);
  if (!fs.existsSync(fullPath)) return null;

  const displayName = entry.display_name || parseDisplayNameFromStored(entry.stored_name);
  const mimeType = guessMimeType(displayName, /\.(png|jpe?g|gif|webp|bmp)$/i.test(displayName) ? "image" : "file");
  const buffer = fs.readFileSync(fullPath);
  const text = isTextAttachment(displayName, mimeType)
    ? buffer.toString("utf8")
    : "";

  return {
    file_name: displayName,
    mime_type: mimeType,
    size: buffer.length,
    text,
    relative_path: entry.relative_path,
    workspace_path: fullPath,
    image_url: mimeType.startsWith("image/") ? pathToFileURL(fullPath).href : undefined,
    uploaded_by: resolveUploaderLabel(entry.uploaded_by),
    uploaded_at: entry.uploaded_at,
    is_current_turn: isCurrentTurn,
    content_note: contentNote,
  };
}

function syncManifestFromDisk(projectId: number, sessionId: string, manifest: UploadManifestEntry[]): UploadManifestEntry[] {
  const uploadsDir = sessionUploadsDir(projectId, feishuWorkspaceSessionId(sessionId));
  if (!fs.existsSync(uploadsDir)) return manifest;

  const known = new Set(manifest.map((entry) => entry.stored_name));
  for (const storedName of fs.readdirSync(uploadsDir)) {
    if (storedName === MANIFEST_FILE || known.has(storedName)) continue;
    const workspacePath = path.join(uploadsDir, storedName);
    if (!fs.statSync(workspacePath).isFile()) continue;
    const displayName = parseDisplayNameFromStored(storedName);
    const relativePath = path.relative(projectWorkspaceRoot(projectId), workspacePath).split(path.sep).join("/");
    const buffer = fs.readFileSync(workspacePath);
    manifest.push({
      stored_name: storedName,
      display_name: displayName,
      relative_path: relativePath,
      sha256: sha256Buffer(buffer),
      uploaded_by: "",
      message_id: "",
      uploaded_at: new Date(fs.statSync(workspacePath).mtimeMs).toISOString(),
    });
  }
  return manifest;
}

function manifestEntryExists(projectId: number, entry: UploadManifestEntry): boolean {
  return fs.existsSync(path.join(projectWorkspaceRoot(projectId), entry.relative_path));
}

/** 同一会话中，同一飞书消息 + 同一 resource_key 视为已下载。 */
function findCachedManifestEntryForAttachment(
  manifest: UploadManifestEntry[],
  projectId: number,
  messageId: string,
  attachment: FeishuIncomingAttachment,
): UploadManifestEntry | undefined {
  const msgId = messageId.trim();
  if (!msgId) return undefined;
  const resourceKey = attachment.resource_key?.trim();
  const fileName = attachment.file_name?.trim().toLowerCase() ?? "";

  for (const entry of manifest) {
    if (!manifestEntryExists(projectId, entry)) continue;
    if (entry.message_id?.trim() !== msgId) continue;
    if (resourceKey && entry.resource_key) {
      if (entry.resource_key === resourceKey) return entry;
      continue;
    }
    if (fileName && entry.display_name.trim().toLowerCase() === fileName) return entry;
  }
  return undefined;
}

function ingestDownloadedAttachment(input: {
  projectId: number;
  sessionId: string;
  messageId: string;
  openId: string;
  buffer: Buffer;
  displayName: string;
  manifest: UploadManifestEntry[];
  resourceKey?: string;
  resourceType?: "file" | "image";
}, currentTurnNotes: Map<string, string>): { manifest: UploadManifestEntry[]; currentTurnKeys: Set<string> } {
  const uploadsDir = sessionUploadsDir(input.projectId, feishuWorkspaceSessionId(input.sessionId));
  const hash = sha256Buffer(input.buffer);
  const existing = input.manifest.find((entry) => entry.sha256 === hash && manifestEntryExists(input.projectId, entry));

  const uploadedAt = new Date().toISOString();
  const currentTurnKeys = new Set<string>();

  if (existing) {
    currentTurnKeys.add(existing.stored_name);
    currentTurnNotes.set(
      existing.stored_name,
      `本轮上传与已有附件「${existing.display_name}」内容相同（SHA256），已合并引用同一文件。`,
    );
    return {
      manifest: input.manifest,
      currentTurnKeys,
    };
  }

  const storedName = buildStoredName(input.openId, input.displayName);
  const tempPath = path.join(UPLOAD_DIR, storedName);
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(tempPath, input.buffer);

  const copied = copyAttachmentsToWorkspace(input.projectId, feishuWorkspaceSessionId(input.sessionId), [{
    stored_name: storedName,
    source_path: tempPath,
  }]);
  const workspace = copied[0]!;
  const entry: UploadManifestEntry = {
    stored_name: storedName,
    display_name: input.displayName,
    relative_path: workspace.relative_path,
    sha256: hash,
    uploaded_by: input.openId,
    message_id: input.messageId,
    uploaded_at: uploadedAt,
    ...(input.resourceKey ? { resource_key: input.resourceKey } : {}),
    ...(input.resourceType ? { resource_type: input.resourceType } : {}),
  };
  input.manifest.push(entry);
  currentTurnKeys.add(storedName);
  writeUploadManifest(uploadsDir, input.manifest);

  return { manifest: input.manifest, currentTurnKeys };
}

function buildMergedAttachmentPrompt(input: {
  projectId: number;
  sessionId: string;
  mode: FeishuSessionMode;
  manifest: UploadManifestEntry[];
  currentTurnKeys: Set<string>;
  currentTurnNotes: Map<string, string>;
  logHint: string | null;
}): FeishuAttachmentAnalysis {
  let manifest = syncManifestFromDisk(input.projectId, input.sessionId, [...input.manifest]);
  const uploadsDir = sessionUploadsDir(input.projectId, feishuWorkspaceSessionId(input.sessionId));
  writeUploadManifest(uploadsDir, manifest);

  const currentTurn: PreparedFeishuFile[] = [];
  const history: PreparedFeishuFile[] = [];

  for (const entry of manifest) {
    const isCurrent = input.currentTurnKeys.has(entry.stored_name);
    const note = input.currentTurnNotes.get(entry.stored_name);
    const prepared = buildPreparedFileFromManifest(input.projectId, entry, isCurrent, note);
    if (!prepared) continue;
    if (isCurrent) currentTurn.push(prepared);
    else history.push(prepared);
  }

  history.sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));

  const hintLower = input.logHint?.toLowerCase() ?? null;
  let pool: PreparedFeishuFile[];
  let scopeNote: string;

  if (hintLower) {
    const matched = [...currentTurn, ...history].filter((file) => fileMatchesLogHint(file.file_name, hintLower));
    pool = matched;
    scopeNote = matched.length
      ? `【仅分析指定日志】用户点名文件：${input.logHint}。禁止读取或引用其他历史附件/路径，结论必须来自下列文件。`
      : "";
  } else if (currentTurn.length) {
    pool = currentTurn;
    scopeNote = "【仅分析本轮附件】以下为本条消息新上传的文件；不要读取会话中其他历史日志。";
  } else {
    // 未点名、本轮也无新附件：默认聚焦最近一次上传的日志，避免在历史多份日志里挑错。
    const latest = history.find((file) => /\.log$/i.test(file.file_name)) ?? history[0] ?? null;
    pool = latest ? [latest] : [];
    scopeNote = latest
      ? `【未指定日志 · 默认分析最近一次上传】会话未点名具体日志，已默认选择最近上传的「${latest.file_name}」（上传时间 ${latest.uploaded_at}）。如需分析其他日志，请回复并写明文件名。`
      : "";
  }

  const sortByHint = (files: PreparedFeishuFile[]) => {
    if (!hintLower) {
      return [...files].sort((a, b) => Number(b.is_current_turn) - Number(a.is_current_turn));
    }
    return [...files].sort((a, b) => {
      const aMatch = fileMatchesLogHint(a.file_name, hintLower) ? 1 : 0;
      const bMatch = fileMatchesLogHint(b.file_name, hintLower) ? 1 : 0;
      if (bMatch !== aMatch) return bMatch - aMatch;
      return Number(b.is_current_turn) - Number(a.is_current_turn);
    });
  };

  const ordered = sortByHint(pool).slice(0, MAX_FILES_IN_PROMPT);

  if (!ordered.length) {
    if (input.logHint) {
      return {
        log_text: [
          `用户指定分析日志：${input.logHint}`,
          "当前会话附件库中未找到匹配文件。请让成员重新发送文件，或在本条消息中附带文件。",
          input.mode === "shared"
            ? "群协作模式下，所有成员附件会累积在同一附件库中供分析。"
            : "个人模式下，仅累积你本人会话中上传的附件。",
        ].join("\n"),
        attachment_images: [],
        focus_log_names: [],
        focus_dir: null,
      };
    }
    return { log_text: "", attachment_images: [], focus_log_names: [], focus_dir: null };
  }

  // 将本轮聚焦的文件复制到隔离目录，使 Agent 只能读取这些文件，物理上隔绝其他会话的历史日志。
  const focusSlug = input.logHint?.trim()
    ? input.logHint
    : ordered.map((file) => file.file_name).sort().join("+");
  const focusDir = stageFeishuFocusFiles(input.projectId, input.sessionId, focusSlug, ordered);

  const logText = [
    scopeNote,
    ...ordered.map((file) => formatAttachmentForPrompt(file, input.mode)),
  ].join("\n\n").slice(0, MAX_LOG_TEXT);

  const attachmentImages = ordered
    .filter((file) => file.is_current_turn && file.image_url)
    .map((file) => ({ url: file.image_url! }));

  const focus_log_names = ordered
    .map((file) => file.file_name)
    .filter((name) => /\.log$/i.test(name));

  return { log_text: logText, attachment_images: attachmentImages, focus_log_names, focus_dir: focusDir };
}

export async function downloadFeishuMessageResource(
  messageId: string,
  resourceKey: string,
  resourceType: "file" | "image",
  fallbackFileName?: string,
): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
  const token = await getFeishuTenantAccessToken();
  const url = `${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(resourceKey)}?type=${resourceType}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`下载飞书附件失败：HTTP ${response.status}`);
  }

  const contentDisposition = response.headers.get("content-disposition") || "";
  const fileName = parseContentDispositionFileName(contentDisposition)
    || fallbackFileName
    || (resourceType === "image" ? "image.png" : "attachment.bin");
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim()
    || guessMimeType(fileName, resourceType);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, fileName, mimeType };
}

export async function prepareFeishuAttachmentsForAnalysis(input: {
  projectId: number;
  sessionId: string;
  messageId: string;
  attachments: FeishuIncomingAttachment[];
  question?: string;
  openId?: string;
  mode?: FeishuSessionMode;
  /** 引用回复时被引用消息的 id，用于解析该消息携带的文件。 */
  parentMessageId?: string;
  log?: FeishuLog;
}): Promise<FeishuAttachmentAnalysis> {
  const sessionMode = input.mode ?? "personal";
  const logHint = extractLogFilenameHint(input.question ?? "");
  const uploadsDir = sessionUploadsDir(input.projectId, feishuWorkspaceSessionId(input.sessionId));
  let manifest = readUploadManifest(uploadsDir);
  const currentTurnKeys = new Set<string>();
  const currentTurnNotes = new Map<string, string>();

  // 本轮直接附件优先；若无附件但属引用回复，则解析被引用消息携带的文件。
  let attachments = input.attachments;
  let downloadMessageId = input.messageId;
  if (!attachments.length && input.parentMessageId) {
    const resolved = await resolveParentMessageAttachments(input.parentMessageId, input.log);
    if (resolved.attachments.length) {
      attachments = resolved.attachments;
      downloadMessageId = resolved.sourceMessageId;
    }
  }

  if (attachments.length) {
    if (!downloadMessageId) {
      throw new Error("无法下载附件：缺少 message_id。");
    }
    const ingested = await ingestFeishuIncomingAttachments({
      projectId: input.projectId,
      sessionId: input.sessionId,
      messageId: downloadMessageId,
      attachments,
      openId: input.openId,
      parentMessageId: input.parentMessageId,
      log: input.log,
    });
    for (const key of ingested.storedKeys) currentTurnKeys.add(key);
    for (const [key, note] of ingested.turnNotes) currentTurnNotes.set(key, note);
  } else if (logHint) {
    const hintLower = logHint.toLowerCase();
    const matched = manifest.filter((entry) =>
      entry.display_name.toLowerCase().includes(hintLower)
      || entry.stored_name.toLowerCase().includes(hintLower));
    for (const entry of matched) currentTurnKeys.add(entry.stored_name);
  }

  if (!attachments.length && !logHint && !feishuSessionHasUploads(input.projectId, input.sessionId)) {
    return { log_text: "", attachment_images: [], focus_log_names: [], focus_dir: null };
  }

  return buildMergedAttachmentPrompt({
    projectId: input.projectId,
    sessionId: input.sessionId,
    mode: sessionMode,
    manifest,
    currentTurnKeys,
    currentTurnNotes,
    logHint,
  });
}

export function feishuSessionHasUploads(projectId: number, sessionId: string): boolean {
  const uploadsDir = sessionUploadsDir(projectId, feishuWorkspaceSessionId(sessionId));
  if (!fs.existsSync(uploadsDir)) return false;
  return fs.readdirSync(uploadsDir).some((name) => name !== MANIFEST_FILE && fs.statSync(path.join(uploadsDir, name)).isFile());
}
