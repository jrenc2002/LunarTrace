import { Component, Input, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'x-aily-task-action-viewer',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ac-task" [attr.data-type]="data?.actionType">
      <div class="ac-task-header">
        <i class="fa-light" [class]="taskIconClass"></i>
        <span class="ac-task-label">{{ taskLabel }}</span>
      </div>
      @if (data?.message) { <p class="ac-task-msg">{{ data.message }}</p> }
      @if (!actionTaken && !data?.isHistory) {
        <div class="ac-task-btns">
          @if (data?.actionType === 'max_messages') {
            <button class="ac-btn" data-type="primary" (click)="taskAction('continue')">继续对话</button>
            <button class="ac-btn" (click)="taskAction('newChat')">新建对话</button>
          } @else if (data?.actionType === 'error' || data?.actionType === 'timeout') {
            <button class="ac-btn" data-type="primary" (click)="taskAction('retry')">重试</button>
            <button class="ac-btn" (click)="taskAction('newChat')">新建对话</button>
          } @else {
            <button class="ac-btn" data-type="primary" (click)="taskAction('continue')">继续</button>
          }
          <button class="ac-btn ac-btn-ghost" (click)="taskAction('dismiss')">关闭</button>
        </div>
      } @else if (actionTaken) {
        <span class="ac-task-done">{{ actionTakenText }}</span>
      }
    </div>
  `,
  styles: [`
    .ac-task {
      border: 1px solid #3c3c3c; border-radius: 5px;
      margin: 4px 0; overflow: hidden; background: #252526;
    }
    .ac-task[data-type="error"]   { border-color: rgba(255,77,79,.35); }
    .ac-task[data-type="timeout"] { border-color: rgba(212,160,23,.35); }
    .ac-task-header {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px; border-bottom: 1px solid #3c3c3c;
    }
    .ac-task-label { font-size: 13px; color: #d4d4d4; font-weight: 500; }
    .ac-task-msg { padding: 6px 12px; margin: 0; font-size: 13px; color: #888; line-height: 1.6; }
    .ac-task-btns { display: flex; gap: 6px; padding: 6px 12px 10px; flex-wrap: wrap; }
    .ac-task-done { display: block; padding: 4px 12px 10px; font-size: 12px; color: #666; }
    .ac-btn {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 4px 12px; border-radius: 5px; font-size: 13px;
      cursor: pointer; border: 1px solid #505050;
      background: #3a3c3f; color: #d4d4d4;
      transition: all 0.2s;
    }
    .ac-btn:hover:not(:disabled) { border-color: #1890ff; color: #91caff; background: rgba(24,144,255,.1); }
    .ac-btn[data-type="primary"] { background: #1890ff; border-color: #1890ff; color: #fff; }
    .ac-btn[data-type="primary"]:hover:not(:disabled) { background: #40a9ff; }
    .ac-btn-ghost { background: none; border-color: #505050; color: #818992; }
    .ac-btn-ghost:hover { color: #a5a5a5 !important; background: rgba(255,255,255,.05) !important; border-color: #666 !important; }
  `],
})
export class XAilyTaskActionViewerComponent {
  @Input() data: {
    actionType?: string;
    message?: string;
    isHistory?: boolean;
  } | null = null;

  actionTaken = false;
  actionTakenText = '';

  constructor(private cdr: ChangeDetectorRef) {}

  get taskIconClass(): string {
    const map: Record<string, string> = {
      max_messages: 'fa-message-exclamation',
      error:        'fa-circle-exclamation',
      timeout:      'fa-clock-rotate-left',
    };
    return map[this.data?.actionType || ''] || 'fa-circle-info';
  }

  get taskLabel(): string {
    const map: Record<string, string> = {
      max_messages: '消息数已达上限',
      error:        '任务执行错误',
      timeout:      '任务超时',
    };
    return map[this.data?.actionType || ''] || '任务操作';
  }

  taskAction(action: string): void {
    if (this.actionTaken) return;
    this.actionTaken = true;
    const labels: Record<string, string> = {
      continue: '正在继续...', retry: '正在重试...',
      newChat: '正在创建新会话...', dismiss: '已关闭',
    };
    this.actionTakenText = labels[action] || '处理中...';
    this.cdr.markForCheck();

    document.dispatchEvent(new CustomEvent('aily-task-action', {
      bubbles: true,
      detail: { action, data: this.data },
    }));
  }
}
