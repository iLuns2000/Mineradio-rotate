#!/usr/bin/env node
// =============================================================================
//  Mineradio — Electron 安装兜底脚本 (fallback installer)
//
//  为什么存在：
//    electron@42 的 install.js 用 require() 加载纯 ESM 的 @electron/get 和
//    @electron-internal/extract-zip。Node < 22.12 不支持 require() 拉 ESM，
//    于是 npm install 后 electron 二进制根本下不下来，npm start 报
//    ERR_REQUIRE_ESM。
//
//  本脚本绕开有问题的 install.js，手动把 Electron 二进制装到位：
//    1. 读 node_modules/electron/package.json 的 version
//    2. 从镜像 (默认 npmmirror) 下载 electron-v<ver>-<platform>-<arch>.zip
//    3. 解压到 node_modules/electron/dist
//    4. 写 path.txt (内容为平台可执行名，无换行) —— 与官方 install.js 一致
//
//  幂等：若 dist/electron.exe 和 dist/version 已就绪且匹配，直接跳过。
//
//  用法：
//    node scripts/install-electron-fallback.js
//  环境变量：
//    ELECTRON_MIRROR    镜像根 (默认 https://npmmirror.com/mirrors/electron/)
//    ELECTRON_VERSION    指定版本 (默认读 electron 包)
//    ELECTRON_PLATFORM   平台 (默认 process.platform)
//    ELECTRON_ARCH       架构 (默认 process.arch)
//
//  兼容官方 electron 的 ELECTRON_OVERRIDE_DIST_PATH 不动 —— 这里只填默认 dist。
// =============================================================================

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ELECTRON_PKG_DIR = path.join(__dirname, '..', 'node_modules', 'electron');
const DIST_DIR = path.join(ELECTRON_PKG_DIR, 'dist');
const PATH_TXT = path.join(ELECTRON_PKG_DIR, 'path.txt');

function platformPath(platform) {
  switch (platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron';
    case 'win32':
      return 'electron.exe';
    default:
      throw new Error('Electron builds are not available on platform: ' + platform);
  }
}

function readVersion() {
  const fromEnv = process.env.ELECTRON_VERSION;
  if (fromEnv) return fromEnv;
  try {
    return require(path.join(ELECTRON_PKG_DIR, 'package.json')).version;
  } catch (e) {
    throw new Error(`读不到 ${ELECTRON_PKG_DIR}/package.json —— 先执行一次 npm install`);
  }
}

// 已就绪且版本匹配 -> 幂等跳过
function isInstalled(version, exeName) {
  try {
    const distVersion = fs.readFileSync(path.join(DIST_DIR, 'version'), 'utf-8').replace(/^v/, '').trim();
    const pathTxt = fs.readFileSync(PATH_TXT, 'utf-8').trim();
    const exeExists = fs.existsSync(path.join(DIST_DIR, ...exeName.split('/')));
    return distVersion === version && pathTxt === exeName && exeExists;
  } catch {
    return false;
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = (currentUrl, redirectsLeft = 8) => {
      https.get(currentUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft <= 0) return reject(new Error('重定向次数过多'));
          res.resume();
          return req(res.headers.location, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`下载失败 HTTP ${res.statusCode}: ${currentUrl}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let done = 0;
        let lastPct = -1;
        res.on('data', (chunk) => {
          done += chunk.length;
          if (total) {
            const pct = Math.floor((done / total) * 100);
            if (pct !== lastPct && pct % 10 === 0) {
              lastPct = pct;
              process.stdout.write(`\r  下载 ${pct}% (${(done / 1048576).toFixed(0)}MB)`);
            }
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => {
          process.stdout.write('\n');
          resolve();
        }));
      }).on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    };
    req(url);
  });
}

function extractZip(zipPath, destDir, platform) {
  if (platform === 'win32') {
    // 系统自带，不依赖第三方 zip 库
    execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ], { stdio: 'inherit' });
  } else {
    // macOS / Linux: 优先 unzip，回退 tar（部分 tar 支持 zip）
    try {
      execFileSync('unzip', ['-o', '-q', zipPath, '-d', destDir], { stdio: 'inherit' });
    } catch {
      execFileSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'inherit' });
    }
  }
}

async function main() {
  const version = readVersion();
  const platform = process.env.ELECTRON_PLATFORM || process.platform;
  const arch = process.env.ELECTRON_ARCH || process.arch;
  const exeName = platformPath(platform);

  console.log(`\n[mineradio] Electron fallback installer`);
  console.log(`  version : ${version}`);
  console.log(`  platform: ${platform}-${arch}`);
  console.log(`  exeName : ${exeName}`);

  if (isInstalled(version, exeName)) {
    console.log('  已就绪且版本匹配，跳过。\n');
    return;
  }

  const mirror = (process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/').replace(/\/$/, '');
  const fileName = `electron-v${version}-${platform}-${arch}.zip`;
  const url = `${mirror}/${version}/${fileName}`;

  const tmpZip = path.join(require('os').tmpdir(), fileName);
  console.log(`  下载: ${url}`);
  await download(url, tmpZip);
  console.log(`  下载完成: ${(fs.statSync(tmpZip).size / 1048576).toFixed(0)}MB`);

  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });
  console.log(`  解压到: ${DIST_DIR}`);
  extractZip(tmpZip, DIST_DIR, platform);

  // path.txt 内容 = 平台可执行名，无换行 —— 与官方 install.js 完全一致
  // 注意 index.js:34 会自己拼 dist/，所以这里只写文件名，不要再带 dist/
  fs.writeFileSync(PATH_TXT, exeName); // 无换行
  fs.unlinkSync(tmpZip);

  const exeFull = path.join(DIST_DIR, ...exeName.split('/'));
  if (!fs.existsSync(exeFull)) {
    throw new Error(`解压后找不到 ${exeFull}`);
  }
  console.log(`  ✓ 就绪: ${exeFull}`);
  console.log(`  ✓ path.txt => ${fs.readFileSync(PATH_TXT, 'utf-8')}\n`);
}

main().catch((err) => {
  console.error('\n[mineradio] Electron 安装失败:', err.message);
  console.error('  可手动设置 ELECTRON_MIRROR 换镜像后重试。');
  process.exit(1);
});
