# dsh-privacy-gateway

[中文](README.md) | English

A DeepSeek Harness plugin that adds a redaction gateway on the host process's undici global dispatcher. Secrets in outgoing model request bodies are replaced with placeholders, and placeholders in the replies are replaced back with the real values. The agent, adapters and providers don't notice it, and one interception point covers every provider that goes through `fetch()`, including adapters that plugins provide.

Status: P0 (interception point proven) is implemented; not released yet. Only three kinds of secret are recognised so far: `sk-…`, GitHub / GitLab tokens (`ghp_…`, `github_pat_…`, `glpat-…`), and AWS `AKIA…` / `ASIA…`.

## Install

Once a stable version is released:

```bash
dsh plugin --profile web add dsh-privacy-gateway@latest
```

Each version's GitHub Release also carries the same tgz, which can be installed by its asset URL. The repository source has no build output `lib/`, so a `github:` install without a ref will not load ([ADR-0006](docs/adr/0006-distribution-and-build-artifacts.md)).

In the default web profile a first install takes effect immediately, with no restart. This plugin has a host half only, so after upgrading an installed version, restart dsh to load the new code.

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch; when off, the gateway is not installed |
| `secrets` | `true` | Mask secrets |
| `protectEnvBlock` | `true` | Send `<env>` … `</env>` blocks as written, for providers that check them ([ADR-0004](docs/adr/0004-protected-regions.md)) |
| `protectTools` | `true` | Send the request's `tools` array as written |
| `excludeHosts` | `[]` | `host` or `host:port` entries that are never rewritten |
| `maxValues` | `5000` | Size of the in-memory value table; when full, the oldest half is dropped |

## Notes

- The session log holds the real values: replies are restored before the log is written ([ADR-0003](docs/adr/0003-restore-before-session-log.md)). Session sync, backups and shares carry the real values.
- Only traffic through the global `fetch()` is covered; direct `node:http`, worker threads and separate processes bypass the gateway ([ADR-0001](docs/adr/0001-intercept-at-undici-global-dispatcher.md)).
- When masking fails, the request is not sent and fails with `dsh-privacy-gateway: masking failed, request not sent` ([ADR-0005](docs/adr/0005-fail-closed.md)). To recover, disable the plugin on the Plugins page, or set `enabled` to `false`.

## Development

```sh
pnpm install
pnpm verify   # typecheck + test
pnpm build    # builds lib/ (not committed)
```

Run `pnpm build` before installing from a local directory:

```sh
dsh plugin --profile web add file:/path/to/dsh-privacy-gateway
```

For CI and releases see [ADR-0007](docs/adr/0007-release-process.md) and [.github/RELEASE_TEMPLATE.md](.github/RELEASE_TEMPLATE.md).

## Conventions

- The package name, cordis row name, loader id and settings namespace are all `dsh-privacy-gateway` (the row name must equal the package name).
- State lives in `~/.dsh/privacy-gateway/`; the `DSH_PRIVACY_GATEWAY_HOME` environment variable moves it.
- The config schema holds no `.transform()` or other callback-bearing node.
- `scripts` declares no install-time lifecycle script.
- Architecture decisions are recorded in [docs/adr/](docs/adr/README.md).
- `README.en.md` follows `README.md` item by item.

## Acknowledgements

The redaction design follows [magpie](https://github.com/yetone/magpie): how placeholders are made and restored, the rule table, the JSON fields left untouched, and the handling of escaped JSON keep its semantics, rewritten in TypeScript.

## License

[MIT](LICENSE)
