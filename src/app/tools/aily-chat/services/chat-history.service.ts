/**
 * ChatHistoryService - Copilot 风格的聊天历史管理服务
 *
 * 采用「全局索引 + 分项目/全局兜底数据」双轨架构：
 * - 全局索引：~/.aily/chat_history_index.json（用户级，永远可用）
 * - 聊天数据：有项目 → {projectPath}/.chat_history/{sessionId}.json
 *             无项目 → ~/.aily/chat_history/{sessionId}.json
 *
 * 持久化策略：关键节点立即保存 + 30s 定时兜底
 * - 每轮对话结束（SSE complete）立即保存
 * - 标题生成完成时更新索引
 * - newChat / 切换会话时保存
 * - 30s 定时检查 dirty 标记
 *
 * 数据范围：UI 列表 + conversationMessages + 元数据
 * - 支持恢复对话上下文继续聊天
 *
 * @see Copilot 使用全局 globalStorageUri 不分项目，我们在此基础上加了 projectPath 标记
 */

import { Injectable, OnDestroy } from '@angular/core';

// ===== 类型定义 =====

/** 全局索引中的会话条目 */
export interface SessionIndexEntry {
  sessionId: string;
  title: string;
  /** 创建此会话时的项目路径，null 表示无项目 */
  projectPath: string | null;
  /** 项目显示名称，null 表示无项目 */
  projectName: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  mode: string;
  model: string | null;
  /** 数据文件是否可用（项目路径被删除/移动时标记为 false） */
  dataAvailable?: boolean;
}

/** 单个会话的完整持久化数据 */
export interface SessionData {
  /** UI 显示列表 */
  chatList: ChatListItem[];
  /** 完整对话历史（用于恢复继续对话） */
  conversationMessages: any[];
  /** 会话元数据 */
  metadata: SessionMetadata;
}

export interface ChatListItem {
  role: string;
  content: string;
  state: 'doing' | 'done';
  source?: string;
}

export interface SessionMetadata {
  sessionId: string;
  title: string;
  projectPath: string | null;
  createdAt: number;
  updatedAt: number;
  mode: string;
  model: string | null;
  /** 上下文预算快照 */
  contextBudget?: {
    currentTokens: number;
    maxContextTokens: number;
    usagePercent: number;
  };
  /** 工具调用迭代次数 */
  toolCallingIteration: number;
}

/** 历史列表的筛选模式 */
export type HistoryFilterMode = 'all' | 'current-project';

@Injectable({
  providedIn: 'root'
})
export class ChatHistoryService implements OnDestroy {

  // ===== 状态 =====
  /** 全局会话索引（内存） */
  private index: SessionIndexEntry[] = [];
  /** 索引是否已从磁盘加载 */
  private indexLoaded = false;
  /** 脏标记：索引有未保存的变更 */
  private indexDirty = false;
  /** 脏标记：各会话有未保存的数据变更 sessionId → true */
  private dirtySessionIds = new Set<string>();
  /** 定时兜底保存的 timer ID */
  private autoSaveTimer: any = null;
  /** 会话数据内存缓存：sessionId → SessionData */
  private sessionCache = new Map<string, SessionData>();

  // ===== 路径常量 =====
  private readonly INDEX_FILE = 'chat_history_index.json';
  private readonly CHAT_DATA_DIR = 'chat_history';
  private readonly PROJECT_CHAT_DIR = '.chat_history';

  constructor() {
    this.startAutoSave();
  }

  ngOnDestroy(): void {
    // 强制保存所有脏数据
    this.flushAll();
    this.stopAutoSave();
  }

  // =========================================================================
  // 公共 API - 索引管理
  // =========================================================================

  /**
   * 获取历史列表（按 updatedAt 降序）
   * @param filter 筛选模式
   * @param projectPath 当前项目路径（filter='current-project' 时使用）
   */
  getHistoryList(filter: HistoryFilterMode = 'all', projectPath?: string | null): SessionIndexEntry[] {
    this.ensureIndexLoaded();
    let result = [...this.index];

    if (filter === 'current-project' && projectPath) {
      result = result.filter(e => this.isSamePath(e.projectPath, projectPath));
    }

    // 按 updatedAt 降序
    result.sort((a, b) => b.updatedAt - a.updatedAt);
    return result;
  }

  /**
   * 查找/确认索引条目是否存在
   */
  findEntry(sessionId: string): SessionIndexEntry | undefined {
    this.ensureIndexLoaded();
    return this.index.find(e => e.sessionId === sessionId);
  }

  // =========================================================================
  // 公共 API - 保存
  // =========================================================================

  /**
   * 保存会话数据（完整保存：索引 + 数据文件）
   * 在每轮对话结束、newChat、组件销毁时调用
   */
  saveSession(
    sessionId: string,
    chatList: ChatListItem[],
    conversationMessages: any[],
    metadata: Partial<SessionMetadata> & { sessionId: string }
  ): void {
    if (!sessionId || (chatList.length === 0 && conversationMessages.length === 0)) {
      return;
    }

    this.ensureIndexLoaded();

    const now = Date.now();

    // 构建完整 metadata
    const fullMetadata: SessionMetadata = {
      sessionId,
      title: metadata.title || '',
      projectPath: metadata.projectPath ?? null,
      createdAt: metadata.createdAt || now,
      updatedAt: now,
      mode: metadata.mode || 'agent',
      model: metadata.model ?? null,
      contextBudget: metadata.contextBudget,
      toolCallingIteration: metadata.toolCallingIteration || 0,
    };

    // 构建 SessionData
    const sessionData: SessionData = {
      chatList,
      conversationMessages,
      metadata: fullMetadata,
    };

    // 更新内存缓存
    this.sessionCache.set(sessionId, sessionData);

    // 更新或创建索引条目
    this.upsertIndexEntry(sessionId, fullMetadata, chatList.length);

    // 写入磁盘
    this.writeSessionData(sessionId, sessionData);
    this.writeIndex();

    // 清理脏标记
    this.dirtySessionIds.delete(sessionId);
    this.indexDirty = false;
  }

  /**
   * 仅更新索引中的标题（标题生成完成时调用，低 IO）
   */
  updateTitle(sessionId: string, title: string): void {
    this.ensureIndexLoaded();
    const entry = this.index.find(e => e.sessionId === sessionId);
    if (entry) {
      entry.title = title;
      entry.updatedAt = Date.now();
      this.indexDirty = true;
      // 同时更新缓存
      const cached = this.sessionCache.get(sessionId);
      if (cached) {
        cached.metadata.title = title;
      }
      // 立即写索引（低 IO，只有几 KB）
      this.writeIndex();
    }
  }

  /**
   * 标记会话数据有变更（用于 dirty 跟踪，30s 兜底保存时使用）
   */
  markDirty(sessionId: string): void {
    this.dirtySessionIds.add(sessionId);
  }

  /**
   * 更新内存缓存（消息变更时调用，不立即写磁盘）
   * 配合 markDirty 使用，由 autoSave 定时兜底写入
   */
  updateCache(
    sessionId: string,
    chatList: ChatListItem[],
    conversationMessages: any[],
    metadata?: Partial<SessionMetadata>
  ): void {
    const existing = this.sessionCache.get(sessionId);
    if (existing) {
      existing.chatList = chatList;
      existing.conversationMessages = conversationMessages;
      if (metadata) {
        Object.assign(existing.metadata, metadata, { updatedAt: Date.now() });
      }
    } else {
      this.sessionCache.set(sessionId, {
        chatList,
        conversationMessages,
        metadata: {
          sessionId,
          title: metadata?.title || '',
          projectPath: metadata?.projectPath ?? null,
          createdAt: metadata?.createdAt || Date.now(),
          updatedAt: Date.now(),
          mode: metadata?.mode || 'agent',
          model: metadata?.model ?? null,
          toolCallingIteration: metadata?.toolCallingIteration || 0,
        }
      });
    }
    this.markDirty(sessionId);
  }

  // =========================================================================
  // 公共 API - 加载
  // =========================================================================

  /**
   * 加载会话的完整数据
   * 查找顺序：内存缓存 → 磁盘文件
   * @param sessionId 会话ID
   * @param projectPathHint 可选的项目路径提示（当索引中找不到时，用于搜索旧格式文件）
   * @returns SessionData 或 null（文件不存在/损坏）
   */
  loadSession(sessionId: string, projectPathHint?: string | null): SessionData | null {
    // 1. 内存缓存
    const cached = this.sessionCache.get(sessionId);
    if (cached) {
      return cached;
    }

    // 2. 从索引中找到数据路径
    this.ensureIndexLoaded();
    const entry = this.index.find(e => e.sessionId === sessionId);

    // 3. 尝试从磁盘读取（索引路径优先，其次 projectPathHint）
    const primaryPath = entry?.projectPath || null;
    const data = this.readSessionData(sessionId, primaryPath);
    if (data) {
      this.sessionCache.set(sessionId, data);
      return data;
    }

    // 4. 如果索引路径找不到，尝试 projectPathHint（兼容旧数据未迁移的情况）
    if (projectPathHint && !this.isSamePath(projectPathHint, primaryPath)) {
      const fallbackData = this.readSessionData(sessionId, projectPathHint);
      if (fallbackData) {
        this.sessionCache.set(sessionId, fallbackData);
        return fallbackData;
      }
    }

    return null;
  }

  /**
   * 仅加载 UI 聊天列表（轻量，兼容旧代码）
   */
  loadChatList(sessionId: string): ChatListItem[] | null {
    const data = this.loadSession(sessionId);
    return data?.chatList || null;
  }

  /**
   * 仅加载 conversationMessages（恢复对话上下文）
   */
  loadConversationMessages(sessionId: string): any[] | null {
    const data = this.loadSession(sessionId);
    return data?.conversationMessages || null;
  }

  // =========================================================================
  // 公共 API - 删除
  // =========================================================================

  /**
   * 删除会话（索引 + 数据文件 + 缓存）
   */
  deleteSession(sessionId: string): void {
    this.ensureIndexLoaded();
    const entry = this.index.find(e => e.sessionId === sessionId);

    // 删除数据文件
    if (entry) {
      this.deleteSessionFile(sessionId, entry.projectPath);
    }
    // 也尝试删全局兜底路径
    this.deleteSessionFile(sessionId, null);

    // 删除索引条目
    this.index = this.index.filter(e => e.sessionId !== sessionId);
    this.writeIndex();

    // 清理缓存
    this.sessionCache.delete(sessionId);
    this.dirtySessionIds.delete(sessionId);
  }

  // =========================================================================
  // 公共 API - 强制保存
  // =========================================================================

  /**
   * 强制保存所有脏数据（组件销毁/窗口关闭时调用）
   */
  flushAll(): void {
    for (const sessionId of this.dirtySessionIds) {
      const cached = this.sessionCache.get(sessionId);
      if (cached) {
        this.writeSessionData(sessionId, cached);
        // 同步更新索引
        this.upsertIndexEntry(sessionId, cached.metadata, cached.chatList.length);
      }
    }
    this.dirtySessionIds.clear();

    if (this.indexDirty) {
      this.writeIndex();
      this.indexDirty = false;
    }
  }

  // =========================================================================
  // 索引操作
  // =========================================================================

  /**
   * 更新或创建索引条目
   */
  private upsertIndexEntry(
    sessionId: string,
    metadata: SessionMetadata,
    messageCount: number
  ): void {
    const existing = this.index.find(e => e.sessionId === sessionId);
    if (existing) {
      existing.title = metadata.title || existing.title;
      existing.updatedAt = metadata.updatedAt || Date.now();
      existing.messageCount = messageCount;
      existing.mode = metadata.mode || existing.mode;
      existing.model = metadata.model ?? existing.model;
      existing.dataAvailable = true;
    } else {
      this.index.push({
        sessionId,
        title: metadata.title || '',
        projectPath: metadata.projectPath ?? null,
        projectName: this.extractProjectName(metadata.projectPath),
        createdAt: metadata.createdAt || Date.now(),
        updatedAt: metadata.updatedAt || Date.now(),
        messageCount,
        mode: metadata.mode || 'agent',
        model: metadata.model ?? null,
        dataAvailable: true,
      });
    }
    this.indexDirty = true;
  }

  // =========================================================================
  // 磁盘 IO
  // =========================================================================

  /**
   * 加载全局索引
   */
  private ensureIndexLoaded(): void {
    if (this.indexLoaded) return;
    this.indexLoaded = true;

    if (!this.hasFs()) return;

    try {
      const indexPath = this.getGlobalIndexPath();
      if (this.fileExists(indexPath)) {
        const content = this.readFileSync(indexPath);
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          this.index = parsed;
          console.log(`[ChatHistory] 全局索引已加载, ${this.index.length} 条记录`);
        }
      }
    } catch (error) {
      console.warn('[ChatHistory] 加载全局索引失败:', error);
      this.index = [];
    }
  }

  /**
   * 写入全局索引
   */
  private writeIndex(): void {
    if (!this.hasFs()) return;

    try {
      const indexPath = this.getGlobalIndexPath();
      this.ensureDir(this.getGlobalAilyDir());
      this.writeFileSync(indexPath, JSON.stringify(this.index, null, 2));
      this.indexDirty = false;
    } catch (error) {
      console.warn('[ChatHistory] 写入全局索引失败:', error);
    }
  }

  /**
   * 写入会话数据文件
   */
  private writeSessionData(sessionId: string, data: SessionData): void {
    if (!this.hasFs()) return;

    const projectPath = data.metadata.projectPath;

    try {
      // 优先写到项目目录
      if (projectPath) {
        const dir = this.joinPath(projectPath, this.PROJECT_CHAT_DIR);
        this.ensureDir(dir);
        const filePath = this.joinPath(dir, `${sessionId}.json`);
        this.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return;
      }

      // 无项目 → 全局兜底
      const dir = this.getGlobalChatDataDir();
      this.ensureDir(dir);
      const filePath = this.joinPath(dir, `${sessionId}.json`);
      this.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.warn(`[ChatHistory] 写入会话数据失败 (${sessionId}):`, error);
    }
  }

  /**
   * 读取会话数据文件
   */
  private readSessionData(sessionId: string, projectPath: string | null): SessionData | null {
    if (!this.hasFs()) return null;

    // 尝试顺序：项目目录 → 全局兜底
    const paths: string[] = [];
    if (projectPath) {
      paths.push(this.joinPath(projectPath, this.PROJECT_CHAT_DIR, `${sessionId}.json`));
    }
    paths.push(this.joinPath(this.getGlobalChatDataDir(), `${sessionId}.json`));

    for (const filePath of paths) {
      try {
        if (this.fileExists(filePath)) {
          const content = this.readFileSync(filePath);
          const parsed = JSON.parse(content);

          // 兼容旧格式：如果是数组，则是纯 chatList
          if (Array.isArray(parsed)) {
            return {
              chatList: parsed,
              conversationMessages: [],
              metadata: {
                sessionId,
                title: '',
                projectPath,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                mode: 'agent',
                model: null,
                toolCallingIteration: 0,
              }
            };
          }

          // 新格式
          if (parsed.chatList && parsed.metadata) {
            return parsed as SessionData;
          }
        }
      } catch (error) {
        console.warn(`[ChatHistory] 读取会话数据失败 (${filePath}):`, error);
      }
    }

    return null;
  }

  /**
   * 删除会话数据文件
   */
  private deleteSessionFile(sessionId: string, projectPath: string | null): void {
    if (!this.hasFs()) return;

    try {
      if (projectPath) {
        const filePath = this.joinPath(projectPath, this.PROJECT_CHAT_DIR, `${sessionId}.json`);
        if (this.fileExists(filePath)) {
          window['fs'].unlinkSync(filePath);
        }
      } else {
        const filePath = this.joinPath(this.getGlobalChatDataDir(), `${sessionId}.json`);
        if (this.fileExists(filePath)) {
          window['fs'].unlinkSync(filePath);
        }
      }
    } catch { }
  }

  // =========================================================================
  // 定时兜底保存
  // =========================================================================

  private startAutoSave(): void {
    this.autoSaveTimer = setInterval(() => {
      if (this.dirtySessionIds.size > 0 || this.indexDirty) {
        console.log(`[ChatHistory] 定时保存: ${this.dirtySessionIds.size} 个脏会话, 索引dirty=${this.indexDirty}`);
        this.flushAll();
      }
    }, 30000); // 30s
  }

  private stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  // =========================================================================
  // 文件系统工具方法
  // =========================================================================

  private hasFs(): boolean {
    return typeof window !== 'undefined' && !!window['fs'];
  }

  private fileExists(path: string): boolean {
    try {
      return window['fs'].existsSync(path);
    } catch {
      return false;
    }
  }

  private readFileSync(path: string): string {
    return window['fs'].readFileSync(path, 'utf-8');
  }

  private writeFileSync(path: string, content: string): void {
    window['fs'].writeFileSync(path, content, 'utf-8');
  }

  private ensureDir(dirPath: string): void {
    if (!this.fileExists(dirPath)) {
      window['fs'].mkdirSync(dirPath, { recursive: true });
    }
  }

  private joinPath(...parts: string[]): string {
    // 优先使用 Electron 的 path API
    if (window['path']?.join) {
      return window['path'].join(...parts);
    }
    // 降级：简单拼接
    return parts.join('/').replace(/\/+/g, '/');
  }

  private getGlobalAilyDir(): string {
    return window['path']?.getAppDataPath?.() || '';
  }

  private getGlobalIndexPath(): string {
    return this.joinPath(this.getGlobalAilyDir(), this.INDEX_FILE);
  }

  private getGlobalChatDataDir(): string {
    return this.joinPath(this.getGlobalAilyDir(), this.CHAT_DATA_DIR);
  }

  private extractProjectName(projectPath: string | null): string | null {
    if (!projectPath) return null;
    // 取最后一段路径作为项目名
    const normalized = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = normalized.split('/');
    return parts[parts.length - 1] || null;
  }

  /**
   * 路径比较（兼容 Windows/Unix 路径分隔符差异）
   */
  private isSamePath(a: string | null, b: string | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return normalize(a) === normalize(b);
  }
}
