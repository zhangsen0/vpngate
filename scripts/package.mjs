/**
 * package.mjs — 生成 Cloudflare Pages 部署包
 *
 * 部署包 = public/（静态资源）+ functions/（API）+ wrangler.toml + _headers，打成 zip。
 * 测试环境与生产环境（GitHub Actions）均以该部署包上传。
 *
 * 用法：node scripts/package.mjs [输出路径，默认 dist/deploy.zip]
 */

import { mkdirSync, copyFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const OUT_DIR = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'dist');
const OUT_ZIP = join(OUT_DIR, 'deploy.zip');

// 清空并重建输出目录
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

// 拷贝静态资源与函数
cpSync(join(ROOT, 'public'), join(OUT_DIR, 'public'), { recursive: true });
cpSync(join(ROOT, 'functions'), join(OUT_DIR, 'functions'), { recursive: true });

// 附带配置文件（本地开发用；远程绑定通过 CF 控制台/API 配置）
for (const f of ['wrangler.toml', '_headers']) {
  const src = join(ROOT, f);
  if (existsSync(src)) copyFileSync(src, join(OUT_DIR, f));
}

// 打 zip（zip 未安装时回退提示）
const items = ['public', 'functions', 'wrangler.toml', ...(existsSync(join(OUT_DIR, '_headers')) ? ['_headers'] : [])].join(' ');
try {
  execSync(`cd "${OUT_DIR}" && zip -qr "${OUT_ZIP}" ${items}`, { stdio: 'inherit' });
} catch {
  console.error('打包失败：请确认已安装 zip（apt install zip）');
  process.exit(1);
}

console.log(`部署包已生成：${OUT_ZIP}`);
console.log(`部署包内容：public/ + functions/ + wrangler.toml${existsSync(join(ROOT, '_headers')) ? ' + _headers' : ''}`);
