/**
 * 模糊搜索工具函数
 * 提供基于 Orama 的全文搜索和基于 Dice 系数的字符串相似度计算
 */

import { create, insert, search, type AnyOrama } from '@orama/orama';

/**
 * 获取字符串的 bigrams 集合
 */
export function getBigrams(str: string): Set<string> {
  const bigrams = new Set<string>();
  for (let i = 0; i < str.length - 1; i++) {
    bigrams.add(str.substring(i, i + 2));
  }
  return bigrams;
}

/**
 * 计算两个字符串的相似度（Dice系数 + 包含关系）
 */
export function calculateSimilarity(str1: string, str2: string): number {
  if (!str1 || !str2) return 0;
  if (str1 === str2) return 1;

  // 包含关系检查
  if (str1.includes(str2) || str2.includes(str1)) {
    const shorter = str1.length < str2.length ? str1 : str2;
    const longer = str1.length < str2.length ? str2 : str1;
    return shorter.length / longer.length * 0.8 + 0.2;
  }

  // Dice 系数计算
  const bigrams1 = getBigrams(str1);
  const bigrams2 = getBigrams(str2);

  let intersection = 0;
  for (const bigram of bigrams1) {
    if (bigrams2.has(bigram)) {
      intersection++;
    }
  }

  return (2 * intersection) / (bigrams1.size + bigrams2.size);
}

/**
 * 提取查询字符串中的关键词
 * 例如: "@aily-project/lib-oled-ssd1306" => ["aily", "project", "lib", "oled", "ssd1306"]
 */
export function extractKeywords(query: string): string[] {
  if (!query) return [];

  // 移除常见的前缀/后缀
  let cleaned = query
    .replace(/@aily-project\//gi, '')  // 移除包前缀
    .replace(/^lib-/gi, '')             // 移除lib-前缀
    .replace(/\s+/g, ' ')               // 合并空格
    .trim();

  // 按多种分隔符分割：连字符、下划线、空格等
  const keywords = cleaned.split(/[-_\s\/]+/)
    .filter(kw => kw.length >= 2)  // 过滤太短的词
    .map(kw => kw.toLowerCase());

  return [...new Set(keywords)];  // 去重
}

// ===================== Orama 搜索引擎 =====================

const LIBRARY_SCHEMA = {
  name: 'string',
  nickname: 'string',
  keywords: 'string',
  tags: 'string',
  description: 'string',
  brand: 'string',
  author: 'string',
  fulltext: 'string',
} as const;

export interface LibrarySearchDoc {
  name: string;
  nickname: string;
  keywords: string;
  tags: string;
  description: string;
  brand: string;
  author: string;
  fulltext: string;
}

/**
 * 创建 Orama 搜索引擎实例，索引库列表
 */
export function createLibrarySearchIndex(libraries: any[]): AnyOrama {
  const db = create({ schema: LIBRARY_SCHEMA });

  for (const lib of libraries) {
    insert(db, {
      name: lib.name || '',
      nickname: lib._nickname || lib.nickname || '',
      keywords: Array.isArray(lib.keywords) ? lib.keywords.join(' ') : (lib.keywords || ''),
      tags: Array.isArray(lib.tags) ? lib.tags.join(' ') : (lib.tags || ''),
      description: lib._description || lib.description || '',
      brand: lib.brand || '',
      author: (typeof lib.author === 'string' ? lib.author : lib.author?.name) || '',
      fulltext: lib.fulltext || '',
    });
  }

  return db;
}

/**
 * 使用 Orama 执行模糊搜索，返回匹配的库名称列表（按相关度排序）
 */
export function searchLibraries(db: AnyOrama, term: string, limit: number = 500): string[] {
  const results = search(db, {
    term,
    properties: ['name', 'nickname', 'keywords', 'tags', 'description', 'brand', 'author'],
    tolerance: 1,
    boost: {
      name: 3,
      nickname: 2.5,
      keywords: 2,
      tags: 1.5,
      description: 0.5,
      brand: 0.5,
      author: 0.5,
    },
    limit,
  }) as any;

  return results.hits.map((hit: any) => hit.document.name as string);
}
