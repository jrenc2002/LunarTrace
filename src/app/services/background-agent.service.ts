/**
 * BackgroundAgentService - 后台 Agent 服务
 *
 * 对接服务端 SubAgent 直连模式：
 * - 通过 start_session({ agent: "schematicAgent" }) 创建独立会话
 * - 独立管理 sessionId，不影响 ChatService 的用户对话
 * - 本地执行工具，回传结果给服务端
 * - 通过 IPC 推送进度到连线图子窗口
 *
 * @see autogen-subagent-direct-connect.md
 */

import { Injectable, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subject, Observable, Subscription } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { API } from '../configs/api.config';
import { AuthService } from './auth.service';
import { ProjectService } from './project.service';
import { ConnectionGraphService } from './connection-graph.service';
import { ElectronService } from './electron.service';
import { TOOLS, ToolUseResult } from '../tools/aily-chat/tools/tools';
import { createSecurityContext } from '../tools/aily-chat/services/security.service';

// 工具函数导入 — 连线图专属
import {
  generateConnectionGraphTool,
  getPinmapSummaryTool,
  validateConnectionGraphTool,
  getSensorPinmapCatalogTool,
  generatePinmapTool,
  savePinmapTool,
  getCurrentSchematicTool,
  applySchematicTool
} from '../tools/aily-chat/tools/connectionGraphTool';

// 工具函数导入 — 共享工具
import { getContextTool } from '../tools/aily-chat/tools/getContextTool';
import { getProjectInfoTool } from '../tools/aily-chat/tools/getProjectInfoTool';
import { readFileTool } from '../tools/aily-chat/tools/readFileTool';
import { createFileTool } from '../tools/aily-chat/tools/createFileTool';
import { editFileTool } from '../tools/aily-chat/tools/editFileTool';
import { deleteFileTool } from '../tools/aily-chat/tools/deleteFileTool';
import { deleteFolderTool } from '../tools/aily-chat/tools/deleteFolderTool';
import { createFolderTool } from '../tools/aily-chat/tools/createFolderTool';
import { listDirectoryTool } from '../tools/aily-chat/tools/listDirectoryTool';
import { getDirectoryTreeTool } from '../tools/aily-chat/tools/getDirectoryTreeTool';
import { grepTool } from '../tools/aily-chat/tools/grepTool';
import globTool from '../tools/aily-chat/tools/globTool';
import { getBoardParametersTool } from '../tools/aily-chat/tools/getBoardParametersTool';
import { fetchTool, FetchToolService } from '../tools/aily-chat/tools/fetchTool';
import { ChatService } from '../tools/aily-chat/services/chat.service';

// ===== 类型定义 =====

export type ProgressEventType =
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'text'
  | 'complete'
  | 'error';

export interface ProgressEvent {
  type: ProgressEventType;
  content: string;
  toolName?: string;
  timestamp: number;
  data?: any;
}

export type BackgroundAgentStatus = 'idle' | 'running' | 'completed' | 'error';

/** 工具显示名称映射 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  'get_pinmap_summary': '获取引脚信息',
  'generate_schematic': '生成连线方案',
  'validate_schematic': '验证连线配置',
  'get_component_catalog': '获取组件目录',
  'generate_pinmap': '生成引脚图',
  'save_pinmap': '保存引脚图',
  'get_current_schematic': '获取当前电路图',
  'apply_schematic': '应用电路方案',
  'get_context': '获取上下文',
  'get_project_info': '获取项目信息',
  'read_file': '读取文件',
  'create_file': '创建文件',
  'edit_file': '编辑文件',
  'delete_file': '删除文件',
  'delete_folder': '删除文件夹',
  'create_folder': '创建文件夹',
  'list_directory': '列出目录',
  'get_directory_tree': '获取目录树',
  'grep_tool': '搜索内容',
  'glob_tool': '搜索文件',
  'get_board_parameters': '获取开发板参数',
  'fetch': '获取网页',
};

@Injectable({
  providedIn: 'root'
})
export class BackgroundAgentService implements OnDestroy {
  // ===== 状态 =====
  private sessionId: string | null = null;
  private progress$ = new Subject<ProgressEvent>();
  private status: BackgroundAgentStatus = 'idle';
  private aborted = false;
  private streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  // ===== 依赖 =====
  private fetchToolService: FetchToolService;

  constructor(
    private http: HttpClient,
    private authService: AuthService,
    private projectService: ProjectService,
    private connectionGraphService: ConnectionGraphService,
    private electronService: ElectronService,
  ) {
    this.fetchToolService = new FetchToolService(this.http);
    this.setupIpcListeners();
    console.log('[BackgroundAgent] 服务初始化');
  }

  ngOnDestroy(): void {
    this.cancel();
  }

  // =========================================================================
  // 公共 API
  // =========================================================================

  /** 当前状态 */
  get currentStatus(): BackgroundAgentStatus {
    return this.status;
  }

  /** 是否正在运行 */
  get isRunning(): boolean {
    return this.status === 'running';
  }

  /** 进度事件流 */
  onProgress(): Observable<ProgressEvent> {
    return this.progress$.asObservable();
  }

  /**
   * 启动连线图生成任务
   * 完整流程：创建会话 → 发送提示词 → 监听流 → 执行工具 → 完成
   */
  async generateSchematic(): Promise<void> {
    if (this.isRunning) {
      console.warn('[BackgroundAgent] 任务已在运行中');
      return;
    }

    this.status = 'running';
    this.aborted = false;

    try {
      // 1. 创建独立会话
      this.sessionId = uuidv4();
      const tools = this.getSchematicTools();
      await this.startSession(tools);
      console.log('[BackgroundAgent] 会话已创建:', this.sessionId);

      // 2. 构建带项目上下文的提示词
      const prompt = await this.buildGenerationPrompt();

      // 3. 发送消息
      await this.sendMessage(prompt, 'user');
      console.log('[BackgroundAgent] 提示词已发送');

      // 4. 连接流并处理
      await this.processStream();

      // 5. 完成
      if (!this.aborted) {
        this.status = 'completed';
        this.emitProgress('complete', '连线图生成完成');
      }
    } catch (error: any) {
      if (!this.aborted) {
        this.status = 'error';
        this.emitProgress('error', error.message || '连线图生成失败');
        console.error('[BackgroundAgent] 生成失败:', error);
      }
    }
  }

  /**
   * 取消当前任务
   */
  async cancel(): Promise<void> {
    this.aborted = true;

    // 关闭流
    if (this.streamReader) {
      try { await this.streamReader.cancel(); } catch { }
      this.streamReader = null;
    }

    // 关闭服务端会话
    if (this.sessionId) {
      try {
        await this.http.post(`${API.closeSession}/${this.sessionId}`, {}).toPromise();
      } catch { }
    }

    this.status = 'idle';
    this.sessionId = null;
  }

  // =========================================================================
  // IPC 监听（来自连线图子窗口的请求）
  // =========================================================================

  private setupIpcListeners(): void {
    if (!this.electronService.isElectron || !window['ipcRenderer']) return;

    window['ipcRenderer'].on('schematic-regenerate-request', () => {
      console.log('[BackgroundAgent] 收到重新生成请求');
      this.generateSchematic();
    });

    window['ipcRenderer'].on('schematic-sync-to-code-request', () => {
      console.log('[BackgroundAgent] 收到同步到代码请求');
      this.handleSyncToCodeRequest();
    });
  }

  // =========================================================================
  // 会话管理（独立于 ChatService）
  // =========================================================================

  /**
   * 创建 schematicAgent 直连会话
   * POST /api/v1/start_session { agent: "schematicAgent", ... }
   */
  private async startSession(tools: any[]): Promise<void> {
    const payload: any = {
      session_id: this.sessionId,
      agent: 'schematicAgent',  // ← 直连 subAgent
      tools,
      mode: 'agent',
    };

    const result: any = await this.http.post(API.startSession, payload).toPromise();
    if (result?.status !== 'success') {
      throw new Error(result?.message || '创建会话失败');
    }
  }

  /**
   * 发送消息
   * POST /api/v1/send_message/{sessionId}
   */
  private async sendMessage(content: string, source: string = 'user'): Promise<void> {
    await this.http.post(`${API.sendMessage}/${this.sessionId}`, { content, source }).toPromise();
  }

  /**
   * 流式连接并处理事件
   * GET /api/v1/stream/{sessionId}（HTTP Streaming + NDJSON）
   */
  private async processStream(): Promise<void> {
    const token = await this.authService.getToken2();
    const headers: HeadersInit = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${API.streamConnect}/${this.sessionId}`, { headers });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    this.streamReader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (!this.aborted) {
        const { value, done } = await this.streamReader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (this.aborted) break;
          if (!line.trim()) continue;

          try {
            const event = JSON.parse(line);
            await this.handleStreamEvent(event);
          } catch (e) {
            console.warn('[BackgroundAgent] JSON 解析失败:', e);
          }
        }
      }

      // 处理缓冲区剩余
      if (!this.aborted && buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          await this.handleStreamEvent(event);
        } catch { }
      }
    } finally {
      this.streamReader = null;
    }
  }

  // =========================================================================
  // 流事件处理
  // =========================================================================

  /**
   * 处理单个流事件
   */
  private async handleStreamEvent(event: any): Promise<void> {
    switch (event.type) {
      case 'ModelClientStreamingChunkEvent': {
        const content = event.content || '';
        // 检测 <think> 标签
        if (content.includes('<think>') || content.includes('</think>')) {
          this.emitProgress('thinking', '正在分析项目...');
        }
        break;
      }

      case 'tool_call_request': {
        await this.handleToolCallRequest(event);
        break;
      }

      case 'ToolCallExecutionEvent': {
        // 服务端通知工具执行情况（可选处理）
        break;
      }

      case 'TaskCompleted': {
        const reason = event.stop_reason || event.data?.stop_reason;
        if (reason === 'error') {
          this.emitProgress('error', '任务异常结束');
        }
        break;
      }

      case 'error': {
        this.emitProgress('error', event.message || event.content || '服务端错误');
        break;
      }
    }
  }

  // =========================================================================
  // 工具调用处理
  // =========================================================================

  /**
   * 处理 tool_call_request：本地执行工具 → 回传结果
   */
  private async handleToolCallRequest(event: any): Promise<void> {
    const toolName = event.tool_name;
    const toolId = event.tool_id;
    let toolArgs: any;

    // 解析参数
    try {
      toolArgs = typeof event.tool_args === 'string'
        ? JSON.parse(event.tool_args)
        : event.tool_args || {};
    } catch {
      await this.sendToolResult(toolId, { is_error: true, content: '参数解析失败' });
      return;
    }

    // 推送进度
    const displayName = TOOL_DISPLAY_NAMES[toolName] || toolName;
    this.emitProgress('tool_call', `正在${displayName}...`, toolName);

    // 执行工具
    let result: ToolUseResult;
    try {
      result = await this.executeTool(toolName, toolArgs);
    } catch (error: any) {
      result = { is_error: true, content: `工具执行异常: ${error.message}` };
    }

    // 推送工具结果
    this.emitProgress('tool_result', result.is_error ? `${displayName}失败` : `${displayName}完成`, toolName);

    // 回传结果给服务端
    await this.sendToolResult(toolId, result);
  }

  /**
   * 路由工具调用到具体的处理函数
   */
  private async executeTool(toolName: string, args: any): Promise<ToolUseResult> {
    const secCtx = createSecurityContext(this.projectService.currentProjectPath || '');

    switch (toolName) {
      // ===== 连线图专属工具 =====
      case 'generate_schematic':
        return generateConnectionGraphTool(this.connectionGraphService, this.projectService, args);
      case 'get_pinmap_summary':
        return getPinmapSummaryTool(this.connectionGraphService, this.projectService, args);
      case 'get_component_catalog':
        return getSensorPinmapCatalogTool(this.connectionGraphService, this.projectService, args);
      case 'validate_schematic':
        return validateConnectionGraphTool(this.connectionGraphService, this.projectService, args);
      case 'apply_schematic':
        return applySchematicTool(this.connectionGraphService, this.projectService, args);
      case 'get_current_schematic':
        return getCurrentSchematicTool(this.connectionGraphService, this.projectService, args);
      case 'generate_pinmap':
        return generatePinmapTool(this.connectionGraphService, this.projectService, args);
      case 'save_pinmap':
        return savePinmapTool(this.connectionGraphService, this.projectService, args);

      // ===== 共享工具 =====
      case 'get_context':
        return getContextTool(this.projectService, args);
      case 'get_project_info':
        return getProjectInfoTool(this.projectService, args);
      case 'read_file':
        return readFileTool(args, secCtx);
      case 'create_file':
        return createFileTool(args, secCtx);
      case 'edit_file':
        return editFileTool(args);
      case 'delete_file':
        return deleteFileTool(args, secCtx);
      case 'delete_folder':
        return deleteFolderTool(args, secCtx);
      case 'create_folder':
        return createFolderTool(args);
      case 'list_directory':
        return listDirectoryTool(args);
      case 'get_directory_tree':
        return getDirectoryTreeTool(args);
      case 'grep_tool':
        return grepTool(args);
      case 'glob_tool':
        return globTool(args);
      case 'get_board_parameters':
        return getBoardParametersTool.handler(this.projectService, args);
      case 'fetch':
        return fetchTool(this.fetchToolService, args);

      default:
        return { is_error: true, content: `后台 Agent 不支持工具: ${toolName}` };
    }
  }

  /**
   * 回传工具执行结果给服务端
   * POST /api/v1/send_message/{sessionId} (source: "tool")
   */
  private async sendToolResult(toolId: string, result: ToolUseResult): Promise<void> {
    const content = JSON.stringify({
      type: 'tool',
      tool_id: toolId,
      content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
      is_error: result.is_error || false,
    });

    try {
      await this.sendMessage(content, 'tool');
    } catch (error) {
      console.error('[BackgroundAgent] 回传工具结果失败:', error);
    }
  }

  // =========================================================================
  // 工具定义
  // =========================================================================

  /**
   * 获取 schematicAgent 可用的工具列表
   * 从 TOOLS 中按 agents 字段过滤
   */
  private getSchematicTools(): any[] {
    return (TOOLS as any[]).filter(tool => {
      if (!tool.agents) return false;
      return tool.agents.includes('schematicAgent');
    });
  }

  // =========================================================================
  // 提示词构建
  // =========================================================================

  /**
   * 构建生成连线图的提示词，附带项目代码上下文
   */
  private async buildGenerationPrompt(): Promise<string> {
    let contextInfo = '';

    try {
      // 获取项目上下文
      const ctxResult = await getContextTool(this.projectService, { info_type: 'project' });
      if (!ctxResult.is_error) {
        contextInfo += `\n## 项目上下文\n${ctxResult.content}\n`;
      }

      // 获取项目目录树
      const projectPath = this.projectService.currentProjectPath;
      if (projectPath) {
        const treeResult = await getDirectoryTreeTool({ path: projectPath, maxDepth: 2 });
        if (!treeResult.is_error) {
          contextInfo += `\n## 项目目录结构\n${treeResult.content}\n`;
        }

        // 尝试读取主要代码文件（如 project.abs 或 main.ino）
        const mainFiles = ['project.abs', 'src/main.ino', 'src/main.cpp', 'main.ino'];
        for (const file of mainFiles) {
          const filePath = window['path']?.join(projectPath, file);
          if (filePath && this.electronService.exists(filePath)) {
            const fileResult = await readFileTool({ path: filePath }, createSecurityContext(projectPath));
            if (!fileResult.is_error) {
              contextInfo += `\n## 项目代码 (${file})\n\`\`\`\n${fileResult.content}\n\`\`\`\n`;
            }
            break; // 只读取第一个找到的主文件
          }
        }
      }
    } catch (e) {
      console.warn('[BackgroundAgent] 收集项目上下文失败:', e);
    }

    return `请分析当前项目的代码，自动生成对应的硬件连线图（电路连线方案）。

${contextInfo}

## 要求
1. 根据代码中使用的传感器/模块，确定需要的硬件组件
2. 查询各组件的引脚信息
3. 生成合理的连线方案
4. 验证连线配置的正确性
5. 应用连线方案到项目中

请开始分析并生成连线图。`;
  }

  // =========================================================================
  // "同步到代码" 处理
  // =========================================================================

  /**
   * 处理"同步到代码"请求
   * 将预设提示词发送到 aily-chat 输入框并自动发送
   */
  private handleSyncToCodeRequest(): void {
    const connectionData = this.connectionGraphService.getConnectionGraph();
    if (!connectionData) {
      console.warn('[BackgroundAgent] 同步到代码: 无连线图数据');
      return;
    }

    const componentSummary = (connectionData.components || [])
      .map((c: any) => `- ${c.title || c.refId || c.id}`)
      .join('\n');

    const prompt = `请根据当前连线图方案，将硬件连线配置同步到项目代码中。

## 当前连线组件
${componentSummary}

## 连线数量
${(connectionData.connections || []).length} 条连线

请分析连线图，在代码中添加或修改对应的传感器初始化和引脚配置代码。`;

    // 通过 ChatService 静态方法发送到 aily-chat 并自动发送
    ChatService.sendToChat(prompt, { cover: true, autoSend: true });
  }

  // =========================================================================
  // 进度推送
  // =========================================================================

  /**
   * 发出进度事件 → Subject + IPC 双通道
   */
  private emitProgress(type: ProgressEventType, content: string, toolName?: string, data?: any): void {
    const event: ProgressEvent = {
      type,
      content,
      toolName,
      timestamp: Date.now(),
      data,
    };

    // RxJS Subject（供主窗口内组件订阅）
    this.progress$.next(event);

    // IPC 推送到连线图子窗口
    if (this.electronService.isElectron && window['ipcRenderer']) {
      window['ipcRenderer'].send('schematic-generation-progress', event);
    }
  }
}
