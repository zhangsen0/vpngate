/**
 * util.js — 公共小工具：JSON 响应、请求体读取、超时 Promise、缓存操作
 */

/** 标准 JSON 响应（含 CORS 头，便于本地跨端口调试） */
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

/** 读取请求 JSON 体（容错：非法 JSON 返回 null） */
export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** 带超时的 Promise（用于外部拉取、探测等） */
export function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 解析查询参数 */
export function queryParams(url) {
  return Object.fromEntries(new URL(url).searchParams.entries());
}

/** 生成字符串哈希（缓存键等用途） */
export async function sha1Hex(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 分块并发执行：把 items 按 size 分片，逐片并行处理 */
export async function chunkParallel(items, size, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    const part = await Promise.all(slice.map((item) => fn(item)));
    results.push(...part);
  }
  return results;
}
