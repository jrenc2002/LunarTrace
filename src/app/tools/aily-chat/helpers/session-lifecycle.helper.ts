/**
 * SessionLifecycleHelper — 会话生命周期辅助类
 *
 * 负责会话的创建、关闭、保存、历史加载、重连等逻辑。
 */

import type { ChatEngineService } from '../services/chat-engine.service';
import { AilyHost } from '../core/host';
import { markContentAsHistory as _markContentAsHistory } from '../services/content-sanitizer.service';

export class SessionLifecycleHelper {
  constructor(private engine: ChatEngineService) {}

  // ==================== 会话持久化 ====================

  saveCurrentSession(): void {
    if (!this.engine.sessionId || this.engine.list.length === 0) return;
    try {
      const currentPath = AilyHost.get().project.currentProjectPath;
      const rootPath = AilyHost.get().project.projectRootPath;
      const isSameAsRoot = (p: string | null) => {
        if (!p || !rootPath) return false;
        const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        return norm(p) === norm(rootPath);
      };
      const cached = this.engine.chatService.currentSessionPath;
      // 优先使用 cached 但不能是 rootPath，否则回退到实时 currentProjectPath
      let prjPath = (cached && !isSameAsRoot(cached)) ? cached
        : (currentPath && !isSameAsRoot(currentPath) ? currentPath : null);
      const budgetSnapshot = this.engine.contextBudgetService?.getSnapshot();

      // 导出 subagent 会话数据（Plan C 压缩：保留最近 3 轮对话）
      const subagentHistories = this.engine.subagentSessionService.exportSessions(3);

      // 导出 checkpoint 数据用于持久化
      const editCheckpoints = this.engine.editCheckpointService?.getTotalEditCount() > 0
        ? this.engine.editCheckpointService.toJSON()
        : undefined;

      this.engine.chatHistoryService.saveSession(
        this.engine.sessionId, this.engine.list, this.engine.conversationMessages || [],
        {
          sessionId: this.engine.sessionId,
          title: this.engine.sessionTitle || '',
          projectPath: prjPath,
          mode: this.engine.currentMode,
          model: this.engine.currentModel?.model || null,
          contextBudget: budgetSnapshot ? {
            currentTokens: budgetSnapshot.currentTokens,
            maxContextTokens: budgetSnapshot.maxContextTokens,
            usagePercent: budgetSnapshot.usagePercent,
          } : undefined,
          toolCallingIteration: this.engine.toolCallingIteration || 0,
        },
        Object.keys(subagentHistories).length > 0 ? subagentHistories : undefined,
        editCheckpoints,
      );
      this.refreshHistoryList();
    } catch (error) { console.warn('保存会话失败:', error); }
  }

  refreshHistoryList(): void {
    const historyActions = [
      { icon: 'fa-light fa-pen', action: 'rename-history', title: '重命名' },
      { icon: 'fa-light fa-trash', action: 'delete-history', title: '删除' },
    ];
    const entries = this.engine.chatHistoryService.getHistoryList('current-project',
      AilyHost.get().project.currentProjectPath || AilyHost.get().project.projectRootPath,
      AilyHost.get().project.projectRootPath
    );
    this.engine.menuManager.historyList = entries.map(e => ({
      sessionId: e.sessionId,
      name: e.title || 'q' + e.createdAt,
      actions: historyActions,
      current: e.sessionId === this.engine.sessionId,
    }));
  }

  // ==================== 会话启动 ====================

  async startSession(): Promise<void> {
    if (this.engine.debug) {
      this.engine.sessionId = new Date().getTime().toString();
      this.engine.isWaiting = true;
      this.engine.stream.streamConnect();
      return;
    }
    if (this.engine.isSessionStarting) return Promise.resolve();
    this.engine.isSessionStarting = true;
    this.engine.isCancelled = false;

    if (this.engine.useStatelessMode) {
      this.engine.conversationMessages = [];
      this.engine.pendingToolResults = [];
      this.engine.currentTurnAssistantContent = '';
      this.engine.currentTurnToolCalls = [];
      this.engine.toolCallingIteration = 0;
      this.engine.contextBudgetService.reset();
      this.engine.subagentSessionService.cleanupAll();
    }
    this.engine.sessionAllowedPaths = [];
    this.engine.repetitionDetectionService.resetAll();
    this.engine.insideThink = false;
    this.engine.rulesInjectedThisSession = false;
    this.engine.activatedDeferredTools.clear();

    if (!this.engine.mcpInitialized) {
      this.engine.mcpInitialized = true;
      await this.engine.mcpService.init();
      AilyHost.get().config.loadHardwareIndexForAI?.().catch(err => { console.warn('[AilyChat] 加载硬件索引失败:', err); });
    }

    this.engine.isCompleted = false;
    const mainAgentConfig = this.engine.ailyChatConfigService.getAgentToolsConfig('mainAgent');
    const schematicAgentConfig = this.engine.ailyChatConfigService.getAgentToolsConfig('schematicAgent');
    const enabledToolNames = [...(mainAgentConfig?.enabledTools || []), ...(schematicAgentConfig?.enabledTools || [])];
    const disabledToolNames = [...(mainAgentConfig?.disabledTools || []), ...(schematicAgentConfig?.disabledTools || [])];
    const hasEnabledToolsConfig = enabledToolNames.length > 0;

    let tools = hasEnabledToolsConfig
      ? this.engine.tools.filter(tool => enabledToolNames.includes(tool.name) || (!disabledToolNames.includes(tool.name) && !enabledToolNames.includes(tool.name)))
      : this.engine.tools;

    let mcpTools = this.engine.mcpService.tools.map(tool => {
      if (!tool.name.startsWith('mcp_')) { tool.name = 'mcp_' + tool.name; }
      return tool;
    });
    if (mcpTools && mcpTools.length > 0) { tools = tools.concat(mcpTools); }

    const maxCount = this.engine.ailyChatConfigService.maxCount;

    let customllmConfig;
    if (this.engine.currentModel && this.engine.currentModel.baseUrl && this.engine.currentModel.apiKey) {
      customllmConfig = { apiKey: this.engine.currentModel.apiKey, baseUrl: this.engine.currentModel.baseUrl };
    } else if (this.engine.ailyChatConfigService.useCustomApiKey) {
      customllmConfig = { apiKey: this.engine.ailyChatConfigService.apiKey, baseUrl: this.engine.ailyChatConfigService.baseUrl };
    } else {
      customllmConfig = null;
    }
    const selectModel = this.engine.currentModel?.model || null;

    return new Promise<void>((resolve, reject) => {
      this.engine.chatService.startSession(this.engine.currentMode, tools, maxCount, customllmConfig, selectModel).subscribe({
        next: (res: any) => {
          if (res.status === 'success') {
            if (res.data != this.engine.sessionId) {
              this.engine.chatService.currentSessionId = res.data;
              this.engine.chatService.currentSessionTitle = '';
              const _curPath = AilyHost.get().project.currentProjectPath;
              const _rootPath = AilyHost.get().project.projectRootPath;
              this.engine.chatService.currentSessionPath = (_curPath && _curPath !== _rootPath) ? _curPath : '';
            }
            if (!this.engine.useStatelessMode) { this.engine.stream.streamConnect(); }
            this.engine.isSessionStarting = false;
            this.engine.serverSessionActive = true;
            this.engine.contextBudgetService.updateBudget(this.engine.conversationMessages, this.engine.turnLoop.getCurrentTools());

            // 从 startSession 响应直接获取系统提示词 token 数（无需额外 HTTP 请求）
            if (res.system_tokens != null) {
              this.engine.contextBudgetService.updateSystemPromptTokens(res.system_tokens);
              this.engine.contextBudgetService.updateBudget(
                this.engine.conversationMessages, this.engine.turnLoop.getCurrentTools()
              );
              console.log(`[ContextBudget] 系统提示词 token 已同步: system=${res.system_tokens}`);
            }

            if (this.engine.list.length === 0) { this.engine.list = []; }
            resolve();
          } else {
            if (res?.data === 401) { this.engine.message.error(res.message); }
            else {
              this.engine.msg.appendMessage('aily', `\n\`\`\`aily-error\n${JSON.stringify({ message: res.message || '启动会话失败，请稍后重试。' })}\n\`\`\`\n\n`);
            }
            this.engine.isSessionStarting = false;
            reject(res.message || '启动会话失败');
          }
        },
        error: (err) => {
          console.warn('启动会话失败:', err);
          this.engine.msg.appendMessage('aily', `\n\`\`\`aily-error\n${JSON.stringify({ status: err.status, message: err.message })}\n\`\`\`\n\n`);
          this.engine.isSessionStarting = false;
          reject(err);
        }
      });
    });
  }

  async ensureServerSession(): Promise<void> {
    const savedMessages = [...this.engine.conversationMessages];
    const savedIteration = this.engine.toolCallingIteration;
    const savedTitle = this.engine.chatService.currentSessionTitle;
    const savedPath = this.engine.chatService.currentSessionPath;
    const savedList = [...this.engine.list];
    const oldSessionId = this.engine.sessionId;
    try { await this.startSession(); } catch (err) {
      console.warn('[AilyChat] 重新注册服务端会话失败:', err);
      this.engine.conversationMessages = savedMessages;
      this.engine.toolCallingIteration = savedIteration;
      this.engine.list = savedList;
      throw err;
    }
    this.engine.conversationMessages = savedMessages;
    this.engine.toolCallingIteration = savedIteration;
    this.engine.chatService.currentSessionTitle = savedTitle;
    this.engine.chatService.currentSessionPath = savedPath;
    this.engine.list = savedList;
    const newSessionId = this.engine.sessionId;
    if (oldSessionId && newSessionId && oldSessionId !== newSessionId) {
      this.engine.chatHistoryService.migrateSessionId(oldSessionId, newSessionId);
    }
  }

  closeSession(): void {
    if (!this.engine.sessionId) return;
    this.engine.chatService.closeSession(this.engine.sessionId).subscribe(() => {});
  }

  async disconnect(): Promise<void> {
    try {
      if (this.engine.sessionId) {
        await new Promise<void>((resolve) => {
          this.engine.chatService.cancelTask(this.engine.sessionId).subscribe({ next: () => resolve(), error: () => resolve() });
        });
        await new Promise<void>((resolve) => {
          this.engine.chatService.closeSession(this.engine.sessionId).subscribe({ next: () => resolve(), error: () => resolve() });
        });
      }
    } catch (error) { console.warn('关闭会话过程中出错:', error); }
  }

  async stopAndCloseSession(skipSave: boolean = false): Promise<void> {
    if (!skipSave) { this.saveCurrentSession(); }
    try {
      await new Promise<void>((resolve) => {
        if (!this.engine.sessionId) { resolve(); return; }
        const timeout = setTimeout(() => { console.warn('停止会话超时，继续执行'); resolve(); }, 5000);
        this.engine.chatService.stopSession(this.engine.sessionId).subscribe({
          next: () => { clearTimeout(timeout); this.engine.isWaiting = false; resolve(); },
          error: (err) => { clearTimeout(timeout); console.warn('停止会话失败:', err); resolve(); }
        });
      });
      await new Promise<void>((resolve) => {
        if (!this.engine.sessionId) { resolve(); return; }
        const timeout = setTimeout(() => { resolve(); }, 5000);
        this.engine.chatService.closeSession(this.engine.sessionId).subscribe({
          next: () => { clearTimeout(timeout); resolve(); },
          error: (err) => { clearTimeout(timeout); console.warn('关闭会话失败:', err); resolve(); }
        });
      });
    } catch (error) { console.warn('停止和关闭会话失败:', error); throw error; }
  }

  // ==================== 新建 / 历史 ====================

  async newChat(): Promise<void> {
    if (this.engine.isWaiting) {
      this.engine.message.warning(this.engine.translate.instant('AILY_CHAT.STOP_CURRENT_SESSION_FIRST') || '请先停止当前会话，再新建');
      return;
    }
    if (this.engine.isSessionStarting) return;
    this.saveCurrentSession();
    this.engine.list = [];
    this.engine.scrollManager.autoScrollEnabled = true;
    this.engine.isCompleted = false;
    this.engine.isCancelled = true;
    this.engine.editCheckpointService.clear();
    if (this.engine.messageSubscription) { this.engine.messageSubscription.unsubscribe(); this.engine.messageSubscription = null; }
    this.engine.activeToolExecutions = 0;
    this.engine.sseStreamCompleted = false;
    try {
      await this.stopAndCloseSession(true);
      this.engine.chatService.currentSessionId = '';
      this.engine.chatService.currentSessionTitle = '';
      this.engine.chatService.currentSessionPath = '';
      this.engine.isSessionStarting = false;
      this.engine.hasInitializedForThisLogin = false;
      await new Promise(resolve => setTimeout(resolve, 100));
      await this.startSession();
    } catch (error) {
      console.warn('新会话启动失败:', error);
      this.engine.isSessionStarting = false;
    }
  }

  getHistory(): void {
    if (!this.engine.sessionId) return;
    this.engine.list = [];
    this.engine.conversationMessages = [];
    this.engine.toolCallingIteration = 0;
    this.engine.contextBudgetService?.reset();
    const currentPrjPath = AilyHost.get().project.currentProjectPath || AilyHost.get().project.projectRootPath;
    const sessionData = this.engine.chatHistoryService.loadSession(this.engine.sessionId, currentPrjPath);
    if (sessionData && sessionData.chatList && sessionData.chatList.length > 0) {
      this.engine.list = sessionData.chatList.map(item => {
        if (item.content && typeof item.content === 'string') {
          return { ...item, content: _markContentAsHistory(item.content) };
        }
        return item;
      });
      if (sessionData.metadata?.title) {
        this.engine.chatService.currentSessionTitle = sessionData.metadata.title;
      } else {
        const indexEntry = this.engine.chatHistoryService.findEntry(this.engine.sessionId);
        if (indexEntry?.title) { this.engine.chatService.currentSessionTitle = indexEntry.title; }
      }
      if (sessionData.conversationMessages && sessionData.conversationMessages.length > 0) {
        this.engine.conversationMessages = sessionData.conversationMessages;
        this.engine.toolCallingIteration = sessionData.metadata?.toolCallingIteration || 0;
        this.engine.contextBudgetService?.updateBudget(this.engine.conversationMessages, this.engine.turnLoop.getCurrentTools());
      } else {
        this.engine.contextBudgetService?.updateBudget([], this.engine.turnLoop.getCurrentTools());
      }

      // 恢复 subagent 会话历史
      if (sessionData.subagentHistories) {
        this.engine.subagentSessionService.importSessions(sessionData.subagentHistories);
      }

      // 恢复文件变更 checkpoint
      if (sessionData.editCheckpoints) {
        this.engine.editCheckpointService?.restoreFromJSON(sessionData.editCheckpoints);
      }

      this.engine.scrollManager.scrollToBottom('auto');
    }
  }

  resetChat(): Promise<void> { return this.startSession(); }
}
