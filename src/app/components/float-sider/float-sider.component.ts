import { Component, Input, OnInit, OnDestroy, ViewChild } from '@angular/core';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { CommonModule } from '@angular/common';
import { ProjectService } from '../../services/project.service';
import { Router, NavigationEnd } from '@angular/router';
import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { ElectronService } from '../../services/electron.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { UiService } from '../../services/ui.service';
import { ConnectionGraphService } from '../../services/connection-graph.service';
import { BackgroundAgentService } from '../../services/background-agent.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ImageViewerComponent } from '../image-viewer/image-viewer.component';
@Component({
  selector: 'app-float-sider',
  imports: [
    NzToolTipModule,
    CommonModule,
    TranslateModule,
    ImageViewerComponent
  ],
  templateUrl: './float-sider.component.html',
  styleUrl: './float-sider.component.scss'
})
export class FloatSiderComponent implements OnInit, OnDestroy {
  @Input() show = false;
  @ViewChild('imageViewer') imageViewer!: ImageViewerComponent;

  loaded = false;
  private routerSubscription: Subscription | undefined;

  constructor(
    private projectService: ProjectService,
    private router: Router,
    private electronService: ElectronService,
    private message: NzMessageService,
    private uiService: UiService,
    private connectionGraphService: ConnectionGraphService,
    private backgroundAgent: BackgroundAgentService,
    private translate: TranslateService
  ) { }

  ngOnInit() {
    // 监听路由变化
    if (this.router.url.indexOf('/main/blockly-editor') !== -1) {
      this.loaded = true;
      this.loadBoardInfo();
    }
    this.routerSubscription = this.router.events
      .pipe(filter(event => event instanceof NavigationEnd))
      .subscribe((event: NavigationEnd) => {
        if (event.url.indexOf('/main/blockly-editor') !== -1) {
          this.loaded = true;
          this.loadBoardInfo();
        } else {
          this.loaded = false;
        }
      });
  }

  ngOnDestroy() {
    // 清理订阅
    if (this.routerSubscription) {
      this.routerSubscription.unsubscribe();
    }
  }

  boardPackagePath;
  async loadBoardInfo() {
    setTimeout(async () => {
      this.boardPackagePath = await this.projectService.getBoardPackagePath();
      console.log('Board Package Path:', this.boardPackagePath);
    }, 1000); // 延时1秒，确保项目服务已准备好
  }

  showPinmap() {
    const pinmapJsonPath = this.boardPackagePath + '/pinmap.json';
    if (this.electronService.exists(pinmapJsonPath)) {
      // 使用子窗口打开，通过 URL 查询参数传递文件路径
      // this.uiService.openWindow({
      //   path: `pinjson?filePath=${encodeURIComponent(pinjsonPath)}`,
      //   width: 800,
      //   height: 600
      // });
      this.uiService.openWindow({
        path: `iframe?url=${encodeURIComponent('https://tool.aily.pro/component-viewer?type=json&theme=dark')}`,
        // path: `iframe?url=${encodeURIComponent('http://localhost:3051/component-viewer?type=json')}`,
        data: this.electronService.readFile(pinmapJsonPath),
        width: 800,
        height: 600
      });
      return;
    }
    const pinmapWebpPath = this.boardPackagePath + '/pinmap.webp';
    if (this.electronService.exists(pinmapWebpPath)) {
      this.imageViewer.open(pinmapWebpPath);
      return;
    }
    this.message.error(this.translate.instant('FLOAT_SIDER.NO_PINMAP'));
  }


  async openDocUrl() {
    let data = await this.projectService.getPackageJson();
    if (data.doc_url) {
      this.electronService.openUrl(data.doc_url);
      return;
    }

    data = JSON.parse(this.electronService.readFile(this.boardPackagePath + '/package.json'))
    if (data.url) {
      this.electronService.openUrl(data.url)
      return;
    }
    this.message.error(this.translate.instant('FLOAT_SIDER.NO_DOCUMENTATION'));
  }

  openSettings() {
    this.uiService.openProjectSettings();
  }

  openFeedback() {
    this.uiService.openFeedback();
  }

  openHistory() {
    this.uiService.openHistory();
  }

  async showCircuit() {
    // this.message.warning(this.translate.instant('COMING SOON'));
    // return;
    if (!this.electronService.isElectron || !this.boardPackagePath) {
      this.message.warning(this.translate.instant('FLOAT_SIDER.NO_PINMAP'));
      return;
    }

    let windowUrl = 'https://tool.aily.pro/connection-graph?type=json&theme=dark';
    // let windowUrl = 'http://localhost:4201/connection-graph?type=json&theme=dark';

    // 项目全路径的 MD5 作为 key，追加到 windowUrl 上
    const projectPath = this.projectService.currentProjectPath || this.projectService.projectRootPath || '';
    const key = projectPath && window['tools']?.calculateMD5
      ? await window['tools'].calculateMD5(projectPath)
      : '';
    if (key) {
      windowUrl += `&key=${encodeURIComponent(key)}`;
    }

    // 构建连线图 payload 并打开子窗口
    const payload = this.connectionGraphService.buildPayload(this.boardPackagePath);
    this.uiService.openWindow({
      path: `iframe?url=${encodeURIComponent(windowUrl)}`,
      data: payload,
      width: 900,
      height: 700,
    });

    // 延迟确保子窗口已打开并注册 IPC 监听，再获取子窗口的 payload
    setTimeout(async () => {
      if (!this.electronService.isElectron || !window['ipcRenderer']) return;
      const childPayload = await window['ipcRenderer'].invoke('get-connection-graph-payload');
      if (childPayload == null) {
        window['ipcRenderer'].send('schematic-start-generating');
        this.backgroundAgent.generateSchematic();
      }
    }, 800);
  }
}
