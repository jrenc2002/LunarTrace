/**
 * 具体 PromptElementProvider 实现
 *
 * 每个 Provider 对应管线中的一个逻辑槽位：
 *   - ContextInjectionProvider    → 瞬态上下文（skills/memory/deferred tools）
 *   - ConversationHistoryProvider → 历史对话消息（从 TurnManager 构建）
 *   - ToolContinuationProvider    → 工具续写提示（P6）
 *
 * 参考 Copilot prompt-tsx 的 TSX 组件模式：
 *   <ContextInjection priority={750} />
 *   <ConversationHistory priority={700} flexGrow={1} />
 *   <ToolContinuation priority={690} />
 */

import {
  PromptElement,
  PromptElementProvider,
  PromptBuildContext,
  PromptPriority,
  ChatMessage,
} from './prompt-elements';
import { estimateTokenCount, estimateMessagesTokens } from '../services/context-budget.service';
import { SkillRegistry } from '../core/skill-registry';
import { getDeferredToolsListing } from '../tools/tools';
import { getMemoryPromptSnippet } from '../tools/memoryTool';
import { ASK_MODE_ROLE_TEXT } from '../services/stream-constants';

// ==================== 工具续写提示常量 ====================

const TOOL_CONTINUATION_PROMPT =
  'Above are the results of calling one or more tools. The user cannot see these results, so you should explain them clearly if needed. Continue your task based on these tool results.';

// ==================== ContextInjectionProvider ====================

/**
 * 瞬态上下文注入 — 对应 Copilot CustomInstructions 组件
 *
 * 将 skills / deferred tools listing / memory snippet 组装为
 * `<aily-context>` 消息，以 priority 750 注入。
 *
 * 注册顺序：第 1 个（消息数组开头，历史之前）
 */
export class ContextInjectionProvider implements PromptElementProvider {
  id = 'context-injection';

  /**
   * @param getAgentExcludedTools 获取被禁用工具名称集合的回调
   */
  constructor(
    private getAgentExcludedTools: (agentName: string) => Set<string>
  ) {}

  build(context: PromptBuildContext): PromptElement | null {
    const { mode, messageSource } = context;
    if (messageSource !== 'mainAgent') return null;

    const parts: string[] = [];

    if (mode === 'agent') {
      const skillsContent = SkillRegistry.getActiveSkillsContent(messageSource);
      if (skillsContent) parts.push(skillsContent);
    } else {
      parts.push(`<rules>${ASK_MODE_ROLE_TEXT}</rules>`);
    }

    const deferredListing = getDeferredToolsListing(
      messageSource,
      this.getAgentExcludedTools(messageSource)
    );
    if (deferredListing) parts.push(deferredListing);

    const skillsListing = SkillRegistry.getSkillsListing(messageSource);
    if (skillsListing) parts.push(skillsListing);

    const memorySnippet = getMemoryPromptSnippet();
    if (memorySnippet) parts.push(memorySnippet);

    if (parts.length === 0) return null;

    const content = `<aily-context>\n${parts.join('\n')}\n</aily-context>`;
    const message: ChatMessage = { role: 'user', content };
    const tokens = estimateTokenCount(content);

    return {
      id: this.id,
      priority: PromptPriority.CONTEXT_INJECTION,
      messages: [message],
      tokens,
      evictable: false, // 上下文指令永远保留
    };
  }
}

// ==================== ConversationHistoryProvider ====================

/**
 * 历史对话 — 对应 Copilot HistoryMessages 组件
 *
 * 从 TurnManager.buildMessages() 获取所有历史消息，
 * 按 TurnSpan 生成子 Element：
 *   - 当前 Turn → priority 899，不可淘汰
 *   - 含信息类工具的 Turn → priority 750，flexGrow=1
 *   - 普通历史 Turn → priority 700
 *   - 最旧历史 → priority 100
 *
 * 注册顺序：第 2 个（context 之后）
 */
export class ConversationHistoryProvider implements PromptElementProvider {
  id = 'conversation-history';

  build(context: PromptBuildContext): PromptElement | null {
    const { engine } = context;
    const { turnManager, turnLoop } = engine;

    // 优先使用预裁剪过的消息，否则从 Turn 构建
    const messages: any[] = turnLoop._preparedMessages
      ?? turnManager.buildMessages();
    turnLoop._preparedMessages = null;

    if (!messages || messages.length === 0) return null;

    // 获取 TurnSpan 元数据
    const turnSpans: any[] = turnManager.turnSpans ? [...turnManager.turnSpans] : [];
    const totalTurns = turnSpans.length;

    if (turnSpans.length === 0) {
      // 没有 TurnSpan 信息：整体作为一个 Element
      const tokens = estimateMessagesTokens(messages);
      return {
        id: this.id,
        priority: PromptPriority.HISTORY_BASE,
        flexGrow: 1,
        messages,
        tokens,
      };
    }

    // 有 TurnSpan：按 Turn 生成子 Element，每个 Turn 独立参与淘汰
    const children: PromptElement[] = [];

    for (let i = 0; i < turnSpans.length; i++) {
      const span = turnSpans[i];
      const isCurrentTurn = (i === totalTurns - 1);
      const isOldest = (i === 0 && totalTurns > 3);
      const turnMessages = messages.slice(span.startIdx, span.endIdx);
      const tokens = estimateMessagesTokens(turnMessages);

      let priority: number;
      let evictable = true;
      let flexGrow: number | undefined;

      if (isCurrentTurn) {
        priority = PromptPriority.CURRENT_TURN;
        evictable = false;
      } else if (span.hasInfoTools) {
        priority = PromptPriority.HISTORY_INFO;
        flexGrow = 1;
      } else if (isOldest) {
        priority = PromptPriority.HISTORY_OLDEST;
      } else {
        priority = PromptPriority.HISTORY_BASE;
      }

      children.push({
        id: `turn-${span.turnId ?? i}`,
        priority,
        messages: turnMessages,
        tokens,
        evictable,
        flexGrow,
      });
    }

    // 父 Element：空消息容器，子 Element 承载实际内容
    const totalTokens = children.reduce((sum, c) => sum + c.tokens, 0);
    return {
      id: this.id,
      priority: PromptPriority.HISTORY_BASE,
      messages: [],
      tokens: totalTokens,
      children,
    };
  }
}

// ==================== ToolContinuationProvider ====================

/**
 * 工具续写提示 — P6 特性
 *
 * 当 toolCallingIteration > 0 时（本轮有工具结果），
 * 在消息末尾追加续写提示。
 *
 * 参考 Copilot toolCallingLoop 的 "Please continue" 注入。
 *
 * 注册顺序：最后一个（消息数组末尾）
 */
export class ToolContinuationProvider implements PromptElementProvider {
  id = 'tool-continuation';

  build(context: PromptBuildContext): PromptElement | null {
    if (context.toolCallingIteration <= 0) return null;

    const message: ChatMessage = {
      role: 'user',
      content: TOOL_CONTINUATION_PROMPT,
    };
    const tokens = estimateTokenCount(TOOL_CONTINUATION_PROMPT);

    return {
      id: this.id,
      priority: PromptPriority.TOOL_CONTINUATION,
      messages: [message],
      tokens,
      evictable: true,
    };
  }
}
