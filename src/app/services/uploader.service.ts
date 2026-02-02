import { Injectable } from '@angular/core';
import { ActionService } from './action.service';
import { ElectronService } from './electron.service';
import { UiService } from './ui.service';

@Injectable({
  providedIn: 'root'
})
export class UploaderService {

  constructor(
    private actionService: ActionService,
    private electronService: ElectronService,
    private uiService: UiService
  ) { }

  async upload() {
    const isSerialMonitorOpen = this.uiService.isToolOpen('serial-monitor');
    try {
      if (isSerialMonitorOpen) {
        this.uiService.closeTool('serial-monitor');
      }
      const result = await this.actionService.dispatchWithFeedback('upload-begin', {}, 300000).toPromise();
      if (!this.electronService.isWindowFocused()) {
        this.electronService.notify('上传', result.data?.result?.text || '');
      }
      if (isSerialMonitorOpen) this.uiService.openTool('serial-monitor');
      return result.data?.result;
    } catch (error) {
      if (!this.electronService.isWindowFocused()) {
        this.electronService.notify('上传', '上传失败');
      }
      if (isSerialMonitorOpen) this.uiService.openTool('serial-monitor');
      throw error;
    }
  }

  /**
  * 取消当前编译过程
  */
  cancel() {
    this.actionService.dispatch('upload-cancel', {}, result => {
      if (result.success) {
      } else {
      }
    });
  }

  /**
   * 烧录 softdevice 到 nRF5 设备
   * @param softdeviceName softdevice 名称，如 "s110" 或 "none"
   * @param serialPort 串口名称
   * @returns Promise 表示烧录结果
   */
  async flashSoftdevice(softdeviceName: string, serialPort: string): Promise<{ success: boolean; message: string }> {
    const isSerialMonitorOpen = this.uiService.isToolOpen('serial-monitor');
    try {
      if (isSerialMonitorOpen) {
        this.uiService.closeTool('serial-monitor');
      }
      const result = await this.actionService.dispatchWithFeedback('flash-softdevice', {
        softdeviceName,
        serialPort
      }, 300000).toPromise();
      
      if (!this.electronService.isWindowFocused()) {
        const message = result.data?.result?.success ? 'SoftDevice 烧录成功' : 'SoftDevice 烧录失败';
        this.electronService.notify('烧录', message);
      }
      if (isSerialMonitorOpen) this.uiService.openTool('serial-monitor');
      return result.data?.result || { success: false, message: '烧录失败' };
    } catch (error: any) {
      if (!this.electronService.isWindowFocused()) {
        this.electronService.notify('烧录', 'SoftDevice 烧录失败');
      }
      if (isSerialMonitorOpen) this.uiService.openTool('serial-monitor');
      return { success: false, message: error.message || '烧录失败' };
    }
  }
}

