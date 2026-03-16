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

function isGenericTransportErrorText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  return [
    /\bhttp\s*error\b/i,
    /\brequest failed with status code \d{3}\b/i,
    /\bstatus(?:\s+code)?\s*[:=]?\s*\d{3}\b/i,
    /\bnetwork\s*error\b/i,
    /\bnetworkerror\b/i,
    /\bfailed to fetch\b/i,
    /\bload failed\b/i,
    /\btimeout of \d+ms exceeded\b/i,
    /^timeout$/i
  ].some(pattern => pattern.test(normalized));
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

    if (isGenericTransportErrorText(text)) continue;

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
    502: '服务连接波动，请稍后重试。',
    503: '服务暂时不可用，请稍后重试。',
    504: '服务响应超时，请重试。'
  };

  return statusMessageMap[status] || '网络波动，请重试。';
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
    const matched = String(text).match(/\b(?:http\s*error[^\d]*|request failed with status code\s*|status(?:\s+code)?\s*[:=]?\s*)(\d{3})\b/i);
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
