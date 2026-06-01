import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { UPLOAD_DIR } from "../../paths.js";
import { copyAttachmentsToWorkspace } from "../code.js";
import { getFeishuTenantAccessToken } from "./api.js";

const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";
const MAX_LOG_TEXT = 100_000;

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
}

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

function formatAttachmentForPrompt(file: PreparedFeishuFile): string {
  const header = [
    `附件：${file.file_name}`,
    `类型：${file.mime_type || "unknown"}`,
    `大小：${file.size} bytes`,
    `工作区相对路径：${file.relative_path}`,
    `读取方式：请使用 read_file 打开 ${file.relative_path}`,
  ].join("\n");

  if (file.text) {
    return `${header}\n内容预览：\n${file.text}`;
  }

  if (file.mime_type.startsWith("image/")) {
    return `${header}\n这是图片附件，已作为图片输入发送给 Agent。请结合图片中的界面、报错、图表或截图内容进行分析。`;
  }

  return `${header}\n这是非文本附件，请根据路径读取。`;
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
}): Promise<{ log_text: string; attachment_images: { url: string }[] }> {
  if (!input.attachments.length) {
    return { log_text: "", attachment_images: [] };
  }

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const workspaceSessionId = `feishu:${input.sessionId}`;
  const preparedFiles: PreparedFeishuFile[] = [];

  for (const attachment of input.attachments) {
    const downloaded = await downloadFeishuMessageResource(
      input.messageId,
      attachment.resource_key,
      attachment.resource_type,
      attachment.file_name,
    );
    const safeName = path.basename(downloaded.fileName || attachment.file_name || "attachment.bin");
    const storedName = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}-${safeName}`;
    const tempPath = path.join(UPLOAD_DIR, storedName);
    fs.writeFileSync(tempPath, downloaded.buffer);

    const copied = copyAttachmentsToWorkspace(input.projectId, workspaceSessionId, [{
      stored_name: storedName,
      source_path: tempPath,
    }]);
    const workspace = copied[0];
    const text = isTextAttachment(safeName, downloaded.mimeType)
      ? downloaded.buffer.toString("utf8").slice(0, MAX_LOG_TEXT)
      : "";
    const workspacePath = workspace?.workspace_path || tempPath;
    const relativePath = workspace?.relative_path || storedName;
    const imageUrl = downloaded.mimeType.startsWith("image/")
      ? pathToFileURL(workspacePath).href
      : undefined;

    preparedFiles.push({
      file_name: safeName,
      mime_type: downloaded.mimeType,
      size: downloaded.buffer.length,
      text,
      relative_path: relativePath,
      workspace_path: workspacePath,
      image_url: imageUrl,
    });
  }

  const logText = preparedFiles.map((file) => formatAttachmentForPrompt(file)).join("\n\n");
  const attachmentImages = preparedFiles
    .filter((file) => file.image_url)
    .map((file) => ({ url: file.image_url! }));

  return { log_text: logText, attachment_images: attachmentImages };
}
