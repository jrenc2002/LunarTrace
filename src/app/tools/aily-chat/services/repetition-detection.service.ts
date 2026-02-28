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
 * 重复检测配置
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
  // 单 token 重复 10 次以上
  { maxTokenSequenceLength: 1, lastTokensToConsider: 10 },
  // 最后 30 个 token 中重复 10 个 token 以内的模式
  { maxTokenSequenceLength: 10, lastTokensToConsider: 30 },
  // 长模式检测
  { maxTokenSequenceLength: 20, lastTokensToConsider: 45 },
  { maxTokenSequenceLength: 30, lastTokensToConsider: 60 },
  { maxTokenSequenceLength: 60, lastTokensToConsider: 120 },
];

/**
 * 重复检测服务
 * 用于检测 Agent 的重复工具调用和重复文字输出
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
  
  /** 相同工具连续调用阈值 */
  private readonly SAME_TOOL_THRESHOLD = 3;

  /** 相同工具不同参数连续调用阈值 */
  private readonly SAME_TOOL_DIFF_ARGS_THRESHOLD = 10;
  
  /** 循环模式检测的历史长度 */
  private readonly CYCLE_PATTERN_LENGTH = 6;

  // ==================== 流式文本检测 ====================
  
  /** 累积的流式 token */
  private streamTokens: string[] = [];
  
  /** 最大保留的 token 数量 */
  private readonly MAX_STREAM_TOKENS = 200;
  
  /** 检测间隔（每 N 个 token 检测一次） */
  private readonly CHECK_INTERVAL = 5;
  
  /** 最小检测 token 数量 */
  private readonly MIN_TOKENS_FOR_DETECTION = 15;

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
    
    // 检测 2: 同一工具不同参数的连续调用
    const sameToolResult = this.checkSameToolRepetition(toolName);
    if (sameToolResult.isRepetitive) {
      return sameToolResult;
    }
    
    // 检测 3: A→B→A→B 或 A→B→C→A→B→C 循环模式
    const cycleResult = this.checkCyclePattern(toolName);
    if (cycleResult.isRepetitive) {
      return cycleResult;
    }
    
    // 记录本次调用
    this.toolCallHistory.push({ name: toolName, argsHash, timestamp: now });
    
    return { isRepetitive: false };
  }

  /**
   * 检测完全相同的工具调用
   */
  private checkExactMatch(toolName: string, argsHash: string): RepetitionCheckResult {
    const recentExact = this.toolCallHistory.filter(
      h => h.name === toolName && h.argsHash === argsHash
    );
    
    if (recentExact.length >= this.SAME_TOOL_THRESHOLD - 1) {
      return {
        isRepetitive: true,
        pattern: `${toolName} 使用相同参数连续调用 ${recentExact.length + 1} 次`,
        suggestion: '请检查是否陷入了无效循环，考虑尝试不同的方法或参数。'
      };
    }
    
    return { isRepetitive: false };
  }

  /**
   * 检测同一工具的连续调用（即使参数不同）
   */
  private checkSameToolRepetition(toolName: string): RepetitionCheckResult {
    const recent = this.toolCallHistory.slice(-this.SAME_TOOL_DIFF_ARGS_THRESHOLD);
    const consecutiveSameTool = recent.filter(h => h.name === toolName);
    
    // 如果最近 N 次调用中有 N-1 次以上是同一工具
    if (consecutiveSameTool.length >= this.SAME_TOOL_DIFF_ARGS_THRESHOLD - 1) {
      return {
        isRepetitive: true,
        pattern: `${toolName} 在最近 ${this.SAME_TOOL_DIFF_ARGS_THRESHOLD} 次调用中出现 ${consecutiveSameTool.length} 次`,
        suggestion: '建议尝试使用其他工具或方法来解决问题。'
      };
    }
    
    return { isRepetitive: false };
  }

  /**
   * 检测循环调用模式 (A→B→A→B 或 A→B→C→A→B→C)
   */
  private checkCyclePattern(toolName: string): RepetitionCheckResult {
    const recent = this.toolCallHistory.slice(-this.CYCLE_PATTERN_LENGTH);
    
    if (recent.length < 4) {
      return { isRepetitive: false };
    }
    
    // 检测 2 元素循环: A→B→A→B
    if (recent.length >= 4) {
      const last4 = recent.slice(-4);
      if (
        last4[0].name === last4[2].name &&
        last4[1].name === last4[3].name &&
        last4[0].name !== last4[1].name
      ) {
        // 检查参数是否也相似
        const argsAlsoMatch = 
          last4[0].argsHash === last4[2].argsHash &&
          last4[1].argsHash === last4[3].argsHash;
        
        if (argsAlsoMatch) {
          return {
            isRepetitive: true,
            pattern: `${last4[0].name} ↔ ${last4[1].name} 循环调用（参数相同）`,
            suggestion: '检测到工具间的循环依赖，请重新思考解决方案。'
          };
        }
      }
    }
    
    // 检测 3 元素循环: A→B→C→A→B→C
    if (recent.length >= 6) {
      const last6 = recent.slice(-6);
      if (
        last6[0].name === last6[3].name &&
        last6[1].name === last6[4].name &&
        last6[2].name === last6[5].name
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
      // 对参数进行排序后序列化，确保相同内容生成相同哈希
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
    this.streamTokens.push(token);
    
    // 保持 token 数量在限制内
    if (this.streamTokens.length > this.MAX_STREAM_TOKENS) {
      this.streamTokens = this.streamTokens.slice(-this.MAX_STREAM_TOKENS);
    }
    
    // 每 N 个 token 检测一次
    if (this.streamTokens.length % this.CHECK_INTERVAL !== 0) {
      return { isRepetitive: false };
    }
    
    // 至少需要一定数量的 token 才开始检测
    if (this.streamTokens.length < this.MIN_TOKENS_FOR_DETECTION) {
      return { isRepetitive: false };
    }
    
    // 检测 1: 基于文本内容的短语重复检测（最灵敏）
    const phraseRepetition = this.checkPhraseRepetition();
    if (phraseRepetition.isRepetitive) {
      return phraseRepetition;
    }
    
    // 检测 2: 使用 KMP 算法检测 token 序列重复模式
    if (this.isRepetitivePattern(this.streamTokens)) {
      return {
        isRepetitive: true,
        pattern: '检测到重复输出模式',
        suggestion: '模型可能陷入了重复输出循环。'
      };
    }
    
    // 检测 3: 行级别重复
    const lineRepetition = this.checkLineRepetition();
    if (lineRepetition.isRepetitive) {
      return lineRepetition;
    }
    
    return { isRepetitive: false };
  }

  /**
   * 检测文本内容中的连续重复模式
   * 只检测真正的连续重复，如 "ABCABCABC"，避免误报正常描述
   */
  private checkPhraseRepetition(): RepetitionCheckResult {
    const text = this.streamTokens.join('');
    
    // 文本太短时不检测
    if (text.length < 30) {
      return { isRepetitive: false };
    }
    
    // 只检测末尾部分的连续重复
    const checkLength = Math.min(text.length, 150);
    const checkText = text.slice(-checkLength);
    
    // 检测不同长度的连续重复模式（从短到长）
    for (let patternLen = 3; patternLen <= Math.min(40, Math.floor(checkText.length / 3)); patternLen++) {
      const result = this.findConsecutiveRepetition(checkText, patternLen);
      if (result) {
        return result;
      }
    }
    
    return { isRepetitive: false };
  }

  /**
   * 查找连续重复的模式
   * 只有当模式在末尾连续重复出现时才触发
   * @param text 要检测的文本
   * @param patternLen 模式长度
   * @returns 检测结果，如果找到连续重复则返回结果，否则返回 null
   */
  private findConsecutiveRepetition(text: string, patternLen: number): RepetitionCheckResult | null {
    if (text.length < patternLen * 3) {
      return null;
    }
    
    // 从末尾取一个模式
    const pattern = text.slice(-patternLen);
    
    // 跳过太短、全是空白、或看起来像正常文本的模式
    const trimmedPattern = pattern.trim();
    if (trimmedPattern.length < 2) {
      return null;
    }
    
    // 跳过纯数字或序号模式（如 "1. ", "2. "）
    if (/^\d+\.\s*$/.test(trimmedPattern)) {
      return null;
    }
    
    // 从末尾往前检测连续重复次数
    let consecutiveCount = 0;
    let pos = text.length;
    
    while (pos >= patternLen) {
      const segment = text.slice(pos - patternLen, pos);
      if (segment === pattern) {
        consecutiveCount++;
        pos -= patternLen;
      } else {
        break; // 不连续了，停止计数
      }
    }
    
    // 根据模式长度调整阈值（要求**连续**重复）
    let threshold: number;
    if (patternLen <= 5) {
      threshold = 6; // 很短的模式需要连续重复 6 次
    } else if (patternLen <= 10) {
      threshold = 4; // 中等模式需要连续重复 4 次
    } else if (patternLen <= 20) {
      threshold = 3; // 较长模式需要连续重复 3 次
    } else {
      threshold = 2; // 长模式只需连续重复 2 次
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

  /**
   * 使用 KMP 前缀函数检测 token 序列重复
   */
  private isRepetitivePattern(tokens: readonly string[]): boolean {
    const tokensBackwards = tokens.slice().reverse();
    
    // 检测原始序列和过滤空白后的序列
    return (
      this.checkKMPPattern(tokensBackwards) ||
      this.checkKMPPattern(tokensBackwards.filter(t => t.trim().length > 0))
    );
  }

  /**
   * KMP 模式检测
   */
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

  /**
   * KMP 前缀函数
   * 用于高效检测重复模式
   */
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

  /**
   * 检测行级别重复
   */
  private checkLineRepetition(): RepetitionCheckResult {
    const text = this.streamTokens.join('');
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    if (lines.length < 5) {
      return { isRepetitive: false };
    }
    
    // 统计行重复次数
    const lineCount = new Map<string, number>();
    for (const line of lines) {
      lineCount.set(line, (lineCount.get(line) || 0) + 1);
    }
    
    // 找出重复最多的行
    let maxCount = 0;
    let mostRepeated = '';
    for (const [line, count] of lineCount.entries()) {
      if (count > maxCount && line.length > 10) { // 忽略太短的行
        maxCount = count;
        mostRepeated = line;
      }
    }
    
    // 如果某行重复超过总行数的 30%，认为是重复
    const repetitionRatio = maxCount / lines.length;
    if (repetitionRatio > 0.3 && maxCount >= 3) {
      return {
        isRepetitive: true,
        pattern: `行 "${mostRepeated.substring(0, 30)}..." 重复 ${maxCount} 次`,
        suggestion: '检测到相同内容的重复输出。'
      };
    }
    
    return { isRepetitive: false };
  }

  // ==================== 状态管理 ====================

  /**
   * 重置工具调用历史
   * 在新会话开始时调用
   */
  resetToolCallHistory(): void {
    this.toolCallHistory = [];
  }

  /**
   * 重置流式 token 缓存
   * 在新消息开始时调用
   */
  resetStreamTokens(): void {
    this.streamTokens = [];
  }

  /**
   * 重置所有状态
   * 在新会话开始时调用
   */
  resetAll(): void {
    this.resetToolCallHistory();
    this.resetStreamTokens();
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
}
