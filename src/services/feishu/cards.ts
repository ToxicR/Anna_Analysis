import type { FeishuAvailableProject } from "../../types.js";

export const FEISHU_CARD_ACTION_PICK_PROJECT = "pick_project";
export const FEISHU_CARD_ACTION_RUN_COMMAND = "run_command";

export interface FeishuProjectPickAction {
  action: typeof FEISHU_CARD_ACTION_PICK_PROJECT;
  project_id: number;
  question: string;
  chat_type: string;
}

export type FeishuRunCommandName = "shared" | "personal" | "new_session" | "select_project";

export interface FeishuRunCommandAction {
  action: typeof FEISHU_CARD_ACTION_RUN_COMMAND;
  command: FeishuRunCommandName;
  project_id?: number;
  chat_type: string;
}

export type FeishuCardAction = FeishuProjectPickAction | FeishuRunCommandAction;

export interface FeishuHelpCardState {
  card_instance?: string;
  mode?: "shared" | "personal";
  session_reset?: boolean;
  selected_project_id?: number;
}

export interface FeishuInteractiveCard {
  config: { wide_screen_mode: boolean; update_multi?: boolean };
  header: {
    template: string;
    title: { tag: "plain_text"; content: string };
  };
  elements: Array<Record<string, unknown>>;
}

const BUTTONS_PER_ROW = 2;
const MAX_BUTTON_LABEL = 40;
const MAX_QUESTION_PREVIEW = 200;

function truncateText(text: string, maxLen: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen - 1)}…`;
}

function normalizeHelpCardState(state?: FeishuHelpCardState): FeishuHelpCardState {
  if (!state) return {};
  const normalized: FeishuHelpCardState = {};
  if (typeof state.card_instance === "string" && state.card_instance.trim()) {
    normalized.card_instance = state.card_instance.trim();
  }
  if (state.mode === "shared" || state.mode === "personal") normalized.mode = state.mode;
  if (state.session_reset) normalized.session_reset = true;
  if (Number.isInteger(state.selected_project_id) && state.selected_project_id! > 0) {
    normalized.selected_project_id = state.selected_project_id;
  }
  return normalized;
}

function createHelpCardInstanceId(): string {
  return `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function buildPickProjectValue(input: {
  projectId: number;
  question: string;
  chatType: string;
  cardState?: FeishuHelpCardState;
}): FeishuProjectPickAction & { card_state?: FeishuHelpCardState } {
  const value: FeishuProjectPickAction & { card_state?: FeishuHelpCardState } = {
    action: FEISHU_CARD_ACTION_PICK_PROJECT,
    project_id: input.projectId,
    question: input.question,
    chat_type: input.chatType,
  };
  const cardState = normalizeHelpCardState(input.cardState);
  if (Object.keys(cardState).length) value.card_state = cardState;
  return value;
}

function buildProjectButton(project: FeishuAvailableProject, input: {
  question: string;
  chatType: string;
  selectedProjectId?: number;
}): Record<string, unknown> {
  const selected = input.selectedProjectId === project.id;
  const label = selected ? `✓ ${truncateText(project.name, MAX_BUTTON_LABEL - 2)}` : truncateText(project.name, MAX_BUTTON_LABEL);
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type: selected ? "primary" : "default",
    disabled: Boolean(input.selectedProjectId),
    value: buildPickProjectValue({
      projectId: project.id,
      question: input.question,
      chatType: input.chatType,
    }),
  };
}

export function buildProjectPickerCard(input: {
  projects: FeishuAvailableProject[];
  question: string;
  chatType: string;
  selectedProjectId?: number;
}): FeishuInteractiveCard {
  const questionPreview = truncateText(input.question, MAX_QUESTION_PREVIEW);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "div",
      text: {
        tag: "plain_text",
        content: questionPreview
          ? `你的问题：${questionPreview}\n\n请点击下方按钮选择要分析的项目：`
          : "请点击下方按钮选择要分析的项目：",
      },
    },
  ];

  for (let index = 0; index < input.projects.length; index += BUTTONS_PER_ROW) {
    const row = input.projects.slice(index, index + BUTTONS_PER_ROW);
    elements.push({
      tag: "action",
      actions: row.map((project) => buildProjectButton(project, {
        question: input.question,
        chatType: input.chatType,
        selectedProjectId: input.selectedProjectId,
      })),
    });
  }

  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: input.selectedProjectId
          ? "项目已选定，请继续发送问题"
          : "也可手动输入：/项目3 你的问题",
      },
    ],
  });

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "请选择项目" },
    },
    elements,
  };
}

function buildRunCommandValue(input: {
  command: FeishuRunCommandName;
  chatType: string;
  projectId?: number;
  cardState?: FeishuHelpCardState;
}): FeishuRunCommandAction & { card_state?: FeishuHelpCardState } {
  const value: FeishuRunCommandAction & { card_state?: FeishuHelpCardState } = {
    action: FEISHU_CARD_ACTION_RUN_COMMAND,
    command: input.command,
    project_id: input.projectId,
    chat_type: input.chatType,
  };
  const cardState = normalizeHelpCardState(input.cardState);
  if (Object.keys(cardState).length) value.card_state = cardState;
  return value;
}

function buildCommandButton(input: {
  label: string;
  command: FeishuRunCommandName;
  chatType: string;
  cardState: FeishuHelpCardState;
  disabled?: boolean;
  selected?: boolean;
}): Record<string, unknown> {
  const label = input.selected ? `✓ ${input.label}` : input.label;
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type: input.selected ? "primary" : "default",
    disabled: input.disabled,
    value: buildRunCommandValue({
      command: input.command,
      chatType: input.chatType,
      cardState: input.cardState,
    }),
  };
}

function buildSelectProjectButton(project: FeishuAvailableProject, input: {
  chatType: string;
  cardState: FeishuHelpCardState;
  disabled?: boolean;
  selected?: boolean;
}): Record<string, unknown> {
  const label = input.selected ? `✓ ${truncateText(project.name, MAX_BUTTON_LABEL - 2)}` : truncateText(project.name, MAX_BUTTON_LABEL);
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type: input.selected ? "primary" : "default",
    disabled: input.disabled,
    value: buildRunCommandValue({
      command: "select_project",
      chatType: input.chatType,
      projectId: project.id,
      cardState: input.cardState,
    }),
  };
}

function buildLockedCategoryNote(content: string): Record<string, unknown> {
  return {
    tag: "div",
    text: { tag: "plain_text", content },
  };
}

export function parseFeishuHelpCardState(value: unknown): FeishuHelpCardState {
  const record = parseCardActionRecord(value);
  if (!record?.card_state || typeof record.card_state !== "object") return {};
  const state = record.card_state as Record<string, unknown>;
  const parsed: FeishuHelpCardState = {};
  if (typeof state.card_instance === "string" && state.card_instance.trim()) {
    parsed.card_instance = state.card_instance.trim();
  }
  if (state.mode === "shared" || state.mode === "personal") parsed.mode = state.mode;
  if (state.session_reset === true) parsed.session_reset = true;
  const projectId = Number(state.selected_project_id);
  if (Number.isInteger(projectId) && projectId > 0) parsed.selected_project_id = projectId;
  return parsed;
}

export function applyHelpCardSelection(
  state: FeishuHelpCardState,
  command: FeishuRunCommandName,
  projectId?: number,
): FeishuHelpCardState {
  const next = { ...normalizeHelpCardState(state) };
  if (command === "shared" || command === "personal") next.mode = command;
  if (command === "new_session") next.session_reset = true;
  if (command === "select_project" && projectId) next.selected_project_id = projectId;
  return next;
}

/** 每次 /帮助、空消息等触发时调用，生成全新可操作的帮助卡片。 */
export function buildFreshHelpCard(input: {
  chatType: string;
  projects?: FeishuAvailableProject[];
}): FeishuInteractiveCard {
  return buildHelpCard({
    chatType: input.chatType,
    projects: input.projects,
    state: { card_instance: createHelpCardInstanceId() },
  });
}

export function buildHelpCard(input: {
  chatType: string;
  projects?: FeishuAvailableProject[];
  state?: FeishuHelpCardState;
}): FeishuInteractiveCard {
  const isGroup = input.chatType !== "p2p";
  const intro = [
    "直接发送问题即可分析（默认个人会话，上下文按人隔离）。",
    isGroup
      ? "群聊：可用项目 = 本群绑定项目 ∩ 你账号已分配项目。"
      : "私聊：可用项目 = 你账号已分配的项目。",
    "",
    "点击下方按钮执行常用操作：",
  ].join("\n");

  const elements: Array<Record<string, unknown>> = [
    {
      tag: "div",
      text: { tag: "plain_text", content: intro },
    },
  ];

  const state = normalizeHelpCardState(input.state);
  const cardStateForButtons = state;

  if (isGroup) {
    if (state.mode) {
      elements.push(buildLockedCategoryNote(
        `会话模式：${state.mode === "shared" ? "群协作" : "个人模式"}（已设定，不可更改）`,
      ));
    } else {
      const modeButtons = [
        buildCommandButton({ label: "群协作", command: "shared", chatType: input.chatType, cardState: cardStateForButtons }),
        buildCommandButton({ label: "个人模式", command: "personal", chatType: input.chatType, cardState: cardStateForButtons }),
      ];
      elements.push({ tag: "action", actions: modeButtons });
    }
  }

  if (state.session_reset) {
    elements.push(buildLockedCategoryNote("新建会话：已执行（不可重复点击）"));
  } else {
    elements.push({
      tag: "action",
      actions: [
        buildCommandButton({
          label: "新建会话",
          command: "new_session",
          chatType: input.chatType,
          cardState: cardStateForButtons,
        }),
      ],
    });
  }

  const projects = input.projects ?? [];
  if (projects.length > 1) {
    if (state.selected_project_id) {
      const selected = projects.find((project) => project.id === state.selected_project_id);
      elements.push(buildLockedCategoryNote(
        `默认项目：${selected?.name ?? state.selected_project_id}（已选定，不可更改）`,
      ));
    } else {
      elements.push({
        tag: "div",
        text: { tag: "plain_text", content: "切换默认项目：" },
      });
      for (let index = 0; index < projects.length; index += BUTTONS_PER_ROW) {
        elements.push({
          tag: "action",
          actions: projects.slice(index, index + BUTTONS_PER_ROW).map((project) => buildSelectProjectButton(project, {
            chatType: input.chatType,
            cardState: cardStateForButtons,
          })),
        });
      }
    }
  }

  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: "多个项目提问时会弹出项目选择卡片；也可手动输入 /项目3 你的问题。发送 /帮助 可获取全新卡片。",
      },
    ],
  });

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "Anna Analysis 飞书助手" },
    },
    elements,
  };
}

function parseCardActionRecord(value: unknown): Record<string, unknown> | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  return parsed as Record<string, unknown>;
}

export function parseFeishuCardAction(value: unknown): FeishuCardAction | null {
  const record = parseCardActionRecord(value);
  if (!record) return null;
  const chatType = typeof record.chat_type === "string" ? record.chat_type : "group";

  if (record.action === FEISHU_CARD_ACTION_PICK_PROJECT) {
    const projectId = Number(record.project_id);
    if (!Number.isInteger(projectId) || projectId <= 0) return null;
    return {
      action: FEISHU_CARD_ACTION_PICK_PROJECT,
      project_id: projectId,
      question: typeof record.question === "string" ? record.question : "",
      chat_type: chatType,
    };
  }

  if (record.action === FEISHU_CARD_ACTION_RUN_COMMAND) {
    const command = record.command;
    if (command !== "shared" && command !== "personal" && command !== "new_session" && command !== "select_project") {
      return null;
    }
    const projectId = command === "select_project" ? Number(record.project_id) : undefined;
    if (command === "select_project" && (!Number.isInteger(projectId) || projectId! <= 0)) {
      return null;
    }
    return {
      action: FEISHU_CARD_ACTION_RUN_COMMAND,
      command,
      project_id: projectId,
      chat_type: chatType,
    };
  }

  return null;
}

export function parseFeishuCardActionValue(value: unknown): FeishuProjectPickAction | null {
  const action = parseFeishuCardAction(value);
  if (!action || action.action !== FEISHU_CARD_ACTION_PICK_PROJECT) return null;
  return action;
}
