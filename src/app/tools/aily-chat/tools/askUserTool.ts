/**
 * ask_user 工具 — 向用户提问并等待回答
 *
 * 参考 VS Code Copilot 的 vscode_askQuestions 工具设计：
 * - 统一使用 questions 数组，单问题即长度为 1 的数组
 * - 每个问题可有选项列表（含描述、推荐标记）
 * - 支持多选 / 自由输入
 *
 * 工具执行时会暂停 LLM 对话，等待用户在聊天界面中回答后再继续。
 */

import { ToolUseResult } from './tools';

// ============================
// 类型定义
// ============================

/** 单个选项（富信息） */
export interface AskUserOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

/** 问题定义 */
export interface AskUserQuestion {
  question: string;
  options?: AskUserOption[];
  allow_freeform?: boolean;
  multi_select?: boolean;
}

/** 工具入参 */
export interface AskUserArgs {
  questions: AskUserQuestion[];
}

/** 单个问题的回答 */
export interface AskUserAnswer {
  selected: string[];
  freeText: string | null;
  skipped: boolean;
}

/** 兼容旧回调的单问题应答 */
export interface AskUserResponse {
  answer: string;
  wasFreeform: boolean;
}

// ============================
// 全局回调注册
// ============================

type AskUserCallback = (question: string, choices?: string[], allowFreeform?: boolean) => Promise<AskUserResponse | undefined>;

let _registeredCallback: AskUserCallback | null = null;

/**
 * 注册用户交互回调。由 UI 层（aily-chat 组件或 ChatEngineService）初始化时调用。
 * 回调负责在聊天界面显示问题和选项，等待用户选择后返回结果。
 */
export function registerAskUserCallback(cb: AskUserCallback): void {
  _registeredCallback = cb;
}

/**
 * 取消注册回调（组件销毁时调用）
 */
export function unregisterAskUserCallback(): void {
  _registeredCallback = null;
}

// ============================
// 内部辅助：执行单个问题
// ============================

async function askSingleQuestion(
  question: string,
  choices?: string[],
  allowFreeform?: boolean,
): Promise<AskUserAnswer> {
  let response: AskUserResponse | undefined;

  if (_registeredCallback) {
    response = await _registeredCallback(question, choices, allowFreeform);
  } else {
    response = await fallbackPrompt(question, choices, allowFreeform);
  }

  if (!response || !response.answer) {
    return { selected: [], freeText: null, skipped: true };
  }

  if (response.wasFreeform) {
    return { selected: [], freeText: response.answer, skipped: false };
  }
  return { selected: [response.answer], freeText: null, skipped: false };
}

// ============================
// 工具执行函数
// ============================

export async function askUserTool(args: AskUserArgs): Promise<ToolUseResult> {
  try {
    const { questions } = args;
    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return {
        is_error: true,
        content: '参数错误：questions 数组不能为空',
      };
    }

    const answers: Record<string, AskUserAnswer> = {};
    let allSkipped = true;

    for (const q of questions) {
      if (!q.question || typeof q.question !== 'string' || q.question.trim().length === 0) {
        continue;
      }
      // 将 AskUserOption[] 转换为 string[] 供现有回调使用
      const choiceLabels = q.options?.map(o => {
        if (o.description) return `${o.label} — ${o.description}`;
        return o.label;
      });
      const allowFreeform = choiceLabels && choiceLabels.length > 0 ? (q.allow_freeform ?? false) : true;

      const answer = await askSingleQuestion(q.question.trim(), choiceLabels, allowFreeform);

      // 如果用户选择了带描述的选项，提取纯 label
      if (answer.selected.length > 0 && q.options) {
        answer.selected = answer.selected.map(sel => {
          const match = q.options!.find(o => `${o.label} — ${o.description}` === sel || o.label === sel);
          return match ? match.label : sel;
        });
      }

      answers[q.question.trim()] = answer;
      if (!answer.skipped) allSkipped = false;
    }

    if (allSkipped) {
      return {
        is_error: false,
        content: '用户未提供任何回答（全部跳过或取消）。',
        metadata: { skipped: true },
      };
    }

    // 单问题时简化输出格式
    if (questions.length === 1) {
      const key = Object.keys(answers)[0];
      const ans = answers[key];
      const answerText = ans.freeText || ans.selected.join(', ');
      return {
        is_error: false,
        content: answerText,
        metadata: { originalQuestion: key, wasFreeform: !!ans.freeText },
      };
    }

    return {
      is_error: false,
      content: JSON.stringify({ answers }, null, 2),
      metadata: { questionCount: questions.length },
    };
  } catch (error: any) {
    return {
      is_error: true,
      content: `向用户提问时出错: ${error.message || '未知错误'}`,
    };
  }
}

// ============================
// 降级实现
// ============================

async function fallbackPrompt(
  question: string,
  choices?: string[],
  allowFreeform?: boolean,
): Promise<AskUserResponse | undefined> {
  if (typeof window === 'undefined') {
    return undefined;
  }

  if (choices && choices.length > 0 && !allowFreeform) {
    const choiceText = choices.map((c, i) => `${i + 1}. ${c}`).join('\n');
    const promptText = `${question}\n\n${choiceText}\n\n请输入选项编号 (1-${choices.length}):`;
    const input = window.prompt(promptText);

    if (input === null) return undefined;

    const idx = parseInt(input.trim(), 10);
    if (idx >= 1 && idx <= choices.length) {
      return { answer: choices[idx - 1], wasFreeform: false };
    }
    return { answer: input.trim(), wasFreeform: true };
  }

  let promptText = question;
  if (choices && choices.length > 0) {
    const choiceText = choices.map((c, i) => `${i + 1}. ${c}`).join('\n');
    promptText = `${question}\n\n可选：\n${choiceText}\n\n也可以直接输入:`;
  }

  const input = window.prompt(promptText);
  if (input === null) return undefined;

  if (choices && choices.length > 0) {
    const idx = parseInt(input.trim(), 10);
    if (idx >= 1 && idx <= choices.length) {
      return { answer: choices[idx - 1], wasFreeform: false };
    }
    const exactMatch = choices.find(c => c.toLowerCase() === input.trim().toLowerCase());
    if (exactMatch) {
      return { answer: exactMatch, wasFreeform: false };
    }
  }

  return { answer: input.trim(), wasFreeform: true };
}
