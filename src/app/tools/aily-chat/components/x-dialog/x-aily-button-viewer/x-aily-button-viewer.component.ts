import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChatService } from '../../../services/chat.service';

interface ButtonData {
  text: string;
  action: string;
  type?: 'primary' | 'default' | 'dashed' | 'link' | 'text';
  icon?: string;
  disabled?: boolean;
  loading?: boolean;
}

@Component({
  selector: 'x-aily-button-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (!isHistory && buttons.length) {
      <div class="ac-btns">
        @for (btn of buttons; track btn.action || $index) {
          <button
            class="ac-btn"
            [attr.data-type]="btn.type"
            [disabled]="isDisabled || btn.disabled"
            (click)="onButtonClick(btn)"
          >
            @if (btn.icon) { <i class="fa-light" [class]="btn.icon"></i> }
            {{ btn.text }}
          </button>
        }
      </div>
    }
  `,
  styles: [`
    .ac-btns { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 0; }
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
    .ac-btn[data-type="dashed"] { border-style: dashed; }
    .ac-btn[data-type="link"] { border: none; background: none; color: #1890ff; padding: 4px 6px; }
    .ac-btn[data-type="link"]:hover { color: #40a9ff; }
    .ac-btn[data-type="text"] { border: none; background: none; }
    .ac-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  `],
})
export class XAilyButtonViewerComponent implements OnChanges {
  @Input() data: any = null;

  buttons: ButtonData[] = [];
  isDisabled = false;
  isHistory = false;

  constructor(private chatService: ChatService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['data']) this.processData();
  }

  private processData(): void {
    if (!this.data) {
      this.buttons = [];
      return;
    }
    this.isHistory = this.data.isHistory === true;
    try {
      const buttonsData = this.data.buttons ?? this.data;
      if (Array.isArray(buttonsData)) {
        this.buttons = buttonsData.map((b: any) => this.normalizeButton(b));
      } else if (typeof buttonsData === 'object') {
        this.buttons = [this.normalizeButton(buttonsData)];
      } else {
        this.buttons = [];
      }
    } catch {
      this.buttons = [];
    }
  }

  private normalizeButton(b: any): ButtonData {
    return {
      text: b.text ?? b.label ?? '按钮',
      action: b.action ?? b.command ?? b.value ?? '',
      type: b.type ?? 'default',
      icon: b.icon,
      disabled: b.disabled,
      loading: b.loading,
    };
  }

  onButtonClick(btn: ButtonData): void {
    this.chatService.sendTextToChat(btn.text, { sender: 'button', type: 'button', cover: false });
  }
}
