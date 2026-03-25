/**
 * ToolCallLoopHelper — 无状态工具调用循环辅助类
 *
 * 负责 stateless chat turn 的发起、上下文压缩、
 * 工具调用结果收集、循环迭代和最终回合结算。
 */

import type { ChatEngineService } from '../services/chat-engine.service';
import { ToolCallState } from '../core/chat-types';
import { AilyHost } from '../core/host';
import { isDeferredTool } from '../tools/tools';

export class ToolCallLoopHelper {
  /** 压缩后的消息（瞬态，仅在 startChatTurn → streamConnect 之间传递） */
  _compressedMessages: any[] | null = null;

  constructor(private engine: ChatEngineService) {}

  // ==================== 工具 / LLM 配置 ====================

  getCurrentTools(): any[] {
    // 1. 按 agents 字段过滤：mainAgent 只获取属于 mainAgent 的工具
    //    参考 SubagentSessionService.getToolsForAgent() 的同等逻辑
    let tools = this.engine.tools.filter(tool =>
      !tool.agents || tool.agents.includes('mainAgent')
    );

    // 2. 按 aily config 配置过滤（尊重用户的 enabledTools/disabledTools 设置）
    const mainAgentConfig = this.engine.ailyChatConfigService.getAgentToolsConfig('mainAgent');
    const enabledToolNames = mainAgentConfig?.enabledTools || [];
    const disabledToolNames = new Set(mainAgentConfig?.disabledTools || []);
    if (enabledToolNames.length > 0) {
      const enabledSet = new Set(enabledToolNames);
      tools = tools.filter(tool => enabledSet.has(tool.name) || !disabledToolNames.has(tool.name));
    } else if (disabledToolNames.size > 0) {
      tools = tools.filter(tool => !disabledToolNames.has(tool.name));
    }

    // 3. Deferred tool filtering: 只发送 core 工具 + 已激活的 deferred 工具
    // 参考 Copilot 的 deferred tool loading 策略
    const activated = this.engine.activatedDeferredTools;
    tools = tools.filter(tool => !isDeferredTool(tool.name) || activated.has(tool.name));

    let mcpTools = this.engine.mcpService.tools.map(tool => {
      if (!tool.name.startsWith('mcp_')) { tool.name = 'mcp_' + tool.name; }
      return tool;
    });
    if (mcpTools && mcpTools.length > 0) { tools = tools.concat(mcpTools); }
    return tools;
  }

  getCurrentLLMConfig(): any {
    if (this.engine.currentModel && this.engine.currentModel.baseUrl && this.engine.currentModel.apiKey) {
      return { apiKey: this.engine.currentModel.apiKey, baseUrl: this.engine.currentModel.baseUrl };
    } else if (this.engine.ailyChatConfigService.useCustomApiKey) {
      return { apiKey: this.engine.ailyChatConfigService.apiKey, baseUrl: this.engine.ailyChatConfigService.baseUrl };
    }
    return null;
  }

  // ==================== turn 发起 ====================

  async startChatTurn(): Promise<void> {
    if (this.engine.isCancelled) { this.engine.isWaiting = false; return; }

    const toolCallLimit = this.engine.ailyChatConfigService.maxCount;
    if (this.engine.toolCallingIteration >= toolCallLimit) {
      console.warn(`[无状态模式] 工具调用循环已达上限 (${toolCallLimit})，强制结束`);
      this.engine.msg.appendMessage('aily', `\n\n> ⚠️ 工具调用轮次已达上限（${toolCallLimit}），请重新发送消息继续。\n\n`);
      this.engine.isWaiting = false;
      this.engine.isCompleted = true;
      return;
    }

    this.engine.contextBudgetService.updateModelContextSize(this.engine.currentModel?.model || null);
    this.engine.contextBudgetService.updateBudget(this.engine.conversationMessages, this.getCurrentTools());

    const preCompressBudget = this.engine.contextBudgetService.getSnapshot();
    const willSummarize = preCompressBudget.currentTokens >= preCompressBudget.summarizationThreshold;
    const bg = this.engine.contextBudgetService.backgroundSummarizer;
    const bgWaiting = bg.shouldBlockAndWait(preCompressBudget.currentTokens, preCompressBudget.maxContextTokens);
    const bgReady = bg.state === 'Completed';
    const showCompressionState = willSummarize || bgWaiting || bgReady;
    const compressionStateId = 'context-compression-' + Date.now();

    if (showCompressionState) {
      const stateText = bgWaiting ? `正在等待上下文摘要完成 (${preCompressBudget.usagePercent}%)...`
        : bgReady ? `正在应用上下文摘要 (${preCompressBudget.usagePercent}%)...`
        : `正在压缩上下文 (${preCompressBudget.usagePercent}%)...`;
      this.engine.msg.displayToolCallState({ id: compressionStateId, name: 'context_compression', state: ToolCallState.DOING, text: stateText });
    }

    try {
      const currentMessages = this.engine.turnManager.buildMessages();
      const turnSpans = this.engine.turnManager.turnSpans;
      const compressed = await this.engine.contextBudgetService.compressIfNeeded(
        currentMessages, this.engine.sessionId, this.getCurrentLLMConfig(), this.engine.currentModel?.model || undefined,
        turnSpans
      );
      // 压缩结果仅瞬态使用，不回写 Turn[]（Turn[] 不可变）
      this._compressedMessages = compressed;
      if (showCompressionState) {
        this.engine.msg.displayToolCallState({ id: compressionStateId, name: 'context_compression', state: ToolCallState.DONE, text: '上下文摘要完成' });
      }
    } catch (error) {
      console.warn('[无状态模式] 上下文压缩失败，使用原始历史:', error);
      this._compressedMessages = null;
      if (showCompressionState) {
        this.engine.msg.displayToolCallState({ id: compressionStateId, name: 'context_compression', state: ToolCallState.WARN, text: '上下文摘要失败，使用原始历史继续' });
      }
    }

    this.engine.pendingToolResults = [];
    this.engine.currentTurnAssistantContent = '';
    this.engine.currentTurnToolCalls = [];
    this.engine.activeToolExecutions = 0;
    this.engine.sseStreamCompleted = false;
    this.engine.currentStatelessMode = true;

    // 压缩期间用户可能已取消，再次检查
    if (this.engine.isCancelled) { this.engine.isWaiting = false; return; }

    this.engine.stream.streamConnect(true);
  }

  // ==================== 循环迭代 ====================

  continueToolCallingLoop(): void {
    // Turn 结构化存储：记录本轮工具调用
    if (this.engine.currentTurnToolCalls.length > 0) {
      this.engine.turnManager.addToolCallRound(
        this.engine.currentTurnAssistantContent || '',
        this.engine.currentTurnToolCalls.map(tc => ({
          id: tc.tool_id,
          name: tc.tool_name,
          arguments: typeof tc.tool_args === 'string' ? tc.tool_args : JSON.stringify(tc.tool_args),
        }))
      );
    }

    // Turn 结构化存储：记录工具结果
    for (const result of this.engine.pendingToolResults) {
      this.engine.turnManager.addToolResult(result.tool_id, {
        content: result.content,
        isError: result.is_error ?? false,
        toolName: result.tool_name,
      });
    }

    this.engine.toolCallingIteration++;
    this.engine.contextBudgetService.updateBudget(this.engine.conversationMessages, this.getCurrentTools());
    this.startChatTurn();
  }

  // ==================== 完成回调 ====================

  onToolExecutionComplete(): void {
    this.engine.activeToolExecutions--;
    // 取消后不再触发循环迭代（stop() 已负责保存已完成的结果）
    if (this.engine.isCancelled) return;
    if (this.engine.activeToolExecutions === 0 && this.engine.sseStreamCompleted) {
      this.finalizeStatelessTurn();
    }
  }

  finalizeStatelessTurn(): void {
    if (this.engine.pendingToolResults.length > 0 && !this.engine.isCancelled) {
      this.continueToolCallingLoop();
    } else {
      // Turn 结构化存储：最终 assistant 响应
      this.engine.turnManager.finalizeTurn(this.engine.currentTurnAssistantContent || '');
      this.engine.contextBudgetService.updateBudget(this.engine.conversationMessages, this.getCurrentTools());
      const budget = this.engine.contextBudgetService.getSnapshot();
      this.engine.contextBudgetService.backgroundSummarizer.checkAndTrigger(
        this.engine.conversationMessages, budget.maxContextTokens, budget.currentTokens,
        this.engine.sessionId, this.getCurrentLLMConfig(), this.engine.currentModel?.model || undefined
      );

      // 提交当前 turn 的 checkpoint
      this.engine.editCheckpointService.commitCurrentTurn();

      // 如果本轮有文件变更，通过服务推送摘要到面板
      if (this.engine.editCheckpointService.hasEditsInCurrentTurn()) {
        if (this.engine.ailyChatConfigService.autoSaveEdits) {
          // 自动保存模式：直接保留变更，不弹出面板
          this.engine.editCheckpointService.acceptAllAsBaseline();
          this.engine.editCheckpointService.dismissSummary();
        } else {
          const summary = this.engine.editCheckpointService.getEditsSummary();
          this.engine.editCheckpointService.publishSummary(summary);
        }
      }

      if (this.engine.list.length > 0 && this.engine.list[this.engine.list.length - 1].role === 'aily') {
        this.engine.list[this.engine.list.length - 1].state = 'done';
      }
      this.engine.isWaiting = false;
      this.engine.isCompleted = true;
      this.engine.session.saveCurrentSession();
      if (!AilyHost.get().electron?.isWindowFocused()) {
        AilyHost.get().electron?.notify('Aily', '对话已完成');
      }
      // 应用延迟的模型/模式切换
      this.engine.applyPendingSwitch();
    }
  }
}
