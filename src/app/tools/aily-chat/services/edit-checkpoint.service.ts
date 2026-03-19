/**
 * EditCheckpointService — 文件变更快照与回滚服务
 *
 * 在 Agent 每次文件操作（create/edit/replace/delete）前记录文件原始状态，
 * 形成按 turn 粒度的 checkpoint 链，支持逐轮回滚。
 *
 * 设计参考 Copilot 的 EditSurvivalTracker + Trajectory 思路：
 * - 记录每个 turn 中所有文件变更的 before/after 快照
 * - 支持按 turn 粒度回滚（恢复文件到变更前状态）
 * - 持久化
 */

import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { AilyHost } from '../core/host';

// ============================
// 类型定义
// ============================

export interface FileEdit {
  /** 文件绝对路径 */
  path: string;
  /** 操作类型 */
  type: 'create' | 'modify' | 'delete';
  /** 变更前的文件内容（create 时为 null，表示文件不存在） */
  oldContent: string | null;
  /** 变更前文件是否存在 */
  existed: boolean;
  /** 时间戳 */
  timestamp: number;
}

export interface TurnCheckpoint {
  /** checkpoint ID */
  id: string;
  /** 对应的 turn 迭代序号 */
  turnIndex: number;
  /** 在 conversationMessages 中 user 消息的索引位置 */
  conversationStartIndex: number;
  /** 在 UI list 中 assistant 消息的起始索引 */
  listStartIndex: number;
  /** 该轮中的所有文件编辑记录 */
  edits: FileEdit[];
  /** 创建时间 */
  createdAt: number;
}

// ============================
// Service
// ============================

/** 最多保留的 checkpoint 数量 */
const MAX_CHECKPOINTS = 30;

@Injectable()
export class EditCheckpointService {

  private checkpoints: TurnCheckpoint[] = [];
  private currentTurnEdits: FileEdit[] = [];
  private currentTurnIndex: number = -1;

  /** 当前显示的文件变更摘要（面板通过订阅此信号更新） */
  private summarySubject = new BehaviorSubject<EditsSummary | null>(null);
  summaryChanged$ = this.summarySubject.asObservable();

  /** 推送新的摘要到面板 */
  publishSummary(summary: EditsSummary | null): void {
    this.summarySubject.next(summary);
  }

  /** 重新计算当前 turn 的摘要并推送到面板（工具每次写盘后调用，实现实时更新） */
  publishCurrentSummary(): void {
    const summary = this.getEditsSummary();
    if (summary) {
      this.summarySubject.next(summary);
    }
  }

  /** 关闭/隐藏面板 */
  dismissSummary(): void {
    this.summarySubject.next(null);
  }

  /**
   * 开始新的 turn（由 ChatEngine 在每轮 startChatTurn / send 时调用）
   */
  startTurn(turnIndex: number, conversationStartIndex: number, listStartIndex: number): void {
    // 如果上一轮有未提交的编辑，先提交
    this.commitCurrentTurn();

    this.currentTurnIndex = turnIndex;
    this.currentTurnEdits = [];

    // 预创建 checkpoint 以记录 conversation 和 list 的位置
    this.checkpoints.push({
      id: `cp_${Date.now()}_${turnIndex}`,
      turnIndex,
      conversationStartIndex,
      listStartIndex,
      edits: this.currentTurnEdits,
      createdAt: Date.now(),
    });

    // 裁剪旧 checkpoint
    while (this.checkpoints.length > MAX_CHECKPOINTS) {
      this.checkpoints.shift();
    }
  }

  /**
   * 记录一次文件编辑（在工具实际写盘前调用）
   * 自动捕获文件当前内容作为 oldContent
   */
  recordEdit(filePath: string, type: 'create' | 'modify' | 'delete'): void {
    const fs = AilyHost.get().fs;
    let oldContent: string | null = null;
    let existed = false;

    try {
      if (fs.existsSync(filePath)) {
        existed = true;
        if (type !== 'create' || fs.existsSync(filePath)) {
          oldContent = fs.readFileSync(filePath, 'utf-8');
        }
      }
    } catch {
      // 读取失败，oldContent 保持 null
    }

    this.currentTurnEdits.push({
      path: filePath,
      type,
      oldContent,
      existed,
      timestamp: Date.now(),
    });
  }

  /**
   * 提交当前 turn 的编辑记录
   * 在 turn 结束时调用（stream complete 或取消时）
   */
  commitCurrentTurn(): void {
    // edits 数组是引用共享的，已自动写入最新的 checkpoint
    this.currentTurnIndex = -1;
  }

  /**
   * 仅回滚指定 checkpoint 的文件变更（不移除 checkpoint 记录）
   * 用于"撤销变更"场景，保留 checkpoint 以便后续"还原检查点"仍可使用
   */
  revertFilesOnly(checkpointId: string): { rolledBackFiles: number; errors: string[] } {
    const cp = this.checkpoints.find(c => c.id === checkpointId);
    if (!cp) {
      return { rolledBackFiles: 0, errors: [`未找到 checkpoint: ${checkpointId}`] };
    }

    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;
    let rolledBackFiles = 0;
    const errors: string[] = [];

    for (let j = cp.edits.length - 1; j >= 0; j--) {
      const edit = cp.edits[j];
      try {
        switch (edit.type) {
          case 'create':
            if (!edit.existed && fs.existsSync(edit.path)) {
              fs.unlinkSync(edit.path);
              rolledBackFiles++;
            } else if (edit.existed && edit.oldContent !== null) {
              fs.writeFileSync(edit.path, edit.oldContent, 'utf-8');
              rolledBackFiles++;
            }
            break;
          case 'modify':
            if (edit.oldContent !== null) {
              fs.writeFileSync(edit.path, edit.oldContent, 'utf-8');
              rolledBackFiles++;
            }
            break;
          case 'delete':
            if (edit.oldContent !== null) {
              const dirPath = pathUtil.dirname(edit.path);
              if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
              }
              fs.writeFileSync(edit.path, edit.oldContent, 'utf-8');
              rolledBackFiles++;
            }
            break;
        }
      } catch (err: any) {
        errors.push(`回滚 ${edit.path} 失败: ${err.message}`);
      }
    }

    return { rolledBackFiles, errors };
  }

  /**
   * 回滚指定 checkpoint 及其之后的所有文件变更
   * @returns 回滚的文件数量
   */
  rollbackToCheckpoint(checkpointId: string): { rolledBackFiles: number; errors: string[] } {
    const idx = this.checkpoints.findIndex(cp => cp.id === checkpointId);
    if (idx === -1) {
      return { rolledBackFiles: 0, errors: [`未找到 checkpoint: ${checkpointId}`] };
    }

    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;
    let rolledBackFiles = 0;
    const errors: string[] = [];

    // 从最新到目标 checkpoint（含），逆序回滚
    const toRollback = this.checkpoints.slice(idx);
    for (let i = toRollback.length - 1; i >= 0; i--) {
      const cp = toRollback[i];
      // 逆序回滚该 checkpoint 中的编辑
      for (let j = cp.edits.length - 1; j >= 0; j--) {
        const edit = cp.edits[j];
        try {
          switch (edit.type) {
            case 'create':
              // 文件是新建的 → 删除
              if (!edit.existed && fs.existsSync(edit.path)) {
                fs.unlinkSync(edit.path);
                rolledBackFiles++;
              } else if (edit.existed && edit.oldContent !== null) {
                // 文件原来存在但被覆盖了 → 恢复原内容
                fs.writeFileSync(edit.path, edit.oldContent, 'utf-8');
                rolledBackFiles++;
              }
              break;

            case 'modify':
              // 恢复原内容
              if (edit.oldContent !== null) {
                fs.writeFileSync(edit.path, edit.oldContent, 'utf-8');
                rolledBackFiles++;
              }
              break;

            case 'delete':
              // 文件被删除 → 恢复
              if (edit.oldContent !== null) {
                const dirPath = pathUtil.dirname(edit.path);
                if (!fs.existsSync(dirPath)) {
                  fs.mkdirSync(dirPath, { recursive: true });
                }
                fs.writeFileSync(edit.path, edit.oldContent, 'utf-8');
                rolledBackFiles++;
              }
              break;
          }
        } catch (err: any) {
          errors.push(`回滚 ${edit.path} 失败: ${err.message}`);
        }
      }
    }

    // 移除已回滚的 checkpoints
    this.checkpoints.splice(idx);

    return { rolledBackFiles, errors };
  }

  /**
   * 获取最近 N 轮的 checkpoint（用于 UI 展示）
   */
  getRecentCheckpoints(count: number = 10): TurnCheckpoint[] {
    return this.checkpoints.slice(-count);
  }

  /**
   * 获取指定 checkpoint 的信息（用于 turn regenerate）
   */
  getCheckpoint(checkpointId: string): TurnCheckpoint | undefined {
    return this.checkpoints.find(cp => cp.id === checkpointId);
  }

  /**
   * 获取最新的有编辑的 checkpoint
   */
  getLastEditCheckpoint(): TurnCheckpoint | undefined {
    for (let i = this.checkpoints.length - 1; i >= 0; i--) {
      if (this.checkpoints[i].edits.length > 0) {
        return this.checkpoints[i];
      }
    }
    return undefined;
  }

  /**
   * 获取最新 checkpoint（无论是否有编辑）
   */
  getLatestCheckpoint(): TurnCheckpoint | undefined {
    return this.checkpoints.length > 0 ? this.checkpoints[this.checkpoints.length - 1] : undefined;
  }

  getCheckpointByListIndex(listIndex: number): TurnCheckpoint | undefined {
    return this.checkpoints.find(cp => cp.listStartIndex === listIndex || cp.listStartIndex === listIndex + 1);
  }

  /**
   * 当前 turn 是否有任何编辑
   */
  hasEditsInCurrentTurn(): boolean {
    return this.currentTurnEdits.length > 0;
  }

  /**
   * 获取所有 checkpoint 的变更文件总数
   */
  getTotalEditCount(): number {
    return this.checkpoints.reduce((acc, cp) => acc + cp.edits.length, 0);
  }

  /**
   * 获取指定 checkpoint 的编辑摘要（用于 UI 展示）
   * 计算每个文件的 added/removed 行数
   */
  getEditsSummary(checkpointId?: string): EditsSummary | null {
    const cp = checkpointId
      ? this.checkpoints.find(c => c.id === checkpointId)
      : this.getLatestCheckpoint();
    if (!cp || cp.edits.length === 0) return null;

    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;
    const projectPath = AilyHost.get().project.currentProjectPath || '';
    let totalAdded = 0;
    let totalRemoved = 0;

    // 按路径去重（同一文件多次编辑只显示一次，以第一次 oldContent 和最终内容比较）
    const fileMap = new Map<string, FileEdit>();
    for (const edit of cp.edits) {
      if (!fileMap.has(edit.path)) {
        fileMap.set(edit.path, edit);
      }
    }

    const files: EditFileSummary[] = [];
    for (const [filePath, firstEdit] of fileMap) {
      let added = 0;
      let removed = 0;
      const relativePath = projectPath ? pathUtil.relative(projectPath, filePath) : pathUtil.basename(filePath);

      try {
        switch (firstEdit.type) {
          case 'create': {
            if (fs.existsSync(filePath)) {
              const content = fs.readFileSync(filePath, 'utf-8');
              added = content.split('\n').length;
            }
            break;
          }
          case 'delete': {
            if (firstEdit.oldContent !== null) {
              removed = firstEdit.oldContent.split('\n').length;
            }
            break;
          }
          case 'modify': {
            const oldLines = (firstEdit.oldContent || '').split('\n');
            let newLines: string[] = [];
            if (fs.existsSync(filePath)) {
              newLines = fs.readFileSync(filePath, 'utf-8').split('\n');
            }
            // 简单行级差异计算
            const oldBag = new Map<string, number>();
            for (const line of oldLines) {
              oldBag.set(line, (oldBag.get(line) || 0) + 1);
            }
            let matched = 0;
            const tempBag = new Map(oldBag);
            for (const line of newLines) {
              const count = tempBag.get(line) || 0;
              if (count > 0) {
                tempBag.set(line, count - 1);
                matched++;
              }
            }
            removed = oldLines.length - matched;
            added = newLines.length - matched;
            break;
          }
        }
      } catch {
        // 文件读取失败，跳过
      }

      totalAdded += added;
      totalRemoved += removed;
      files.push({ path: relativePath, fullPath: filePath, type: firstEdit.type, added, removed });
    }

    return {
      checkpointId: cp.id,
      fileCount: files.length,
      totalAdded,
      totalRemoved,
      files,
    };
  }

  // ==================== 序列化 / 反序列化 ====================

  /**
   * 导出 checkpoint 数据用于持久化
   * oldContent 较大时截断以控制存储体积
   */
  toJSON(): SerializedCheckpoints {
    const MAX_CONTENT_SIZE = 100 * 1024; // 单文件 oldContent 最大 100KB
    return {
      checkpoints: this.checkpoints.map(cp => ({
        ...cp,
        edits: cp.edits.map(edit => ({
          ...edit,
          oldContent: edit.oldContent && edit.oldContent.length > MAX_CONTENT_SIZE
            ? null  // 太大则不保存
            : edit.oldContent,
          _contentTruncated: edit.oldContent !== null && edit.oldContent.length > MAX_CONTENT_SIZE,
        })),
      })),
    };
  }

  /**
   * 从持久化数据恢复 checkpoint
   */
  restoreFromJSON(data: SerializedCheckpoints): void {
    if (!data?.checkpoints || !Array.isArray(data.checkpoints)) return;
    this.checkpoints = data.checkpoints.map(cp => ({
      id: cp.id,
      turnIndex: cp.turnIndex,
      conversationStartIndex: cp.conversationStartIndex,
      listStartIndex: cp.listStartIndex,
      edits: (cp.edits || []).map((edit: any) => ({
        path: edit.path,
        type: edit.type,
        oldContent: edit.oldContent ?? null,
        existed: edit.existed,
        timestamp: edit.timestamp,
      })),
      createdAt: cp.createdAt,
    }));
    this.currentTurnEdits = [];
    this.currentTurnIndex = -1;
  }

  /**
   * 清空所有 checkpoint（新会话 / 销毁时）
   */
  clear(): void {
    this.checkpoints = [];
    this.currentTurnEdits = [];
    this.currentTurnIndex = -1;
  }
}

// ============================
// 导出类型
// ============================

export interface EditFileSummary {
  path: string;
  fullPath: string;
  type: 'create' | 'modify' | 'delete';
  added: number;
  removed: number;
}

export interface EditsSummary {
  checkpointId: string;
  fileCount: number;
  totalAdded: number;
  totalRemoved: number;
  files: EditFileSummary[];
}

export interface SerializedCheckpoints {
  checkpoints: any[];
}
