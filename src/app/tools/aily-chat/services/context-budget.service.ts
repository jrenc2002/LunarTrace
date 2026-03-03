import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { ChatService } from './chat.service';
import { AilyChatConfigService } from './aily-chat-config.service';

// ==================== Token 计数工具 ====================

/**
 * 轻量级 Token 估算器
 * 使用 OpenAI 的经验法则：英文约 4 字符 ≈ 1 token，中文约 1.5 字符 ≈ 1 token
 * 实际生产中可替换为 tiktoken 等精确分词器
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;

  let tokenCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x4E00 && code < 0x9FFF) {
      // CJK 统一汉字：约 1.5 字符 ≈ 1 token → 每个汉字约 0.67 token
      tokenCount += 0.67;
    } else if (code > 0x7F) {
      // 其他非 ASCII 字符
      tokenCount += 0.5;
    } else {
      // ASCII 字符：约 4 字符 ≈ 1 token → 每个字符约 0.25 token
      tokenCount += 0.25;
    }
  }

  return Math.ceil(tokenCount);
}

/**
 * 估算单条消息的 token 数
 * 参考 OpenAI 的 "every message follows <im_start>{role/name}\n{content}<im_end>\n" 格式
 * 每条消息额外开销约 4 tokens
 */
export function estimateMessageTokens(message: any): number {
  const overhead = 4; // 消息框架开销

  let tokens = overhead;
  if (message.role) tokens += estimateTokenCount(message.role);
  if (message.content) tokens += estimateTokenCount(message.content);
  if (message.name) tokens += estimateTokenCount(message.name);

  // tool_calls 字段
  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      tokens += 4; // tool_call 框架
      if (tc.id) tokens += estimateTokenCount(tc.id);
      if (tc.function?.name) tokens += estimateTokenCount(tc.function.name);
      if (tc.function?.arguments) {
        const args = typeof tc.function.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments);
        tokens += estimateTokenCount(args);
      }
    }
  }

  return tokens;
}

/**
 * 估算消息数组的总 token 数
 */
export function estimateMessagesTokens(messages: any[]): number {
  if (!messages || messages.length === 0) return 0;
  // 额外 2 tokens 用于 prompt 首尾
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0) + 2;
}

/**
 * 估算工具定义数组的 token 数
 * 每个工具定义会被序列化为 JSON schema 格式发送给 LLM
 */
export function estimateToolsTokens(tools: any[]): number {
  if (!tools || tools.length === 0) return 0;

  let tokens = 0;
  for (const tool of tools) {
    // 工具名 + 描述 + JSON schema 序列化
    tokens += 4; // 工具定义框架开销
    if (tool.name) tokens += estimateTokenCount(tool.name);
    if (tool.description) tokens += estimateTokenCount(tool.description);
    if (tool.input_schema) {
      tokens += estimateTokenCount(JSON.stringify(tool.input_schema));
    } else if (tool.parameters) {
      tokens += estimateTokenCount(JSON.stringify(tool.parameters));
    }
  }

  return tokens;
}

// ==================== 上下文预算状态 ====================

/**
 * 上下文预算快照（供 UI 消费）
 *
 * 参考 Copilot 的 Context Window 面板，分 System / Tools / Messages 三部分展示占用
 */
export interface ContextBudgetSnapshot {
  /** 总占用 token 数（system + tools + messages） */
  currentTokens: number;
  /** 模型上下文窗口总 token 数 */
  maxContextTokens: number;
  /** 触发工具结果压缩的阈值（token 数） */
  compressionThreshold: number;
  /** 触发 LLM 摘要的阈值（token 数） */
  summarizationThreshold: number;
  /** 使用率百分比 (0-100) */
  usagePercent: number;
  /** 消息总数 */
  messageCount: number;
  /** 最后一次更新时间 */
  updatedAt: number;

  // ===== 分项明细（参考 Copilot Context Window 面板） =====
  /** 系统提示词占用 token 数 */
  systemTokens: number;
  /** 工具定义占用 token 数 */
  toolsTokens: number;
  /** 对话消息占用 token 数 */
  messagesTokens: number;
  /** 系统提示词占比 (0-100) */
  systemPercent: number;
  /** 工具定义占比 (0-100) */
  toolsPercent: number;
  /** 对话消息占比 (0-100) */
  messagesPercent: number;
}

/**
 * 上下文压缩事件
 */
export interface ContextCompressionEvent {
  type: 'tool_compression' | 'llm_summarization';
  /** 压缩前 token 数 */
  beforeTokens: number;
  /** 压缩后 token 数 */
  afterTokens: number;
  /** 压缩的消息数量 */
  compressedMessages: number;
  timestamp: number;
}

// ==================== 摘要提示模板 ====================

/**
 * 参考 Copilot 的结构化摘要提示词模板
 * 用于 LLM 驱动的对话历史摘要
 */
const SUMMARIZATION_SYSTEM_PROMPT = `你是一个对话历史摘要专家。你的任务是创建一份全面、详细的对话摘要，捕获所有关键信息以确保后续对话能无缝继续。

## 输出要求

用 <conversation-summary> 标签包裹你的摘要，包含以下分区：

### 1. 对话概览
- 用户的主要目标和需求
- 会话的整体方向和进展

### 2. 技术上下文
- 涉及的技术栈、框架、语言
- 关键的技术约束和依赖关系
- 重要的配置信息

### 3. 代码/文件变更记录
- 已修改的文件列表及变更内容摘要
- 关键的代码结构和设计决策
- 重要的函数/类/变量名称

### 4. 工具调用记录
- 已执行的工具操作及其结果摘要
- 关键的文件读写、搜索、命令执行记录
- 重要的工具执行结论（成功/失败/关键发现）

### 5. 问题解决进度
- 已解决的问题列表
- 未解决的问题和待办事项
- 当前正在处理的任务

### 6. 重要约束和决策
- 用户提出的特定要求和偏好
- 已确认的设计决策
- 需要遵守的规则和限制

### 7. 当前状态
- 最后正在执行的操作
- 下一步计划
- 任何未完成的工作流

## 注意事项
- 保留所有重要的文件路径、变量名、函数名等具体信息
- 工具调用结果中的关键数据要保留（如搜索到的文件列表、代码片段的关键部分）
- 不要遗漏任何可能影响后续对话的技术细节
- 摘要应当详细到让一个新的 AI 接手也能无缝继续工作
- 使用简洁的结构化格式，避免冗余描述`;

const SUMMARIZATION_USER_PROMPT_TEMPLATE = `请为以下对话历史创建一份详细的结构化摘要。

特别注意：
1. 保留最近几轮的完整上下文（最后的 agent 操作和工具结果）
2. 确保所有文件路径、变量名、函数签名等具体信息不丢失
3. 工具执行的关键结果要保留
4. 当前正在进行的任务状态要清晰

对话历史：
{conversation}`;

// ==================== 主服务 ====================

/**
 * 上下文预算管理服务
 *
 * 分层策略：
 * 1. 全量保留：当 token 数低于 compressionThreshold 时保留完整历史
 * 2. 工具结果压缩：超过 compressionThreshold 时截断旧的工具结果
 * 3. LLM 摘要：超过 summarizationThreshold 时调用 LLM 生成摘要替换旧历史
 *
 * 同时暴露 Observable 供 UI 展示上下文使用量。
 */
@Injectable({
  providedIn: 'root'
})
export class ContextBudgetService {

  // ==================== 模型上下文窗口配置 ====================

  /** 已知模型的上下文窗口大小（tokens） */
  private static readonly MODEL_CONTEXT_SIZES: Record<string, number> = {
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'gpt-4-turbo': 128000,
    'gpt-4': 8192,
    'gpt-3.5-turbo': 16385,
    'claude-3-opus': 200000,
    'claude-3-sonnet': 200000,
    'claude-3-haiku': 200000,
    'claude-3.5-sonnet': 200000,
    'claude-4-sonnet': 200000,
    'deepseek-chat': 64000,
    'deepseek-coder': 64000,
    'qwen-turbo': 131072,
    'qwen-plus': 131072,
    'qwen-max': 32768,
  };

  /** 默认上下文窗口大小 */
  private static readonly DEFAULT_CONTEXT_SIZE = 128000;

  /** 工具结果压缩阈值比例（占 maxContextTokens 的百分比） */
  private static readonly COMPRESSION_THRESHOLD_RATIO = 0.50;

  /** LLM 摘要阈值比例（占 maxContextTokens 的百分比） */
  private static readonly SUMMARIZATION_THRESHOLD_RATIO = 0.75;

  /** 工具结果截断长度（字符数） */
  private static readonly TOOL_RESULT_TRUNCATE_LENGTH = 500;

  /** 保留最近 N 条消息不压缩（确保最近上下文完整） */
  private static readonly RECENT_MESSAGES_PRESERVE = 6;

  /** 摘要最大 token 数 */
  private static readonly MAX_SUMMARY_TOKENS = 4000;

  /**
   * 服务端系统提示词的预估 token 数
   *
   * 服务端系统提示词在客户端不可见，
   * 通过人工预估给出合理值。后续可由服务端 API 返回精确值。
   * 当前 系统提示词约 10000+ 中文字符 → ~4500 tokens
   */
  private static readonly ESTIMATED_SYSTEM_PROMPT_TOKENS = 4500;

  // ==================== 状态 ====================

  /** 当前模型上下文窗口大小 */
  private _maxContextTokens: number = ContextBudgetService.DEFAULT_CONTEXT_SIZE;

  /** 自定义上下文窗口大小覆盖（用户在设置中指定时使用） */
  private _customMaxContextTokens: number | null = null;

  /** 上下文预算状态 Observable */
  private budgetSubject = new BehaviorSubject<ContextBudgetSnapshot>(this.createEmptySnapshot());

  /** 压缩事件 Observable */
  private compressionEventSubject = new BehaviorSubject<ContextCompressionEvent | null>(null);

  /** 上下文预算状态 Observable（供 UI 消费） */
  public budget$: Observable<ContextBudgetSnapshot> = this.budgetSubject.asObservable();

  /** 压缩事件 Observable（供 UI 消费） */
  public compressionEvent$: Observable<ContextCompressionEvent | null> = this.compressionEventSubject.asObservable();

  constructor(
    private chatService: ChatService,
    private ailyChatConfigService: AilyChatConfigService
  ) {
    // 初始化系统提示词 token 估算
    this._cachedSystemTokens = ContextBudgetService.ESTIMATED_SYSTEM_PROMPT_TOKENS;
  }

  // ==================== 公共接口 ====================

  /**
   * 获取当前上下文预算快照
   */
  getSnapshot(): ContextBudgetSnapshot {
    return this.budgetSubject.getValue();
  }

  /**
   * 获取当前 LLM 上下文窗口总 token 数
   * 优先级：用户配置 > 代码设置 > 模型自动检测值
   */
  get maxContextTokens(): number {
    const configSize = this.ailyChatConfigService?.contextWindowSize;
    if (configSize && configSize > 0) return configSize;
    return this._customMaxContextTokens ?? this._maxContextTokens;
  }

  /**
   * 设置自定义上下文窗口大小（用户覆盖）
   */
  set maxContextTokens(value: number) {
    this._customMaxContextTokens = value > 0 ? value : null;
  }

  /**
   * 获取工具结果压缩阈值（token 数）
   * 优先使用用户配置的比例，否则使用默认值
   */
  get compressionThreshold(): number {
    const ratio = this.ailyChatConfigService?.compressionThresholdRatio
      ?? ContextBudgetService.COMPRESSION_THRESHOLD_RATIO;
    return Math.floor(this.maxContextTokens * ratio);
  }

  /**
   * 获取 LLM 摘要阈值（token 数）
   * 优先使用用户配置的比例，否则使用默认值
   */
  get summarizationThreshold(): number {
    const ratio = this.ailyChatConfigService?.summarizationThresholdRatio
      ?? ContextBudgetService.SUMMARIZATION_THRESHOLD_RATIO;
    return Math.floor(this.maxContextTokens * ratio);
  }

  /**
   * 根据模型名称更新上下文窗口大小
   * @param modelName 模型名称（如 'gpt-4o', 'claude-3-sonnet' 等）
   */
  updateModelContextSize(modelName: string | null): void {
    if (!modelName || modelName === 'auto') {
      this._maxContextTokens = ContextBudgetService.DEFAULT_CONTEXT_SIZE;
      return;
    }

    // 尝试精确匹配
    const lowerName = modelName.toLowerCase();
    for (const [key, size] of Object.entries(ContextBudgetService.MODEL_CONTEXT_SIZES)) {
      if (lowerName.includes(key)) {
        this._maxContextTokens = size;
        return;
      }
    }

    // 无匹配时使用默认值
    this._maxContextTokens = ContextBudgetService.DEFAULT_CONTEXT_SIZE;
  }

  /** 缓存的系统提示词 token 估算值 */
  private _cachedSystemTokens: number = 0;
  /** 缓存的工具定义 token 估算值 */
  private _cachedToolsTokens: number = 0;
  /** 上一次工具数组长度（用于判断是否需要重新估算） */
  private _lastToolsCount: number = 0;

  /**
   * 更新系统提示词 token 估算（服务端提示词，客户端无法获取原文，需估算）
   *
   * 参考 Copilot Context Window 面板的 "System Instructions" 一栏。
   * 由于系统提示词在服务端，客户端通过配置估算。
   *
   * @param tokenCount 估算的系统提示词 token 数（可通过 estimateTokenCount(promptText) 计算）
   */
  updateSystemPromptTokens(tokenCount: number): void {
    this._cachedSystemTokens = tokenCount;
  }

  /**
   * 更新工具定义 token 估算
   * @param tools 当前工具数组
   */
  updateToolsTokens(tools: any[]): void {
    if (!tools || tools.length === 0) {
      this._cachedToolsTokens = 0;
      this._lastToolsCount = 0;
      return;
    }
    // 仅在工具数量变化时重新估算（避免每次都序列化大量 JSON）
    if (tools.length !== this._lastToolsCount) {
      this._cachedToolsTokens = estimateToolsTokens(tools);
      this._lastToolsCount = tools.length;
    }
  }

  /**
   * 更新上下文预算状态（每次 conversationMessages 变化时调用）
   *
   * 参考 Copilot 的 Context Window 面板，完整上下文 = System + Tools + Messages
   *
   * @param messages 当前完整对话历史
   * @param tools 可选，当前工具数组（传入时会更新工具 token 缓存）
   */
  updateBudget(messages: any[], tools?: any[]): void {
    // 如果传入了 tools，更新缓存
    if (tools) {
      this.updateToolsTokens(tools);
    }

    const messagesTokens = estimateMessagesTokens(messages);
    const systemTokens = this._cachedSystemTokens;
    const toolsTokens = this._cachedToolsTokens;
    const currentTokens = systemTokens + toolsTokens + messagesTokens;
    const max = this.maxContextTokens;

    const snapshot: ContextBudgetSnapshot = {
      currentTokens,
      maxContextTokens: max,
      compressionThreshold: this.compressionThreshold,
      summarizationThreshold: this.summarizationThreshold,
      usagePercent: Math.min(100, Math.round((currentTokens / max) * 100)),
      messageCount: messages.length,
      updatedAt: Date.now(),
      // 分项明细
      systemTokens,
      toolsTokens,
      messagesTokens,
      systemPercent: max > 0 ? Math.round((systemTokens / max) * 1000) / 10 : 0,
      toolsPercent: max > 0 ? Math.round((toolsTokens / max) * 1000) / 10 : 0,
      messagesPercent: max > 0 ? Math.round((messagesTokens / max) * 1000) / 10 : 0,
    };
    this.budgetSubject.next(snapshot);
  }

  /**
   * 在发送请求前检查并执行必要的压缩
   *
   * 策略分层：
   * 1. currentTokens < compressionThreshold → 不压缩，保留全量
   * 2. compressionThreshold ≤ currentTokens < summarizationThreshold → 压缩旧的工具结果
   * 3. currentTokens ≥ summarizationThreshold → 调用 LLM 生成摘要替换旧历史
   *
   * @param messages 当前完整对话历史（会被原地修改）
   * @param sessionId 会话ID（LLM 摘要需要）
   * @returns 处理后的消息数组（可能是新数组）
   */
  async compressIfNeeded(
    messages: any[],
    sessionId: string,
    llmConfig?: any,
    selectModel?: string
  ): Promise<any[]> {
    const currentTokens = estimateMessagesTokens(messages);

    // 第一层：无需压缩
    if (currentTokens < this.compressionThreshold) {
      return messages;
    }

    // 第二层：工具结果压缩
    if (currentTokens < this.summarizationThreshold) {
      const compressed = this.compressToolResults(messages);
      const afterTokens = estimateMessagesTokens(compressed);
      console.log(`[上下文压缩] 工具结果压缩: ${currentTokens} → ${afterTokens} tokens (节省 ${currentTokens - afterTokens})`);

      this.compressionEventSubject.next({
        type: 'tool_compression',
        beforeTokens: currentTokens,
        afterTokens,
        compressedMessages: messages.length - compressed.length,
        timestamp: Date.now()
      });

      this.updateBudget(compressed);
      return compressed;
    }

    // 第三层：LLM 摘要
    console.log(`[上下文压缩] Token 数 (${currentTokens}) 超过摘要阈值 (${this.summarizationThreshold})，触发 LLM 摘要`);

    try {
      const summarized = await this.summarizeHistory(messages, sessionId, llmConfig, selectModel);
      const afterTokens = estimateMessagesTokens(summarized);
      console.log(`[上下文压缩] LLM 摘要: ${currentTokens} → ${afterTokens} tokens (节省 ${currentTokens - afterTokens})`);

      this.compressionEventSubject.next({
        type: 'llm_summarization',
        beforeTokens: currentTokens,
        afterTokens,
        compressedMessages: messages.length - summarized.length,
        timestamp: Date.now()
      });

      this.updateBudget(summarized);
      return summarized;
    } catch (error) {
      console.warn('[上下文压缩] LLM 摘要失败，回退到工具结果压缩:', error);
      // 回退到工具结果压缩
      const compressed = this.compressToolResults(messages);
      this.updateBudget(compressed);
      return compressed;
    }
  }

  // ==================== 第一层：工具结果压缩 ====================

  /**
   * 压缩旧的工具结果消息
   *
   * 策略：
   * - 保留最近 N 条消息不动（确保当前上下文完整）
   * - 对更早的 tool 消息，截断 content 到指定长度
   * - 对更早的 assistant 消息中大的 tool_calls arguments，截断
   * - 保留 user 和 system 消息原样
   */
  compressToolResults(messages: any[]): any[] {
    if (messages.length <= ContextBudgetService.RECENT_MESSAGES_PRESERVE) {
      return messages;
    }

    const preserveStart = messages.length - ContextBudgetService.RECENT_MESSAGES_PRESERVE;
    const result: any[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // 保留最近 N 条消息不压缩
      if (i >= preserveStart) {
        result.push(msg);
        continue;
      }

      // 压缩旧的 tool 消息
      if (msg.role === 'tool') {
        const truncatedContent = this.truncateText(
          msg.content || '',
          ContextBudgetService.TOOL_RESULT_TRUNCATE_LENGTH
        );
        result.push({
          ...msg,
          content: truncatedContent
        });
        continue;
      }

      // 压缩旧的 assistant 消息中的 tool_calls arguments
      if (msg.role === 'assistant' && msg.tool_calls) {
        const compressedToolCalls = msg.tool_calls.map((tc: any) => {
          const args = tc.function?.arguments;
          if (args && args.length > ContextBudgetService.TOOL_RESULT_TRUNCATE_LENGTH) {
            return {
              ...tc,
              function: {
                ...tc.function,
                arguments: this.truncateText(args, ContextBudgetService.TOOL_RESULT_TRUNCATE_LENGTH)
              }
            };
          }
          return tc;
        });
        result.push({
          ...msg,
          tool_calls: compressedToolCalls
        });
        continue;
      }

      // user / system / 其他消息保持原样
      result.push(msg);
    }

    return result;
  }

  // ==================== 第二层：LLM 摘要 ====================

  /**
   * 调用 LLM 生成对话历史摘要，用一条 summary 消息替换旧的所有轮次
   *
   * @param messages 完整对话历史
   * @param sessionId 会话ID
   * @returns 压缩后的消息数组：[summary_system_message, ...recent_messages]
   */
  private async summarizeHistory(
    messages: any[],
    sessionId: string,
    llmConfig?: any,
    selectModel?: string
  ): Promise<any[]> {
    // 保留最近的消息不摘要（至少保留最后一个完整的用户-助手-工具交互周期）
    const preserveCount = this.findPreservePoint(messages);
    const toSummarize = messages.slice(0, messages.length - preserveCount);
    const toPreserve = messages.slice(messages.length - preserveCount);

    if (toSummarize.length === 0) {
      // 没有可摘要的历史
      return messages;
    }

    // 构建摘要请求的对话
    const conversationText = toSummarize.map(msg => {
      let text = `[${msg.role}]`;
      if (msg.name) text += ` (${msg.name})`;
      text += `: `;
      if (msg.content) {
        // 对工具结果做截断（避免摘要请求本身过大）
        const content = msg.role === 'tool'
          ? this.truncateText(msg.content, 2000)
          : this.truncateText(msg.content, 5000);
        text += content;
      }
      if (msg.tool_calls) {
        text += `\n  [工具调用]: ${msg.tool_calls.map((tc: any) =>
          `${tc.function?.name}(${this.truncateText(tc.function?.arguments || '', 200)})`
        ).join(', ')}`;
      }
      return text;
    }).join('\n\n');

    const summaryUserPrompt = SUMMARIZATION_USER_PROMPT_TEMPLATE.replace('{conversation}', conversationText);

    // 使用 chatRequest 发送摘要请求
    const summaryMessages = [
      { role: 'system', content: SUMMARIZATION_SYSTEM_PROMPT },
      { role: 'user', content: summaryUserPrompt }
    ];

    const summary = await this.callLLMForSummary(sessionId, summaryMessages, llmConfig, selectModel);

    if (!summary) {
      throw new Error('LLM 摘要返回空结果');
    }

    // 组装新的消息数组：[摘要消息, ...保留的最近消息]
    const summaryMessage = {
      role: 'system',
      content: `<conversation-summary>\n${summary}\n</conversation-summary>\n\n以上是之前对话历史的摘要。请基于这些上下文继续对话。`
    };

    console.log(`[LLM摘要] 将 ${toSummarize.length} 条消息摘要为 1 条，保留最近 ${preserveCount} 条原始消息`);

    return [summaryMessage, ...toPreserve];
  }

  /**
   * 调用 LLM 获取摘要文本
   * 使用 chatRequest 发送请求，收集流式响应
   */
  private callLLMForSummary(
    sessionId: string,
    messages: any[],
    llmConfig?: any,
    selectModel?: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let summaryText = '';
      let resolved = false;

      // 使用 chatService.chatRequest 发送摘要请求
      // 不传工具列表（摘要不需要工具），mode 设为 'ask'
      const subscription = this.chatService.chatRequest(
        sessionId + '_summary', // 使用独立的 session ID
        messages,
        null, // 不需要工具
        'ask',
        llmConfig,
        selectModel,
        undefined
      ).subscribe({
        next: (data: any) => {
          if (data.type === 'ModelClientStreamingChunkEvent' && data.content) {
            summaryText += data.content;
          }
          if (data.type === 'TaskCompleted') {
            // 正常完成
          }
        },
        complete: () => {
          if (!resolved) {
            resolved = true;
            resolve(summaryText.trim());
          }
          subscription.unsubscribe();
        },
        error: (err) => {
          if (!resolved) {
            resolved = true;
            reject(err);
          }
          subscription.unsubscribe();
        }
      });

      // 超时保护：30 秒
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          subscription.unsubscribe();
          if (summaryText.trim()) {
            // 超时但有部分结果，使用已收到的内容
            resolve(summaryText.trim());
          } else {
            reject(new Error('LLM 摘要请求超时'));
          }
        }
      }, 30000);
    });
  }

  /**
   * 找到保留最近消息的起始点
   * 至少保留最后一个完整的 user → assistant → tool 交互周期
   * 最少保留 RECENT_MESSAGES_PRESERVE 条
   */
  private findPreservePoint(messages: any[]): number {
    const minPreserve = ContextBudgetService.RECENT_MESSAGES_PRESERVE;

    if (messages.length <= minPreserve) {
      return messages.length;
    }

    // 从末尾向前扫描，找到第一个 user 消息的位置
    // 保留该 user 消息及其后的所有消息
    let preserveCount = 0;
    let foundUser = false;

    for (let i = messages.length - 1; i >= 0; i--) {
      preserveCount++;

      if (messages[i].role === 'user') {
        foundUser = true;
        // 继续包含前一个 user 消息（如果在合理范围内）
        if (preserveCount >= minPreserve) {
          break;
        }
      }

      // 安全上限：不要保留太多
      if (preserveCount >= minPreserve * 3) {
        break;
      }
    }

    return Math.max(preserveCount, minPreserve);
  }

  // ==================== 工具方法 ====================

  /**
   * 截断文本到指定长度
   */
  private truncateText(text: string, maxLength: number): string {
    if (!text || text.length <= maxLength) return text;
    return text.substring(0, maxLength) + `\n...[已截断，原始长度: ${text.length} 字符]`;
  }

  /**
   * 创建空的预算快照
   */
  private createEmptySnapshot(): ContextBudgetSnapshot {
    return {
      currentTokens: 0,
      maxContextTokens: this.maxContextTokens,
      compressionThreshold: this.compressionThreshold,
      summarizationThreshold: this.summarizationThreshold,
      usagePercent: 0,
      messageCount: 0,
      updatedAt: Date.now(),
      systemTokens: 0,
      toolsTokens: 0,
      messagesTokens: 0,
      systemPercent: 0,
      toolsPercent: 0,
      messagesPercent: 0,
    };
  }

  /**
   * 重置状态（新会话时调用）
   */
  reset(): void {
    // 注意：不清除 _cachedSystemTokens，因为系统提示词在会话间不变
    this._cachedToolsTokens = 0;
    this._lastToolsCount = 0;
    this.budgetSubject.next(this.createEmptySnapshot());
    this.compressionEventSubject.next(null);
  }
}
