import { Injectable } from '@angular/core';
import { ElectronService } from './electron.service';

export interface OpenocdDevice {
  type: string;          // "ST-Link" | "DAPLink (CMSIS-DAP)"
  description?: string;
  vid?: string;
  pid?: string;
  serial?: string;
  targetVoltage?: string;
}

export interface OpenocdFlashOptions {
  firmwarePath: string;
  target: string;
  interface?: string;    // "stlink" | "cmsis-dap"
  transport?: string;    // "swd" | "jtag"
  speed?: number;
  baseAddress?: number;
  verify?: boolean;
  reset?: boolean;
  eraseAll?: boolean;
  timeout?: number;
}

export interface OpenocdResult {
  success: boolean;
  devices?: OpenocdDevice[];
  output?: string;
  error?: string;
}

@Injectable({
  providedIn: 'root'
})
export class OpenocdService {

  constructor(
    private electronService: ElectronService
  ) { }

  private get api() {
    return window['openocd'];
  }

  async detectAll(): Promise<OpenocdResult> {
    if (!this.electronService.isElectron) {
      return { success: false, error: 'Not running in Electron' };
    }
    return await this.api.detectAll();
  }

  async detectStlink(): Promise<OpenocdResult> {
    if (!this.electronService.isElectron) {
      return { success: false, error: 'Not running in Electron' };
    }
    return await this.api.detectStlink();
  }

  async detectDaplink(): Promise<OpenocdResult> {
    if (!this.electronService.isElectron) {
      return { success: false, error: 'Not running in Electron' };
    }
    return await this.api.detectDaplink();
  }

  async flash(options: OpenocdFlashOptions): Promise<OpenocdResult> {
    if (!this.electronService.isElectron) {
      return { success: false, error: 'Not running in Electron' };
    }
    return await this.api.flash(options);
  }
}
