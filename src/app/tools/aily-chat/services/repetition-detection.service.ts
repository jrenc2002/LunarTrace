import { Injectable } from '@angular/core';

/**
 * 工具调用历史记录
 */
interface ToolCallRecord {
  name: string;
  argsHash: string;
  timestamp: number;
}

/**
 * 重复检测结果
 */
export interface RepetitionCheckResult {
  isRepetitive: boolean;
  pattern?: string;
  suggestion?: string;
}

/**
 * 重复检测配置（KMP）
 */
interface RepetitionConfig {
  maxTokenSequenceLength: number;
  lastTokensToConsider: number;
}

/**
 * 流式文本重复检测配置
 * 基于 KMP 算法检测各种长度的重复模式
 */
const STREAM_REPETITION_CONFIGS: RepetitionConfig[] = [
  { maxTokenSequenceLength: 1, lastTokensToConsider: 10 },
  { maxTokenSequenceLength: 10, lastTokensToConsider: 30 },
  { maxTokenSequenceLength: 20, lastTokensToConsider: 45 },
  { maxTokenSequenceLength: 30, lastTokensToConsider: 60 },
  { maxTokenSequenceLength: 60, lastTokensToConsider: 120 },
];

/**
 * 重复检测服务
 *
 * 设计原则：
 * 1. 只检测「连续重复」和「循环模式」，不检测「某内容在全文出现了几次」
 * 2. 不使用白名单 —— 严格的连续性判断本身就是最好的过滤器
 * 3. 文本检测基于「语义单元」（句子/段落）而非固定长度滑窗
 *
 * 检测层级：
 * - Layer 1: Token 级连续重复（"哈哈哈哈"、token 卡顿）
 * - Layer 2: 句子级连续重复（相同句子连续出现 ≥3 次）
 * - Layer 3: 内容块跨边界重复（<think>/tool_call 前后输出相同内容块 ≥3 次）
 * - Layer 4: KMP token 循环模式（ABABAB 级 token 循环）
 * - Layer 5: 连续行重复（相同行连续出现多次）
 */
@Injectable({
  providedIn: 'root'
})
export class RepetitionDetectionService {

  // ==================== 工具调用检测 ====================

  /** 工具调用历史记录 */
  private toolCallHistory: ToolCallRecord[] = [];

  /** 工具调用历史保留时间（毫秒） */
  private readonly TOOL_HISTORY_TTL = 120000; // 2 分钟

  /** 完全相同调用（同名+同参数）的阈值 */
  private readonly SAME_TOOL_THRESHOLD = 3;

  /** 循环模式检测的历史长度 */
  private readonly CYCLE_PATTERN_LENGTH = 6;

  // ==================== 流式文本检测 ====================

  /** 累积的流式 token */
  private streamTokens: string[] = [];

  /** 最大保留的 token 数量 */
  private readonly MAX_STREAM_TOKENS = 500;

  /** 检测间隔（每 N 个 token 检测一次） */
  private readonly CHECK_INTERVAL = 5;

  /** 最小检测 token 数量 */
  private readonly MIN_TOKENS_FOR_DETECTION = 15;

  // ==================== 跨边界块级检测 ====================

  /**
   * 已完成的内容块列表
   * 每次 markBoundary() 时，上次边界到当前边界之间的增量文本会被存入此列表
   */
  private contentBlocks: string[] = [];

  /** 上次边界时 streamTokens 的长度，用于提取增量内容 */
  private lastBoundaryTokenIndex = 0;

  /** 块级重复阈值：连续相似块的数量 */
  private readonly BLOCK_REPETITION_THRESHOLD = 3;

  /** 块级相似度阈值（0-1，1=完全相同） */
  private readonly BLOCK_SIMILARITY_THRESHOLD = 0.85;

  /** 块的最小长度（太短的块不参与检测，中文场景下一个句子可能只有 8-15 字符） */
  private readonly MIN_BLOCK_LENGTH = 10;

  // ==================== Think 状态跟踪 ====================

  /** 当前是否在 <think> 标签内部（思考内容不参与重复检测） */
  private insideThink = false;

  constructor() {}

  // ==================== 工具调用重复检测 ====================

  /**
   * 检测是否为重复工具调用
   * @param toolName 工具名称
   * @param toolArgs 工具参数
   * @returns 检测结果
   */
  checkToolCallRepetition(toolName: string, toolArgs: any): RepetitionCheckResult {
    const argsHash = this.hashArgs(toolArgs);
    const now = Date.now();

    // 清理过期记录
    this.toolCallHistory = this.toolCallHistory.filter(
      h => now - h.timestamp < this.TOOL_HISTORY_TTL
    );

    // 检测 1: 完全相同的调用（同名+同参数）连续出现多次
    const exactMatchResult = this.checkExactMatch(toolName, argsHash);
    if (exactMatchResult.isRepetitive) {
      return exactMatchResult;
    }

    // 检测 2: A→B→A→B 或 A→B→C→A→B→C 循环模式（必须参数也相同才触发）
    const cycleResult = this.checkCyclePattern(toolName, argsHash);
    if (cycleResult.isRepetitive) {
      return cycleResult;
    }

    // 记录本次调用
    this.toolCallHistory.push({ name: toolName, argsHash, timestamp: now });

    return { isRepetitive: false };
  }

  /**
   * 检测完全相同的工具调用（同名+同参数）
   */
  private checkExactMatch(toolName: string, argsHash: string): RepetitionCheckResult {
    // 只检查末尾连续的相同调用
    let consecutiveCount = 0;
    for (let i = this.toolCallHistory.length - 1; i >= 0; i--) {
      const h = this.toolCallHistory[i];
      if (h.name === toolName && h.argsHash === argsHash) {
        consecutiveCount++;
      } else {
        break; // 不连续了
      }
    }

    if (consecutiveCount >= this.SAME_TOOL_THRESHOLD - 1) {
      return {
        isRepetitive: true,
        pattern: `${toolName} 使用相同参数连续调用 ${consecutiveCount + 1} 次`,
        suggestion: '请检查是否陷入了无效循环，考虑尝试不同的方法或参数。'
      };
    }

    return { isRepetitive: false };
  }

  /**
   * 检测循环调用模式 (A→B→A→B 或 A→B→C→A→B→C)
   * 必须同时满足：工具名循环 + 参数也相同
   */
  private checkCyclePattern(toolName: string, argsHash: string): RepetitionCheckResult {
    // 构造包含当前调用（尚未 push）的虚拟历史
    const virtualHistory = [
      ...this.toolCallHistory.slice(-this.CYCLE_PATTERN_LENGTH),
      { name: toolName, argsHash, timestamp: Date.now() }
    ];

    // 检测 2 元素循环: A→B→A→B（工具名+参数都相同）
    if (virtualHistory.length >= 4) {
      const last4 = virtualHistory.slice(-4);
      if (
        last4[0].name === last4[2].name &&
        last4[1].name === last4[3].name &&
        last4[0].name !== last4[1].name &&
        last4[0].argsHash === last4[2].argsHash &&
        last4[1].argsHash === last4[3].argsHash
      ) {
        return {
          isRepetitive: true,
          pattern: `${last4[0].name} ↔ ${last4[1].name} 循环调用（参数相同）`,
          suggestion: '检测到工具间的循环依赖，请重新思考解决方案。'
        };
      }
    }

    // 检测 3 元素循环: A→B→C→A→B→C（工具名+参数都相同）
    if (virtualHistory.length >= 6) {
      const last6 = virtualHistory.slice(-6);
      const uniqueTools = new Set([last6[0].name, last6[1].name, last6[2].name]);
      if (
        uniqueTools.size >= 2 &&
        last6[0].name === last6[3].name &&
        last6[1].name === last6[4].name &&
        last6[2].name === last6[5].name &&
        last6[0].argsHash === last6[3].argsHash &&
        last6[1].argsHash === last6[4].argsHash &&
        last6[2].argsHash === last6[5].argsHash
      ) {
        return {
          isRepetitive: true,
          pattern: `${last6[0].name} → ${last6[1].name} → ${last6[2].name} 循环调用`,
          suggestion: '检测到三工具循环模式，请尝试不同的解决策略。'
        };
      }
    }

    return { isRepetitive: false };
  }

  /**
   * 生成参数哈希（用于比较参数是否相同）
   */
  private hashArgs(args: any): string {
    try {
      return JSON.stringify(args, Object.keys(args || {}).sort());
    } catch (e) {
      return String(args);
    }
  }

  // ==================== 流式文本重复检测 ====================

  /**
   * 添加流式 token 并检测重复
   * @param token 新的 token
   * @returns 检测结果
   */
  checkStreamRepetition(token: string): RepetitionCheckResult {
    // 检测 think 标签边界
    if (token.includes('<think>')) {
      this.insideThink = true;
    }
    if (token.includes('</think>')) {
      this.insideThink = false;
      return { isRepetitive: false }; // 刚出 think，跳过本次检测
    }

    // think 内容不加入检测缓冲区（但仍计入 streamTokens 以保持索引一致性）
    this.streamTokens.push(token);

    // 保持 token 数量在限制内
    if (this.streamTokens.length > this.MAX_STREAM_TOKENS) {
      const trimCount = this.streamTokens.length - this.MAX_STREAM_TOKENS;
      this.streamTokens = this.streamTokens.slice(trimCount);
      this.lastBoundaryTokenIndex = Math.max(0, this.lastBoundaryTokenIndex - trimCount);
    }

    // think 内容不参与重复检测（思考过程天然含重复模式）
    if (this.insideThink) {
      return { isRepetitive: false };
    }

    // 每 N 个 token 检测一次
    if (this.streamTokens.length % this.CHECK_INTERVAL !== 0) {
      return { isRepetitive: false };
    }

    // 至少需要一定数量的 token 才开始检测
    if (this.streamTokens.length < this.MIN_TOKENS_FOR_DETECTION) {
      return { isRepetitive: false };
    }

    // Layer 1: Token 级连续短语重复（"哈哈哈哈哈" 或 token 卡顿）
    const phraseResult = this.checkPhraseRepetition();
    if (phraseResult.isRepetitive) {
      return phraseResult;
    }

    // Layer 2: 句子级连续重复（相同句子在末尾连续出现 ≥3 次）
    const sentenceResult = this.checkConsecutiveSentenceRepetition();
    if (sentenceResult.isRepetitive) {
      return sentenceResult;
    }

    // Layer 3: 内容块跨边界重复（<think>/tool_call 前后相同内容块）
    const blockResult = this.checkBlockRepetition();
    if (blockResult.isRepetitive) {
      return blockResult;
    }

    // Layer 4: KMP token 循环模式（ABABAB 级 token 循环）
    if (this.isRepetitivePattern(this.streamTokens)) {
      return {
        isRepetitive: true,
        pattern: '检测到重复输出模式',
        suggestion: '模型可能陷入了重复输出循环。'
      };
    }

    // Layer 5: 连续行重复（相同行连续出现多次）
    const lineResult = this.checkConsecutiveLineRepetition();
    if (lineResult.isRepetitive) {
      return lineResult;
    }

    return { isRepetitive: false };
  }

  // -------------------- Layer 1: 短语连续重复 --------------------

  /**
   * 检测文本末尾的连续重复模式
   * 用于检测 "ABCABCABC" 这种纯粹的连续重复
   */
  private checkPhraseRepetition(): RepetitionCheckResult {
    const text = this.streamTokens.join('');

    if (text.length < 30) {
      return { isRepetitive: false };
    }

    const checkLength = Math.min(text.length, 200);
    const checkText = text.slice(-checkLength);

    // 检测不同长度的连续重复模式
    for (let patternLen = 3; patternLen <= Math.min(50, Math.floor(checkText.length / 3)); patternLen++) {
      const result = this.findConsecutiveRepetition(checkText, patternLen);
      if (result) {
        return result;
      }
    }

    return { isRepetitive: false };
  }

  /**
   * 查找末尾连续重复的模式
   */
  private findConsecutiveRepetition(text: string, patternLen: number): RepetitionCheckResult | null {
    if (text.length < patternLen * 3) {
      return null;
    }

    const pattern = text.slice(-patternLen);

    // 跳过纯空白
    if (pattern.trim().length < 2) {
      return null;
    }

    // 跳过纯数字序号
    if (/^\d+\.\s*$/.test(pattern.trim())) {
      return null;
    }

    // 从末尾往前计数连续重复
    let consecutiveCount = 0;
    let pos = text.length;

    while (pos >= patternLen) {
      const segment = text.slice(pos - patternLen, pos);
      if (segment === pattern) {
        consecutiveCount++;
        pos -= patternLen;
      } else {
        break;
      }
    }

    // 根据模式长度调整阈值
    let threshold: number;
    if (patternLen <= 5) {
      threshold = 6;
    } else if (patternLen <= 10) {
      threshold = 4;
    } else if (patternLen <= 20) {
      threshold = 3;
    } else {
      threshold = 3; // 统一使用 3 次阈值
    }

    if (consecutiveCount >= threshold) {
      const displayPattern = pattern.length > 20
        ? pattern.substring(0, 20) + '...'
        : pattern;
      return {
        isRepetitive: true,
        pattern: `"${displayPattern}" 连续重复 ${consecutiveCount} 次`,
        suggestion: '检测到相同内容的连续重复输出。'
      };
    }

    return null;
  }

  // -------------------- Layer 2: 句子级连续重复 --------------------

  /**
   * 将文本按句子边界拆分
   * 句子边界：中文句号、问号、感叹号、英文句号+空格、换行
   * 不拆分：英文小数点、URL中的点、缩写中的点
   */
  private splitIntoSentences(text: string): string[] {
    // 先去除 <think>...</think> 标签内容（思考过程不参与比较）
    const cleanText = text.replace(/<think>[\s\S]*?<\/think>/g, '\n');

    return cleanText
      .split(/(?:[。？！\n]|(?:\.\s))+/)
      .map(s => s.trim())
      .filter(s => s.length >= 8); // 只保留 ≥8 字符的句子（中文场景较短）
  }

  /**
   * 归一化句子用于比较
   * 去除多余空白、统一标点，使微小排版差异不影响比较
   */
  private normalizeSentence(sentence: string): string {
    return sentence
      .replace(/\s+/g, ' ')  // 多空白 → 单空格
      .replace(/[，,]/g, ',')  // 统一逗号
      .replace(/[：:]/g, ':')  // 统一冒号
      .trim()
      .toLowerCase();
  }

  /**
   * 检测末尾是否有连续相同的句子
   * 例如："请问有什么帮助？请问有什么帮助？请问有什么帮助？" → 3 次连续
   */
  private checkConsecutiveSentenceRepetition(): RepetitionCheckResult {
    const text = this.streamTokens.join('');

    if (text.length < 50) {
      return { isRepetitive: false };
    }

    const sentences = this.splitIntoSentences(text);

    if (sentences.length < 3) {
      return { isRepetitive: false };
    }

    // 从末尾往前检测连续相同的句子
    const lastNormalized = this.normalizeSentence(sentences[sentences.length - 1]);

    let consecutiveCount = 1;
    for (let i = sentences.length - 2; i >= 0; i--) {
      if (this.normalizeSentence(sentences[i]) === lastNormalized) {
        consecutiveCount++;
      } else {
        break;
      }
    }

    if (consecutiveCount >= 3) {
      const displaySentence = sentences[sentences.length - 1].length > 30
        ? sentences[sentences.length - 1].substring(0, 30) + '...'
        : sentences[sentences.length - 1];
      return {
        isRepetitive: true,
        pattern: `相同句子连续出现 ${consecutiveCount} 次: "${displaySentence}"`,
        suggestion: '检测到相同内容的连续重复输出。'
      };
    }

    return { isRepetitive: false };
  }

  // -------------------- Layer 3: 跨边界块级重复 --------------------

  /**
   * 标记内容边界
   * 当遇到 tool_call、<think> 开始或 </think> 结束时调用
   *
   * - 'tool_call': 工具调用边界，保存之前的输出内容为一个块
   * - 'think_start': <think> 开始，保存之前的输出内容为一个块
   * - 'think_end': </think> 结束，不保存内容（think 内容丢弃），只更新索引
   */
  markBoundary(type: 'tool_call' | 'think_start' | 'think_end' = 'tool_call'): void {
    if (type === 'think_end') {
      // think 内容不保存为内容块，只更新边界位置
      this.lastBoundaryTokenIndex = this.streamTokens.length;
      return;
    }

    // 提取上次边界到现在的增量 token
    const deltaTokens = this.streamTokens.slice(this.lastBoundaryTokenIndex);
    const deltaText = deltaTokens.join('').trim();

    // 去除可能残留的 think 标签内容
    const cleanText = deltaText
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<think>[\s\S]*/g, '')  // 去除未关闭的 think 标签
      .replace(/[\s\S]*<\/think>/g, '') // 去除只有关闭标签的情况
      .trim();

    if (cleanText.length >= this.MIN_BLOCK_LENGTH) {
      this.contentBlocks.push(cleanText);

      if (this.contentBlocks.length > 10) {
        this.contentBlocks = this.contentBlocks.slice(-10);
      }
    }

    // 更新边界位置
    this.lastBoundaryTokenIndex = this.streamTokens.length;
  }

  /**
   * 计算两个文本的相似度（基于最长公共子序列 LCS）
   * 返回 0-1 之间的值，1 = 完全相同
   */
  private computeSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length === 0 || b.length === 0) return 0;

    // 归一化后先做快速比较
    const na = this.normalizeSentence(a);
    const nb = this.normalizeSentence(b);
    if (na === nb) return 1;

    // 对于较长文本，使用采样比较以控制性能
    // 取固定间隔的 n-gram 进行比较
    const ngramSize = 10;
    const sampleStep = Math.max(1, Math.floor(na.length / 50)); // 最多比较约50个点

    let matches = 0;
    let total = 0;

    for (let i = 0; i <= na.length - ngramSize; i += sampleStep) {
      total++;
      const gram = na.substring(i, i + ngramSize);
      if (nb.includes(gram)) {
        matches++;
      }
    }

    return total > 0 ? matches / total : 0;
  }

  /**
   * 检测跨边界的内容块重复
   * 当大模型在 think/tool_call 前后输出相同内容时触发
   */
  private checkBlockRepetition(): RepetitionCheckResult {
    if (this.contentBlocks.length < 2) {
      return { isRepetitive: false };
    }

    // 获取当前正在输出的增量文本（上次边界以来的新内容）
    const deltaTokens = this.streamTokens.slice(this.lastBoundaryTokenIndex);
    const currentDelta = deltaTokens.join('')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .trim();

    if (currentDelta.length < this.MIN_BLOCK_LENGTH) {
      return { isRepetitive: false };
    }

    // 从最近的块往前比较，计算连续相似块数
    let consecutiveSimilar = 0;
    for (let i = this.contentBlocks.length - 1; i >= 0; i--) {
      const similarity = this.computeSimilarity(currentDelta, this.contentBlocks[i]);
      if (similarity >= this.BLOCK_SIMILARITY_THRESHOLD) {
        consecutiveSimilar++;
      } else {
        break; // 不连续了
      }
    }

    // 加上当前块自身 → 连续相似块总数
    const totalSimilar = consecutiveSimilar + 1;

    if (totalSimilar >= this.BLOCK_REPETITION_THRESHOLD) {
      const displayText = currentDelta.length > 50
        ? currentDelta.substring(0, 50) + '...'
        : currentDelta;
      return {
        isRepetitive: true,
        pattern: `相同内容块跨边界连续出现 ${totalSimilar} 次: "${displayText}"`,
        suggestion: '检测到跨工具调用/思考过程的重复输出。'
      };
    }

    return { isRepetitive: false };
  }

  // -------------------- Layer 4: KMP token 循环模式 --------------------

  /**
   * 使用 KMP 前缀函数检测 token 序列循环模式
   */
  private isRepetitivePattern(tokens: readonly string[]): boolean {
    const tokensBackwards = tokens.slice().reverse();

    return (
      this.checkKMPPattern(tokensBackwards) ||
      this.checkKMPPattern(tokensBackwards.filter(t => t.trim().length > 0))
    );
  }

  private checkKMPPattern<T>(s: ArrayLike<T>): boolean {
    const prefix = this.kmpPrefixFunction(s);

    for (const config of STREAM_REPETITION_CONFIGS) {
      if (s.length < config.lastTokensToConsider) {
        continue;
      }

      const patternLength = config.lastTokensToConsider - 1 - prefix[config.lastTokensToConsider - 1];
      if (patternLength <= config.maxTokenSequenceLength) {
        return true;
      }
    }

    return false;
  }

  private kmpPrefixFunction<T>(s: ArrayLike<T>): number[] {
    const pi = Array(s.length).fill(0);
    pi[0] = -1;
    let k = -1;

    for (let q = 1; q < s.length; q++) {
      while (k >= 0 && s[k + 1] !== s[q]) {
        k = pi[k];
      }
      if (s[k + 1] === s[q]) {
        k++;
      }
      pi[q] = k;
    }

    return pi;
  }

  // -------------------- Layer 5: 连续行重复 --------------------

  /**
   * 检测末尾连续相同的行
   */
  private checkConsecutiveLineRepetition(): RepetitionCheckResult {
    const text = this.streamTokens.join('');
    const lines = text.split('\n').filter(l => l.trim().length > 0);

    if (lines.length < 4) {
      return { isRepetitive: false };
    }

    const lastLine = lines[lines.length - 1].trim();

    // 跳过太短的行
    if (lastLine.length < 10) {
      return { isRepetitive: false };
    }

    // 计算末尾连续相同行数
    let consecutiveCount = 1;
    for (let i = lines.length - 2; i >= 0; i--) {
      if (lines[i].trim() === lastLine) {
        consecutiveCount++;
      } else {
        break;
      }
    }

    // 阈值根据行长度调整
    let threshold: number;
    if (lastLine.length < 20) {
      threshold = 6;
    } else if (lastLine.length < 50) {
      threshold = 4;
    } else {
      threshold = 3;
    }

    if (consecutiveCount >= threshold) {
      const displayLine = lastLine.length > 30
        ? lastLine.substring(0, 30) + '...'
        : lastLine;
      return {
        isRepetitive: true,
        pattern: `行 "${displayLine}" 连续重复 ${consecutiveCount} 次`,
        suggestion: '检测到相同行的连续重复输出。'
      };
    }

    return { isRepetitive: false };
  }

  // ==================== 状态管理 ====================

  /**
   * 重置工具调用历史
   */
  resetToolCallHistory(): void {
    this.toolCallHistory = [];
  }

  /**
   * 重置流式 token 缓存
   * 在新用户消息开始时调用
   */
  resetStreamTokens(): void {
    this.streamTokens = [];
    this.lastBoundaryTokenIndex = 0;
    this.insideThink = false;
  }

  /**
   * 重置所有状态
   * 在新会话开始时调用
   */
  resetAll(): void {
    this.resetToolCallHistory();
    this.resetStreamTokens();
    this.contentBlocks = [];
    this.lastBoundaryTokenIndex = 0;
    this.insideThink = false;
  }

  /**
   * 获取当前工具调用历史（用于调试）
   */
  getToolCallHistory(): ToolCallRecord[] {
    return [...this.toolCallHistory];
  }

  /**
   * 获取当前累积的 token 数量（用于调试）
   */
  getStreamTokenCount(): number {
    return this.streamTokens.length;
  }

  /**
   * 获取当前内容块数量（用于调试）
   */
  getContentBlockCount(): number {
    return this.contentBlocks.length;
  }
}
