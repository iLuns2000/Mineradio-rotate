#!/usr/bin/env node
// =============================================================================
//  Mineradio — electron-builder ESM 补丁脚本
//
//  为什么存在：
//    electron-builder@26 的 app-builder-lib/out/targets/blockmap/blockmap.js
//    用 require("@noble/hashes/blake2.js") 拉纯 ESM 的 @noble/hashes v2。
//    Node < 22.12 不支持 require() 拉 ESM，于是 npm run build:win 在最后
//    一步 "building block map" 崩 ERR_REQUIRE_ESM。
//
//  本脚本让 app-builder-lib 在 Node 20 下能用 CJS 版 @noble/hashes：
//    1. 顶层安装 @noble/hashes@1.4.0 (CommonJS)，让 require() 可解析
//    2. 删除 app-builder-lib 自己嵌套的 ESM @noble 副本 (否则优先解析 v2)
//    3. 给 blockmap.js 打补丁：blake2.js -> blake2b (v1 的合法导出路径)
//
//  幂等：每步先检测状态，已就绪就跳过，不重复 npm install / 不重复打补丁。
//
//  用法：
//    node scripts/patch-builder-esm.js
//  仅在 electron-builder 装好后才有意义；node_modules 重建后会丢，需重跑
//  (已挂到 postinstall，见 package.json)。
// =============================================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
const NOBLE_DIR = path.join(NM, '@noble', 'hashes');
const APP_BUILDER_NOBLE = path.join(NM, 'app-builder-lib', 'node_modules', '@noble');
const BLOCKMAP_JS = path.join(NM, 'app-builder-lib', 'out', 'targets', 'blockmap', 'blockmap.js');

function log(msg) { console.log('[patch-builder-esm] ' + msg); }
function warn(msg) { console.warn('[patch-builder-esm] ' + msg); }

// 读 @noble/hashes 版本与 module 类型 (cjs / module)
function nobleInfo(dir) {
  try {
    const p = require(path.join(dir, 'package.json'));
    return { version: p.version, type: p.type === 'module' ? 'module' : 'cjs' };
  } catch (e) {
    return null;
  }
}

// 第 1 步：顶层 @noble/hashes 必须是 v1.4.0 (CJS)
function ensureTopLevelCjs() {
  const info = nobleInfo(NOBLE_DIR);
  if (info && info.type === 'cjs') {
    log('顶层 @noble/hashes v' + info.version + ' (CJS) — OK，跳过安装。');
    return;
  }
  if (info) {
    log('顶层 @noble/hashes v' + info.version + ' (' + info.type + ')，需降到 CJS v1.4.0...');
  } else {
    log('顶层 @noble/hashes 缺失，安装 CJS v1.4.0...');
  }
  const registry = process.env.npm_config_registry || 'https://registry.npmmirror.com';
  execSync('npm i -D @noble/hashes@1.4.0 --no-save --registry=' + registry, {
    cwd: ROOT, stdio: 'inherit',
  });
  const after = nobleInfo(NOBLE_DIR);
  if (!after || after.type !== 'cjs') {
    throw new Error('降级 @noble/hashes 失败，仍为 ' + (after ? after.type : '缺失'));
  }
  log('顶层已就绪 @noble/hashes v' + after.version + ' (CJS)。');
}

// 第 2 步：删 app-builder-lib 嵌套的 ESM @noble 副本 (否则优先解析它)
function removeNestedEsm() {
  if (!fs.existsSync(APP_BUILDER_NOBLE)) {
    log('app-builder-lib 无嵌套 @noble 副本 — OK。');
    return;
  }
  // 只在嵌套副本是 ESM 时删 (CJS 嵌套不影响，保留)
  const nested = nobleInfo(path.join(APP_BUILDER_NOBLE, 'hashes'));
  if (nested && nested.type === 'module') {
    log('删除 app-builder-lib 嵌套的 ESM @noble/hashes v' + nested.version + '...');
    fs.rmSync(APP_BUILDER_NOBLE, { recursive: true, force: true });
    log('嵌套副本已删，回退到顶层 CJS。');
  } else if (nested) {
    log('app-builder-lib 嵌套 @noble/hashes v' + nested.version + ' (' + nested.type + ')，保留。');
  }
}

// 第 3 步：给 blockmap.js 打补丁 blake2.js -> blake2b
const BAD_REQUIRE = 'require("@noble/hashes/blake2.js")';
const GOOD_REQUIRE = 'require("@noble/hashes/blake2b")';

function patchBlockmap() {
  if (!fs.existsSync(BLOCKMAP_JS)) {
    log('blockmap.js 不存在 (electron-builder 未安装?)，跳过补丁。');
    return false;
  }
  const src = fs.readFileSync(BLOCKMAP_JS, 'utf8');
  if (src.indexOf(GOOD_REQUIRE) !== -1) {
    log('blockmap.js 已打补丁 — OK。');
    return true;
  }
  if (src.indexOf(BAD_REQUIRE) === -1) {
    warn('blockmap.js 未找到预期的 require("@noble/hashes/blake2.js")，跳过 (可能上游已修)。');
    return true;
  }
  log('给 blockmap.js 打补丁：blake2.js -> blake2b ...');
  fs.writeFileSync(BLOCKMAP_JS, src.replace(BAD_REQUIRE, GOOD_REQUIRE));
  log('补丁已打。');
  return true;
}

// 验证 v1.4.0 的 blake2b 可 require (确认补丁有效)
function verifyRequire() {
  try {
    const { blake2b } = require('@noble/hashes/blake2b');
    if (typeof blake2b !== 'function') throw new Error('blake2b 不是函数');
    log('验证通过：require("@noble/hashes/blake2b") 可用。');
  } catch (e) {
    throw new Error('验证失败，require blake2b 报错：' + e.message);
  }
}

function main() {
  if (!fs.existsSync(NM)) {
    log('node_modules 不存在，跳过 (先 npm install)。');
    return;
  }
  log('开始修复 electron-builder 的 ESM 依赖...');
  ensureTopLevelCjs();
  removeNestedEsm();
  patchBlockmap();
  verifyRequire();
  log('完成。可运行 npm run build:win。\n');
}

main();
