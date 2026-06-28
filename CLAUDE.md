# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Mineradio is a Windows **Electron** desktop music player: immersive particle/3D visuals, lyrics stage, weather radio, search/playback via Netease Cloud Music + QQ Music, 3D playlist shelf, and a self-hosted in-app update system. Communicate with the user in **中文**, direct and practical — do the work and verify it, don't just propose.

**Orientation note:** the in-repo handoff docs (`AGENTS.md`, `AI_HANDOFF.md`, `docs/PROJECT_MEMORY.md`) were written from the author's live install and repeatedly point at `E:\桌面\播放器软件\Mineradio\resources\app` as the "real" repo. Treat **this checkout's working directory as the repo root**; those `E:\` paths are the author's machine, not here. Current version is in `package.json` (currently `1.1.1`); the version checkpoints inside the handoff docs lag behind `package.json`/`README.md`.

## Commands

```bash
npm install
npm start                  # electron . — launches app (spawns local server, opens window)
npm run build:win          # electron-builder NSIS installer → dist/
npm run build:win:dir      # unpacked dir build (faster, for testing visuals/behavior)

node --check server.js     # syntax check the server (do this after any server.js edit)
git diff --check           # whitespace / conflict-marker check
```

### Electron 安装兜底（Node < 22.12 必须）
`electron@42` 的 `install.js` 用 `require()` 加载纯 ESM 的 `@electron/get` / `@electron-internal/extract-zip`，**Node < 22.12 不支持 require ESM**，于是 `npm install` 后 electron 二进制下不下来，`npm start` 报 `ERR_REQUIRE_ESM`。

已固化为 `npm: postinstall` → `scripts/install-electron-fallback.js`：跳过有问题的 install 脚本，直接从镜像（默认 `npmmirror`，可用 `ELECTRON_MIRROR` 覆盖）下载 zip → 解压到 `node_modules/electron/dist` → 写 `path.txt`（内容仅 `electron.exe`，无换行，**不要带 `dist/`**，`electron/index.js` 会自己拼）。幂等，已装就跳过。手动重跑：`npm run postinstall`。

两个坑：①若 `postinstall` 报 `EBUSY` 锁 `default_app.asar`，是上一次的 `electron.exe` 没退干净，先 `Stop-Process -Name electron` 再重跑；②PowerShell 的 `Expand-Archive` 在某些 shell 环境（如 GBK 控制台）传中文参数会乱码，脚本里已只用 ASCII 命令。长期正解仍是升级到 Node 22 LTS。

### electron-builder ESM 补丁（Node < 22.12 打包必须）
`electron-builder@26` 的 `app-builder-lib/.../blockmap.js` 用 `require("@noble/hashes/blake2.js")` 拉纯 ESM 的 `@noble/hashes` v2，Node 20 下 `npm run build:win` 在最后 `building block map` 步崩 `ERR_REQUIRE_ESM`。已固化为 `postinstall` 第二步 → `scripts/patch-builder-esm.js`：①顶层装 `@noble/hashes@1.4.0`(CJS)；②删 `app-builder-lib` 嵌套的 ESM 副本；③给 `blockmap.js` 打补丁 `blake2.js → blake2b`(v1 合法路径)。幂等，已修复就跳过。手动重跑：`node scripts/patch-builder-esm.js`。

**打包被 `EPERM rename win-unpacked.tmp` 卡住时**：是 QQ 电脑管家(`QQPCRTP`/`QQPCTray`)实时扫描刚解压的 `electron.exe` 锁住句柄。退掉管家托盘**不够**(实时保护服务仍跑)，需在管家设置信任区加 `F:\study\Mineradio` 白名单，或在"服务"里停 `QQPCRTP` 服务后再打包。

There is **no test suite** (`没有独立 npm test`). After changes, verify by running the actual Electron app or opening `public/index.html` in a browser, exercising the affected interaction. The frontend logic is all inline `<script>` in `public/index.html`.

## Architecture

Three layers, all in this repo root (no src/ nesting):

**`desktop/main.js` — Electron main process.** On launch it picks a free port (from 3000), sets env, `require()`s `server.js` to start the local API, then loads `http://127.0.0.1:<port>` in a frameless transparent `BrowserWindow`. It also owns:
- **Overlay windows** loaded from the same server: `desktop-lyrics.html` (always-on-top transparent click-through lyrics; lock toggled by mouse **middle-click**, detected via a PowerShell child process polling `GetAsyncKeyState(4)`) and `wallpaper.html` (live desktop wallpaper — reparented to the Windows `WorkerW` via a PowerShell `SetParent` script). Both use `desktop/overlay-preload.js`.
- **Login flows** for Netease & QQ Music: opens a real login page in a separate persistent Electron `partition` (`persist:mineradio-*-login`), polls cookies, and extracts the auth cookie the server needs.
- Global hotkeys, JSON archive import/export dialogs, desktop-shortcut creation. IPC surface exposed to the page via `desktop/preload.js` as `window.desktopWindow`.

**`server.js` — local API server (~4200 lines, raw Node `http`, NO Express).** Routing is one long `if (pn === '/api/...')` chain (starts ~line 3245). Responsibilities:
- **Music providers.** Netease is wrapped through the `NeteaseCloudMusicApi` npm module (called server-side with the user's persisted `MUSIC_U` cookie). QQ Music is hand-rolled reverse-engineered HTTP requests (see `docs/QQ_MUSIC_INTERFACE_NOTES.md` before touching QQ playback/auth). Routes are namespaced `/api/...` (Netease) and `/api/qq/...`.
- **Home/discover, weather radio** (`/api/weather/radio`) built on Open-Meteo forecast + ip-api geolocation, generating mood-based queues.
- **Beatmap caching** at `D:\MineradioCache\beatmaps` (env-overridable) for rhythm analysis used by the cinematic visuals.
- **The update system** — the most intricate part: fetches GitHub Releases manifest (`latest.yml` + release notes), downloads the installer with **multiple China mirrors** (`gh.llkk.cc` etc.), verifies **SHA-512** from the blockmap, tracks download jobs, and can apply lightweight **JSON patch files** to upgrade an installed copy in place. Patches are strictly allowlisted: roots `public/desktop/build` only, plus `server.js`, `dj-analyzer.js`, `package.json`, `package-lock.json`; max 12 MB. Patch backups go to `updates/backups/patches/`.

**`public/index.html` — the entire frontend in ONE ~27k-line file** (HTML + CSS + inline JS). This is the bulk of the app: UI, lyrics stage, WebGL particle visuals + 3D playlist shelf (Three.js r128, vendored), DIY visual console, GSAP animations, `mpg123-decoder` for MP3, `music-tempo` for beat detection. **Always `rg` to locate the exact function/state before editing; never rewrite big blocks.** Other public pages: `desktop-lyrics.html`, `wallpaper.html`, and `default-user-fx-archive.json` (the "默认测试" first-launch default visual archive).

**`dj-analyzer.js` — rhythm/energy analysis** for podcasts/DJ tracks. Exports `analyzePodcastDjStream`, `analyzePodcastDjIntro`, `buildBeatMapFromLowEnergy`. Feeds the beat-synced cinematic camera.

**`build/` — packaging.** `installer.nsh` is the custom NSIS script (dark branded installer pages, install-path safety, uninstall safety — see P0 rule below), `after-pack.js` resource injection, icons, sidebar/header bitmaps. `electron-builder` config lives in `package.json` (`build` key); `asar: false`.

### Environment variables (server.js / desktop)
`PORT`, `HOST`, `COOKIE_FILE`, `QQ_COOKIE_FILE`, `MINERADIO_UPDATE_DIR`, `MINERADIO_UPDATE_DOWNLOAD_DIR`, `MINERADIO_PATCH_BACKUP_DIR`, `MINERADIO_BEAT_CACHE_DIR`, `MINERADIO_VERSION`, `MINERADIO_UPDATE_MANIFEST` (point at a local JSON/URL to test the update flow without a real release), `MINERADIO_NO_DESKTOP_SHORTCUT` / `MINERADIO_CREATE_DESKTOP_SHORTCUT`. `desktop/main.js` sets most of these itself when launching the server; in packaged builds cookies/updates move under Electron `userData`.

## Conventions & guardrails

These come from `AGENTS.md` and `docs/PROJECT_MEMORY.md` and are durable user requirements — read the linked doc before touching that area:

- **Visual quality is a hard constraint.** Aesthetic = dark, glass, stage, music visualization; refined and smooth. **No cheap gradients, excessive transparency, misalignment, flicker, or stutter.** Performance work must keep visual quality, smoothness, and framerate intact — never trade effects away for lower CPU. Background-throttle only on truly hidden/minimized windows; a visible but unfocused window stays at full quality.
- **Don't rewrite the `public/index.html` visual system in bulk** — locate existing functions/state first. Don't touch the cinematic camera/visual system unless the user explicitly names it.
- **Glass SVG texture is the "golden" baseline** (`#mineradio-control-glass-filter`, `generateControlGlassDisplacementMap()`) — see `docs/GLASS_SVG_TEXTURE.md`. Never replace it with plain frosted glass / cheap transparency. Can be extended to new panels/buttons without changing the console core.
- **3D playlist shelf** is delicately hand-tuned (console, dynamic/static camera, detail-page layering, lyric avoidance, selection tick). Don't redo it; see `docs/3D_PLAYLIST_SHELF_MEMORY.md`. Search results, playlist lists, and the shelf must use **batched/virtualized rendering**, never one-shot full render.
- **Sensitive areas** that have broken repeatedly and need real-machine verification: play/pause button sync (esp. after weather-radio / next-track / playlist load), Emily preset entrance & track-switch animation smoothness, search-bar glass right-side clipping.
- **Backup strategy:** don't delete old files. Move historical/duplicate material to `backups/` (gitignored) — never `rm` reference assets. `.gitignore` already excludes `dist/`, `updates/`, `backups/`, `.cookie`, `.qq-cookie`, `*.exe`, screenshots, etc. — keep user data (cookies, search history, custom covers/lyrics, beatmap cache) out of the repo.
- **Line endings:** `.gitattributes` forces LF on `.js/.html/.css/.json/.md` (including `vendor/*.min.js`). Don't let an editor rewrite vendor files as CRLF.
- **Don't push to GitHub or upload releases unless the user explicitly says so** ("上传/push/发布到 Release"). Local commits are fine; just state clearly what's committed vs. left as local/ignored artifacts (`git status --short`).

### Memory protocol
When the user says "保留 / 喜欢 / 这个很好 / 记住 / 保存一下" (or equivalent), append a dated entry to `docs/PROJECT_MEMORY.md` with: what was approved, files involved, key params/implementation, and **what must not be regressed**. For fragile visual areas (glass SVG, particle presets, 3D shelf, desktop lyrics) also update the relevant `docs/*.md`. Commit memory updates alongside code changes when relevant.

## Release workflow

From `AGENTS.md` / `RELEASE.md`:
1. Bump version in `package.json` **and** `package-lock.json`.
2. Update `CHANGELOG.md` top with a Chinese note (the in-app updater copy convention is the short line `反正没什么人看，布想写日志了` unless the user asks for a long changelog).
3. `git diff --check` + `node --check server.js` + visual verification.
4. `npm run build:win` → `dist/Mineradio-<version>-Setup.exe` (+ `.blockmap`, `latest.yml`).
5. Upload to GitHub Release: installer `.exe`, `.blockmap`, `latest.yml`, and any `Mineradio-<from>→<to>.patch.json` light patches. Patch policy: skip the `0.9.x` series entirely; for `1.0.x`+ generate cross-version patches for only the most recent ~4 versions (older users get the full installer). The `→` arrow in patch filenames is sanitized to `.` on GitHub but the from/to versions still parse.

**GitHub access gotcha (author's machine):** `gh`/git over HTTPS needs the working proxy `127.0.0.1:10808`; the old `127.0.0.1:26001` is dead (`connection refused`). Temporarily clear `HTTP_PROXY`/`HTTPS_PROXY` then set `http://127.0.0.1:10808` when releasing.

### Installer path/uninstall safety (P0 — do not regress)
From `docs/PROJECT_MEMORY.md` (2026-06-25) and `build/installer.nsh`:
- Default install path prefers `D:\Mineradio`, then E…Z; only fall back to `C:\Mineradio` when **no** D–Z drive exists. Block installing directly into a non-empty non-Mineradio directory. Only a `.mineradio-install-root` marker counts as Mineradio-owned.
- The new uninstaller deletes only known Mineradio/Electron top-level files; `resources`/`locales` subdirs get non-recursive empty-dir cleanup only. **Never restore `RMDir /r $INSTDIR`** or recursive deletion of app subdirs. Never run the old uninstaller; never default back to `AppData\Local\Programs` or a bare drive root.

### Security rebuild context
`v1.0.10` and earlier installers are **quarantined / untrusted** (suspected infection on the author's machine — see `docs/SECURITY_REBUILD_2026-06-24.md`). `v1.1.0`/`v1.1.1` are clean rebuilds from git-tracked source. The `v1.1.0` release deliberately did **not** upload `latest.yml` (so old `v1.0.10` clients can't auto-update into it) — users must manually download and clean-install. Never reuse old `dist/`, old `node_modules`, browser profiles, or scan artifacts; rebuild from current source and scan before publishing.
