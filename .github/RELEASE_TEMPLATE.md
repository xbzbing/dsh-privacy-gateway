# Release notes template

本文件是**正式版** GitHub Release 正文的唯一格式来源（ADR-0007）。发版时照抄下面的骨架写进 `docs/releases/v<版本>.md`，随发版提交一起入库。

- Release 标题 = tag 名 = `v<package.json version>`。
- 正文中英双语：中文段在前，`---` 分隔，英文段在后；两段内容一一对应。
- 两段都以 compare 链接收尾：`https://github.com/xbzbing/dsh-privacy-gateway/compare/<PREV>...<TAG>`，`<PREV>` 是上一个**正式版** tag，跳过中间的 rc / alpha。首个正式版没有 `<PREV>`，改链到 `https://github.com/xbzbing/dsh-privacy-gateway/commits/<TAG>`。
- 不用 GitHub 自动生成的 `## What's Changed`，不用 `--generate-notes`。
- `docs/releases/` 只收正式版；预发布页面由 workflow 用 `.github/PRERELEASE_BODY.md` 建好后，再用 `gh release edit "v<v>" --notes-file docs/local/releases/v<v>.md` 补正文。

## 写作规则

- **主要变更**：一条一个用户可感知的结果，标题加粗，冒号后写现在是什么样、为什么值得升级；`**内部**` 类放最后。不写版本号变更、`lib/` 重建、纯格式调整。
- **验证**：写当次 `pnpm verify` 的真实输出（单测数）与 `assert-pack` 结果，数字不得沿用上一版；再写 1–3 条最有判别力的回归。
- **安装**：npm 一条钉到本版具体版本（不写 `@latest`），加同版本 Release 附件一条；命令带 `--profile web`。

## 骨架

<!-- 从下一行开始复制 -->

## 主要变更

- **<用户可感知的标题>**：<现在是什么样、为什么值得升级>（#<issue 或 PR>）
- **修复**：<修掉的现象与影响面>（#<N>）
- **内部**：<约定 / 门禁 / 结构性改动>

## 安装

```bash
# 正式版（npm）
dsh plugin --profile web add dsh-privacy-gateway@<VERSION>

# 同一版本的 GitHub Release 附件
dsh plugin --profile web add https://github.com/xbzbing/dsh-privacy-gateway/releases/download/<TAG>/dsh-privacy-gateway-<VERSION>.tgz
```

## 验证

- `pnpm verify` 全绿：typecheck + <N> 单测；`assert-pack` 通过
- <关键回归：修了什么；去掉该修复后哪条测试转红>

[完整变更记录 <PREV>...<TAG>](https://github.com/xbzbing/dsh-privacy-gateway/compare/<PREV>...<TAG>)

---

## English

- **<Title>**: <what it does now and why it is worth upgrading> (#<issue or PR>)
- **Fixes**: <the symptom and its blast radius> (#<N>)
- **Internal**: <conventions / gates / structural changes>

## Install

```bash
# Stable (npm)
dsh plugin --profile web add dsh-privacy-gateway@<VERSION>

# The same version as a GitHub Release asset
dsh plugin --profile web add https://github.com/xbzbing/dsh-privacy-gateway/releases/download/<TAG>/dsh-privacy-gateway-<VERSION>.tgz
```

## Verification

- `pnpm verify` green: typecheck + <N> unit tests; `assert-pack` passed
- <key regression: what was fixed and which test turns red without it>

[Full changelog <PREV>...<TAG>](https://github.com/xbzbing/dsh-privacy-gateway/compare/<PREV>...<TAG>)

<!-- 复制到上一行结束 -->

## 发布流程

```bash
# 首次正式发布前：删掉 package.json 的 "private": true（private 时 release workflow 什么都不做）

# 1. 版本号：预发布用带 - 的版本（0.1.0-rc.1，只发 GitHub）；正式版用纯 semver（0.1.0，发 npm + Release）
pnpm version <v> --no-git-tag-version

# 2. 正式版正文（预发布跳过）
$EDITOR docs/releases/v<v>.md
git add package.json docs/releases/v<v>.md && git commit -m "chore: release v<v>"
git push origin main
```

合入 main 后 `.github/workflows/release.yml` 自动完成：门禁 → 打 tag →（仅正式版）`npm publish --provenance` → GitHub Release（附同一个 tgz）。不要手工在 main 上打 tag。失败后可直接重跑：`gh workflow run release.yml`。
