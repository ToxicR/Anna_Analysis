export type FeishuCommandName = "shared" | "personal" | "new_session" | "select_project" | "help" | "message";

export interface ParsedFeishuCommand {
  name: FeishuCommandName;
  projectId?: number;
  projectQuery?: string;
  question: string;
}

const COMMAND_ALIASES: Record<Exclude<FeishuCommandName, "message" | "select_project">, string[]> = {
  shared: ["/共享", "/shared", "/协作"],
  personal: ["/私有", "/personal", "/结束共享"],
  new_session: ["/新建会话", "/new", "/重置"],
  help: ["/帮助", "/help"],
};

const PROJECT_COMMAND_PREFIX = "/项目";

function parseProjectCommand(trimmed: string): ParsedFeishuCommand | null {
  if (!trimmed.startsWith(PROJECT_COMMAND_PREFIX)) return null;
  const rest = trimmed.slice(PROJECT_COMMAND_PREFIX.length);
  const match = rest.match(/^(\d+)(?:\s+(.*))?$/);
  if (match) {
    return {
      name: "select_project",
      projectId: Number(match[1]),
      question: match[2]?.trim() ?? "",
    };
  }
  const query = rest.trim();
  if (!query) return { name: "select_project", question: "" };
  return { name: "select_project", projectQuery: query, question: "" };
}

export function parseFeishuMessage(text: string): ParsedFeishuCommand {
  const trimmed = text.trim();
  if (!trimmed) return { name: "help", question: "" };

  const projectCommand = parseProjectCommand(trimmed);
  if (projectCommand) return projectCommand;

  for (const [name, aliases] of Object.entries(COMMAND_ALIASES) as Array<[Exclude<FeishuCommandName, "message" | "select_project">, string[]]>) {
    for (const alias of aliases) {
      if (trimmed === alias || trimmed.startsWith(`${alias} `)) {
        const rest = trimmed.slice(alias.length).trim();
        return { name, question: rest };
      }
    }
  }

  return { name: "message", question: trimmed };
}

export function stripBotMention(text: string): string {
  return text
    .replace(/@_user_\d+/g, "")
    .replace(/@[^\s]+/g, "")
    .replace(/^\s+/, "")
    .trim();
}

export function feishuHelpText(): string {
  return [
    "Anna Analysis 飞书助手",
    "",
    "直接发送问题即可分析（默认个人会话，上下文按人隔离）。",
    "私聊：可用项目 = 你账号已分配的项目。",
    "群聊：可用项目 = 本群绑定项目 ∩ 你账号已分配项目。",
    "",
    "命令：",
    "/共享 — 进入群协作会话（本群共用上下文）",
    "/私有 — 回到个人会话",
    "/新建会话 — 清空当前模式下的上下文",
    "/项目3 你的问题 — 指定项目后提问（/项目 与编号之间可不加空格）",
    "多个项目时会弹出可点击的项目按钮",
    "/帮助 — 显示本说明",
  ].join("\n");
}
