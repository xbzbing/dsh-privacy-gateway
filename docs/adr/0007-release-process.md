# ADR-0007：发布流程：GitHub Actions 驱动

- 状态：Accepted（2026-10-31）
- 相关：`.github/workflows/release.yml`、`.github/workflows/ci.yml`、`.github/RELEASE_TEMPLATE.md`、`.github/PRERELEASE_BODY.md`、`docs/releases/`、ADR-0006

## Context

手工发布要改 manifest、构建、打 tag、写正文、发布，每一步都能漏。npm 发布不可逆，漏了正文或发错产物没法回头。流程照 dsh-git-panel 的 ADR-0019 / ADR-0021，已经在那边稳定运行。

## Decision

- **CI**（`ci.yml`）：push 到 main、每个 PR、手动触发时，在 Node 22.x 与 24.x 上跑 `pnpm install --frozen-lockfile` → typecheck → 单测 → 构建、打包与 `assert-pack`。
- **发布**（`release.yml`）：push 到 main 且改动 `package.json`，或手动触发。
  - `package.json` 带 `"private": true` 时什么都不做。首次正式发布前删掉这一行。
  - 版本号含 `-`（`0.1.0-rc.1`）是预发布：只建 GitHub prerelease 并附 tgz，不发 npm。
  - 纯 semver 是正式版：先 `npm publish --provenance`，再建稳定 Release 并附同一个 tgz。
  - 顺序：状态检查 → 正文检查 → 门禁（`pnpm verify`、构建、打包、`assert-pack`）→ 打 tag → 〔正式版〕npm publish → Release。npm 是唯一不可逆的一步，排在 tag 之后、Release 之前。
  - 幂等可重跑：npm 已有该版本、远端已有 tag、已有 Release 时相应步骤跳过；稳定 Release 的正文按文件刷新。
- **正文**：正式版的 `docs/releases/v<版本>.md` 随发版提交入库，格式以 `.github/RELEASE_TEMPLATE.md` 为唯一来源（四段双语 + compare 链接）。文件缺失时在门禁之前失败。预发布用 `.github/PRERELEASE_BODY.md` 的固定说明建页，正文发布后用 `gh release edit` 补，不入库。
- npm 认证优先 Trusted Publishing（OIDC）；退回 `NPM_TOKEN` 时用只限本包、只能 publish 的 granular token。

## Consequences

- 发版由人发起（`pnpm version <v> --no-git-tag-version` + 正文 + 推 main），之后全部由 workflow 完成，不要手工在 main 上打 tag。
- workflow 需要 `contents: write`（打 tag、建 Release）与 `id-token: write`（provenance / OIDC）。
- 前提：仓库在 GitHub 上（`xbzbing/dsh-privacy-gateway`，与 `package.json` 的 `repository` 一致，provenance 要求两者匹配），并在 npmjs.com 登记 trusted publisher 或配置 `NPM_TOKEN`。
- 在网页上手改稳定 Release 正文而不改文件，下次重跑会被文件覆盖；文件是唯一来源。
