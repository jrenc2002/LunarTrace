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
import { API } from '../../../configs/api.config';
import { AuthService } from '../../../services/auth.service';

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
  type: 'started' | 'streaming' | 'tool_call' | 'completed' | 'error';
  agentName: string;
  toolId: string;
  content: string;
  /** 流式文本累积（type=streaming 时持续更新） */
  accumulatedText?: string;
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

  constructor(
    private http: HttpClient,
    private authService: AuthService,
  ) {
    console.log('[SubagentSession] 服务初始化');
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

    console.log(`[SubagentSession] 执行 subagent 工具: ${tool_name}, agent: ${agent_name}, task: ${task.substring(0, 100)}...`);

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
      console.log(`[SubagentSession] ${agent_name} 执行完成, 结果长度: ${result.length}`);

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

    console.log('[SubagentSession] 已清理所有会话');
  }

  /**
   * 清理指定 agent 的会话
   */
  cleanupAgent(agentName: string): void {
    const session = this.sessions.get(agentName);
    if (session) {
      this.closeServerSession(session.sessionId);
      this.sessions.delete(agentName);
      console.log(`[SubagentSession] 已清理 ${agentName} 的会话`);
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
      console.log(`[SubagentSession] 复用 ${agentName} 会话: ${existing.sessionId}`);
      return existing;
    }

    // 创建新会话
    const sessionId = uuidv4();
    console.log(`[SubagentSession] 为 ${agentName} 创建新会话: ${sessionId}`);

    // POST /api/v1/start_session
    const payload = {
      session_id: sessionId,
      agent: agentName,
      tools: [],         // subagent 的工具由服务端管理
      mode: 'agent',
    };

    try {
      const result: any = await this.http.post(API.startSession, payload).toPromise();
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
    this.http.post(`${API.closeSession}/${sessionId}`, {}).toPromise().catch(() => {});
  }

  // =========================================================================
  // 直连执行
  // =========================================================================

  /**
   * 通过 chatRequest 直连 subagent 执行任务
   *
   * 流程：
   * 1. 将用户消息加入会话历史
   * 2. POST /api/v1/chat/{sessionId}，携带完整消息历史
   * 3. 流式解析 NDJSON 响应，累积 assistant 文本
   * 4. 处理 subagent 内部的工具调用事件（仅记录进度，不在前端执行）
   * 5. 收到 TaskCompleted 或流结束后，返回完整回复
   *
   * 注意：subagent 内部的工具调用由服务端编排执行（internal tools），
   * 前端只负责收集最终文本回复。
   */
  private async chatWithSubagent(
    session: SubagentSession,
    userContent: string,
    toolId: string,
    timeout: number,
  ): Promise<string> {
    // 加入用户消息
    session.messages.push({ role: 'user', content: userContent });

    const token = await this.authService.getToken2();
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const payload = {
      session_id: session.sessionId,
      messages: session.messages,
      tools: [],
      mode: 'agent',
      agent: session.agentName,
    };

    // 带超时的 fetch
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    let response: Response;
    try {
      response = await fetch(`${API.chatRequest}/${session.sessionId}`, {
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

    // 流式读取并解析
    const reader = response.body!.getReader();
    this.activeReaders.set(toolId, reader);
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulatedText = '';

    try {
      while (true) {
        // 检查是否被取消
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
            accumulatedText = this.handleSubagentStreamEvent(
              event,
              session.agentName,
              toolId,
              accumulatedText,
            );
          } catch (e) {
            console.warn(`[SubagentSession] JSON 解析失败:`, line, e);
          }
        }
      }

      // 处理缓冲区剩余
      if (buffer.trim() && !this.abortedToolIds.has(toolId)) {
        try {
          const event = JSON.parse(buffer);
          accumulatedText = this.handleSubagentStreamEvent(
            event,
            session.agentName,
            toolId,
            accumulatedText,
          );
        } catch { }
      }
    } finally {
      clearTimeout(timeoutId);
      this.activeReaders.delete(toolId);
      this.abortedToolIds.delete(toolId);
    }

    // 将 assistant 回复加入会话历史（支持后续复用）
    if (accumulatedText) {
      session.messages.push({ role: 'assistant', content: accumulatedText });
    }

    return accumulatedText || '(subagent 未返回内容)';
  }

  // =========================================================================
  // 流事件处理
  // =========================================================================

  /**
   * 处理 subagent SSE 流中的单个事件
   * @returns 更新后的累积文本
   */
  private handleSubagentStreamEvent(
    event: any,
    agentName: string,
    toolId: string,
    accumulatedText: string,
  ): string {
    switch (event.type) {
      case 'ModelClientStreamingChunkEvent': {
        const content = event.content || '';
        accumulatedText += content;
        // 推送流式进度（节流：每次只发最新累积片段）
        this.emitProgress('streaming', agentName, toolId, content, accumulatedText);
        break;
      }

      case 'tool_call_request': {
        // Subagent 内部工具调用 — 服务端执行，前端只记录进度
        const toolName = event.tool_name || 'unknown';
        this.emitProgress('tool_call', agentName, toolId, `${agentName}: 调用 ${toolName}...`);
        break;
      }

      case 'tool_call_execution': {
        // Subagent 内部工具执行完成
        const execResult = event.is_error ? `执行失败` : '执行完成';
        this.emitProgress('tool_call', agentName, toolId, `${agentName}: ${event.tool_name || ''} ${execResult}`);
        break;
      }

      case 'TaskCompleted': {
        const reason = event.stop_reason || '';
        console.log(`[SubagentSession] ${agentName} TaskCompleted, stop_reason: ${reason}`);
        break;
      }

      case 'error': {
        const errMsg = event.message || event.content || '未知错误';
        console.error(`[SubagentSession] ${agentName} 服务端错误:`, errMsg);
        break;
      }
    }

    return accumulatedText;
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
}
