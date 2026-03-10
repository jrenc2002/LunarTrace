/**
 * ToolCallLoopHelper — 无状态工具调用循环辅助类
 *
 * 负责 stateless chat turn 的发起、上下文压缩、
 * 工具调用结果收集、循环迭代和最终回合结算。
 */

import type { ChatEngineService } from '../services/chat-engine.service';
import { ToolCallState } from '../core/chat-types';
import { AilyHost } from '../core/host';

export class ToolCallLoopHelper {
  constructor(private engine: ChatEngineService) {}

  // ==================== 工具 / LLM 配置 ====================

  getCurrentTools(): any[] {
    const mainAgentConfig = this.engine.ailyChatConfigService.getAgentToolsConfig('mainAgent');
    const schematicAgentConfig = this.engine.ailyChatConfigService.getAgentToolsConfig('schematicAgent');
    const enabledToolNames = [...(mainAgentConfig?.enabledTools || []), ...(schematicAgentConfig?.enabledTools || [])];
    const disabledToolNames = [...(mainAgentConfig?.disabledTools || []), ...(schematicAgentConfig?.disabledTools || [])];
    const hasEnabledToolsConfig = enabledToolNames.length > 0;
    let tools = hasEnabledToolsConfig
      ? this.engine.tools.filter(tool => enabledToolNames.includes(tool.name) || (!disabledToolNames.includes(tool.name) && !enabledToolNames.includes(tool.name)))
      : [...this.engine.tools];
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

    const toolCallLimit = this.engine.ailyChatConfigService.maxCount || 50;
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
      this.engine.conversationMessages = await this.engine.contextBudgetService.compressIfNeeded(
        this.engine.conversationMessages, this.engine.sessionId, this.getCurrentLLMConfig(), this.engine.currentModel?.model || undefined
      );
      if (showCompressionState) {
        this.engine.msg.displayToolCallState({ id: compressionStateId, name: 'context_compression', state: ToolCallState.DONE, text: '上下文摘要完成' });
      }
    } catch (error) {
      console.warn('[无状态模式] 上下文压缩失败，使用原始历史:', error);
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
    this.engine.stream.streamConnect(true);
  }

  // ==================== 循环迭代 ====================

  continueToolCallingLoop(): void {
    const assistantMessage: any = {
      role: 'assistant',
      content: this.engine.msg.sanitizeAssistantContent(this.engine.currentTurnAssistantContent) || ''
    };
    if (this.engine.currentTurnToolCalls.length > 0) {
      assistantMessage.tool_calls = this.engine.currentTurnToolCalls.map(tc => ({
        id: tc.tool_id, type: 'function',
        function: { name: tc.tool_name, arguments: typeof tc.tool_args === 'string' ? tc.tool_args : JSON.stringify(tc.tool_args) }
      }));
    }
    this.engine.conversationMessages.push(assistantMessage);
    for (const result of this.engine.pendingToolResults) {
      this.engine.conversationMessages.push({
        role: 'tool', tool_call_id: result.tool_id, name: result.tool_name,
        content: this.engine.msg.truncateToolResult(this.engine.msg.sanitizeToolContent(result.content), result.tool_name)
      });
    }
    this.engine.toolCallingIteration++;
    this.engine.contextBudgetService.updateBudget(this.engine.conversationMessages, this.getCurrentTools());
    this.startChatTurn();
  }

  // ==================== 完成回调 ====================

  onToolExecutionComplete(): void {
    this.engine.activeToolExecutions--;
    if (this.engine.activeToolExecutions === 0 && this.engine.sseStreamCompleted) {
      this.finalizeStatelessTurn();
    }
  }

  finalizeStatelessTurn(): void {
    if (this.engine.pendingToolResults.length > 0 && !this.engine.isCancelled) {
      this.continueToolCallingLoop();
    } else {
      const sanitized = this.engine.currentTurnAssistantContent ? this.engine.msg.sanitizeAssistantContent(this.engine.currentTurnAssistantContent) : '';
      if (this.engine.currentTurnAssistantContent) {
        this.engine.conversationMessages.push({ role: 'assistant', content: sanitized });
      }
      this.engine.contextBudgetService.updateBudget(this.engine.conversationMessages, this.getCurrentTools());
      const budget = this.engine.contextBudgetService.getSnapshot();
      this.engine.contextBudgetService.backgroundSummarizer.checkAndTrigger(
        this.engine.conversationMessages, budget.maxContextTokens, budget.currentTokens,
        this.engine.sessionId, this.getCurrentLLMConfig(), this.engine.currentModel?.model || undefined
      );
      if (this.engine.list.length > 0 && this.engine.list[this.engine.list.length - 1].role === 'aily') {
        this.engine.list[this.engine.list.length - 1].state = 'done';
      }
      this.engine.isWaiting = false;
      this.engine.isCompleted = true;
      this.engine.session.saveCurrentSession();
      if (!AilyHost.get().electron?.isWindowFocused()) {
        AilyHost.get().electron?.notify('Aily', '对话已完成');
      }
    }
  }
}
