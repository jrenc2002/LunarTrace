/**
 * MessageDisplayHelper — 消息显示与操作辅助类
 *
 * 负责聊天消息的追加、工具调用状态显示、历史解析、
 * TERMINATE 前缀检测、aily-button 截断等逻辑。
 */

import type { ChatEngineService } from '../services/chat-engine.service';
import { ChatMessage, ToolCallState, ToolCallInfo } from '../core/chat-types';
import {
  makeJsonSafe as _makeJsonSafe,
  findTerminatePrefixStart as _findTerminatePrefixStart,
  markContentAsHistory as _markContentAsHistory,
  getClosingTagsForOpenBlocks as _getClosingTagsForOpenBlocks,
  sanitizeAssistantContent as _sanitizeAssistantContent,
  sanitizeToolContent as _sanitizeToolContent,
  truncateToolResult as _truncateToolResult,
} from '../services/content-sanitizer.service';
import {
  generateToolStartText as _generateToolStartText,
  generateToolResultText as _generateToolResultText,
} from '../services/tool-display.service';

export class MessageDisplayHelper {
  constructor(private engine: ChatEngineService) {}

  // ==================== 纯函数包装 ====================

  makeJsonSafe(str: string): string { return _makeJsonSafe(str); }
  sanitizeAssistantContent(content: string): string { return _sanitizeAssistantContent(content); }
  sanitizeToolContent(content: string): string { return _sanitizeToolContent(content); }
  truncateToolResult(content: string, toolName?: string, maxChars?: number): string { return _truncateToolResult(content, toolName, maxChars); }

  getClosingTagsForOpenBlocks(): string {
    if (this.engine.list.length === 0) return '';
    const lastMsg = this.engine.list[this.engine.list.length - 1];
    if (lastMsg.role !== 'aily') return '';
    return _getClosingTagsForOpenBlocks(lastMsg.content || '');
  }

  cleanupLastAiMessage(): void {
    // no-op: cleanup logic removed to prevent aily-state block corruption
  }

  checkAndTruncateAilyButtonBlock(): boolean {
    if (this.engine.list.length === 0 || this.engine.list[this.engine.list.length - 1].role !== 'aily') return false;
    const content = this.engine.list[this.engine.list.length - 1].content;
    const lastThinkEnd = content.lastIndexOf('</think>');
    if (lastThinkEnd < 0 && content.includes('<think>')) return false;
    const searchStart = lastThinkEnd >= 0 ? lastThinkEnd : 0;
    const afterThink = content.substring(searchStart);
    const match = afterThink.match(/```aily-button[\s\S]*?```/);
    if (!match) return false;
    const blockEnd = searchStart + match.index! + match[0].length;
    if (blockEnd < content.length) { this.engine.list[this.engine.list.length - 1].content = content.substring(0, blockEnd); }
    return true;
  }

  // ==================== 工具调用状态显示 ====================

  displayToolCallState(toolCallInfo: ToolCallInfo, source?: string): void {
    const stateMessage = `
\`\`\`aily-state
{
  "state": "${toolCallInfo.state}",
  "text": "${this.makeJsonSafe(toolCallInfo.text)}",
  "id": "${toolCallInfo.id}"
}
\`\`\`\n\n
`;
    if (toolCallInfo.state !== ToolCallState.DOING) {
      const idEscaped = toolCallInfo.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = '`{3}aily-state[^`]*"id"\\s*:\\s*"' + idEscaped + '"[^`]*`{3}';
      for (let i = this.engine.list.length - 1; i >= 0; i--) {
        if (this.engine.list[i].role !== 'aily') continue;
        if (new RegExp(pattern).test(this.engine.list[i].content)) {
          const newBlock =
            '```aily-state\n{\n  "state": "' + toolCallInfo.state +
            '",\n  "text": "' + this.makeJsonSafe(toolCallInfo.text) +
            '",\n  "id": "' + toolCallInfo.id + '"\n}\n```';
          this.engine.list[i].content = this.engine.list[i].content.replace(new RegExp(pattern, 'g'), newBlock);
          if (this.engine.sessionId) { this.engine.chatHistoryService.markDirty(this.engine.sessionId); }
          return;
        }
      }
    }
    this.appendMessage('aily', stateMessage, source);
    if (toolCallInfo.state === ToolCallState.DOING) {
      this.engine.toolCallStates[toolCallInfo.id] = toolCallInfo.text;
    }
  }

  startToolCall(toolId: string, toolName: string, text: string, args?: any, source?: string): void {
    text = this.makeJsonSafe(text);
    const toolCallInfo: ToolCallInfo = { id: toolId, name: toolName, state: ToolCallState.DOING, text, args };
    this.displayToolCallState(toolCallInfo, source);
  }

  completeToolCall(toolId: string, toolName: string, state: ToolCallState, text: string, source?: string): void {
    const displayText = text || this.engine.toolCallStates[toolId] || '';
    const toolCallInfo: ToolCallInfo = { id: toolId, name: toolName, state, text: displayText };
    this.displayToolCallState(toolCallInfo, source);
    delete this.engine.toolCallStates[toolId];
  }

  // ==================== 历史解析 ====================

  parseHistory(historyData: any[]): void {
    const toolCallMap = new Map<string, { name: string, args?: any }>();
    historyData.forEach(item => {
      if (item.type === 'ToolCallRequestEvent' && Array.isArray(item.content)) {
        item.content.forEach(call => {
          if (call.id && call.name) {
            let args = null;
            try { args = call.arguments ? JSON.parse(call.arguments) : null; } catch (e) { console.warn('解析工具参数失败:', e); }
            toolCallMap.set(call.id, { name: call.name, args });
            const startText = _generateToolStartText(call.name, args);
            this.displayToolCallState({ id: call.id, name: call.name, state: ToolCallState.DOING, text: startText, args });
          }
        });
      } else if (item.type === 'ToolCallExecutionEvent' && Array.isArray(item.content)) {
        item.content.forEach(result => {
          if (result.call_id && toolCallMap.has(result.call_id)) {
            const toolInfo = toolCallMap.get(result.call_id)!;
            const resultState = result?.is_error ? ToolCallState.ERROR : ToolCallState.DONE;
            const resultText = _generateToolResultText(toolInfo.name, toolInfo.args, result);
            this.displayToolCallState({ id: result.call_id, name: toolInfo.name, state: resultState, text: resultText, args: toolInfo.args });
            toolCallMap.delete(result.call_id);
          }
        });
      } else {
        this.appendMessage(item.role, _markContentAsHistory(item.content));
      }
    });
    toolCallMap.forEach((toolInfo, callId) => {
      this.displayToolCallState({
        id: callId, name: toolInfo.name, state: ToolCallState.ERROR,
        text: `${_generateToolStartText(toolInfo.name, toolInfo.args)} (会话中断)`, args: toolInfo.args
      });
    });
  }

  // ==================== 消息追加 ====================

  setLastMsgContent(role: string, text: string, source?: string): void {
    const msgSource = source || this.engine.currentMessageSource;
    if (this.engine.list.length > 0 &&
        this.engine.list[this.engine.list.length - 1].role === role &&
        this.engine.list[this.engine.list.length - 1].source === msgSource) {
      this.engine.list[this.engine.list.length - 1].content += text;
      if (role === 'aily' && this.engine.isWaiting) { this.engine.list[this.engine.list.length - 1].state = 'doing'; }
    } else {
      this.engine.list.push({
        role, content: text,
        state: (role === 'aily' && this.engine.isWaiting) ? 'doing' : 'done',
        source: msgSource
      });
    }
    if (this.engine.sessionId) { this.engine.chatHistoryService.markDirty(this.engine.sessionId); }
  }

  appendMessage(role: string, text: string, source?: string): void {
    try {
      const parsedText = JSON.parse(text);
      if (typeof parsedText === 'object') { text = parsedText.content || JSON.stringify(parsedText, null, 2); }
    } catch (e) { /* not JSON */ }

    text = text.replace(/```/g, '\n```');

    const terminateText = 'TERMINATE';
    if (this.engine.terminateTemp) {
      this.engine.terminateTemp += text;
      if (terminateText.startsWith(this.engine.terminateTemp)) return;
      this.setLastMsgContent(role, this.engine.terminateTemp, source);
      this.engine.terminateTemp = '';
      return;
    }
    let prefixStart = _findTerminatePrefixStart(text, terminateText);
    if (prefixStart >= 0) {
      this.engine.terminateTemp += text.substring(prefixStart);
      text = text.substring(0, prefixStart);
      this.setLastMsgContent(role, text, source);
      return;
    }
    this.setLastMsgContent(role, text, source);
    this.engine.terminateTemp = '';
  }
}
