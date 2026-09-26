/**
 * _middleware.js — 全站登录保护中间件
 *
 * 对整个项目（含静态资源）做登录校验：
 *  - 未登录访问页面 → 302 跳转 /login.html?next=<原路径>；
 *  - 未登录访问 /api/*（除登录相关）→ 401 JSON；
 *  - /login.html 与 /api/auth/* 始终放行。
 */

import { json } from './_lib/util.js';
import { isAuthed } from './_lib/auth.js';

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // 登录相关路径与无鉴权探活接口始终放行
  if (path === '/login.html' || path.startsWith('/api/auth/') || path === '/api/healthz') {
    return next();
  }

  if (isAuthed(request, env)) {
    return next();
  }

  if (path.startsWith('/api/')) {
    return json({ ok: false, error: '未登录或会话已过期' }, 401);
  }

  // 静态页面/资源未登录 → 跳转登录页（带 next 回跳）
  const nextPath = path === '/' ? '/' : path;
  return Response.redirect(`${url.origin}/login.html?next=${encodeURIComponent(nextPath)}`, 302);
}
