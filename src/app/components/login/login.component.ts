import { CommonModule } from '@angular/common';
import { Component, ViewChild, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subject, takeUntil, interval, Subscription } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { ElectronService } from '../../services/electron.service';
import sha256 from 'crypto-js/sha256';
import { AltchaComponent } from './altcha/altcha.component';

@Component({
  selector: 'app-login',
  imports: [
    NzButtonModule,
    CommonModule,
    FormsModule,
    NzIconModule,
    NzInputModule,
    TranslateModule,
    AltchaComponent,
  ],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss'
})
export class LoginComponent implements OnDestroy {
  private destroy$ = new Subject<void>();

  @ViewChild(AltchaComponent) altchaComponent!: AltchaComponent;

  showWeChatLogin = false;
  showPhoneLogin = true;

  isWaiting = false;
  inputUsername = '';
  inputPassword = '';
  
  // 控制组件显隐：未登录时显示，已登录时隐藏
  showLogin = true;

  // 微信扫码登录相关属性
  wechatQrcodeUrl: string | null = null;
  wechatTicket: string | null = null;
  wechatStatus: 'loading' | 'pending' | 'confirmed' | 'expired' | 'error' = 'loading';
  wechatStatusMessage: string = '';
  wechatCheckSubscription: Subscription | null = null;

  constructor(
    private authService: AuthService,
    private message: NzMessageService,
    private electronService: ElectronService,
    private translate: TranslateService
  ) {
    // 监听登录状态，控制组件显隐
    this.authService.isLoggedIn$
      .pipe(takeUntil(this.destroy$))
      .subscribe(isLoggedIn => {
        // 未登录时显示组件，已登录时隐藏组件
        this.showLogin = !isLoggedIn;
      });
  }

  onCloseDialog(): void {
    // this.modal.close({ result: 'cancel' });
  }

  mode = '';
  select(mode) {
    this.mode = mode;
    // 当选择微信登录时，初始化二维码
    if (mode === 'wechat') {
      this.initWeChatLogin();
    } else {
      // 切换到其他登录方式时，清理微信登录状态
      this.cleanupWeChatLogin();
    }
  }

  /**
   * 初始化微信扫码登录
   */
  initWeChatLogin() {
    this.wechatStatus = 'loading';
    this.wechatQrcodeUrl = null;
    this.wechatTicket = null;
    this.wechatStatusMessage = '';

    // 获取二维码
    this.authService.getWeChatQrcode().subscribe({
      next: (response) => {
        if (response.status === 200 && response.data) {
          this.wechatTicket = response.data.ticket;
          this.wechatQrcodeUrl = response.data.qrcode_url;
          this.wechatStatus = 'pending';
          this.wechatStatusMessage = this.translate.instant('LOGIN.WECHAT_SCAN') || '请使用微信扫码登录';
          
          // 开始轮询检查扫码状态
          this.startWeChatStatusCheck();
        } else {
          this.wechatStatus = 'error';
          this.wechatStatusMessage = response.message || this.translate.instant('LOGIN.WECHAT_QRCODE_FAILED') || '获取二维码失败';
          this.message.error(this.wechatStatusMessage);
        }
      },
      error: (error) => {
        console.error('获取微信二维码失败:', error);
        this.wechatStatus = 'error';
        this.wechatStatusMessage = this.translate.instant('LOGIN.WECHAT_QRCODE_FAILED') || '获取二维码失败';
        this.message.error(this.wechatStatusMessage);
      }
    });
  }

  /**
   * 开始轮询检查微信扫码状态
   */
  startWeChatStatusCheck() {
    // 先清理之前的订阅
    this.cleanupWeChatStatusCheck();

    if (!this.wechatTicket) {
      return;
    }

    // 每2秒检查一次扫码状态
    this.wechatCheckSubscription = interval(2000).pipe(
      takeUntil(this.destroy$)
    ).subscribe(() => {
      if (!this.wechatTicket) {
        return;
      }

      this.authService.checkWeChatStatus(this.wechatTicket).subscribe({
        next: (response) => {
          if (response.status === 200 && response.data) {
            const status = response.data.status;

            if (status === 'pending') {
              // 等待扫码
              this.wechatStatus = 'pending';
              this.wechatStatusMessage = response.data.message || this.translate.instant('LOGIN.WECHAT_WAITING') || '等待扫码';
            } else if (status === 'confirmed') {
              // 扫码成功，登录成功
              this.wechatStatus = 'confirmed';
              this.cleanupWeChatStatusCheck();
              
              // 处理登录成功
              if (response.data.access_token) {
                this.authService.handleWeChatOAuthSuccess({
                  access_token: response.data.access_token,
                  refresh_token: response.data.refresh_token,
                  user: response.data.user
                }).then(() => {
                  this.message.success(
                    response.data.is_new_user 
                      ? (this.translate.instant('LOGIN.WECHAT_REGISTER_SUCCESS') || '注册成功')
                      : (this.translate.instant('LOGIN.LOGIN_SUCCESS') || '登录成功')
                  );
                }).catch((error) => {
                  console.error('处理微信登录成功数据失败:', error);
                  this.message.error(this.translate.instant('LOGIN.LOGIN_FAILED') || '登录失败');
                });
              }
            } else if (status === 'expired') {
              // 二维码已过期
              this.wechatStatus = 'expired';
              this.wechatStatusMessage = response.data.message || this.translate.instant('LOGIN.WECHAT_EXPIRED') || '二维码已过期，请刷新';
              this.cleanupWeChatStatusCheck();
              this.message.warning(this.wechatStatusMessage);
            }
          }
        },
        error: (error) => {
          console.error('检查微信扫码状态失败:', error);
          // 如果是404错误，说明ticket不存在或已过期
          if (error.status === 404) {
            this.wechatStatus = 'expired';
            this.wechatStatusMessage = this.translate.instant('LOGIN.WECHAT_EXPIRED') || '二维码已过期，请刷新';
            this.cleanupWeChatStatusCheck();
            this.message.warning(this.wechatStatusMessage);
          }
        }
      });
    });
  }

  /**
   * 清理微信扫码状态检查
   */
  cleanupWeChatStatusCheck() {
    if (this.wechatCheckSubscription) {
      this.wechatCheckSubscription.unsubscribe();
      this.wechatCheckSubscription = null;
    }
  }

  /**
   * 清理微信登录状态
   */
  cleanupWeChatLogin() {
    this.cleanupWeChatStatusCheck();
    this.wechatQrcodeUrl = null;
    this.wechatTicket = null;
    this.wechatStatus = 'loading';
    this.wechatStatusMessage = '';
  }

  /**
   * 刷新微信二维码
   */
  refreshWeChatQrcode() {
    this.cleanupWeChatLogin();
    this.initWeChatLogin();
  }

  /**
   * 获取微信加载文本
   */
  getWeChatLoadingText(): string {
    const translated = this.translate.instant('LOGIN.WECHAT_LOADING');
    return translated !== 'LOGIN.WECHAT_LOADING' ? translated : '正在加载二维码...';
  }

  /**
   * 获取微信错误文本
   */
  getWeChatErrorText(): string {
    const translated = this.translate.instant('LOGIN.WECHAT_QRCODE_FAILED');
    return translated !== 'LOGIN.WECHAT_QRCODE_FAILED' ? translated : '获取二维码失败';
  }

  /**
   * 获取微信状态消息
   */
  getWeChatStatusMessage(): string {
    if (this.wechatStatusMessage) {
      return this.wechatStatusMessage;
    }
    const translated = this.translate.instant('LOGIN.WECHAT_SCAN');
    return translated !== 'LOGIN.WECHAT_SCAN' ? translated : '请使用微信扫码登录';
  }

  /**
   * 获取微信成功文本
   */
  getWeChatSuccessText(): string {
    const translated = this.translate.instant('LOGIN.LOGIN_SUCCESS');
    return translated !== 'LOGIN.LOGIN_SUCCESS' ? translated : '登录成功';
  }

  /**
   * 获取微信刷新文本
   */
  getWeChatRefreshText(): string {
    const translated = this.translate.instant('LOGIN.WECHAT_REFRESH');
    return translated !== 'LOGIN.WECHAT_REFRESH' ? translated : '刷新二维码';
  }

  /**
   * 获取微信重试文本
   */
  getWeChatRetryText(): string {
    const translated = this.translate.instant('LOGIN.WECHAT_RETRY');
    return translated !== 'LOGIN.WECHAT_RETRY' ? translated : '重试';
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
    this.cleanupWeChatLogin();
  }

  onButtonClick(action: string): void {
    if (action === 'cancel') {
      // this.modal.close({ result: 'cancel' });
    } else if (action === 'agree') {
      // this.modal.close({ result: 'agree' });
    }
  }

  /**
   * 执行 altcha 隐式验证
   * @returns Promise<string | null> 返回验证 token，验证失败返回 null
   */
  private async verifyAltcha(): Promise<string | null> {
    if (!this.altchaComponent) {
      // 如果 altcha 组件不存在，允许继续（向后兼容）
      return null;
    }

    try {
      const token = await this.altchaComponent.triggerVerification();
      return token;
    } catch (error) {
      console.error('Altcha 验证失败:', error);
      this.message.error(this.translate.instant('LOGIN.VERIFICATION_FAILED') || '验证失败，请重试');
      return null;
    }
  }

  /**
   * 执行实际的GitHub登录流程
   */
  async loginByGithub() {
    try {
      // TODO: 临时注释掉验证逻辑
      // const altchaToken = await this.verifyAltcha();
      // if (altchaToken === null) {
      //   return;
      // }

      // 直接通过 HTTP 请求启动 GitHub OAuth 流程
      this.authService.startGitHubOAuth().subscribe({
        next: (response) => {
          // 使用 ElectronService 在系统浏览器中打开授权页面
          if (this.electronService.isElectron) {
            this.electronService.openUrl(response.authorization_url);
            this.message.info(this.translate.instant('LOGIN.REDIRECTING_GITHUB'));
          } else {
            // 如果不在 Electron 环境中，使用 window.open 作为降级方案
            window.open(response.authorization_url, '_blank');
            this.message.info(this.translate.instant('LOGIN.REDIRECTING_GITHUB'));
          }
        },
        error: (error) => {
          console.error('启动 GitHub OAuth 失败:', error);
          this.message.error(this.translate.instant('LOGIN.GITHUB_LOGIN_FAILED'));
        }
      });
    } catch (error) {
      console.error('GitHub 登录出错:', error);
      this.message.error(this.translate.instant('LOGIN.GITHUB_ERROR'));
    }
  }

  async loginByPhone() {
    if (!this.inputUsername || !this.inputPassword) {
      this.message.warning(this.translate.instant('LOGIN.ENTER_CREDENTIALS'));
      return;
    }

    // 立即显示加载状态，避免用户感觉按钮无响应
    this.isWaiting = true;

    // TODO: 临时注释掉验证逻辑
    // const altchaToken = await this.verifyAltcha();
    // if (altchaToken === null) {
    //   this.isWaiting = false;
    //   return;
    // }
    const altchaToken = '';

    try {
      const loginData = {
        username: this.inputUsername,
        password: sha256(this.inputPassword).toString(),
        altcha: altchaToken
      };

      this.authService.login(loginData).subscribe({
        next: (response) => {
          if (response.status === 200 && response.data) {
            this.message.success(this.translate.instant('LOGIN.LOGIN_SUCCESS'));
          } else {
            this.message.error(response.message || this.translate.instant('LOGIN.LOGIN_FAILED'));
          }
        },
        error: (error) => {
          console.error('登录错误:', error);
          this.message.error(this.translate.instant('LOGIN.LOGIN_NETWORK_ERROR'));
        },
        complete: () => {
          this.isWaiting = false;
        }
      });
    } catch (error) {
      console.error('登录过程中出错:', error);
      this.message.error(this.translate.instant('LOGIN.LOGIN_FAILED'));
      this.isWaiting = false;
    }
  }
}
