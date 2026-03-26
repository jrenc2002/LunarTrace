import { Component, Input, OnChanges, SimpleChanges, ChangeDetectionStrategy, ChangeDetectorRef, HostListener, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'x-aily-approval-viewer',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="aa-container" [class.aa-done]="resolved">
      <div class="aa-header">
        <div class="aa-title">{{ title }}</div>
      </div>
      @if (message) {
        <div class="aa-message">{{ message }}</div>
      }
      @if (resolved) {
        <div class="aa-done-bar" [attr.data-approved]="approved">
          <i [class]="approved ? 'fa-solid fa-circle-check' : 'fa-solid fa-circle-xmark'"></i>
          <span>{{ resolvedText }}</span>
        </div>
      } @else {
        <div class="aa-nav">
          <div class="aa-split-btn">
            <button class="aa-btn-primary" (click)="onApprove('once')">允许</button>
            <button class="aa-btn-caret" #caretBtn (click)="toggleDropdown($event)">
              <i class="fa-solid fa-chevron-down"></i>
            </button>
            @if (dropdownOpen) {
              <div class="aa-dropdown" [style.top.px]="dropdownTop" [style.left.px]="dropdownLeft">
                <button class="aa-dropdown-item" (click)="onApprove('session')">后续自动允许</button>
              </div>
            }
          </div>
          <button class="aa-btn-reject" (click)="onReject()">拒绝</button>
        </div>
      }
    </div>
  `,
  styles: [`
    .aa-container {
      border-radius: 10px;
      padding: 10px;
      margin: 0;
      background: #1e1e1e;
      border: 1px solid #333;
      transition: border-color 0.2s;
      min-width: 0;
    }
    .aa-container:not(.aa-done):hover { border-color: #444; }
    .aa-done { opacity: 0.72; }

    .aa-header {
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }
    .aa-title {
      font-size: 13px;
      font-weight: 500;
      color: #d4d4d4;
      line-height: 1.5;
      flex: 1;
      min-width: 0;
      word-break: break-word;
      overflow-wrap: break-word;
    }
    .aa-message {
      margin-top: 10px;
      font-size: 12px;
      color: #888;
      line-height: 1.4;
      word-break: break-word;
      overflow-wrap: break-word;
      white-space: pre-wrap;
    }

    .aa-nav {
      margin-top: 10px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* Split button group */
    .aa-split-btn {
      display: flex;
      position: relative;
    }
    .aa-btn-primary {
      padding: 4px 14px;
      border-radius: 6px 0 0 6px;
      font-size: 12px;
      font-weight: 500;
      background: #1890ff;
      color: #fff;
      border: none;
      outline: none;
      cursor: pointer;
      transition: background 0.15s;
    }
    .aa-btn-primary:hover { background: #40a9ff; }
    .aa-btn-caret {
      padding: 4px 6px;
      border-radius: 0 6px 6px 0;
      font-size: 10px;
      background: #1890ff;
      color: #fff;
      border: none;
      border-left: 1px solid rgba(255,255,255,0.2);
      outline: none;
      cursor: pointer;
      transition: background 0.15s;
      display: flex;
      align-items: center;
    }
    .aa-btn-caret:hover { background: #40a9ff; }

    .aa-dropdown {
      position: fixed;
      background: #252526;
      border: 1px solid #444;
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      z-index: 9999;
      min-width: 120px;
      overflow: hidden;
    }
    .aa-dropdown-item {
      display: block;
      width: 100%;
      padding: 6px 12px;
      font-size: 12px;
      color: #ccc;
      background: transparent;
      border: none;
      outline: none;
      cursor: pointer;
      text-align: left;
      transition: background 0.15s;
      white-space: nowrap;
    }
    .aa-dropdown-item:hover { background: rgba(255,255,255,0.06); color: #e0e0e0; }

    .aa-btn-reject {
      padding: 4px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      background: transparent;
      color: #999;
      border: 1px solid #444;
      outline: none;
      cursor: pointer;
      transition: all 0.15s;
    }
    .aa-btn-reject:hover { color: #ddd; border-color: #666; }

    /* Done bar */
    .aa-done-bar {
      margin-top: 10px;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
    }
    .aa-done-bar[data-approved="true"] i { color: #52c41a; }
    .aa-done-bar[data-approved="false"] i { color: #faad14; }
    .aa-done-bar i { font-size: 13px; }
    .aa-done-bar span { color: #888; }
  `],
})
export class XAilyApprovalViewerComponent implements OnChanges {
  @Input() data: any = null;

  toolCallId = '';
  toolName = '';
  title = '确认操作';
  message = '';
  resolved = false;
  approved = false;
  resolvedText = '';
  dropdownOpen = false;
  dropdownTop = 0;
  dropdownLeft = 0;

  @ViewChild('caretBtn', { static: false }) caretBtn!: ElementRef<HTMLButtonElement>;

  constructor(private cdr: ChangeDetectorRef, private elRef: ElementRef) {}

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.dropdownOpen && !this.elRef.nativeElement.contains(event.target)) {
      this.dropdownOpen = false;
      this.cdr.markForCheck();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['data'] && this.data) {
      this.toolCallId = this.data.toolCallId || '';
      this.toolName = this.data.toolName || '';
      this.title = this.data.title || '确认操作';
      this.message = this.data.message || '';
      this.resolved = !!this.data.resolved;
      this.approved = !!this.data.approved;
      if (this.resolved) {
        this.resolvedText = this.approved
          ? (this.data.scope === 'session' ? `已批准（后续自动允许）: ${this.title}` : `已批准: ${this.title}`)
          : `已拒绝: ${this.title}`;
      }
    }
  }

  toggleDropdown(event: MouseEvent): void {
    event.stopPropagation();
    this.dropdownOpen = !this.dropdownOpen;
    if (this.dropdownOpen && this.caretBtn) {
      const rect = this.caretBtn.nativeElement.getBoundingClientRect();
      this.dropdownTop = rect.bottom + 4;
      this.dropdownLeft = rect.left;
    }
    this.cdr.markForCheck();
  }

  onApprove(scope: 'once' | 'session'): void {
    this.resolved = true;
    this.approved = true;
    this.dropdownOpen = false;
    this.resolvedText = scope === 'session' ? `已批准（后续自动允许）: ${this.title}` : `已批准: ${this.title}`;
    this.cdr.markForCheck();
    document.dispatchEvent(new CustomEvent('aily-approval-result', {
      detail: { toolCallId: this.toolCallId, approved: true, scope }
    }));
  }

  onReject(): void {
    this.resolved = true;
    this.approved = false;
    this.dropdownOpen = false;
    this.resolvedText = `已拒绝: ${this.title}`;
    this.cdr.markForCheck();
    document.dispatchEvent(new CustomEvent('aily-approval-result', {
      detail: { toolCallId: this.toolCallId, approved: false, reason: '用户拒绝执行' }
    }));
  }
}
