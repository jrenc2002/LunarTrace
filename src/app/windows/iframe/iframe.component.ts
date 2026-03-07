import {
  Component,
  Inject,
  OnDestroy,
  Optional,
  OnInit,
  NgZone,
} from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { NZ_MODAL_DATA } from 'ng-zorro-antd/modal';
import { ActivatedRoute } from '@angular/router';
import { ElectronService } from '../../services/electron.service';
import { ConnectionGraphService } from '../../services/connection-graph.service';
import { NoticeService } from '../../services/notice.service';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { NotificationComponent } from '../../components/notification/notification.component';
import { CommonModule } from '@angular/common';
import { WindowMessenger, connect, Connection } from 'penpal';
import type { ProgressEvent } from '../../services/background-agent.service';

/** iframe IPC 统一载荷（规范：docs/iframe-ipc-spec.md） */
export interface IframeIpcPayload<T = unknown> {
  type: string;
  data?: T;
}

/** connection-graph 模块 type 枚举 */
export type ConnectionGraphIpcType =
  | 'generate-graph-data'
  | 'generate-graph-updated'
  | 'generate-graph-progress'
  | 'get-graph-data'
  | 'save-graph-data'
  | 'regenerate-graph-data'
  | 'generate-graph-code';

const IFRAME_CHANNEL_CONNECTION_GRAPH = 'iframe-message-connection-graph';

export interface IframeModalData {
  /** 要加载的 iframe URL */
  url: string;
  /** 传递给 iframe 页面的数据 */
  data?: unknown;
  /** 窗口标题 */
  title?: string;
}

@Component({
  selector: 'app-iframe',
  imports: [SubWindowComponent, NotificationComponent, CommonModule],
  templateUrl: './iframe.component.html',
  styleUrl: './iframe.component.scss',
})
export class IframeComponent implements OnInit, OnDestroy {
  iframeSrc: SafeResourceUrl = '';
  private iframeData: unknown;
  private allowedOrigins: string[] = ['*'];

  // Penpal 连接
  private penpalConnection: Connection | null = null;
  private remoteApi: any = null;

  // IPC 初始化数据清理函数
  private initDataCleanup: (() => void) | null = null;

  // 窗口标题
  windowTitle = '';

  // 无数据状态显示控制
  showEmptyState = false;
  // Loading 状态显示控制
  isLoading = true;
  // 文件更新提示
  hasUpdate = false;

  // ===== 连线图自动生成相关 =====
  /** 是否为连线图窗口 */
  isConnectionGraphWindow = false;
  /** 是否正在生成中 */
  isGenerating = false;
  /** connection-graph IPC 统一监听清理函数 */
  private connectionGraphIpcCleanup: (() => void) | null = null;

  constructor(
    @Optional() @Inject(NZ_MODAL_DATA) public data: IframeModalData | null,
    private sanitizer: DomSanitizer,
    private route: ActivatedRoute,
    private electronService: ElectronService,
    private connectionGraphService: ConnectionGraphService,
    private noticeService: NoticeService,
    private ngZone: NgZone,
  ) {
    // 如果是从 modal 打开，使用 modal data
    console.log('🚀 ~ IframeComponent ~ constructor ~ data:', data);
    if (this.data) {
      if (this.data.url) {
        this.applyUrl(this.data.url);
      }
      if (this.data.data) {
        this.iframeData = this.data.data;
      }
      if (this.data.title) {
        this.windowTitle = this.data.title;
      }
    }
  }

  async ngOnInit() {
    // 延迟显示无数据状态（如果加载失败）
    setTimeout(() => {
      if (this.isLoading) {
        this.isLoading = false;
        this.showEmptyState = true;
      }
    }, 10000); // 10秒超时

    await new Promise((resolve) => setTimeout(resolve, 100));

    // 如果不是 modal 模式，从 URL 查询参数读取
    if (!this.data) {
      this.route.queryParams.subscribe((params) => {
        const url = params['url'];
        if (url) {
          this.applyUrl(url);
        }
      });

      // 监听来自 openWindow 的 IPC 初始化数据
      if (this.electronService.isElectron && window['subWindow']?.onInitData) {
        this.initDataCleanup = window['subWindow'].onInitData(
          (initData: any) => {
            this.handleInitData(initData);
          },
        );
      }
    }
  }

  /**
   * 统一应用 URL：设置 iframeSrc、allowedOrigins、isConnectionGraphWindow
   */
  private applyUrl(url: string): void {
    this.iframeSrc = this.sanitizer.bypassSecurityTrustResourceUrl(url);
    try {
      this.allowedOrigins = [new URL(url).origin];
    } catch {
      this.allowedOrigins = ['*'];
    }
    if (url.includes('connection-graph')) {
      this.isConnectionGraphWindow = true;
    }
  }

  /**
   * 处理来自 openWindow 传递的 IPC 初始化数据
   */
  private handleInitData(initData: any): void {
    console.log(
      '[IframeComponent] handleInitData received:',
      initData ? 'has data' : 'null',
    );
    if (!initData) return;

    if (initData.title) {
      this.windowTitle = initData.title;
    }

    if (initData.url) {
      this.applyUrl(initData.url);
    }

    this.iframeData = initData.data !== undefined ? initData.data : initData;
  }

  /**
   * iframe 加载完成后，使用 penpal 建立连接
   */
  onIframeLoad(event: Event): void {
    const iframe = event.target as HTMLIFrameElement;
    if (!iframe.contentWindow) {
      this.handleLoadError();
      return;
    }

    // 销毁旧连接，避免连接残留
    if (this.penpalConnection) {
      this.penpalConnection.destroy();
      this.penpalConnection = null;
      this.remoteApi = null;
    }

    this.startPenpalConnection(iframe);
  }

  /**
   * 使用 penpal 建立与 iframe 的双向通信
   */
  private async startPenpalConnection(
    iframe: HTMLIFrameElement,
  ): Promise<void> {
    try {
      const messenger = new WindowMessenger({
        remoteWindow: iframe.contentWindow!,
        allowedOrigins: this.allowedOrigins,
      });

      // 父窗口暴露给子页面的方法
      this.penpalConnection = connect({
        messenger,
        methods: {
          inited: () => {
            this.pushDataToRemote();
          },
          generateGraphData: () => {
            console.log(
              '🚀 ~ IframeComponent ~ startPenpalConnection ~ generateGraphData:',
            );
            this.sendToMain('generate-graph-data');
          },
          // 子页面调用此方法通过 IPC 实时获取连线图 payload（type: get-graph-data）
          getGraphData: () => {
            if (!this.electronService.isElectron || !window['ipcRenderer']) {
              return Promise.resolve(this.iframeData ?? null);
            }
            const messageId = Date.now() + '-' + Math.random().toString(36).slice(2);
            console.log("🚀 ~ IframeComponent ~ getGraphData ~ messageId:", messageId)
            return new Promise<unknown>((resolve) => {
              const timeoutId = setTimeout(() => {
                // window['ipcRenderer'].removeListener(IFRAME_CHANNEL_CONNECTION_GRAPH, listener);
                resolve(this.iframeData ?? null);
              }, 5000);
              const listener = (_event: unknown, p: { type?: string; data?: { messageId?: string; payload?: unknown } }) => {
                if (p?.type === 'get-graph-data' && p?.data?.messageId === messageId) {
                  clearTimeout(timeoutId);
                  // window['ipcRenderer'].removeListener(IFRAME_CHANNEL_CONNECTION_GRAPH, listener);
                  resolve(p.data?.payload ?? this.iframeData ?? null);
                }
              };
              window['ipcRenderer'].on(IFRAME_CHANNEL_CONNECTION_GRAPH, listener);
              this.sendToMain('get-graph-data', { messageId });
            });
          },
          // 子页面编辑连线后回调此方法，持久化更新
          onConnectionsChanged: (connections: any) => {
            try {
              if (connections && Array.isArray(connections)) {
                // 获取当前 payload 数据（包含 componentConfigs, components, connections）
                const currentPayload = this.iframeData as any;
                if (currentPayload && currentPayload.components) {
                  // 通过 IPC 让主窗口保存数据（子窗口无法直接访问 projectPath）
                  const updatedData = {
                    version: '1.0.0',
                    description: '',
                    components: currentPayload.components,
                    connections: connections,
                  };
                  this.sendToMain('save-graph-data', updatedData);
                  this.iframeData = {
                    ...currentPayload,
                    connections: connections,
                  };
                  console.log(
                    '[IframeComponent] 已发送保存请求:',
                    connections.length,
                  );
                }
              }
            } catch (e) {
              console.warn('onConnectionsChanged 持久化失败:', e);
            }
          },
        },
      });

      const remote = await this.penpalConnection.promise;
      this.remoteApi = remote;

      // 将 remote API 注册到 ConnectionGraphService，供 Agent 工具推送数据
      this.connectionGraphService.setIframeApi(remote);

      // 连接成功，结束 loading
      this.isLoading = false;
      this.showEmptyState = false;

      // 开始监听 connection-graph IPC（统一按 type 分发）
      if (this.isConnectionGraphWindow) {
        this.startConnectionGraphIpcListener();
      }
    } catch (error) {
      console.error('Penpal 连接失败:', error);
      // 连接失败时降级：使用 postMessage 发送数据
      this.isLoading = false;
      this.showEmptyState = false;
    }
  }

  /**
   * 向主窗口发送 connection-graph IPC 消息（规范：iframe-message-connection-graph）
   */
  private sendToMain(type: ConnectionGraphIpcType, data?: unknown): void {
    if (!this.electronService.isElectron || !window['ipcRenderer']) return;
    window['ipcRenderer'].send(IFRAME_CHANNEL_CONNECTION_GRAPH, { type, data });
  }

  /**
   * 推送数据给已连接的子页面（penpal 方式）
   */
  private async pushDataToRemote(): Promise<void> {
    if (!this.remoteApi) return;
    try {
      if (typeof this.remoteApi['receiveData'] === 'function') {
        await (
          this.remoteApi['receiveData'] as (data: unknown) => Promise<void>
        )(this.iframeData);
      }
    } catch (error) {
      console.warn('推送数据给子页面失败:', error);
    }
  }

  /**
   * 处理加载错误
   */
  handleLoadError(): void {
    this.isLoading = false;
    this.showEmptyState = true;
  }

  /**
   * 调用子页面暴露的远程方法
   */
  async callRemote(method: string, ...args: any[]): Promise<any> {
    if (!this.remoteApi || typeof this.remoteApi[method] !== 'function') {
      console.warn(`远程方法 ${method} 不可用`);
      return null;
    }
    return this.remoteApi[method](...args);
  }

  /**
   * 开始监听 connection-graph IPC（统一按 type 分发，规范：docs/iframe-ipc-spec.md）
   */
  private startConnectionGraphIpcListener(): void {
    if (!this.electronService.isElectron || !window['ipcRenderer']) return;

    const handler = (_event: unknown, payload: IframeIpcPayload) => {
      const { type, data } = payload ?? {};
      switch (type) {
        case 'generate-graph-updated':
          this.ngZone.run(() => this.handleConnectionGraphUpdate(data));
          break;
        case 'get-graph-data': {
          const messageId = (data as { messageId?: string })?.messageId;
          if (messageId) {
            this.sendToMain('get-graph-data', {
              messageId,
              payload: this.iframeData,
            });
          }
          break;
        }
        case 'generate-graph-data':
          this.ngZone.run(() => {
            this.isGenerating = true;
            this.noticeService.update({
              title: 'AI生成中',
              text: '正在准备生成连线图...',
              state: 'doing',
              showProgress: false,
            });
          });
          break;
        case 'generate-graph-progress':
          this.ngZone.run(() =>
            this.handleProgressEvent(data as ProgressEvent),
          );
          break;
      }
    };

    window['ipcRenderer'].on(IFRAME_CHANNEL_CONNECTION_GRAPH, handler);
    this.connectionGraphIpcCleanup = () => {
      window['ipcRenderer'].removeListener(
        IFRAME_CHANNEL_CONNECTION_GRAPH,
        handler,
      );
    };
  }

  ngOnDestroy(): void {
    if (this.connectionGraphIpcCleanup) {
      this.connectionGraphIpcCleanup();
      this.connectionGraphIpcCleanup = null;
    }
    // 清除 ConnectionGraphService 中的 iframe API 引用
    this.connectionGraphService.clearIframeApi();
    if (this.penpalConnection) {
      this.penpalConnection.destroy();
      this.penpalConnection = null;
    }
    if (this.initDataCleanup) {
      this.initDataCleanup();
      this.initDataCleanup = null;
    }
  }

  // =====================================================
  // connection-graph IPC 消息处理
  // =====================================================

  /**
   * 处理连线图全量更新
   */
  private async handleConnectionGraphUpdate(data: any): Promise<void> {
    if (!data) return;
    try {
      // 使用 IPC 发送过来的完整 payload（包含最新的 componentConfigs）
      const currentPayload = this.iframeData as any;
      const newPayload = {
        // 优先使用新的 componentConfigs，如果没有则保留旧的
        componentConfigs:
          data.componentConfigs || currentPayload?.componentConfigs || {},
        components: data.components || [],
        connections: data.connections || [],
        theme: data.theme || currentPayload?.theme || 'dark',
      };
      this.iframeData = newPayload;
      await this.pushDataToRemote();
      this.noticeService.update({
        title: 'AI生成中',
        text: '连线图已自动更新',
        state: 'done',
        setTimeout: 3000,
      });
    } catch (error) {
      console.error('[IframeComponent] 处理连线图更新失败:', error);
    }
  }

  /**
   * 关闭更新提示（用户选择不刷新）
   */
  dismissUpdate(): void {
    this.hasUpdate = false;
  }

  // =====================================================
  // 连线图自动生成 - 进度处理 & 操作按钮
  // =====================================================

  /**
   * 处理进度事件 → 更新 notice 通知栏
   */
  private handleProgressEvent(event: ProgressEvent): void {
    if (!event) return;
    switch (event.type) {
      case 'thinking':
        this.noticeService.update({
          title: 'AI生成中',
          text: event.content || '正在分析项目...',
          state: 'doing',
          showProgress: false,
        });
        break;
      case 'tool_call':
        this.noticeService.update({
          title: 'AI生成中',
          text: event.content || '正在执行工具...',
          state: 'doing',
          showProgress: false,
        });
        break;
      case 'tool_result':
        this.noticeService.update({
          title: 'AI生成中',
          text: event.content || '工具执行完成',
          state: 'doing',
          showProgress: false,
        });
        break;
      case 'complete':
        this.isGenerating = false;
        this.noticeService.update({
          title: 'AI生成完成',
          text: '连线图生成完成',
          state: 'done',
          setTimeout: 3000,
        });
        break;
      case 'error':
        this.isGenerating = false;
        this.noticeService.update({
          title: 'AI生成失败',
          text: event.content || '生成失败',
          state: 'error',
          setTimeout: 5000,
        });
        break;
      default:
        if (event.content) {
          this.noticeService.update({
            title: 'AI生成中',
            text: event.content,
            state: 'doing',
            showProgress: false,
          });
        }
    }
  }

  /**
   * 操作按钮: 重新生成
   */
  onRegenerate(): void {
    this.isGenerating = true;
    this.noticeService.update({
      title: 'AI生成中',
      text: '正在重新生成连线图...',
      state: 'doing',
      showProgress: false,
    });

    this.callRemote('clearCache').catch(() => {
      // 子页面未暴露 clearCache 时静默忽略
    });

    this.sendToMain('regenerate-graph-data');
  }

  /**
   * 操作按钮: 同步到代码
   */
  onSyncToCode(): void {
    this.sendToMain('generate-graph-code');
  }
}
