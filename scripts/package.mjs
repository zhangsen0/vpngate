/**
 * package.mjs — 生成 Cloudflare Pages 部署包
 *
 * 部署包结构 = Pages 输出目录根：
 *   dist/
 *   ├── index.html / app.js / style.css / login.html   （public/ 内容平铺到根）
 *   ├── functions/                                      （API + 中间件）
 *   └── _headers                                         （响应头）
 *
 * 注意：wrangler.toml 仅用于本地开发（含占位 KV id），**不打包进部署包**，
 *      远程部署时 KV 绑定与环境变量一律通过 CF 控制台/API 的项目级
 *      deployment_configs 配置，避免占位配置覆盖线上绑定。
 *
 * 测试环境与生产环境（GitHub Actions）均以该目录上传部署。
 *
 * 用法：node scripts/package.mjs [输出路径，默认 dist]
 */

import { mkdirSync, copyFileSync, rmSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const OUT_DIR = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'dist');

// 清空并重建输出目录
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

// public/ 内容平铺到输出目录根（Pages 输出目录要求）
const publicDir = join(ROOT, 'public');
for (const name of readdirSync(publicDir)) {
  cpSync(join(publicDir, name), join(OUT_DIR, name), { recursive: true });
}

// functions/ 整体拷贝（Pages Functions 编译入口）
cpSync(join(ROOT, 'functions'), join(OUT_DIR, 'functions'), { recursive: true });

// 附带响应头文件（不打包 wrangler.toml：避免占位 KV 覆盖线上绑定）
if (existsSync(join(ROOT, '_headers'))) {
  copyFileSync(join(ROOT, '_headers'), join(OUT_DIR, '_headers'));
}

// 可选：打 zip 归档（部分部署流程需要单文件）
if (process.argv.includes('--zip')) {
  const zipPath = join(ROOT, 'dist', 'deploy.zip');
  const items = ['index.html', 'app.js', 'style.css', 'login.html', 'functions', ...(existsSync(join(OUT_DIR, '_headers')) ? ['_headers'] : [])].join(' ');
  try {
    execSync(`cd "${OUT_DIR}" && zip -qr "${zipPath}" ${items}`, { stdio: 'inherit' });
    console.log(`zip 已生成：${zipPath}`);
  } catch {
    console.error('打包失败：请确认已安装 zip（apt install zip）');
    process.exit(1);
  }
}

console.log(`部署包已生成：${OUT_DIR}`);
console.log('部署包内容：public/* → 根目录，functions/ → functions/，_headers（不含 wrangler.toml）');
