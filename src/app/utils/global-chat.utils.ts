import { ChatService, ChatTextOptions } from '../tools/aily-chat/public-api';

/**
 * 全局方法：发送文本到聊天组件（不打开面板，面板须已开启）
 *
 * @param text 要发送的文本内容
 * @param options 发送选项，包含 sender、type、cover 等参数
 *                cover 默认为 true（覆盖模式），设置为 false 则追加内容
 *
 * @example
 * window.sendToAilyChat('帮我生成Arduino代码');
 */

/**
 * 全局方法：打开 aily-chat 面板并发送消息（推荐用于按钮触发场景）
 *
 * 标准接口：当用户点击某处，需代为向大模型发送消息时，统一使用此方法。
 * 它会确保 aily-chat 面板已打开，再注入消息文本（可选自动发送）。
 * 此方法由 UiService.init() 注册，使用前需确保主窗口已初始化。
 *
 * @param text 要发送的文本内容
 * @param options 发送选项。建议传 { autoSend: true } 以自动触发发送
 *
 * @example
 * // 最常见用法：打开对话框并自动触发发送
 * window.openAndSendToAilyChat('生成项目连线图', { autoSend: true });
 *
 * // 只填入输入框，让用户手动确认
 * window.openAndSendToAilyChat('帮我分析这段代码');
 */
declare global {
  interface Window {
    sendToAilyChat: (text: string, options?: ChatTextOptions) => void;
    openAndSendToAilyChat: (text: string, options?: Record<string, any>) => void;
  }
}

// 不打开面板，直接注入文本（适合面板已开启的场景）
window.sendToAilyChat = function (text: string, options?: ChatTextOptions): void {
  ChatService.sendToChat(text, options);
};

// openAndSendToAilyChat 由 UiService.init() 注册（确保可用时机正确）
// 这里提供一个占位，避免在 UiService 初始化前调用时报错
if (!window.openAndSendToAilyChat) {
  window.openAndSendToAilyChat = function (text: string, options?: Record<string, any>): void {
    console.warn('openAndSendToAilyChat: UiService 尚未初始化');
  };
}

// 导出，也可以直接 import 使用
export const sendToAilyChat = window.sendToAilyChat;
