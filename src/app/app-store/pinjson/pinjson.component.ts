import { Component, Inject, OnDestroy } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { NZ_MODAL_DATA } from 'ng-zorro-antd/modal';

export interface PinjsonModalData {
  /** pinjson.json 解析后的数据 */
  jsonData: unknown;
  /** component-viewer 基础 URL，默认 http://localhost:4202/component-viewer */
  iframeBaseUrl?: string;
  /** 组件 id，用于 URL 参数，默认使用时间戳生成 */
  componentId?: string;
}

@Component({
  selector: 'app-pinjson',
  imports: [],
  templateUrl: './pinjson.component.html',
  styleUrl: './pinjson.component.scss'
})
export class PinjsonComponent implements OnDestroy {
  iframeSrc: SafeResourceUrl;
  private jsonData: unknown;
  private allowedOrigins: string[];
  
  // PostMessage 通信相关
  private iframeElement: HTMLIFrameElement | null = null;
  private messageListenerBound: ((event: MessageEvent) => void) | null = null;
  private childReadyReceived = false;
  private dataConfirmed = false;

  constructor(
    @Inject(NZ_MODAL_DATA) public data: PinjsonModalData,
    private sanitizer: DomSanitizer
  ) {
    this.jsonData = data.jsonData;
    const baseUrl = data.iframeBaseUrl || 'http://localhost:4202/component-viewer';
    const id = data.componentId || `component_${Date.now()}`;
    const url = `${baseUrl}?id=${encodeURIComponent(id)}&type=json`;
    this.iframeSrc = this.sanitizer.bypassSecurityTrustResourceUrl(url);
    try {
      this.allowedOrigins = [new URL(baseUrl).origin];
    } catch {
      this.allowedOrigins = ['*'];
    }

    // 设置 PostMessage 监听
    this.setupPostMessageListener();
  }

  onIframeLoad(event: Event): void {
    const iframe = event.target as HTMLIFrameElement;
    this.iframeElement = iframe;
  }

  /**
   * 设置 PostMessage 监听器
   */
  private setupPostMessageListener(): void {
    this.messageListenerBound = this.handlePostMessage.bind(this);
    window.addEventListener('message', this.messageListenerBound);
  }

  /**
   * 处理来自子窗口的 PostMessage
   */
  private handlePostMessage(event: MessageEvent): void {
    // 验证消息来源（可选）
    // if (this.allowedOrigins[0] !== '*' && !this.allowedOrigins.includes(event.origin)) {
    //   return;
    // }

    const message = event.data;
    
    // 确保消息格式正确
    if (!message || typeof message !== 'object') return;
    
    // 确保是来自子端的消息
    if (message.source !== 'aily-component-viewer') return;

    switch (message.type) {
      case 'CHILD_READY':
        // 子端已就绪，发送数据
        this.handleChildReady();
        break;

      case 'DATA_RECEIVED':
        // 子端确认收到数据
        this.handleDataConfirmed();
        break;

      case 'PONG':
        // 子端响应健康检查
        console.log('PostMessage: 收到子端 PONG 响应');
        break;
    }
  }

  /**
   * 处理子端就绪信号
   */
  private handleChildReady(): void {
    if (!this.childReadyReceived) {
      console.log('PostMessage: 收到子端就绪信号');
      this.childReadyReceived = true;
    }

    // 发送数据到子端
    this.sendDataToChild();
  }

  /**
   * 发送数据到子窗口
   */
  private sendDataToChild(): void {
    if (!this.iframeElement?.contentWindow) return;

    const targetOrigin = this.allowedOrigins[0] || '*';
    
    // 方式1：使用 PARENT_READY 消息（带数据）
    this.iframeElement.contentWindow.postMessage(
      {
        type: 'PARENT_READY',
        source: 'aily-component-parent',
        data: this.jsonData,
        timestamp: Date.now(),
      },
      targetOrigin
    );

    // 方式2：同时发送 COMPONENT_DATA 消息（双保险）
    setTimeout(() => {
      if (!this.dataConfirmed && this.iframeElement?.contentWindow) {
        this.iframeElement.contentWindow.postMessage(
          {
            type: 'COMPONENT_DATA',
            source: 'aily-component-parent',
            data: this.jsonData,
            timestamp: Date.now(),
          },
          targetOrigin
        );
      }
    }, 100);
  }

  /**
   * 处理子端数据确认
   */
  private handleDataConfirmed(): void {
    this.dataConfirmed = true;
    console.log('PostMessage: 子端已确认收到数据');
  }

  /**
   * 向子端发送健康检查 PING
   */
  private sendPingToChild(): void {
    if (!this.iframeElement?.contentWindow) return;

    const targetOrigin = this.allowedOrigins[0] || '*';
    this.iframeElement.contentWindow.postMessage(
      {
        type: 'PING',
        source: 'aily-component-parent',
        timestamp: Date.now(),
      },
      targetOrigin
    );
  }

  /**
   * 清理 PostMessage 通信资源
   */
  private cleanupPostMessage(): void {
    if (this.messageListenerBound) {
      window.removeEventListener('message', this.messageListenerBound);
      this.messageListenerBound = null;
    }
  }

  ngOnDestroy(): void {
    this.cleanupPostMessage();
  }
}
