# ADR-0006：分发渠道与构建产物：`lib/` 不入库

- 状态：Accepted（2026-10-31）
- 相关：`.gitignore`、`package.json` 的 `files` 与 `scripts`、`scripts/assert-pack.mjs`、`.github/workflows/ci.yml`、ADR-0007

## Context

插件入口 `main` / `exports` 指向构建产物 `lib/`。把 `lib/` 提交进仓库可以让 `dsh plugin add github:…` 直接装上，但每次改源码都要带新鲜产物，并行分支在产物上必然冲突（dsh-git-panel 的 ADR-0018 记录了同样的代价）。

让安装端自己构建也不可行：pnpm 默认不执行 git 依赖的构建脚本；DSH 插件管理器把构建脚本审批做成人工步骤，且脚本以宿主用户权限执行。

## Decision

- `lib/` 不入库，`.gitignore` 覆盖整个目录。
- 不挂任何安装期生命周期脚本：`preinstall`、`install`、`postinstall`、`prepare`、`prepublish`、`prepublishOnly`、`prepack`、`postpack` 都不出现在 `scripts` 里。构建只是显式的 `pnpm build`。
- 正式版走 npm：`dsh plugin --profile web add dsh-privacy-gateway@<版本>`。
- 每个版本的 `pnpm pack` tarball 作为 GitHub Release 附件；预发布只走附件。npm 与 Release 用的是同一个 tgz。
- 产物由 CI 与 release workflow 生成：`pnpm build` → `pnpm pack` → 解包后用 `scripts/assert-pack.mjs` 检查必需文件、manifest 指向的文件都在，且没有安装期脚本。
- 本地开发安装用目录：先 `pnpm build`，再按目录安装（目录安装链接 checkout，读本地的 `lib/`）。

## Consequences

- 仓库 diff 只有源码，分支不会在产物上冲突。
- 不带 ref 的 `dsh plugin add github:xbzbing/dsh-privacy-gateway` 拿到的树没有 `lib/`，插件加载不了。README 只推荐 npm 与 Release 附件。
- `files` 漏掉运行时文件、入口指错，会在 CI 的打包检查里失败，不会等到用户安装。
- `LICENSE`（MIT）与 `README.md` 随包分发，由 `assert-pack.mjs` 检查。
