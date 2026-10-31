# dsh-privacy-gateway

[中文](README.md) | English

A DeepSeek Harness plugin that adds a redaction gateway on the host process's undici global dispatcher. Secrets in outgoing model request bodies are replaced with placeholders, and placeholders in the replies are replaced back with the real values. The agent, adapters and providers don't notice it, and one interception point covers every provider that goes through `fetch()`, including adapters that plugins provide.

Status: P1 is implemented; not released yet.

## What is masked

| Kind | What | Switch |
| --- | --- | --- |
| `API_KEY` | OpenAI / Anthropic `sk-…`, GitHub / GitLab tokens, Google `AIza…`, Slack `xox…`, Stripe, AWS `AKIA…`, Alibaba Cloud `LTAI…`, Tencent Cloud `AKID…`, Hugging Face, Groq, xAI, npm, PyPI, DigitalOcean, SendGrid and other prefixes | `secrets` |
| `TOKEN` | JWTs | `secrets` |
| `PRIVATE_KEY` | PEM private key blocks | `secrets` |
| `PASSWORD` / `SECRET` | Passwords in URLs, fields named password / secret / token, Chinese phrases such as 「密码为…」「密钥是…」 | `secrets` |
| `COOKIE` | `Cookie` / `Set-Cookie` headers, `curl -b`, cookies.txt, Playwright storageState, HAR, common session cookie names (`BDUSS`, `JSESSIONID` and others) | `secrets` |
| `EMAIL` / `PHONE` / `ID_CARD` / `BANK_CARD` | Email addresses, mainland China mobile numbers, ID card numbers (check digit), bank card numbers (Luhn) | `personal` |
| `TERM` | The words listed in the `words` config | whenever there are words |

A value masked once is masked with the same placeholder wherever else the request has it (its finder is `known`). History sent to the same host again keeps the bytes it went with before, so the prompt cache still hits.

## Install

Once a stable version is released:

```bash
dsh plugin --profile web add dsh-privacy-gateway@latest
```

Each version's GitHub Release also carries the same tgz, which can be installed by its asset URL. The repository source has no build output `lib/`, so a `github:` install without a ref will not load ([ADR-0006](docs/adr/0006-distribution-and-build-artifacts.md)).

In the default web profile a first install takes effect immediately, with no restart. The plugin has a host half, so after upgrading an installed version, restart dsh to load the new code.

## Configuration

The everyday settings can be changed on the Configure page of this plugin's row on the plugin page: `enabled`, `secrets`, `personal`, `shape`, `toolGuard`, `words`, `allow`, `record`, `keepDays`, `vendorView`, `showPanel`, `excludeProviders`. A change is saved at once and applies from the next model call, with no restart ([ADR-0021](docs/adr/0021-live-settings.md)). The others are changed in `cordis.patch.yml`.

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch; when off, the gateway stays but lets every request by as it is, restoring and recording nothing |
| `secrets` | `true` | Mask secrets, tokens, passwords, private keys and cookies |
| `personal` | `false` | Mask email addresses, phone numbers, ID card and bank card numbers |
| `words` | `[]` | Your own words (a project's code name, a customer's name), masked as written as `TERM` |
| `allow` | `[]` | Values never masked: whole values, in any case |
| `actions` | `{}` | An action per kind: `mask` (the default, a placeholder), `warn` (sent as written and recorded) or `block` (the whole request is not sent). For example `{ PRIVATE_KEY: block, EMAIL: warn }` ([ADR-0013](docs/adr/0013-actions.md)) |
| `toolGuard` | `off` | When a tool call's arguments would have a value restored and name a host off this machine: `off` only counts it, `warn` logs and records it, `block` leaves the placeholders in that call's arguments, so the tool gets the placeholder ([ADR-0014](docs/adr/0014-tool-guard.md)) |
| `shape` | `false` | Send a key as a made-up key of its own form (same prefix, length and kinds of character) instead of a `{{…}}` placeholder; replies put it back the same way ([ADR-0015](docs/adr/0015-shape.md)) |
| `cookieNames` | `[]` | More cookie names to mask |
| `cookieKeep` | `['lang', 'locale', 'theme', 'tz']` | Cookie names never masked |
| `protectEnvBlock` | `true` | Send `<env>` … `</env>` blocks as written, for providers that check them ([ADR-0004](docs/adr/0004-protected-regions.md)) |
| `protectTools` | `true` | Send the request's `tools` array as written |
| `excludeHosts` | `[]` | `host` or `host:port` entries that are never rewritten |
| `excludeProviders` | `[]` | Provider ids whose requests are not masked; checked on the Configure page from the providers registered now ([ADR-0018](docs/adr/0018-exclude-providers.md)) |
| `maxValues` | `5000` | Size of the in-memory value table; when full, the oldest half is dropped |
| `record` | `true` | Write the masking records to disk; when off, the statistics stay in memory |
| `keepDays` | `30` | Days of records kept |
| `keepMegabytes` | `100` | Megabytes of records kept; past it, the oldest days are deleted |
| `keepRecords` | `500` | Latest records kept in memory |
| `vendorView` | `false` | Keep in memory the body each recorded request went out with, for the side-by-side view in the statistics card; at most 100 bodies and 64 MiB in all, never on disk ([ADR-0016](docs/adr/0016-vendor-view.md)) |
| `showPanel` | `false` | Offer a Privacy tab at the top of the session (after Chat / Trajectory / Git) with this session's records and counts ([ADR-0017](docs/adr/0017-sidebar-panel.md)) |

## The `/privacy` command

| Usage | What it does |
| --- | --- |
| `/privacy` or `/privacy status` | On or off, the value table's size, today's / 7 days' / 30 days' requests and places replaced, the counts by kind and finder, and warning signals |
| `/privacy off` | Stops masking for this run: requests go as written. The config is unchanged; a restart turns masking back on |
| `/privacy on` | Turns masking back on |
| `/privacy test <text>` | Shows how the text would go: the masked text, and each value's kind, finder, head and length. Nothing goes into the value table, and the text is not written to the session log |

No answer of the command has a value in it.

## Records and statistics

Only a model request that had something masked or restored makes a record, one each (a request with neither makes none): the time, how long masking took, the host, the model, the session id with its workspace name and session title, the places replaced, each value's placeholder / kind / finder / head / length / tail, the places the reply had restored (with those in tool call arguments counted apart), and the placeholders the reply had that the value table has no value for. A record never holds a value, nor a URL's query ([ADR-0008](docs/adr/0008-masking-records.md), [ADR-0020](docs/adr/0020-record-attribution.md)).

The head keeps a few characters to recognize it by: a key with a prefix keeps the prefix and the 4 characters after it, one without keeps its first 4, and a long value also keeps its last 2 (`sk-proj-g6sx…3QaZ`); shorter values keep fewer. Personal data and the user's words still keep one character ([ADR-0019](docs/adr/0019-hint.md)).

Records go to `~/.dsh/privacy-gateway/masking/YYYY-MM-DD.jsonl`, one file a day; the directory is 0700 and the files 0600. A failed write is logged as a warning and the request goes on.

The plugin's detail page has a statistics card at the bottom: today / 7 days / 30 days, the counts, the distributions by kind / finder / host, and the latest 200 records, 10 a page, each with its workspace · session title; open one to see each of its values. The card's Clear data button, once its confirmation box is checked, deletes the records, counts and record files of every session; this cannot be undone ([ADR-0022](docs/adr/0022-reset.md)). With `showPanel` on, the same view is a Privacy tab at the top of the session, counting only that session.

With `vendorView` on (“Keep what was sent, to compare” on the Configure page), a record's details have a “What was sent” button, to check what the model service actually got and whether anything slipped through: on the right the body as the model service got it, on the left the same body with each replaced place shown as a "kind · head · length" marker; by default only the lines with replacements are listed. Neither side has a value in it; a value a warn action sent as written is a placeholder in the copy too.

## Notes

- The session log holds the real values: replies are restored before the log is written ([ADR-0003](docs/adr/0003-restore-before-session-log.md)). Session sync, backups and shares carry the real values.
- Only traffic through the global `fetch()` is covered; direct `node:http`, worker threads and separate processes bypass the gateway ([ADR-0001](docs/adr/0001-intercept-at-undici-global-dispatcher.md)).
- The value table is in memory only ([ADR-0009](docs/adr/0009-value-table-and-restore-exfiltration.md)). After a restart, a value no rule finds, masked only because it was remembered, goes as written the first time it is sent again.
- Replies are restored everywhere, tool call arguments included: a model led into writing a placeholder into a command such as `curl` runs the tool with the real value. The plugin counts these places (the tool-argument count on the card and in `/privacy status`) and does not block them ([ADR-0009](docs/adr/0009-value-table-and-restore-exfiltration.md)).
- When masking fails, the request is not sent and fails with `dsh-privacy-gateway: masking failed, request not sent` ([ADR-0005](docs/adr/0005-fail-closed.md)). To recover, run `/privacy off`, or disable the plugin on the Plugins page or set `enabled` to `false`.

## Development

```sh
pnpm install
pnpm verify   # typecheck + test
pnpm build    # builds lib/: the host half index.js and the client half client.js (not committed)
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
- Other dispatcher plugins join under the gateway through the composition contract of [ADR-0012](docs/adr/0012-dispatcher-composition.md) (`chainTo`, `below`, `release`, `downstreams`).
- Architecture decisions are recorded in [docs/adr/](docs/adr/README.md).
- `README.en.md` follows `README.md` item by item.

## Acknowledgements

The redaction design follows [magpie](https://github.com/yetone/magpie): how placeholders are made and restored, the rule table, the JSON fields left untouched, and the handling of escaped JSON keep its semantics, rewritten in TypeScript.

## License

[MIT](LICENSE)
