import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { db } from "../../db.js";
import { UPLOAD_DIR } from "../../paths.js";
import { copyAttachmentsToWorkspace, projectWorkspaceRoot, sessionUploadsDir } from "../workspace.js";
import { getFeishuTenantAccessToken } from "./api.js";
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
  image_url?: string;
  uploaded_by: string;
  uploaded_at: string;
  is_current_turn: boolean;
  content_note?: string;
}

interface UploadManifestEntry {
  stored_name: string;
  display_name: string;
  relative_path: string;
  sha256: string;
  uploaded_by: string;
  message_id: string;
  uploaded_at: string;
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

  try {
    const parsed = JSON.parse(content) as {
      file_key?: string;
      file_name?: string;
      image_key?: string;
      content?: PostContentNode[][];
    };

    if (messageType === "file" && parsed.file_key) {
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
  } catch {
    return [];
  }

  return dedupeAttachments(bucket);
}

export function extractLogFilenameHint(text: string): string | null {
  const normalized = text.trim();
  if (!normalized) return null;
  const bracketMatch = normalized.match(/\[文件\]\s*([^\s\]]+\.log)\b/i);
  if (bracketMatch?.[1]) return bracketMatch[1];
  const quotedMatch = normalized.match(/[「"']([^「"']+\.log)[」"']/i);
  if (quotedMatch?.[1]) return quotedMatch[1];
  const plainMatch = normalized.match(/\b([\w.-]+\.log)\b/i);
  return plainMatch?.[1] ?? null;
}

function formatAttachmentForPrompt(file: PreparedFeishuFile, mode: FeishuSessionMode): string {
  const scopeLabel = file.is_current_turn ? "本轮新增" : "历史累积";
  const modeHint = mode === "shared"
    ? "（群协作：附件来自本群各成员，可综合阅读）"
    : "（个人会话：仅你本人上传的附件）";
  const header = [
    `【${scopeLabel}附件${modeHint}】`,
    `文件名：${file.file_name}`,
    `上传者：${file.uploaded_by}`,
    `上传时间：${file.uploaded_at}`,
    `类型：${file.mime_type || "unknown"}`,
    `大小：${file.size} bytes`,
    `工作区相对路径：${file.relative_path}`,
    file.content_note ? `说明：${file.content_note}` : "",
  ].filter(Boolean).join("\n");

  const previewLimit = file.is_current_turn ? MAX_PREVIEW_CURRENT : MAX_PREVIEW_HISTORY;
  if (file.text) {
    return `${header}\n内容预览（前 ${previewLimit} 字符）：\n${file.text.slice(0, previewLimit)}`;
  }

  if (file.mime_type.startsWith("image/")) {
    return file.is_current_turn
      ? `${header}\n（图片已随本轮消息注入 Agent）`
      : `${header}\n（历史图片，请用 read_file 读取路径）`;
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

function ingestDownloadedAttachment(input: {
  projectId: number;
  sessionId: string;
  messageId: string;
  openId: string;
  buffer: Buffer;
  displayName: string;
  manifest: UploadManifestEntry[];
}, currentTurnNotes: Map<string, string>): { manifest: UploadManifestEntry[]; currentTurnKeys: Set<string> } {
  const uploadsDir = sessionUploadsDir(input.projectId, feishuWorkspaceSessionId(input.sessionId));
  const hash = sha256Buffer(input.buffer);
  const existing = input.manifest.find((entry) => entry.sha256 === hash && fs.existsSync(
    path.join(projectWorkspaceRoot(input.projectId), entry.relative_path),
  ));

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
}): { log_text: string; attachment_images: { url: string }[] } {
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
  const sortByHint = (files: PreparedFeishuFile[]) => {
    if (!hintLower) return files;
    return [...files].sort((a, b) => {
      const aMatch = a.file_name.toLowerCase().includes(hintLower) ? 1 : 0;
      const bMatch = b.file_name.toLowerCase().includes(hintLower) ? 1 : 0;
      return bMatch - aMatch;
    });
  };

  const ordered = [
    ...sortByHint(currentTurn),
    ...sortByHint(history),
  ].slice(0, MAX_FILES_IN_PROMPT);

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
      };
    }
    return { log_text: "", attachment_images: [] };
  }

  const intro = input.mode === "shared"
    ? "【飞书群协作 · 会话附件库】以下包含本轮新增与历史累积附件（多用户上传会合并在此目录），请综合阅读；若用户指定某一日志，优先分析匹配文件，必要时可对照其他附件。"
    : "【飞书个人会话 · 附件库】以下包含本轮新增与历史累积附件，请综合阅读。";

  const hintLine = input.logHint
    ? `\n用户本轮指定优先关注：${input.logHint}`
    : "";

  const logText = [
    intro + hintLine,
    ...ordered.map((file) => formatAttachmentForPrompt(file, input.mode)),
  ].join("\n\n").slice(0, MAX_LOG_TEXT);

  const attachmentImages = ordered
    .filter((file) => file.is_current_turn && file.image_url)
    .map((file) => ({ url: file.image_url! }));

  return { log_text: logText, attachment_images: attachmentImages };
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
}): Promise<{ log_text: string; attachment_images: { url: string }[] }> {
  const sessionMode = input.mode ?? "personal";
  const logHint = extractLogFilenameHint(input.question ?? "");
  const uploadsDir = sessionUploadsDir(input.projectId, feishuWorkspaceSessionId(input.sessionId));
  let manifest = readUploadManifest(uploadsDir);
  const currentTurnKeys = new Set<string>();
  const currentTurnNotes = new Map<string, string>();

  if (input.attachments.length) {
    if (!input.messageId) {
      throw new Error("无法下载附件：缺少 message_id。");
    }

    for (const attachment of input.attachments) {
      const downloaded = await downloadFeishuMessageResource(
        input.messageId,
        attachment.resource_key,
        attachment.resource_type,
        attachment.file_name,
      );
      const displayName = path.basename(downloaded.fileName || attachment.file_name || "attachment.bin");
      const result = ingestDownloadedAttachment({
        projectId: input.projectId,
        sessionId: input.sessionId,
        messageId: input.messageId,
        openId: input.openId ?? "",
        buffer: downloaded.buffer,
        displayName,
        manifest,
      }, currentTurnNotes);
      manifest = result.manifest;
      for (const key of result.currentTurnKeys) currentTurnKeys.add(key);
    }
  } else if (logHint) {
    const hintLower = logHint.toLowerCase();
    const matched = manifest.filter((entry) =>
      entry.display_name.toLowerCase().includes(hintLower)
      || entry.stored_name.toLowerCase().includes(hintLower));
    for (const entry of matched) currentTurnKeys.add(entry.stored_name);
  }

  if (!input.attachments.length && !logHint && !feishuSessionHasUploads(input.projectId, input.sessionId)) {
    return { log_text: "", attachment_images: [] };
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
