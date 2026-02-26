import {
  Component,
  Input,
  ViewChild,
  ElementRef,
  AfterViewChecked,
  OnChanges,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'x-aily-think-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="ac-think" [class.expanded]="thinkExpanded">
      <div class="ac-think-header" (click)="thinkExpanded = !thinkExpanded">
        <i
          class="fa-light"
          [class]="data?.isComplete ? 'fa-lightbulb' : 'fa-rotate ac-spin'"
        ></i>
        <span>{{ data?.isComplete ? 'Think' : 'Thinking...' }}</span>
        <i class="fa-light fa-chevron-down ac-think-arrow"></i>
      </div>
      @if (thinkExpanded) {
        <div class="ac-think-body" #thinkBody>{{ thinkContent }}</div>
      }
    </div>
  `,
  styles: [
    `
      .ac-think {
        border: 1px solid #3c3c3c;
        border-radius: 5px;
        margin: 4px 0;
        overflow: hidden;
        background: #222427;
      }
      .ac-think-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        cursor: pointer;
        font-size: 13px;
        color: #a5a5a5;
        user-select: none;
        transition: background 0.2s;
      }
      .ac-think-header:hover {
        background: rgba(255, 255, 255, 0.04);
      }
      .ac-think-arrow {
        margin-left: auto;
        font-size: 10px;
        color: #666;
        transition: transform 0.2s;
      }
      .ac-think.expanded .ac-think-arrow {
        transform: rotate(180deg);
      }
      .ac-think-body {
        padding: 6px 12px 10px;
        font-size: 12px;
        color: #777;
        line-height: 1.7;
        white-space: pre-wrap;
        border-top: 1px solid #3c3c3c;
        max-height: 220px;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.15) transparent;
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
