/**
 * check-syntax.mjs — 全量语法检查
 *
 * 对 public/、functions/、scripts/ 下所有 .js / .mjs 依次执行 node --check，
 * 任一文件语法错误即非零退出。
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DIRS = ['public', 'functions', 'scripts'];

/** 递归收集 JS 文件 */
function collectJs(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (['.js', '.mjs', '.cjs'].includes(extname(name))) out.push(full);
    }
  };
  walk(dir);
  return out;
}

let failed = 0;
const files = [];
for (const d of DIRS) {
  const dir = join(ROOT, d);
  try { files.push(...collectJs(dir)); } catch { /* 目录不存在则跳过 */ }
}
files.push(import.meta.filename);

for (const file of files) {
  const r = spawnSync('node', ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`✗ ${file}\n${r.stderr.trim()}`);
  } else {
    console.log(`✓ ${file}`);
  }
}

if (failed > 0) {
  console.error(`\n语法检查失败：${failed} 个文件`);
  process.exit(1);
}
console.log(`\n语法检查通过：共 ${files.length} 个文件`);
