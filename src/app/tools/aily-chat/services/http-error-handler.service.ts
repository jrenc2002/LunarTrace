/**
 * HTTP 错误处理工具函数
 *
 * 从 AilyChatComponent 提取的纯函数集合，用于：
 * - 从复杂的错误对象中提取可读的错误信息
 * - 根据 HTTP 状态码生成友好文案
 */

/**
 * 获取首选的 HTTP 错误消息
 */
export function getPreferredHttpErrorMessage(err: any): string {
  const detailMessage = extractErrorDetailMessage(err);
  if (detailMessage) {
    return detailMessage;
  }
  return getHttpErrorFallbackMessage(err);
}

/**
 * 从错误对象中提取详细错误信息
 */
export function extractErrorDetailMessage(err: any): string {
  if (!err) return '';

  const detailCandidate =
    err?.error ??
    err?.response?.data ??
    err?.data ??
    err?.cause?.error;

  const asObject = detailCandidate && typeof detailCandidate === 'object' ? detailCandidate : null;
  if (asObject) {
    const objectCode = asObject.code;
    const objectMessage =
      asObject.message ??
      asObject.msg ??
      asObject.error_description ??
      asObject.error ??
      asObject.detail;

    if (objectCode !== undefined && objectCode !== null) {
      if (typeof objectMessage === 'string' && objectMessage.trim()) {
        return objectMessage.trim();
      }
    }

    if (typeof objectMessage === 'string' && objectMessage.trim()) {
      return objectMessage.trim();
    }
  }

  const directTextCandidates = [
    err?.detail,
    err?.error?.detail,
    err?.error?.message,
    err?.response?.data?.message,
    err?.response?.data?.detail,
    err?.message,
    typeof err === 'string' ? err : ''
  ];

  for (const candidate of directTextCandidates) {
    if (typeof candidate !== 'string') continue;

    const text = candidate.trim();
    if (!text) continue;

    const isHttpStatusText = /\bhttp\s*error\b/i.test(text) || /\bstatus\s*[:=]?\s*\d{3}\b/i.test(text);
    if (isHttpStatusText) continue;

    return text;
  }

  return '';
}

/**
 * 根据 HTTP 状态码返回 fallback 消息
 */
export function getHttpErrorFallbackMessage(err: any): string {
  const status = extractHttpStatusCode(err);

  const statusMessageMap: Record<number, string> = {
    400: '请求格式错误，请检查。',
    401: '登录已失效，请重新登录。',
    403: '无权限执行该操作。',
    404: '资源不存在，请确认。',
    408: '请求超时，请重试。',
    429: '请求过快，请稍后再试。',
    500: '服务器异常，请稍后再试。',
    502: '网关无响应，请稍后再试。',
    503: '服务繁忙，请稍后再试。',
    504: 'AI响应超时，请重试。'
  };

  return statusMessageMap[status] || '网络异常，请检查连接。';
}

/**
 * 从错误对象中提取 HTTP 状态码
 */
export function extractHttpStatusCode(err: any): number {
  const directCandidate =
    err?.status ??
    err?.statusCode ??
    err?.response?.status ??
    err?.error?.status ??
    err?.error?.statusCode ??
    err?.cause?.status ??
    err?.cause?.statusCode;

  const directStatus = Number(directCandidate);
  if (Number.isFinite(directStatus) && directStatus >= 100 && directStatus <= 599) {
    return directStatus;
  }

  const textCandidates = [
    err?.message,
    err?.error?.message,
    err?.response?.statusText,
    err?.cause?.message,
    typeof err === 'string' ? err : ''
  ].filter(Boolean);

  for (const text of textCandidates) {
    const matched = String(text).match(/\b(?:http\s*error[^\d]*|status\s*[:=]?\s*)(\d{3})\b/i);
    if (matched?.[1]) {
      return Number(matched[1]);
    }
  }

  const joined = textCandidates.map(v => String(v)).join(' | ').toLowerCase();
  if (
    joined.includes('failed to fetch') ||
    joined.includes('networkerror') ||
    joined.includes('network error') ||
    joined.includes('load failed') ||
    joined.includes('timeout')
  ) {
    return 0;
  }

  return 0;
}
