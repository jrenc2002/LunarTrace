import {
  CUSTOM_ELEMENTS_SCHEMA,
  Component,
  ElementRef,
  ViewChild,
  forwardRef,
  AfterViewInit,
} from '@angular/core';
import {
  ControlValueAccessor,
  NG_VALUE_ACCESSOR,
  NG_VALIDATORS,
  Validator,
  ValidationErrors,
} from '@angular/forms';

import 'altcha';
import "altcha/i18n/zh-cn";
import { API } from '../../../configs/api.config';

@Component({
  selector: 'app-altcha',
  standalone: true,
  templateUrl: './altcha.component.html',
  styleUrls: ['./altcha.component.css'],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => AltchaComponent),
      multi: true,
    },
    {
      provide: NG_VALIDATORS,
      useExisting: forwardRef(() => AltchaComponent),
      multi: true,
    },
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class AltchaComponent implements ControlValueAccessor, Validator, AfterViewInit {
  @ViewChild('altchaWidget', { static: true }) altchaWidget!: ElementRef;

  altchaChallenge = API.altchaChallenge;

  value = '';
  onChange: CallableFunction = () => undefined;
  onTouched: CallableFunction = () => undefined;

  ngAfterViewInit(): void {
    const el = this.altchaWidget.nativeElement as HTMLElement;
    // customElements.whenDefined('altcha-widget').then(() => {
    //   setTimeout(() => {
    //     const widget = el as any;
    //     if (widget && typeof widget.configure === 'function') {
    //       widget.configure({
    //         strings: {
    //           label: '完成人机验证',
    //         },
    //       });
    //     } else {
    //       console.warn('altcha-widget configure method not available yet');
    //     }
    //   }, 0);
    // });
    
    // el.addEventListener('statechange', (ev) => {
    //   console.log("🚀 ~ AltchaComponent ~ ngAfterViewInit ~ ev:", ev)
    //   const { detail } = ev as CustomEvent;
    //   if (detail) {
    //     const { payload, state } = detail;
    //     this.onStateChange(state, payload);
    //   }
    // });
  }

  writeValue(value: string): void {
    this.value = value;
  }

  registerOnChange(fn: CallableFunction): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: CallableFunction): void {
    this.onTouched = fn;
  }

  validate(): ValidationErrors | null {
    if (!this.value) {
      return { required: true };
    }
    return null;
  }

  onStateChange(state: 'unverified' | 'verifying' | 'verified' | 'error', payload = '') {
    this.value = state === 'verified' ? payload : '';
    this.onChange(this.value);
    this.onTouched();
  }

  /**
   * 手动触发验证
   * @returns Promise<string> 返回验证 token，如果验证失败则 reject
   */
  triggerVerification(): Promise<string> {
    return new Promise((resolve, reject) => {
      // 检查是否已经验证
      if (this.value && this.value !== '') {
        resolve(this.value);
        return;
      }

      // 等待组件就绪
      customElements.whenDefined('altcha-widget').then(() => {
        const el = this.altchaWidget.nativeElement as any;
        
        // 设置一次性监听器
        const handleStateChange = (ev: Event) => {
          const { detail } = ev as CustomEvent;
          if (detail) {
            const { payload, state } = detail;
            if (state === 'verified') {
              el.removeEventListener('statechange', handleStateChange);
              this.onStateChange(state, payload);
              resolve(payload);
            } else if (state === 'error') {
              el.removeEventListener('statechange', handleStateChange);
              reject(new Error('验证失败'));
            }
          }
        };

        el.addEventListener('statechange', handleStateChange);

        // 触发验证
        if (el && typeof el.verify === 'function') {
          el.verify();
        } else {
          el.removeEventListener('statechange', handleStateChange);
          reject(new Error('无法触发验证，组件未就绪'));
        }
      }).catch((error) => {
        reject(new Error('组件加载失败：' + error.message));
      });
    });
  }
}
