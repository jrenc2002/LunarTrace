/**
 * ChatEngineService — aily-chat 核心业务逻辑引擎
 *
 * 从 AilyChatComponent 中提取的全部业务逻辑、副作用和共享状态。
 * Component 仅保留 Angular 生命周期、模板绑定和 UI 事件处理器。
 *
 * 职责：
 * - 会话生命周期管理（start / stop / close / new / history）
 * - 消息发送与工具调用循环（stateless turn loop）
 * - SSE 流处理与事件分发
 * - 订阅管理（项目路径、登录状态、配置变更等）
 */

import { Injectable, ElementRef } from '@angular/core';
import { Subscription, skip, distinctUntilChanged, combineLatest } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { NzMessageService } from 'ng-zorro-antd/message';

import { ChatService, ChatTextOptions, ModelConfig } from './chat.service';
import { McpService } from './mcp.service';
import { AilyChatConfigService } from './aily-chat-config.service';
import { ChatHistoryService } from './chat-history.service';
import { RepetitionDetectionService } from './repetition-detection.service';
import { ContextBudgetService, ContextBudgetSnapshot } from './context-budget.service';
import { SubagentSessionService, SubagentProgressEvent } from './subagent-session.service';
import { AbsAutoSyncService } from './abs-auto-sync.service';
import { ScrollManagerService } from './scroll-manager.service';
import { ResourceManagerService } from './resource-manager.service';
import { MenuManagerService } from './menu-manager.service';

import { ChatMessage, Tool, ToolCallState } from '../core/chat-types';
import { AilyHost } from '../core/host';
import { ToolRegistry } from '../core/tool-registry';
import { createSecurityContext } from './security.service';
import { TOOLS } from '../tools/tools';
import { registerAskUserCallback, unregisterAskUserCallback, AskUserResponse } from '../tools/askUserTool';
import { cleanupAllTerminalSessions } from '../tools/terminalSessionTool';

import { AILY_CHAT_ONBOARDING_CONFIG } from '../../../configs/onboarding.config';

import { MessageDisplayHelper } from '../helpers/message-display.helper';
import { SessionLifecycleHelper } from '../helpers/session-lifecycle.helper';
import { StreamProcessorHelper } from '../helpers/stream-processor.helper';
import { ToolCallLoopHelper } from '../helpers/tool-call-loop.helper';

@Injectable()
export class ChatEngineService {

  // ==================== 辅助类 ====================
  readonly msg = new MessageDisplayHelper(this);
  readonly session = new SessionLifecycleHelper(this);
  readonly stream = new StreamProcessorHelper(this);
  readonly turnLoop = new ToolCallLoopHelper(this);

  // ==================== 公共状态（模板绑定） ====================
  list: ChatMessage[] = [];
  inputValue = '';
  prjRootPath = '';
  prjPath = '';
  currentUserGroup: string[] = [];
  isCompleted = false;
  isLoggedIn = false;
  debug = false;

  // ==================== 半公共状态 ====================
  sessionAllowedPaths: string[] = [];
  currentMessageSource: string = 'mainAgent';
  terminateTemp = '';
  toolCallStates: { [key: string]: string } = {};

  // ==================== 内置工具 ====================
  tools: Tool[] = TOOLS;

  // ==================== 内部状态（helper 可访问） ====================
  isSessionStarting = false;
  hasInitializedForThisLogin = false;
  isCancelled = false;
  useStatelessMode = true;
  conversationMessages: any[] = [];
  pendingToolResults: any[] = [];
  currentTurnAssistantContent = '';
  currentTurnToolCalls: any[] = [];
  toolCallingIteration = 0;
  activeToolExecutions = 0;
  sseStreamCompleted = false;
  currentStatelessMode = false;
  serverSessionActive = false;

  setServerSessionInactive() { this.serverSessionActive = false; }
  pendingUserInput = false;
  streamCompleted = false;
  private _isWaiting = false;
  insideThink = false;
  mcpInitialized = false;
  private _aiNoticeShown = false;
  lastStopReason = '';
  /** 会话级标记：规则/角色提示词是否已注入（仅首次工具调用时注入） */
  rulesInjectedThisSession = false;
  /** 会话级：已激活的 deferred 工具名称集合（通过 search_available_tools 加载） */
  activatedDeferredTools = new Set<string>();

  /** 延迟切换：活跃请求期间暂存待切换的模型/模式，完成后自动应用 */
  _pendingModelSwitch: ModelConfig | null = null;
  _pendingModeSwitch: string | null = null;

  /** autoSend 消息在 sessionId 未就绪时的暂存区，startSession 完成后自动冲刷 */
  private _pendingAutoSendText: string | null = null;

  /** ask_user 工具的 Promise resolve 回调（等待用户在聊天界面输入） */
  _resolveAskUser: ((response: AskUserResponse | undefined) => void) | null = null;

  // ==================== 订阅 ====================
  messageSubscription: any;
  private textMessageSubscription: Subscription;
  private loginStatusSubscription: Subscription;
  private aiWritingSubscription: Subscription;
  private aiWaitingSubscription: Subscription;
  private projectPathSubscription: Subscription;
  private configChangedSubscription: Subscription;
  private blockSelectionSubscription: Subscription;
  private subagentProgressSubscription: Subscription;
  private uiChatMessageSubscription: Subscription;
  private taskActionHandler: ((event: Event) => void) | null = null;

  // ==================== 外部引用 ====================
  private chatTextareaRef: ElementRef | null = null;

  // ==================== Getters / Setters ====================

  get sessionId() { return this.chatService.currentSessionId; }
  set sessionId(value: string) { this.chatService.currentSessionId = value; }

  get sessionTitle() { return this.chatService.currentSessionTitle; }

  get currentMode() { return this.chatService.currentMode; }

  get currentModel() { return this.chatService.currentModel; }

  get currentModelName() { return this.chatService.currentModel?.name; }

  get isWaiting() { return this._isWaiting; }
  set isWaiting(value: boolean) {
    this._isWaiting = value;
    this.chatService.isWaiting = value;
    AilyHost.get().blockly.aiWaiting = value;
    if (!value) {
      this.aiWriting = false;
      AilyHost.get().blockly.aiWaitWriting = false;
    }
  }

  set aiWriting(value: boolean) {
    AilyHost.get().blockly.aiWriting = value;
  }

  get contextBudget$() { return this.contextBudgetService?.budget$; }

  get contextBudgetSnapshot(): ContextBudgetSnapshot | null {
    return this.contextBudgetService?.getSnapshot() ?? null;
  }

  // ==================== 构造函数 ====================

  constructor(
    public chatService: ChatService,
    public mcpService: McpService,
    public ailyChatConfigService: AilyChatConfigService,
    public chatHistoryService: ChatHistoryService,
    public repetitionDetectionService: RepetitionDetectionService,
    public contextBudgetService: ContextBudgetService,
    public subagentSessionService: SubagentSessionService,
    private absAutoSyncService: AbsAutoSyncService,
    public translate: TranslateService,
    public message: NzMessageService,
    public scrollManager: ScrollManagerService,
    public resourceManager: ResourceManagerService,
    public menuManager: MenuManagerService,
  ) {}

  // ==================== 初始化 / 销毁 ====================

  /**
   * 引擎初始化 — 由 Component 的 ngOnInit 调用
   * @param chatTextareaRef 输入框 ElementRef（用于自动聚焦）
   */
  init(chatTextareaRef: ElementRef | null): void {
    this.chatTextareaRef = chatTextareaRef;
    this.chatService.isWaiting = this._isWaiting;

    this.prjPath = AilyHost.get().project.currentProjectPath === AilyHost.get().project.projectRootPath
      ? '' : AilyHost.get().project.currentProjectPath;
    this.prjRootPath = AilyHost.get().project.projectRootPath;

    // 注册 ask_user 回调：在聊天界面显示问题并等待用户回答
    registerAskUserCallback((question, choices, allowFreeform) => this._handleAskUser(question, choices, allowFreeform));

    this.setupSubscriptions();
  }

  /**
   * 引擎销毁 — 由 Component 的 ngOnDestroy 调用
   */
  destroy(): void {
    this.chatService.isWaiting = false;
    this.session.saveCurrentSession();
    this.chatHistoryService.flushAll();

    unregisterAskUserCallback();
    cleanupAllTerminalSessions();
    this._resolveAskUser = null;

    this.cleanupSubscriptions();
    this.session.disconnect();

    if (this.list.length > 0 && this.list[this.list.length - 1].role === 'aily') {
      this.list[this.list.length - 1].state = 'done';
    }
  }

  // ==================== 订阅管理 ====================

  private setupSubscriptions(): void {
    // 订阅外部文本消息（ChatService 内部 Subject）
    this.textMessageSubscription = this.chatService.getTextMessages().subscribe(
      message => {
        this.receiveTextFromExternal(message.text, message.options);
      }
    );

    // 订阅通过 UiService 从外部发来的聊天消息（通过 AilyHost 抽象层解耦）
    const uiChatMessage$ = AilyHost.get().ui?.chatMessage$;
    if (uiChatMessage$) {
      this.uiChatMessageSubscription = uiChatMessage$.subscribe(
        (message: any) => {
          this.receiveTextFromExternal(message.text, message.options);
        }
      );
    }

    AilyHost.get().authFull?.initializeAuth().then(() => {
      AilyHost.get().authFull?.userInfo$.subscribe(userInfo => {
        this.currentUserGroup = userInfo?.groups || [];
      });
    });

    this.aiWritingSubscription = AilyHost.get().blockly.aiWriting$.subscribe(this.showAiWritingNotice.bind(this));
    this.aiWaitingSubscription = AilyHost.get().blockly.aiWaiting$.subscribe(this.showAiWritingNotice.bind(this));

    // 订阅 Blockly 块选中变化 + 代码映射变化
    this.blockSelectionSubscription = combineLatest([
      AilyHost.get().blockly.selectedBlockSubject,
      AilyHost.get().blockly.blockCodeMapSubject
    ]).subscribe((results: any[]) => {
      this.resourceManager.updateBlockContext(results[0], () => AilyHost.get().blockly.getSelectedBlockContextLabel());
    });

    // 绑定任务操作事件监听
    this.taskActionHandler = this.handleTaskAction.bind(this);
    document.addEventListener('aily-task-action', this.taskActionHandler);

    // 订阅 subagent 执行进度
    this.subagentProgressSubscription = this.subagentSessionService.onProgress()
      .subscribe((event: SubagentProgressEvent) => {
        if (!this.isWaiting) return;
        const agentSource = event.agentName || 'subAgent';
        switch (event.type) {
          case 'streaming':
            if (event.content) { this.msg.appendMessage('aily', event.content, agentSource); }
            break;
          case 'tool_call_start': {
            const innerId = event.innerToolId || `${event.toolId}_inner_${Date.now()}`;
            const innerName = event.innerToolName || 'unknown';
            this.msg.startToolCall(innerId, innerName, `${agentSource}: ${innerName}...`, undefined, agentSource);
            break;
          }
          case 'tool_call_end': {
            const innerId = event.innerToolId || `${event.toolId}_inner_${Date.now()}`;
            const innerName = event.innerToolName || 'unknown';
            const state = event.isError ? ToolCallState.ERROR : ToolCallState.DONE;
            const text = event.isError ? `${agentSource}: ${innerName} 失败` : `${agentSource}: ${innerName} 完成`;
            this.msg.completeToolCall(innerId, innerName, state, text, agentSource);
            break;
          }
          case 'tool_call':
            this.msg.appendMessage('aily', `\n\n> 🛠️ ${event.content}\n\n`, agentSource);
            break;
          case 'error':
            this.msg.appendMessage('aily', `\n\n> ❌ ${event.content}\n\n`, agentSource);
            break;
        }
        // 子Agent内容更新后，驱动外部消息容器也滚动到底部
        this.scrollManager.scrollToBottom();
      });

    // 订阅项目路径变化
    this.projectPathSubscription = AilyHost.get().project.currentProjectPath$.pipe(
      distinctUntilChanged(), skip(1)
    ).subscribe((newPath: string) => {
      const rootPath = AilyHost.get().project.projectRootPath;
      this.prjPath = newPath === rootPath ? '' : newPath;
      this.prjRootPath = rootPath;

      // 新建项目时自动领养根目录下的孤儿会话
      if (newPath && newPath !== rootPath) {
        const adopted = this.chatHistoryService.adoptOrphanSessions(newPath, rootPath);
        if (adopted > 0) {
          console.log(`[ChatEngine] 项目切换，自动领养 ${adopted} 个孤儿会话到: ${newPath}`);
        }
      }

      this.session.refreshHistoryList();
      if (newPath && newPath !== rootPath) {
        this.absAutoSyncService.initialize(newPath);
      }
    });

    // 订阅登录状态变化
    this.loginStatusSubscription = AilyHost.get().authFull?.isLoggedIn$.subscribe(
      async isLoggedIn => {
        if (!this.hasInitializedForThisLogin && !this.isSessionStarting && isLoggedIn) {
          this.isLoggedIn = isLoggedIn;
          this.hasInitializedForThisLogin = true;
          this.list = [];
          this.session.startSession().then(() => {
            this.session.getHistory();
            this.checkFirstUsage();
            // 冲刷因 sessionId 未就绪而暂存的 autoSend 消息
            if (this._pendingAutoSendText) {
              const txt = this._pendingAutoSendText;
              this._pendingAutoSendText = null;
              this.inputValue = txt;
              setTimeout(() => this.send('user', txt, true), 50);
            }
          }).catch(() => {});
        }

        if (isLoggedIn) {
          // logged in
        } else {
          try { await this.session.stopAndCloseSession(); } catch (error) { console.warn('清理会话时出错:', error); }
          this.hasInitializedForThisLogin = false;
          this.mcpInitialized = false;
          this.isWaiting = false;
          this.isCompleted = false;
          this.isSessionStarting = false;
          this.chatService.currentSessionId = '';
          this.chatService.currentSessionPath = '';
          this.list = [];
          this.toolCallStates = {};
          if (this.messageSubscription) { this.messageSubscription.unsubscribe(); this.messageSubscription = null; }
        }
      }
    );

    // 订阅配置变更
    this.configChangedSubscription = this.ailyChatConfigService.configChanged$.subscribe(
      async (newConfig) => {
        const hasConversationHistory = this.list.length > 0;
        if (!hasConversationHistory && this.sessionId && this.isLoggedIn) {
          try {
            await this.session.stopAndCloseSession(true);
            await this.session.startSession();
            this.message.success('配置已更新并生效');
          } catch (error) {
            console.warn('重新启动会话失败:', error);
            this.message.warning('配置更新失败，请尝试新建对话');
          }
        } else if (hasConversationHistory) {
          this.message.info('配置已保存，将在下次新建对话时生效');
        }
      }
    );
  }

  private cleanupSubscriptions(): void {
    if (this.messageSubscription) { this.messageSubscription.unsubscribe(); this.messageSubscription = null; }
    if (this.textMessageSubscription) { this.textMessageSubscription.unsubscribe(); this.textMessageSubscription = null; }
    if (this.loginStatusSubscription) { this.loginStatusSubscription.unsubscribe(); this.loginStatusSubscription = null; }
    if (this.aiWritingSubscription) { this.aiWritingSubscription.unsubscribe(); this.aiWritingSubscription = null; }
    if (this.aiWaitingSubscription) { this.aiWaitingSubscription.unsubscribe(); this.aiWaitingSubscription = null; }
    if (this.projectPathSubscription) { this.projectPathSubscription.unsubscribe(); this.projectPathSubscription = null; }
    if (this.configChangedSubscription) { this.configChangedSubscription.unsubscribe(); this.configChangedSubscription = null; }
    if (this.blockSelectionSubscription) { this.blockSelectionSubscription.unsubscribe(); this.blockSelectionSubscription = null; }
    if (this.subagentProgressSubscription) { this.subagentProgressSubscription.unsubscribe(); this.subagentProgressSubscription = null; }
    if (this.uiChatMessageSubscription) { this.uiChatMessageSubscription.unsubscribe(); this.uiChatMessageSubscription = null; }
    if (this.taskActionHandler) { document.removeEventListener('aily-task-action', this.taskActionHandler); this.taskActionHandler = null; }
    this.isSessionStarting = false;
    this.mcpInitialized = false;
    this.hasInitializedForThisLogin = false;
  }

  // ==================== 辅助方法 ====================

  getCurrentProjectPath(): string {
    return AilyHost.get().project.currentProjectPath !== AilyHost.get().project.projectRootPath
      ? AilyHost.get().project.currentProjectPath : '';
  }

  private get securityContext(): ReturnType<typeof createSecurityContext> {
    const securityWorkspaces = this.ailyChatConfigService.securityWorkspaces;
    return createSecurityContext(this.getCurrentProjectPath(), {
      allowProjectPathAccess: securityWorkspaces.project,
      allowNodeModulesAccess: securityWorkspaces.library,
      additionalAllowedPaths: this.sessionAllowedPaths
    });
  }

  private buildToolContext(): any {
    return {
      host: AilyHost.get(),
      securityContext: this.securityContext,
      sessionId: this.sessionId,
    };
  }

  public async executeRegisteredTool(
    toolCallId: string, toolName: string, toolArgs: any
  ): Promise<{ toolResult: any; resultState: string; resultText: string }> {
    const tool = ToolRegistry.get(toolName);
    if (!tool) {
      return { toolResult: { is_error: true, content: `未知工具: ${toolName}` }, resultState: 'error', resultText: `未知工具: ${toolName}` };
    }
    const displayMode = tool.displayMode || 'toolCall';
    const startText = ToolRegistry.getStartText(toolName, toolArgs);
    if (displayMode === 'appendMessage') {
      const safeText = startText.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').replace(/\r/g, '').replace(/\t/g, ' ');
      if (safeText) {
        this.msg.appendMessage('aily', `\n\`\`\`aily-state\n{\n  "state": "doing",\n  "text": "${safeText}",\n  "id": "${toolCallId}"\n}\n\`\`\`\n\n`);
      }
    } else if (displayMode === 'toolCall') {
      if (startText) { this.msg.startToolCall(toolCallId, toolName, startText, toolArgs); }
    }
    const ctx = this.buildToolContext();
    const toolResult = await ToolRegistry.execute(toolName, toolArgs, ctx);
    const resultText = ToolRegistry.getResultText(toolName, toolArgs, toolResult);
    if (toolName === 'create_project' && toolResult?.is_error) {
      AilyHost.get().ui?.updateFooterState({ state: 'warn', text: '项目创建失败' });
    }
    let resultState = 'done';
    if (toolResult?.is_error) { resultState = 'error'; }
    else if (toolResult?.warning) { resultState = 'warn'; }
    return { toolResult, resultState, resultText };
  }

  getKeyInfo = async () => {
    const shell = await AilyHost.get().terminal.getShell();
    return `
<keyinfo>
项目存放根路径(**rootFolder**): ${AilyHost.get().project.projectRootPath || '无'}
当前项目路径(**path**): ${this.getCurrentProjectPath() || '无'}
当前项目库存放路径(**librariesPath**): ${this.getCurrentProjectPath() ? this.getCurrentProjectPath() + '/node_modules/@aily-project' : '无'}
appDataPath(**appDataPath**): ${AilyHost.get().path.getAppDataPath() || '无'}
 - 包含SDK文件、编译器工具等，boards.json-开发板列表 libraries.json-库列表 等缓存到此路径
转换库存放路径(**libraryConversionPath**): ${this.getCurrentProjectPath() ? this.getCurrentProjectPath() : (AilyHost.get().path.join(AilyHost.get().path.getAppDataPath(), 'libraries') || '无')}
当前使用的语言(**lang**)： ${AilyHost.get().config.data?.lang || 'zh-cn'}
操作系统(**os**): ${AilyHost.get().platform.type || 'unknown'}
当前命令行终端(**terminal**): ${shell || 'unknown'}
</keyinfo>
<keyinfo>
uses get_hardware_categories tool to get hardware categories before searching boards and libraries.
uses search_boards_libraries tool to search for boards and libraries based on user needs.
Do not create non-existent boards and libraries.
</keyinfo>
`;
  }

  generateTitle(content: string): void {
    if (this.sessionTitle) return;
    const initialTitle = content.length > 20 ? content.substring(0, 20) + '...' : content;
    this.chatService.currentSessionTitle = initialTitle;
    this.chatHistoryService.updateTitle(this.sessionId, initialTitle);
    this.session.refreshHistoryList();
    if (content.length <= 20) return;
    const titleContent = content.length > 500 ? content.substring(0, 500) : content;
    this.chatService.generateTitle(this.sessionId, titleContent, (title: string) => {
      this.chatService.currentSessionTitle = title;
      this.chatHistoryService.updateTitle(this.sessionId, title);
      this.session.refreshHistoryList();
    });
  }

  showAiWritingNotice(isWaiting: boolean): void {
    if (isWaiting) {
      if (AilyHost.get().electron?.isWindowMinimized()) {
        AilyHost.get().electron?.notify('Aily', 'Blockly图形需要窗口权限', { timeoutType: 'never' });
      }
      this._aiNoticeShown = true;
      AilyHost.get().notice?.update({
        title: 'AI正在操作', state: 'doing', showProgress: false, setTimeout: 0,
        stop: () => { this.stop(); },
      });
    } else if (this._aiNoticeShown) {
      this._aiNoticeShown = false;
      AilyHost.get().notice?.clear();
    }
  }

  receiveTextFromExternal(text: string, options?: ChatTextOptions): void {
    if (options?.type === 'button') {
      if (text === '重试') { this.retryLastAction(); return; }
      if (text === '新建会话') { this.newChat(); return; }
      this.send('user', text, false);
      this.scrollManager.autoScrollEnabled = true;
      this.scrollManager.scrollToBottom();
      return;
    }
    // 当前有对话正在执行时，拦截 autoSend 请求并提示用户
    if (options?.autoSend && this.isWaiting) {
      this.message.warning('当前对话正在执行中，请等待完成后再试');
      return;
    }
    if (options?.cover === false) {
      this.inputValue = this.inputValue ? this.inputValue + '\n' + text : text;
    } else {
      this.inputValue = text;
    }
    setTimeout(() => {
      if (this.chatTextareaRef?.nativeElement) {
        const textarea = this.chatTextareaRef.nativeElement;
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }
      if (options?.autoSend) {
        if (this.sessionId) {
          // sessionId 已就绪，直接发送
          this.send('user', this.inputValue, true);
        } else {
          // sessionId 尚未就绪（startSession 仍在进行 / 未登录）
          // 暂存文本，等待 startSession 完成后自动冲刷
          this._pendingAutoSendText = this.inputValue;
        }
      }
    }, 100);
  }

  // ==================== 外观方法（转发到 helper） ====================

  saveCurrentSession(): void { this.session.saveCurrentSession(); }
  refreshHistoryList(): void { this.session.refreshHistoryList(); }
  newChat(): Promise<void> { return this.session.newChat(); }
  getHistory(): void { this.session.getHistory(); }
  getCurrentTools(): any[] { return this.turnLoop.getCurrentTools(); }
  getCurrentLLMConfig(): any { return this.turnLoop.getCurrentLLMConfig(); }

  // ==================== 消息发送 ====================

  async send(sender: string, content: string, clear: boolean = true): Promise<void> {
    if (this.isCancelled && sender === 'tool') return;

    if (this.isCompleted) {
      this.isCancelled = false;
      if (this.useStatelessMode) {
        this.isCompleted = false;
        if (!this.serverSessionActive) { await this.session.ensureServerSession(); }
      } else {
        await this.session.resetChat();
      }
    }

    this.scrollManager.autoScrollEnabled = true;
    this.terminateTemp = '';
    let text = content.trim();
    if (!this.sessionId || !text) return;

    let llmText = text;
    let displayText = text;

    if (sender === 'user') {
      if (this.isWaiting) return;
      if (this.isCancelled) {
        this.isCancelled = false;
        this.pendingUserInput = false;
        this.streamCompleted = false;
        this.sseStreamCompleted = false;
        this.activeToolExecutions = 0;
      }
      this.repetitionDetectionService.resetStreamTokens();
      this.insideThink = false;
      this.generateTitle(text);

      // @agentName 直连路由：跳过 mainAgent，直接与子 Agent 对话
      const atMatch = text.match(/^@(\w+)\s+([\s\S]+)/);
      if (atMatch) {
        const targetAgent = atMatch[1];
        const agentText = atMatch[2].trim();
        const availableAgents = SubagentSessionService.getAvailableAgents();
        if (availableAgents.includes(targetAgent) && agentText) {
          this.isWaiting = true;
          this.msg.appendMessage('user', text);
          this.msg.appendMessage('aily', '[thinking...]', targetAgent);
          if (clear) { this.inputValue = ''; }
          this.sendToSubagentDirect(targetAgent, agentText);
          return;
        }
      }

      const resourcesText = this.resourceManager.getResourcesText();
      if (resourcesText) {
        llmText = `${resourcesText}\n\n${text}`;
        displayText = resourcesText + '\n\n' + text;
      } else {
        llmText = text;
        displayText = text;
      }

      this.msg.appendMessage('user', displayText);
      this.msg.appendMessage('aily', '[thinking...]');

      if (this.useStatelessMode) {
        this.conversationMessages.push({ role: 'user', content: llmText });
        this.isWaiting = true;
        this.currentMessageSource = 'mainAgent';
        this.toolCallingIteration = 0;
        this.contextBudgetService.updateBudget(this.conversationMessages, this.turnLoop.getCurrentTools());
        if (clear) { this.inputValue = ''; }
        this.turnLoop.startChatTurn();
        return;
      }
    } else if (sender === 'tool') {
      if (!this.isWaiting) return;
    } else {
      console.warn('未知发送者类型:', sender);
      return;
    }

    this.isWaiting = true;
    this.currentMessageSource = 'mainAgent';
    this.sendMessageWithRetry(this.sessionId, llmText, sender, clear, 3);
  }

  private sendMessageWithRetry(sessionId: string, text: string, sender: string, clear: boolean, retryCount: number): void {
    this.chatService.sendMessage(sessionId, text, sender).subscribe({
      next: (res: any) => {
        if (res.status === 'success') {
          if (res.data) { this.msg.appendMessage('aily', res.data); }
          if (clear) { this.inputValue = ''; }
        }
      },
      error: (error) => {
        console.warn('发送消息失败:', error);
        if (error.status === 502 && retryCount > 0) {
          setTimeout(() => { this.sendMessageWithRetry(sessionId, text, sender, clear, retryCount - 1); }, 1000);
        } else {
          this.isWaiting = false;
          let errorMessage = '发送消息失败';
          if (error.status === 502) { errorMessage = '服务器暂时无法响应，请稍后重试'; }
          else if (error.message) { errorMessage = error.message; }
          this.msg.appendMessage('aily', `\n\`\`\`aily-error\n{\n  "message": "${errorMessage}",\n  "status": ${error.status || 'unknown'}\n}\n\`\`\`\n\n\`\`\`aily-button\n[{"text":"重试","action":"retry","type":"primary"}]\n\`\`\`\n\n`);
          this.isWaiting = false;
          this.list[this.list.length - 1].state = 'done';
        }
      }
    });
  }

  resetChat(): Promise<void> { return this.session.startSession(); }

  // ==================== @agent 直连对话 ====================

  /**
   * 用户通过 @agentName 直接与 subagent 对话
   * 跳过 mainAgent 调度，直连目标 agent
   */
  private async sendToSubagentDirect(agentName: string, userText: string): Promise<void> {
    this.isWaiting = true;
    this.currentMessageSource = agentName;

    // 将 user message 记录到主对话历史（保持对话完整性）
    this.conversationMessages.push({ role: 'user', content: `@${agentName} ${userText}` });

    try {
      const result = await this.subagentSessionService.directChat(agentName, userText);

      // 将 subagent 回复记录到主对话历史
      this.conversationMessages.push({ role: 'assistant', content: `[${agentName}] ${result}` });

      // 确保最后一条消息标记完成
      if (this.list.length > 0 && this.list[this.list.length - 1].role === 'aily') {
        this.list[this.list.length - 1].state = 'done';
      }
    } catch (error: any) {
      const errMsg = error?.message || `${agentName} 执行失败`;
      this.msg.appendMessage('aily', `\n\`\`\`aily-error\n{\n  "message": "${this.msg.makeJsonSafe(errMsg)}"}\n\`\`\`\n\n`, agentName);
    } finally {
      this.currentMessageSource = 'mainAgent';
      this.isWaiting = false;
      this.isCompleted = true;
      this.session.saveCurrentSession();
    }
  }

  // ==================== 停止 ====================

  stop(): void {
    this.isCancelled = true;
    const wasStatelessTurn = this.currentStatelessMode;
    if (this.messageSubscription) { this.messageSubscription.unsubscribe(); this.messageSubscription = null; }
    this.pendingUserInput = false;
    this.streamCompleted = false;
    this.sseStreamCompleted = false;
    this.activeToolExecutions = 0;
    this.currentStatelessMode = false;
    if (this.messageSubscription) { this.messageSubscription.unsubscribe(); this.messageSubscription = null; }
    this.subagentSessionService.cleanupAll();

    if (wasStatelessTurn && this.currentTurnAssistantContent) {
      const assistantMessage: any = {
        role: 'assistant',
        content: this.msg.sanitizeAssistantContent(this.currentTurnAssistantContent)
      };
      if (this.currentTurnToolCalls.length > 0) {
        assistantMessage.tool_calls = this.currentTurnToolCalls.map(tc => ({
          id: tc.tool_id, type: 'function',
          function: { name: tc.tool_name, arguments: typeof tc.tool_args === 'string' ? tc.tool_args : JSON.stringify(tc.tool_args) }
        }));
      }
      this.conversationMessages.push(assistantMessage);
      if (this.pendingToolResults.length > 0) {
        for (const result of this.pendingToolResults) {
          this.conversationMessages.push({
            role: 'tool', tool_call_id: result.tool_id, name: result.tool_name,
            content: this.msg.truncateToolResult(this.msg.sanitizeToolContent(result.content), result.tool_name)
          });
        }
      }
      this.currentTurnAssistantContent = '';
      this.currentTurnToolCalls = [];
      this.pendingToolResults = [];
      this.contextBudgetService.updateBudget(this.conversationMessages, this.turnLoop.getCurrentTools());
      const budget = this.contextBudgetService.getSnapshot();
      this.contextBudgetService.backgroundSummarizer.checkAndTrigger(
        this.conversationMessages, budget.maxContextTokens, budget.currentTokens,
        this.sessionId, this.turnLoop.getCurrentLLMConfig(), this.currentModel?.model || undefined
      );
    }

    if (this.list.length > 0 && this.list[this.list.length - 1].role === 'aily') {
      this.list[this.list.length - 1].state = 'done';
    }
    this.isWaiting = false;
    this.isCompleted = true;
    if (this.useStatelessMode || wasStatelessTurn) { this.session.saveCurrentSession(); }

    this.chatService.cancelTask(this.sessionId).subscribe({
      next: (res: any) => { if (res.status !== 'success') { console.warn('取消任务失败:', res); } },
      error: (err) => { console.warn('取消任务请求失败:', err); }
    });

    // 停止后应用延迟切换
    this.applyPendingSwitch();
  }

  // ==================== 模式 / 模型切换 ====================

  async switchToModel(model: ModelConfig): Promise<void> {
    if (model.model === this.currentModel?.model) return;
    // 活跃请求期间：保存偏好并暂存，待当前请求完成后自动应用
    if (this.isWaiting) {
      this.chatService.saveChatModel(model);
      this._pendingModelSwitch = model;
      this._pendingModeSwitch = null; // 模型切换优先，清除待切换模式
      this.message.info('模型将在当前对话完成后切换');
      return;
    }
    await this._doSwitchModel(model);
  }

  /** 实际执行模型切换（重建会话） */
  private async _doSwitchModel(model: ModelConfig): Promise<void> {
    this.chatService.saveChatModel(model);
    const savedMessages = [...this.conversationMessages];
    const savedIteration = this.toolCallingIteration;
    const savedTitle = this.chatService.currentSessionTitle;
    const savedPath = this.chatService.currentSessionPath;
    const savedList = [...this.list];
    const oldSessionId = this.sessionId;
    await this.session.stopAndCloseSession();
    try { await this.session.startSession(); } catch (err) {
      console.error('切换模型失败:', err);
      this.conversationMessages = savedMessages;
      this.toolCallingIteration = savedIteration;
      this.list = savedList;
      return;
    }
    this.conversationMessages = savedMessages;
    this.toolCallingIteration = savedIteration;
    this.chatService.currentSessionTitle = savedTitle;
    this.chatService.currentSessionPath = savedPath;
    this.list = savedList;
    const newSessionId = this.sessionId;
    if (oldSessionId && newSessionId && oldSessionId !== newSessionId) {
      this.chatHistoryService.migrateSessionId(oldSessionId, newSessionId);
    }
    this.contextBudgetService?.updateBudget(this.conversationMessages, this.turnLoop.getCurrentTools());
  }

  async switchToMode(mode: string): Promise<void> {
    if (mode === this.currentMode) return;
    // 活跃请求期间：保存偏好并暂存，待当前请求完成后自动应用
    if (this.isWaiting) {
      this.chatService.saveChatMode(mode as 'agent' | 'ask');
      this._pendingModeSwitch = mode;
      this._pendingModelSwitch = null; // 模式切换优先，清除待切换模型
      this.message.info('模式将在当前对话完成后切换');
      return;
    }
    await this._doSwitchMode(mode);
  }

  /** 实际执行模式切换（重建会话） */
  private async _doSwitchMode(mode: string): Promise<void> {
    this.chatService.saveChatMode(mode as 'agent' | 'ask');
    const savedMessages = [...this.conversationMessages];
    const savedIteration = this.toolCallingIteration;
    const savedTitle = this.chatService.currentSessionTitle;
    const savedPath = this.chatService.currentSessionPath;
    const savedList = [...this.list];
    const oldSessionId = this.sessionId;
    await this.session.stopAndCloseSession();
    try { await this.session.startSession(); } catch (err) {
      console.error('切换模式失败:', err);
      this.conversationMessages = savedMessages;
      this.toolCallingIteration = savedIteration;
      this.list = savedList;
      this.chatService.saveChatMode('agent');
      return;
    }
    this.conversationMessages = savedMessages;
    this.toolCallingIteration = savedIteration;
    this.chatService.currentSessionTitle = savedTitle;
    this.chatService.currentSessionPath = savedPath;
    this.list = savedList;
    const newSessionId = this.sessionId;
    if (oldSessionId && newSessionId && oldSessionId !== newSessionId) {
      this.chatHistoryService.migrateSessionId(oldSessionId, newSessionId);
    }
    this.contextBudgetService?.updateBudget(this.conversationMessages, this.turnLoop.getCurrentTools());
  }

  /**
   * 应用延迟的模型/模式切换。
   * 在 turn 完成（finalizeStatelessTurn / stream complete / stop）后调用。
   */
  async applyPendingSwitch(): Promise<void> {
    const pendingModel = this._pendingModelSwitch;
    const pendingMode = this._pendingModeSwitch;
    this._pendingModelSwitch = null;
    this._pendingModeSwitch = null;
    if (pendingModel) {
      await this._doSwitchModel(pendingModel);
    } else if (pendingMode) {
      await this._doSwitchMode(pendingMode);
    }
  }

  // ==================== 任务操作 ====================

  private handleTaskAction(event: Event): void {
    const customEvent = event as CustomEvent;
    const { action } = customEvent.detail || {};
    switch (action) {
      case 'continue': this.continueConversation(); break;
      case 'retry': this.retryLastAction(); break;
      case 'newChat': this.newChat(); break;
      case 'dismiss': break;
      default: console.warn('未知的任务操作:', action);
    }
  }

  async continueConversation(): Promise<void> {
    if (this.isWaiting) { this.message.warning('正在处理中，请稍候...'); return; }
    if (!this.sessionId) { this.message.warning('会话不存在，请开始新对话'); return; }
    await this.send('user', '请继续完成之前的任务。', false);
  }

  async retryLastAction(): Promise<void> {
    if (this.isWaiting) { this.message.warning('正在处理中，请稍候...'); return; }
    if (!this.sessionId) { this.message.warning('会话不存在，请开始新对话'); return; }
    await this.send('user', '请重试上次的操作。', false);
    this.scrollManager.autoScrollEnabled = true;
    this.scrollManager.scrollToBottom();
  }

  // ==================== 新手引导 ====================

  private checkFirstUsage(): void {
    const hasSeenOnboarding = AilyHost.get().config.data?.ailyChatOnboardingCompleted;
    if (!hasSeenOnboarding && this.isLoggedIn) {
      setTimeout(() => {
        AilyHost.get().onboarding?.start(AILY_CHAT_ONBOARDING_CONFIG, {
          onClosed: () => this.onOnboardingClosed(),
          onCompleted: () => this.onOnboardingClosed()
        });
      }, 500);
    }
  }

  private onOnboardingClosed(): void {
    AilyHost.get().config.data.ailyChatOnboardingCompleted = true;
    AilyHost.get().config.save?.();
  }

  // ==================== ask_user 交互处理 ====================

  /**
   * ask_user 工具的 UI 层回调。
   * 在聊天界面显示问题（含可选项/自由输入），等待用户回答后 resolve。
   */
  private _handleAskUser(
    question: string,
    choices?: string[],
    allowFreeform?: boolean,
  ): Promise<AskUserResponse | undefined> {
    return new Promise<AskUserResponse | undefined>((resolve) => {
      // 构建聊天界面中的问题展示（使用 aily-question 自定义块）
      const questionData: any = { question, choices: choices || [], allowFreeform: !!allowFreeform };
      const questionJson = JSON.stringify(questionData).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

      // 在聊天消息中显示问题块
      this.msg.appendMessage('aily',
        `\n\`\`\`aily-question\n${JSON.stringify(questionData, null, 2)}\n\`\`\`\n\n`
      );

      // 保存 resolve 回调，等待用户通过 resolveAskUserResponse() 触发
      this._resolveAskUser = resolve;
    });
  }

  /**
   * 用户在聊天界面回答 ask_user 问题后调用此方法。
   * 由 Component 在用户选择选项或提交自由输入时调用。
   */
  resolveAskUserResponse(answer: string, wasFreeform: boolean): void {
    if (this._resolveAskUser) {
      const resolve = this._resolveAskUser;
      this._resolveAskUser = null;
      resolve({ answer, wasFreeform });
    }
  }

  /**
   * 用户跳过/取消 ask_user 问题。
   */
  skipAskUserResponse(): void {
    if (this._resolveAskUser) {
      const resolve = this._resolveAskUser;
      this._resolveAskUser = null;
      resolve(undefined);
    }
  }
}
