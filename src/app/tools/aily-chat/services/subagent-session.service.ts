/**
 * SubagentSessionService - Subagent 会话管理服务
 *
 * 当 mainAgent 通过 tool_call_request 下发 tool_type="subagent" 的工具调用时，
 * 前端需要直连对应的 subagent 执行任务，并将结果回传主会话。
 *
 * 核心职责：
 * 1. 为每个 subagent 创建/复用独立会话（与 BackgroundAgentService 的直连会话隔离）
 * 2. 通过 chatRequest 直连 subagent 执行任务，流式接收回复
 * 3. 支持同一轮中多个 subagent 并行执行
 * 4. 生命周期管理：主会话重置时清理所有 subagent 会话
 *
 * 与 BackgroundAgentService 的关系：
 * - BackgroundAgentService 用于「用户主动触发的后台任务」（如点击生成连线图按钮）
 * - SubagentSessionService 用于「mainAgent 作为工具调用的 subagent」
 * - 两者使用完全独立的 sessionId，互不干扰，可同时运行
 */

import { Injectable, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subject, Observable } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { ChatAPI } from '../core/api-endpoints';
import { AilyHost } from '../core/host';
import { AilyChatConfigService } from './aily-chat-config.service';
import { TOOLS, ToolUseResult } from '../tools/tools';
import { createSecurityContext } from './security.service';
// ToolRegistry: 统一工具调度
import { ToolRegistry } from '../core/tool-registry';
import '../tools/registered/register-all';

import { fetchTool, FetchToolService } from '../tools/fetchTool';

// ===== 类型定义 =====

/** Subagent 工具调用请求（从 SSE 事件中解析） */
export interface SubagentToolCallRequest {
  tool_id: string;
  tool_name: string;
  tool_args: string | Record<string, any>;
  tool_type: 'subagent';
  agent_name: string;
  source?: string;
}

/** Subagent 执行进度事件 */
export interface SubagentProgressEvent {
  type: 'started' | 'streaming' | 'tool_call' | 'tool_call_start' | 'tool_call_end' | 'completed' | 'error';
  agentName: string;
  toolId: string;
  content: string;
  /** 流式文本累积（type=streaming 时持续更新） */
  accumulatedText?: string;
  /** subagent 内部工具调用名（type=tool_call_start/tool_call_end 时） */
  innerToolName?: string;
  /** subagent 内部工具调用 ID（type=tool_call_start/tool_call_end 时） */
  innerToolId?: string;
  /** 工具调用是否失败（type=tool_call_end 时） */
  isError?: boolean;
  timestamp: number;
}

/** Subagent 会话状态 */
interface SubagentSession {
  sessionId: string;
  agentName: string;
  /** 该 subagent 的对话历史（支持多轮内会话复用） */
  messages: any[];
  /** 是否正在执行中 */
  running: boolean;
  /** 创建时间 */
  createdAt: number;
}

/** Subagent 单轮 chatRequest 的状态收集器（局部变量，支持并发） */
interface SubagentTurnState {
  toolCalls: any[];
  pendingToolResults: any[];
  assistantContent: string;
  taskCompleted: boolean;
  stopReason: string;
}

@Injectable({
  providedIn: 'root'
})
export class SubagentSessionService implements OnDestroy {

  // ===== 状态 =====
  /** agentName → SubagentSession 映射（会话复用） */
  private sessions = new Map<string, SubagentSession>();
  /** 进度事件流（供 UI 消费，可在 subagent 面板实时展示） */
  private progress$ = new Subject<SubagentProgressEvent>();
  /** 活跃的 fetch reader（用于取消） */
  private activeReaders = new Map<string, ReadableStreamDefaultReader<Uint8Array>>();
  /** 取消标记 */
  private abortedToolIds = new Set<string>();
  /** 工具 fetch 服务 */
  private fetchToolService: FetchToolService;

  constructor(
    private http: HttpClient,
    private ailyChatConfigService: AilyChatConfigService,
  ) {
    this.fetchToolService = new FetchToolService(this.http);
  }

  ngOnDestroy(): void {
    this.cleanupAll();
  }

  // =========================================================================
  // 公共 API
  // =========================================================================

  /** 进度事件流（供 UI 订阅） */
  onProgress(): Observable<SubagentProgressEvent> {
    return this.progress$.asObservable();
  }

  /**
   * 执行一个 subagent 工具调用
   *
   * 完整流程：
   * 1. 获取/创建 subagent 会话
   * 2. 构建用户消息（task + context）
   * 3. 通过 chatRequest 直连 subagent 执行
   * 4. 流式接收回复，实时推送进度
   * 5. 返回完整回复文本
   *
   * @param request 工具调用请求
   * @param timeout 超时时间（ms），默认 120s
   * @returns subagent 的完整回复文本
   */
  async executeSubagentToolCall(
    request: SubagentToolCallRequest,
    timeout: number = 120000,
  ): Promise<string> {
    const { tool_id, tool_name, agent_name } = request;

    // 解析参数
    let args: Record<string, any>;
    try {
      args = typeof request.tool_args === 'string'
        ? JSON.parse(request.tool_args)
        : request.tool_args || {};
    } catch (e) {
      const errMsg = `Subagent 工具参数解析失败: ${(e as Error).message}`;
      this.emitProgress('error', agent_name, tool_id, errMsg);
      throw new Error(errMsg);
    }

    const task = args['task'] || args['content'] || JSON.stringify(args);
    const context = args['context'] || '';

    // console.log(`[SubagentSession] 执行 subagent 工具: ${tool_name}, agent: ${agent_name}, task: ${task.substring(0, 100)}...`);

    // 1. 获取或创建 subagent 会话
    const session = await this.getOrCreateSession(agent_name);

    // 标记为执行中
    session.running = true;
    this.emitProgress('started', agent_name, tool_id, `正在执行 ${agent_name}...`);

    try {
      // 2. 构建用户消息
      const userContent = context
        ? `上下文信息:\n${context}\n\n任务:\n${task}`
        : task;

      // 3. 直连 subagent 执行并收集回复
      const result = await this.chatWithSubagent(
        session,
        userContent,
        tool_id,
        timeout,
      );

      this.emitProgress('completed', agent_name, tool_id, `${agent_name} 执行完成`);
      // console.log(`[SubagentSession] ${agent_name} 执行完成, 结果长度: ${result.length}`);

      return result;
    } catch (error: any) {
      const errMsg = error.message || `${agent_name} 执行失败`;
      this.emitProgress('error', agent_name, tool_id, errMsg);
      console.error(`[SubagentSession] ${agent_name} 执行失败:`, error);
      throw error;
    } finally {
      session.running = false;
    }
  }

  /**
   * 判断给定的 SSE 事件是否为 subagent 工具调用
   */
  static isSubagentToolCall(event: any): event is SubagentToolCallRequest {
    return event?.tool_type === 'subagent' && !!event?.agent_name;
  }

  /**
   * 取消指定工具调用
   */
  cancelToolCall(toolId: string): void {
    this.abortedToolIds.add(toolId);
    const reader = this.activeReaders.get(toolId);
    if (reader) {
      reader.cancel().catch(() => {});
      this.activeReaders.delete(toolId);
    }
  }

  /**
   * 清理所有 subagent 会话（主会话重置时调用）
   */
  cleanupAll(): void {
    // 取消所有正在执行的 reader
    for (const [toolId, reader] of this.activeReaders) {
      reader.cancel().catch(() => {});
    }
    this.activeReaders.clear();
    this.abortedToolIds.clear();

    // 关闭服务端会话
    for (const [_, session] of this.sessions) {
      this.closeServerSession(session.sessionId);
    }
    this.sessions.clear();

    // console.log('[SubagentSession] 已清理所有会话');
  }

  /**
   * 清理指定 agent 的会话
   */
  cleanupAgent(agentName: string): void {
    const session = this.sessions.get(agentName);
    if (session) {
      this.closeServerSession(session.sessionId);
      this.sessions.delete(agentName);
      // console.log(`[SubagentSession] 已清理 ${agentName} 的会话`);
    }
  }

  // =========================================================================
  // 会话管理
  // =========================================================================

  /**
   * 获取或创建 subagent 会话
   * 同名 subagent 会复用已有会话（避免每次 tool call 都重建）
   */
  private async getOrCreateSession(agentName: string): Promise<SubagentSession> {
    const existing = this.sessions.get(agentName);
    if (existing) {
      // console.log(`[SubagentSession] 复用 ${agentName} 会话: ${existing.sessionId}`);
      return existing;
    }

    // 创建新会话
    const sessionId = uuidv4();
    // console.log(`[SubagentSession] 为 ${agentName} 创建新会话: ${sessionId}`);

    // 根据 agentName 过滤可用工具（与 BackgroundAgentService 同逻辑）
    const agentTools = this.getToolsForAgent(agentName);

    // POST /api/v1/start_session
    const payload = {
      session_id: sessionId,
      agent: agentName,
      tools: agentTools,
      mode: 'agent',
    };

    try {
      const result: any = await this.http.post(ChatAPI.startSession, payload).toPromise();
      if (result?.status !== 'success') {
        throw new Error(result?.message || `创建 ${agentName} 会话失败`);
      }
    } catch (error: any) {
      throw new Error(`创建 ${agentName} 会话失败: ${error.message}`);
    }

    const session: SubagentSession = {
      sessionId,
      agentName,
      messages: [],
      running: false,
      createdAt: Date.now(),
    };

    this.sessions.set(agentName, session);
    return session;
  }

  /**
   * 关闭服务端会话
   */
  private closeServerSession(sessionId: string): void {
    this.http.post(`${ChatAPI.closeSession}/${sessionId}`, {}).toPromise().catch(() => {});
  }

  // =========================================================================
  // 直连执行（Copilot 式无状态 Request-per-Turn 工具调用循环）
  // =========================================================================

  /**
   * 通过 chatRequest 直连 subagent 执行任务 —— 完整工具调用循环
   *
   * 流程：
   * 1. 将用户消息加入会话历史
   * 2. 循环：发送 chatRequest → 处理 SSE → 若有本地工具调用则执行并注入结果 → 重复
   * 3. 收到 TaskCompleted(COMPLETED|TERMINATE|end_turn) 或无更多工具调用时返回最终文本
   *
   * 与之前的区别：
   * - 之前只发一轮 chatRequest，subagent 内部工具调用无法被本地执行，导致结果不完整
   * - 现在实现了与 BackgroundAgentService.runToolCallingLoop() 同等的多轮循环
   */
  private async chatWithSubagent(
    session: SubagentSession,
    userContent: string,
    toolId: string,
    timeout: number,
  ): Promise<string> {
    session.messages.push({ role: 'user', content: userContent });

    const deadline = Date.now() + timeout;
    const toolCallLimit = this.ailyChatConfigService?.maxCount || 30;
    let iteration = 0;
    let finalText = '';

    while (iteration < toolCallLimit) {
      if (this.abortedToolIds.has(toolId)) break;

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`${session.agentName} 执行超时 (${timeout / 1000}s)`);
      }

      const turnState: SubagentTurnState = {
        toolCalls: [],
        pendingToolResults: [],
        assistantContent: '',
        taskCompleted: false,
        stopReason: '',
      };

      // console.log(`[SubagentSession] ${session.agentName} 第 ${iteration + 1} 轮请求, messages: ${session.messages.length} 条`);

      await this.processSubagentChatTurn(session, toolId, remaining, turnState);

      if (this.abortedToolIds.has(toolId)) break;

      finalText = turnState.assistantContent;

      // TaskCompleted 且 stop_reason 为终止类型 → 循环结束
      if (turnState.taskCompleted &&
          ['COMPLETED', 'TERMINATE', 'end_turn'].includes(turnState.stopReason)) {
        // console.log(`[SubagentSession] ${session.agentName} 任务完成, stop_reason: ${turnState.stopReason}`);
        break;
      }

      // 没有待处理的工具结果 → 循环结束（纯文本回复或 internal 工具已由服务端处理完）
      if (turnState.pendingToolResults.length === 0) {
        // 如果 taskCompleted 但 stopReason 不是终止类型（如 tool_calls），且没有本地工具结果
        // 说明是 internal 工具循环，但服务端应该在流中已处理完，直接结束
        break;
      }

      // 有本地工具执行结果 → 将 assistant 消息(含 tool_calls) + 工具结果加入对话历史，继续下一轮
      const assistantMessage: any = {
        role: 'assistant',
        content: turnState.assistantContent || ''
      };
      if (turnState.toolCalls.length > 0) {
        assistantMessage.tool_calls = turnState.toolCalls.map(tc => ({
          id: tc.tool_id,
          type: 'function',
          function: {
            name: tc.tool_name,
            arguments: typeof tc.tool_args === 'string' ? tc.tool_args : JSON.stringify(tc.tool_args)
          }
        }));
      }
      session.messages.push(assistantMessage);

      for (const result of turnState.pendingToolResults) {
        session.messages.push({
          role: 'tool',
          tool_call_id: result.tool_id,
          name: result.tool_name,
          content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
        });
      }

      iteration++;
      // console.log(`[SubagentSession] ${session.agentName} ${turnState.pendingToolResults.length} 个工具结果已加入对话历史，继续第 ${iteration + 1} 轮`);
    }

    // 将最终的 assistant 回复加入会话历史（支持后续复用）
    if (finalText) {
      session.messages.push({ role: 'assistant', content: finalText });
    }

    return finalText || '(subagent 未返回内容)';
  }

  /**
   * 发送一轮 chatRequest 并处理 SSE 流
   * 流事件中遇到非 internal 的 tool_call_request 会立即本地执行，结果收集到 turnState
   */
  private async processSubagentChatTurn(
    session: SubagentSession,
    toolId: string,
    timeout: number,
    turnState: SubagentTurnState,
  ): Promise<void> {
    const token = await AilyHost.get().auth.getToken!();
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const agentTools = this.getToolsForAgent(session.agentName);
    const payload = {
      session_id: session.sessionId,
      messages: session.messages,
      tools: agentTools,
      mode: 'agent',
      agent: session.agentName,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    let response: Response;
    try {
      response = await fetch(`${ChatAPI.chatRequest}/${session.sessionId}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`${session.agentName} 执行超时 (${timeout / 1000}s)`);
      }
      throw error;
    }

    if (!response.ok) {
      clearTimeout(timeoutId);
      throw new Error(`${session.agentName} HTTP ${response.status}: ${response.statusText}`);
    }

    const reader = response.body!.getReader();
    this.activeReaders.set(toolId, reader);
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        if (this.abortedToolIds.has(toolId)) {
          throw new Error(`${session.agentName} 执行被取消`);
        }

        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          if (this.abortedToolIds.has(toolId)) break;

          try {
            const event = JSON.parse(line);
            await this.handleSubagentStreamEvent(event, session.agentName, toolId, turnState);
          } catch (e) {
            console.warn(`[SubagentSession] JSON 解析失败:`, line, e);
          }
        }
      }

      if (buffer.trim() && !this.abortedToolIds.has(toolId)) {
        try {
          const event = JSON.parse(buffer);
          await this.handleSubagentStreamEvent(event, session.agentName, toolId, turnState);
        } catch { }
      }
    } finally {
      clearTimeout(timeoutId);
      this.activeReaders.delete(toolId);
    }
  }

  // =========================================================================
  // 流事件处理
  // =========================================================================

  /**
   * 处理 subagent SSE 流中的单个事件（async — 支持本地工具执行）
   */
  private async handleSubagentStreamEvent(
    event: any,
    agentName: string,
    toolId: string,
    turnState: SubagentTurnState,
  ): Promise<void> {
    switch (event.type) {
      case 'ModelClientStreamingChunkEvent': {
        const content = event.content || '';
        turnState.assistantContent += content;
        this.emitProgress('streaming', agentName, toolId, content, turnState.assistantContent);
        break;
      }

      case 'tool_call_request': {
        const innerToolName = event.tool_name || 'unknown';
        const innerToolId = event.tool_id || `${toolId}_inner_${Date.now()}`;

        this.emitProgressEx('tool_call_start', agentName, toolId, `${agentName}: 调用 ${innerToolName}...`, {
          innerToolName,
          innerToolId,
        });

        if (event.internal === true) {
          break;
        }

        await this.handleLocalToolCall(event, agentName, toolId, turnState);
        break;
      }

      case 'tool_call_execution': {
        const innerToolName2 = event.tool_name || 'unknown';
        const innerToolId2 = event.tool_id || `${toolId}_inner_${Date.now()}`;
        const isError = !!event.is_error;
        const execResult = isError ? `执行失败` : '执行完成';
        this.emitProgressEx('tool_call_end', agentName, toolId, `${agentName}: ${innerToolName2} ${execResult}`, {
          innerToolName: innerToolName2,
          innerToolId: innerToolId2,
          isError,
        });
        break;
      }

      case 'TaskCompleted': {
        turnState.taskCompleted = true;
        turnState.stopReason = event.stop_reason || event.data?.stop_reason || '';
        // console.log(`[SubagentSession] ${agentName} TaskCompleted, stop_reason: ${turnState.stopReason}`);
        break;
      }

      case 'error': {
        const errMsg = event.message || event.content || '未知错误';
        console.error(`[SubagentSession] ${agentName} 服务端错误:`, errMsg);
        break;
      }
    }
  }

  // =========================================================================
  // 本地工具执行（与 BackgroundAgentService.handleToolCallRequest 同逻辑）
  // =========================================================================

  /**
   * 处理非 internal 的 tool_call_request：本地执行工具并收集结果
   */
  private async handleLocalToolCall(
    event: any,
    agentName: string,
    toolId: string,
    turnState: SubagentTurnState,
  ): Promise<void> {
    const toolName = event.tool_name;
    const innerToolId = event.tool_id;

    turnState.toolCalls.push({
      tool_id: innerToolId,
      tool_name: toolName,
      tool_args: event.tool_args,
    });

    let toolArgs: any;
    try {
      toolArgs = typeof event.tool_args === 'string'
        ? JSON.parse(event.tool_args)
        : event.tool_args || {};
    } catch {
      turnState.pendingToolResults.push({
        tool_id: innerToolId,
        tool_name: toolName,
        content: '参数解析失败',
        is_error: true,
      });
      this.emitProgressEx('tool_call_end', agentName, toolId, `${agentName}: ${toolName} 参数解析失败`, {
        innerToolName: toolName, innerToolId, isError: true,
      });
      return;
    }

    let result: ToolUseResult;
    try {
      result = await this.executeTool(toolName, toolArgs);
    } catch (error: any) {
      result = { is_error: true, content: `工具执行异常: ${error.message}` };
    }

    const isError = result.is_error || false;
    this.emitProgressEx('tool_call_end', agentName, toolId,
      `${agentName}: ${toolName} ${isError ? '失败' : '完成'}`, {
        innerToolName: toolName, innerToolId, isError,
      });

    turnState.pendingToolResults.push({
      tool_id: innerToolId,
      tool_name: toolName,
      content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
      is_error: isError,
    });
  }

  /**
   * 路由工具调用到具体的处理函数。
   * 优先通过 ToolRegistry 统一调度，减少重复 switch/case。
   */
  private async executeTool(toolName: string, args: any): Promise<ToolUseResult> {
    // 已注册工具：通过 ToolRegistry 统一调度
    if (ToolRegistry.has(toolName)) {
      const ctx = {
        projectService: AilyHost.get().project,
        connectionGraphService: AilyHost.get().connectionGraph,
        securityContext: createSecurityContext(AilyHost.get().project.currentProjectPath || ''),
        fetchToolService: this.fetchToolService,
        configService: AilyHost.get().config,
      };
      return ToolRegistry.execute(toolName, args, ctx);
    }

    // 未注册工具：返回错误
    return { is_error: true, content: `Subagent 不支持工具: ${toolName}` };
  }

  // =========================================================================
  // 进度推送
  // =========================================================================

  private emitProgress(
    type: SubagentProgressEvent['type'],
    agentName: string,
    toolId: string,
    content: string,
    accumulatedText?: string,
  ): void {
    this.progress$.next({
      type,
      agentName,
      toolId,
      content,
      accumulatedText,
      timestamp: Date.now(),
    });
  }

  private emitProgressEx(
    type: SubagentProgressEvent['type'],
    agentName: string,
    toolId: string,
    content: string,
    extra: { innerToolName?: string; innerToolId?: string; isError?: boolean; accumulatedText?: string } = {},
  ): void {
    this.progress$.next({
      type,
      agentName,
      toolId,
      content,
      innerToolName: extra.innerToolName,
      innerToolId: extra.innerToolId,
      isError: extra.isError,
      accumulatedText: extra.accumulatedText,
      timestamp: Date.now(),
    });
  }

  // =========================================================================
  // 工具定义
  // =========================================================================

  private getToolsForAgent(agentName: string): any[] {
    // 1. 按 agents 字段过滤
    let tools = (TOOLS as any[]).filter(tool => {
      if (!tool.agents) return false;
      return tool.agents.includes(agentName);
    });
    // 2. 按 aily config 配置过滤（尊重用户的 enabledTools/disabledTools 设置）
    const agentConfig = this.ailyChatConfigService.getAgentToolsConfig(agentName);
    const disabledTools = new Set(agentConfig.disabledTools || []);
    if (disabledTools.size > 0) {
      tools = tools.filter(tool => !disabledTools.has(tool.name));
    }
    return tools;
  }
}
