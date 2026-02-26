import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'x-aily-context-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="ac-context">
      <div class="ac-context-header">
        <i class="fa-light fa-file-code"></i>
        <span>{{ data?.label || '代码上下文' }}</span>
      </div>
      <pre class="ac-context-body"><code>{{ content }}</code></pre>
    </div>
  `,
  styles: [`
    .ac-context {
      border: 1px solid #3c3c3c; border-radius: 5px;
      margin: 4px 0; overflow: hidden;
    }
    .ac-context-header {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 12px; background: #252526;
      border-bottom: 1px solid #3c3c3c;
      font-size: 12px; color: #888;
    }
    .ac-context-body {
      margin: 0; padding: 10px 12px; font-size: 12px;
      line-height: 1.6; overflow-x: auto;
      background: #1e1e1e; color: #abb2bf;
      font-family: Consolas, 'Courier New', monospace;
    }
  `],
})
export class XAilyContextViewerComponent {
  @Input() data: { label?: string; content?: string; encoded?: boolean } | null = null;

  get content(): string {
    if (!this.data?.content) return '';
    if (this.data.encoded) {
      try { return decodeURIComponent(atob(this.data.content)); } catch {
        try { return atob(this.data.content); } catch { return this.data.content; }
      }
    }
    return this.data.content;
  }
}
