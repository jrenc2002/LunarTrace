import {
  Component,
  Input,
  ViewChild,
  ElementRef,
  AfterViewChecked,
  OnChanges,
  SimpleChanges,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { XMarkdownComponent } from 'ngx-x-markdown';
import type { StreamingOption, ComponentMap } from 'ngx-x-markdown';
import { AilyChatCodeComponent } from '../aily-chat-code.component';
import { getClosingTagsForOpenBlocks } from '../../../services/content-sanitizer.service';

@Component({
  selector: 'x-aily-think-viewer',
  standalone: true,
  imports: [CommonModule, XMarkdownComponent],
  template: `
    <div class="ac-think" [class.expanded]="thinkExpanded">
      <div class="ac-think-header" (click)="thinkExpanded = !thinkExpanded">
        @if (data?.isComplete) {
          <i class="fa-light fa-circle-check ac-think-icon done"></i>
        } @else {
          <i class="fa-duotone fa-solid fa-loader ac-think-icon loading ac-spin"></i>
        }
        <span>{{ data?.isComplete ? 'Think' : 'Thinking...' }}</span>
        <i class="fa-light fa-chevron-down ac-think-arrow"></i>
      </div>
      @if (thinkExpanded) {
        <div class="ac-think-body" #thinkBody>
          @if (thinkContent) {
            <x-markdown
              [content]="markdownContent()"
              [streaming]="streamingConfig()"
              [components]="componentMap"
              rootClassName="x-markdown-dark"
            />
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      .ac-think {
        border-radius: 5px;
        padding: 5px 10px;
        margin: 0;
        overflow: hidden;
        background-color: #3a3a3a;
        color: #ccc;
      }
      .ac-think-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 0;
        cursor: pointer;
        font-size: 13px;
        user-select: none;
        transition: background 0.2s;
      }
      .ac-think-header:hover {
        background: rgba(255, 255, 255, 0.05);
        margin: -5px -10px;
        padding: 5px 10px;
      }
      .ac-think-icon { flex-shrink: 0; margin-right: 5px; }
      .ac-think-icon.loading { color: #1890ff; }
      .ac-think-icon.done { color: #52c41a; }
      .ac-think-arrow {
        margin-left: auto;
        font-size: 10px;
        color: #888;
        transition: transform 0.2s;
      }
      .ac-think.expanded .ac-think-arrow {
        transform: rotate(180deg);
      }
      .ac-think-body {
        padding: 8px 2px;
        margin: 5px -10px 0 0;
        max-height: 200px;
        overflow-y: auto;
        overflow-x: hidden;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
        scrollbar-gutter: stable;
        user-select: text;
      }
      :host ::ng-deep .ac-think-body .x-markdown-dark {
        font-size: 13px;
        line-height: 1.5;
        color: #999;
        word-break: break-word;
        overflow-wrap: anywhere;
        white-space: normal;
        max-width: 100%;
        min-width: 0;
      }
      :host ::ng-deep .ac-think-body .x-markdown-dark * {
        max-width: 100%;
      }
      :host ::ng-deep .ac-think-body .x-markdown-dark p {
        margin: 2px 0;
      }
      :host ::ng-deep .ac-think-body .x-markdown-dark h1,
      :host ::ng-deep .ac-think-body .x-markdown-dark h2,
      :host ::ng-deep .ac-think-body .x-markdown-dark h3,
      :host ::ng-deep .ac-think-body .x-markdown-dark h4 {
        font-size: 13px;
        font-weight: 600;
        color: #bbb;
        margin: 4px 0 2px;
      }
      :host ::ng-deep .ac-think-body .x-markdown-dark h2 {
        border-left: 4px solid #3794ff;
        padding-left: 6px;
      }
      :host ::ng-deep .ac-think-body .x-markdown-dark ul,
      :host ::ng-deep .ac-think-body .x-markdown-dark ol {
        padding-left: 1.2em;
        margin: 2px 0;
      }
      :host ::ng-deep .ac-think-body .x-markdown-dark pre {
        max-width: 100%;
        overflow-x: auto;
      }
      :host ::ng-deep .ac-think-body .x-markdown-dark table {
        max-width: 100%;
        display: block;
        overflow-x: auto;
      }
      :host ::ng-deep .ac-think-body .x-markdown-dark th,
      :host ::ng-deep .ac-think-body .x-markdown-dark td {
        padding: 4px 8px;
        font-size: 12px;
      }
      :host ::ng-deep .ac-think-body .x-markdown-dark blockquote {
        margin: 4px 0;
        padding: 2px 8px;
      }
      @keyframes ac-spin {
        to {
          transform: rotate(360deg);
        }
      }
      .ac-spin {
        animation: ac-spin 0.8s linear infinite;
        display: inline-block;
      }
    `,
  ],
})
export class XAilyThinkViewerComponent implements AfterViewChecked, OnChanges {
  @Input() data: {
    content?: string;
    encoded?: boolean;
    isComplete?: boolean;
  } | null = null;
  @ViewChild('thinkBody') thinkBodyRef?: ElementRef<HTMLElement>;

  thinkContent = '';
  thinkExpanded = false;
  markdownContent = signal('');
  streamingConfig = signal<StreamingOption>({ hasNextChunk: false, enableAnimation: false });
  readonly componentMap: ComponentMap = { code: AilyChatCodeComponent };
  private shouldScrollThink = false;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['data']) {
      if (!this.data) return;
      let raw = this.data.content || '';
      if (this.data.encoded) {
        try {
          raw = decodeURIComponent(atob(raw));
        } catch {
          /* ignore */
        }
      }
      const prev = this.thinkContent;
      this.thinkContent = raw;

      // 流式中对未闭合的 markdown 结构补全闭合标签
      const displayContent = this.data.isComplete ? raw : raw + getClosingTagsForOpenBlocks(raw);
      this.markdownContent.set(displayContent);
      this.streamingConfig.set({ hasNextChunk: !this.data.isComplete });
      if (raw.length > prev.length) this.shouldScrollThink = true;
      this.thinkExpanded = !this.data.isComplete;
    }
  }

  ngAfterViewChecked(): void {
    if (this.shouldScrollThink && this.thinkBodyRef?.nativeElement) {
      const el = this.thinkBodyRef.nativeElement;
      el.scrollTop = el.scrollHeight;
      this.shouldScrollThink = false;
    }
  }
}
