/**
 * TurnManager — Turn 结构化存储管理器（Primary Source of Truth）
 *
 * 参考 Copilot 的 ConversationHistory：
 * - Turn[] 作为 source of truth，engine.conversationMessages 是只读 getter
 * - 每次 API 调用前通过 buildMessages() 从 Turn[] 重建消息数组
 * - 上下文注入（skills/tools listing/memory）在 API 调用时瞬态插入，不存储
 * - Turn[] 不可变：压缩结果通过瞬态 _compressedMessages 传递，不回写 Turn[]
 * - 回滚/截断使用 Turn-native 操作（removeFromTurn / truncateToTurn）
 * - 工具结果去重在 buildMessages() 中执行，不修改原始 Turn 数据
 */

import type {
  Turn,
  TurnRequest,
  TurnResponse,
  ToolCallRound,
  ToolCallEntry,
  ToolCallResult,
  TurnSpan,
  SerializedTurns,
} from '../core/turn-types';
import {
  sanitizeToolContent,
  truncateToolResult,
  sanitizeAssistantContent,
} from '../services/content-sanitizer.service';

export class TurnManager {
  /** 不可变 Turn 列表（source of truth） */
  private _turns: Turn[] = [];

  /** 缓存的消息数组（buildMessages() 的输出） */
  private _cachedMessages: any[] | null = null;
  /** 缓存的 Turn 边界跨度（与 _cachedMessages 同步更新） */
  private _cachedTurnSpans: TurnSpan[] = [];
  /** 缓存失效标记 */
  private _dirty = true;

  /**
   * 信息类工具名称集合（与 ContextBudgetService.INFO_TOOLS 保持同步）
   * 用于标记 TurnSpan.hasInfoTools，帮助 prioritizedTrim 做 Turn 级价值评估
   */
  private static readonly INFO_TOOLS = new Set([
    'read_file', 'fetch', 'web_search', 'grep', 'grep_tool', 'glob_tool',
    'get_directory_tree', 'list_directory', 'search_boards_libraries',
    'get_workspace_overview_tool',
  ]);



  // ==================== 读取 ====================

  /** 获取所有 Turn（只读视图） */
  get turns(): readonly Turn[] {
    return this._turns;
  }

  get length(): number {
    return this._turns.length;
  }

  /** 获取最后一个 Turn */
  get lastTurn(): Turn | undefined {
    return this._turns[this._turns.length - 1];
  }

  /**
   * 获取 Turn 边界跨度（与 buildMessages() 的输出对应）
   *
   * 供 ContextBudgetService.prioritizedTrim() 使用，
   * 保证裁剪以 Turn 为最小单元，不拆散 tool_call ↔ tool_result 配对。
   */
  get turnSpans(): readonly TurnSpan[] {
    // 确保 messages 已构建（spans 随 buildMessages 一起生成）
    this.buildMessages();
    return this._cachedTurnSpans;
  }

  /** 获取最后一个 Turn 的 ID（用于 checkpoint 关联） */
  get currentTurnId(): string | undefined {
    return this._turns[this._turns.length - 1]?.id;
  }

  // ==================== Turn 生命周期 ====================

  /**
   * 开启新 Turn（用户发送消息时调用）
   * @returns 新 Turn 的 id
   */
  startTurn(userContent: string): string {
    const id = this.generateTurnId();
    const turn: Turn = {
      id,
      request: {
        content: userContent,
        timestamp: Date.now(),
      },
    };
    this._turns.push(turn);
    this.invalidateCache();
    return id;
  }

  /**
   * 记录当前 Turn 中一轮 LLM 响应和工具调用
   *
   * 每次 SSE 流完成（含 tool_calls）后调用，
   * 将 assistant 文本 + tool_calls 收集为一个 ToolCallRound。
   *
   * @param assistantContent 本轮 LLM 输出的文本
   * @param toolCalls 本轮 LLM 请求的工具调用列表
   */
  addToolCallRound(assistantContent: string, toolCalls: ToolCallEntry[]): void {
    const turn = this.lastTurn;
    if (!turn) return;

    if (!turn.response) {
      turn.response = { content: '', toolCallRounds: [] };
    }

    const round: ToolCallRound = {
      assistantContent: assistantContent || '',
      toolCalls,
      results: {},
    };
    turn.response.toolCallRounds.push(round);
    this.invalidateCache();
  }

  /**
   * 记录工具执行结果
   *
   * 在工具执行完成时调用，将结果关联到对应的 ToolCallRound。
   */
  addToolResult(toolCallId: string, result: ToolCallResult): void {
    const turn = this.lastTurn;
    if (!turn?.response) return;

    // 找到包含该 toolCallId 的 round
    for (let i = turn.response.toolCallRounds.length - 1; i >= 0; i--) {
      const round = turn.response.toolCallRounds[i];
      if (round.toolCalls.some(tc => tc.id === toolCallId)) {
        round.results[toolCallId] = result;
        this.invalidateCache();
        return;
      }
    }

    // 兜底：放入最后一个 round
    const lastRound = turn.response.toolCallRounds[turn.response.toolCallRounds.length - 1];
    if (lastRound) {
      lastRound.results[toolCallId] = result;
      this.invalidateCache();
    }
  }

  /**
   * 完成当前 Turn 的最终 assistant 响应（无工具调用的最终文本）
   *
   * 在 finalizeStatelessTurn() 中调用（SSE 流完成且无 pending tool results）。
   */
  finalizeTurn(assistantContent: string): void {
    const turn = this.lastTurn;
    if (!turn) return;

    if (!turn.response) {
      turn.response = { content: assistantContent, toolCallRounds: [] };
    } else {
      turn.response.content = assistantContent;
    }
    this.invalidateCache();
  }

  // ==================== 消息构建（Copilot 风格：每次 fresh render） ====================

  /**
   * 从 Turn[] 构建 LLM 消息数组
   *
   * 参考 Copilot 的 PromptRenderer — 每次调用都重新构建，
   * 不依赖上次的结果。上下文注入（skills/tools/memory）由调用方在
   * 返回数组上追加。
   *
   * @returns 标准 LLM messages 数组 [{ role, content, tool_calls?, tool_call_id?, name? }]
   */
  buildMessages(): any[] {
    if (!this._dirty && this._cachedMessages) {
      return this._cachedMessages;
    }

    const messages: any[] = [];
    const turnSpans: TurnSpan[] = [];

    for (let turnIdx = 0; turnIdx < this._turns.length; turnIdx++) {
      const turn = this._turns[turnIdx];
      const spanStart = messages.length;
      let hasInfoTools = false;

      // 如果 turn 已被摘要化，使用摘要替代原始内容
      if (turn.metadata?.compressed && turn.metadata?.summary) {
        messages.push({
          role: 'user',
          content: `[历史摘要] ${turn.metadata.summary}`,
        });
        turnSpans.push({
          turnId: turn.id,
          turnIndex: turnIdx,
          startIdx: spanStart,
          endIdx: messages.length,
          hasInfoTools: false,
        });
        continue;
      }

      // User message
      messages.push({
        role: 'user',
        content: turn.request.content,
      });

      if (!turn.response) {
        turnSpans.push({
          turnId: turn.id,
          turnIndex: turnIdx,
          startIdx: spanStart,
          endIdx: messages.length,
          hasInfoTools: false,
        });
        continue;
      }

      const rounds = turn.response.toolCallRounds;

      if (rounds.length === 0) {
        // 无工具调用的简单响应
        if (turn.response.content) {
          messages.push({
            role: 'assistant',
            content: sanitizeAssistantContent(turn.response.content),
          });
        }
        turnSpans.push({
          turnId: turn.id,
          turnIndex: turnIdx,
          startIdx: spanStart,
          endIdx: messages.length,
          hasInfoTools: false,
        });
        continue;
      }

      // 有工具调用：按 round 展开（Copilot 风格：保留所有 rounds 完整内容）
      // 清理 <think>/aily-state 等非推理内容，但不折叠或丢弃 rounds
      // token 裁剪由 prioritizedTrim()（Turn 级）和 compressToolResults()（内容级）负责
      for (const round of rounds) {
        // 清理中间轮内容：移除 <think>、aily-state 等 UI 标记，保留有意义的输出文本
        const content = sanitizeAssistantContent(round.assistantContent || '');

        const assistantMsg: any = {
          role: 'assistant',
          content,
        };

        // 工具调用格式
        if (round.toolCalls.length > 0) {
          assistantMsg.tool_calls = round.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }

        messages.push(assistantMsg);

        // Tool results — 同时检测是否包含信息类工具
        for (const tc of round.toolCalls) {
          const result = round.results[tc.id];
          if (result) {
            if (TurnManager.INFO_TOOLS.has(result.toolName)) {
              hasInfoTools = true;
            }
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              name: result.toolName,
              content: truncateToolResult(sanitizeToolContent(result.content), result.toolName),
            });
          }
        }
      }

      // 最终 assistant 文本（tool loop 结束后 LLM 返回的最终回答）
      if (turn.response.content) {
        // 检查最后一条是不是 assistant 消息，如果是的话可以合并
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.role === 'assistant' && !lastMsg.tool_calls) {
          lastMsg.content = sanitizeAssistantContent(turn.response.content);
        } else {
          messages.push({
            role: 'assistant',
            content: sanitizeAssistantContent(turn.response.content),
          });
        }
      }

      turnSpans.push({
        turnId: turn.id,
        turnIndex: turnIdx,
        startIdx: spanStart,
        endIdx: messages.length,
        hasInfoTools,
      });
    }

    // 工具结果去重：同名工具的重复结果折叠以节省 token
    this.deduplicateToolResults(messages);

    this._cachedMessages = messages;
    this._cachedTurnSpans = turnSpans;
    this._dirty = false;
    return messages;
  }



  // ==================== 回滚 / 截断 ====================

  /**
   * 回滚到指定 Turn（包含该 Turn）
   * 用于 restoreToCheckpoint / regenerateTurn
   */
  truncateToTurn(turnId: string): void {
    const idx = this._turns.findIndex(t => t.id === turnId);
    if (idx >= 0) {
      this._turns.length = idx + 1;
      // 清除该 turn 的 response（用于 regenerate）
      delete this._turns[idx].response;
      this.invalidateCache();
    }
  }

  /**
   * 删除指定 Turn 及之后的所有 Turn
   * 用于 restoreToCheckpoint（恢复到某 turn 之前的状态）
   */
  removeFromTurn(turnId: string): void {
    const idx = this._turns.findIndex(t => t.id === turnId);
    if (idx >= 0) {
      this._turns.length = idx;
      this.invalidateCache();
    }
  }

  /**
   * 移除最后一个 Turn（如果它没有 response）
   */
  removeIncompleteLast(): void {
    if (this._turns.length > 0 && !this._turns[this._turns.length - 1].response) {
      this._turns.pop();
      this.invalidateCache();
    }
  }

  // ==================== 压缩标记 ====================

  /**
   * 标记指定范围的 Turn 为已摘要化
   */
  markCompressed(turnIds: string[], summary: string): void {
    for (const turn of this._turns) {
      if (turnIds.includes(turn.id)) {
        if (!turn.metadata) turn.metadata = {};
        turn.metadata.compressed = true;
        turn.metadata.summary = summary;
      }
    }
    this.invalidateCache();
  }

  // ==================== 序列化 ====================

  /**
   * 序列化为可持久化格式
   */
  serialize(): SerializedTurns {
    return {
      version: 1,
      turns: structuredClone(this._turns),
    };
  }

  /**
   * 从序列化数据恢复
   */
  deserialize(data: SerializedTurns): void {
    if (data?.version === 1 && Array.isArray(data.turns)) {
      this._turns = data.turns;
      this.invalidateCache();
    }
  }

  /**
   * @deprecated 仅用于旧快照兼容（无 turnId 的历史检查点）。
   * 新代码应使用 removeFromTurn() / truncateToTurn() 进行 Turn-native 截断。
   *
   * 从消息数组重建 Turn[]
   */
  rebuildFromMessages(messages: any[]): void {
    this._turns = [];
    if (!messages || messages.length === 0) {
      this.invalidateCache();
      return;
    }

    let currentTurn: Turn | null = null;
    let currentRound: ToolCallRound | null = null;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // 跳过 <aily-context> 注入消息
      if (msg.role === 'user' && msg.content?.startsWith('<aily-context>')) {
        continue;
      }

      if (msg.role === 'user') {
        // 新 Turn 开始
        if (currentTurn) {
          this._turns.push(currentTurn);
        }
        currentTurn = {
          id: this.generateTurnId(),
          request: { content: msg.content || '', timestamp: Date.now() },
        };
        currentRound = null;
      } else if (msg.role === 'assistant' && currentTurn) {
        if (!currentTurn.response) {
          currentTurn.response = { content: '', toolCallRounds: [] };
        }

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // 有 tool_calls 的 assistant 消息 → 新建一个 ToolCallRound
          currentRound = {
            assistantContent: msg.content || '',
            toolCalls: msg.tool_calls.map((tc: any) => ({
              id: tc.id,
              name: tc.function?.name || '',
              arguments: tc.function?.arguments || '{}',
            })),
            results: {},
          };
          currentTurn.response.toolCallRounds.push(currentRound);
        } else {
          // 纯文本 assistant 消息
          currentTurn.response.content += (msg.content || '');
        }
      } else if (msg.role === 'tool' && currentRound) {
        // 工具结果 → 关联到当前 round
        const toolCallId = msg.tool_call_id;
        if (toolCallId) {
          currentRound.results[toolCallId] = {
            content: msg.content || '',
            isError: false,
            toolName: msg.name || '',
          };
        }
      }
    }

    // 推入最后一个 turn
    if (currentTurn) {
      this._turns.push(currentTurn);
    }

    this.invalidateCache();
  }

  // ==================== 重置 ====================

  clear(): void {
    this._turns = [];
    this.invalidateCache();
  }

  // ==================== 工具结果去重 ====================

  /**
   * 折叠同名工具的重复结果以节省 token（在 buildMessages 输出上执行）。
   * 仅修改 built messages 数组，不影响原始 Turn 数据。
   */
  private deduplicateToolResults(messages: any[]): void {
    const toolsByName = new Map<string, number[]>();
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'tool' && messages[i].name) {
        const indices = toolsByName.get(messages[i].name) || [];
        indices.push(i);
        toolsByName.set(messages[i].name, indices);
      }
    }

    let foldedCount = 0;
    for (const [name, indices] of toolsByName) {
      if (indices.length <= 1) continue;
      for (let i = indices.length - 1; i > 0; i--) {
        const newerContent = messages[indices[i]].content || '';
        for (let j = 0; j < i; j++) {
          const olderContent = messages[indices[j]].content || '';
          if (olderContent && newerContent && olderContent.length >= 80 && olderContent === newerContent) {
            messages[indices[j]].content = `[与后续 ${name} 调用结果相同，已折叠]`;
            foldedCount++;
          }
        }
      }
    }
    if (foldedCount > 0) {
      console.log(`[TurnManager] 折叠了 ${foldedCount} 条重复工具结果`);
    }
  }

  // ==================== 内部方法 ====================

  private invalidateCache(): void {
    this._dirty = true;
    this._cachedMessages = null;
    this._cachedTurnSpans = [];
  }

  private generateTurnId(): string {
    return `turn_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }
}
