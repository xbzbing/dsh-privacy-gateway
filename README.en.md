# dsh-privacy-gateway

[简体中文](README.md) | English

![The model only sees {{placeholder}}: secrets, credentials and personal data go out as placeholders and come back as real values — one interception point, every model request through the global fetch goes through it](docs/assets/screenshots/0-banner-en.png)

A redaction gateway on the host process's undici global dispatcher. Secrets in outgoing model request bodies are replaced with placeholders, and placeholders in the replies are replaced back with the real values. The agent, adapters and providers don't notice it, and one interception point covers every provider that goes through `fetch()`, including adapters that plugins provide.

If you are using an **API relay**, or you are working with **sensitive information** or **production data**, please be sure to protect information security.

## Install

```bash
# Stable (npm)
dsh plugin --profile web add dsh-privacy-gateway@latest

# The same version as a GitHub Release asset (prereleases get one too)
dsh plugin --profile web add https://github.com/xbzbing/dsh-privacy-gateway/releases/download/v0.1.4/dsh-privacy-gateway-0.1.4.tgz
```

A prerelease version has a `-` in it and goes to GitHub Releases only, never to npm. The repository does not commit `lib/`, so `dsh plugin add github:…` cannot load the plugin ([ADR-0006](docs/adr/0006-distribution-and-build-artifacts.md)).

In the default web profile the first install works at once, with no restart of the dsh instance. Updating the plugin through the dsh web profile's plugin update feature needs no restart of the dsh instance either. When updating by hand, uninstall the old version before installing the new one, and that needs no restart either.

## Features

- **What is masked**: keys, tokens, passwords, private keys, cookies, email addresses, phone numbers, ID card and bank card numbers, and your own words — each with its own switch.
- **Actions**: pick `mask` / `warn` / `block` per kind; a key can be sent as a made-up key of its own form (`shape`).
- **Records and statistics**: records written to disk by the day, a statistics card, and the session's 「隐私保护」 (Privacy) tab; a record holds placeholders, never a value.
- **The `/privacy` command**: status, a temporary on / off, and `test` to preview how a text would go out.
- **Live configuration**: everyday items are changed on the plugin page and apply from the next call; when masking fails, the request is not sent.

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

A value masked once is masked with the same placeholder wherever else the request has it (its finder is `known`), `url` / `image_url` included; a signed URL (an S3 presigned one, say) goes as it is, since masking one character breaks it ([ADR-0004](docs/adr/0004-protected-regions.md)). History sent to the same host again keeps the bytes it went with before, so the prompt cache still hits.

To try it: every line below is a **fake** value; paste one into a session and the matching record on the card shows the placeholder it became. Neither the records, the stats, the log nor the vendorView copy holds the value, only the placeholder and a few characters at each end.

```text
sk-proj-Zq7Lr2Vt9mK1Px3aB5cD8eF0gH4jN6wY                             → API_KEY
ghp_Zq7Lr2Vt9mK1Px3aB5cD8eF0gH4jN6wYQ7RT2W                           → API_KEY
AKIAQ7RT2W9KLM4NP8XZ                                                 → API_KEY
Authorization: Bearer Zq7Lr2Vt9mK1Px3aB5cD8eF0gH4jN6wY9f2kLm4pQr7sT  → TOKEN
DB_PASSWORD=Zq7Lr2Vt9mK1Px3aB5cD8eF0gH4jN6wY9                        → SECRET
postgres://app:Zq7Lr2Vt9mK1Px3aB5cD8eF0gH4jN6wY9@db.internal/x       → PASSWORD
Cookie: BDUSS=Zq7Lr2Vt9mK1Px3aB5cD8eF0gH4jN6wY                       → COOKIE
someone@gmail.com                                                    → EMAIL
13800138000                                                          → PHONE
11010519491231002X                                                   → ID_CARD
```

- The Chinese wordings 「密码：…」 and 「密钥是 …」, and a password in a URL, are recorded as `{{PASSWORD_p7gqwtns}}`, apart from `SECRET`.
- `EMAIL`, `PHONE`, `ID_CARD` and `BANK_CARD` are off until 「脱敏个人信息」 is on.
- A word in 「自定义敏感词」 is replaced where it appears and recorded as `TERM`; a value in 「永不脱敏的值」 or `allow` goes out as it is.
- A private key goes whole: `-----BEGIN` to `-----END`, or a truncated one with only the opening lines and base64.
- A documentation domain (`example.com`, `.example`) is no email; a phone number needs 11 digits, an ID card its check digit, a bank card its Luhn sum.
- A field's value is no secret when it is a file's name: only a file name's characters, and an extension of a known kind (model weights such as `safetensors`, `gguf`, `ckpt`, archives, pictures, sound and video, documents and data); it goes out as it is ([ADR-0026](docs/adr/0026-file-name-values.md)).
- One value seen again gets the same placeholder.
- A secret shorter than 8 characters (`abc123`, `666666`, `888888`: a short password) is no value: it goes as written and makes no record. It is guessed in no time, so masking it only promises a protection that is not there — and the value table never matched anything that short as known anyway ([ADR-0031](docs/adr/0031-no-short-or-template-values.md)).
- A value typed to stand for a key is no value: eight or more of one character in a row (`sk-proj-xxxx…`, `AKIA0000…`), or one that says what it is (`your_api_key`, `example`, `changeme`, `placeholder`, `dummy`, `***`). A random key has such a run with a chance below one in a billion, and a vendor's real test key (`sk_test_…`) is still masked ([ADR-0031](docs/adr/0031-no-short-or-template-values.md)).
- The name of a cryptographic algorithm is no value: names like `SCRAM-SHA-512` and `PBKDF2WithHmacSHA256` are published in a spec for anyone to read, so masking one hides nothing; they go as they are ([ADR-0033](docs/adr/0033-algorithm-names.md)).
- A key is masked the way a value is: the key in `{"metadata": {"sk-…": …}}` goes as a placeholder and comes back in the reply. The protocol's own keys (`model`, `role`, `type`, `name`, `id` and so on), the tool definitions and a tool call's argument names are never touched ([ADR-0029](docs/adr/0029-mask-json-keys.md)).

## Screens

The screenshots show the Chinese interface.

| Plugin configuration | The 「隐私保护」 (Privacy) tab |
| :---: | :---: |
| ![Plugin configuration: the master switch, secrets and credentials, personal data, shape, the tool-call guard, and the words, records, tab and provider groups](docs/assets/screenshots/1-plugin-config.png) | ![The 「隐私保护」 tab: the per-session switch, today / 7 days / 30 days statistics, the kind, finder and host breakdowns, and the recent records](docs/assets/screenshots/2-privacy-panel.png) |

## Configuration

The everyday settings can be changed on the Configure page of this plugin's row on the plugin page: `enabled`, `secrets`, `personal`, `shape`, `toolGuard`, `maskKeys`, `words`, `allow`, `record`, `keepDays`, `recordContext`, `vendorView`, `showPanel`, `excludeProviders`. A change is saved at once and applies from the next model call, with no restart ([ADR-0021](docs/adr/0021-live-settings.md)). The others are changed in the profile's `~/.dsh/profiles/<profile>/cordis.patch.yml`, under `config` of the `id: dsh-privacy-gateway` row; the `cordis.patch.yml` shipped in the package is replaced on upgrade, so do not edit it.

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch; when off, the gateway stays but lets every request by as it is, restoring and recording nothing |
| `secrets` | `true` | Mask secrets, tokens, passwords, private keys and cookies |
| `personal` | `false` | Mask email addresses, phone numbers, ID card and bank card numbers |
| `words` | `[]` | Your own words (a project's code name, a customer's name), masked as written as `TERM` |
| `allow` | `[]` | Values never masked: whole values, in any case |
| `actions` | `{}` | An action per kind: `mask` (the default, a placeholder), `warn` (sent as written and recorded) or `block` (the whole request is not sent). For example `{ PRIVATE_KEY: block, EMAIL: warn }` ([ADR-0013](docs/adr/0013-actions.md)) |
| `maskKeys` | `true` | A **JSON key** that reads like a secret or personal data goes as a placeholder too (`{"sk-…": …}`). The protocol's own keys (`model`, `role`, `type`, `name`, `id` and so on), the tool definitions and a tool call's argument names are never touched, or the vendor could not read the request. When off, such keys go as they are ([ADR-0029](docs/adr/0029-mask-json-keys.md)) |
| `toolGuard` | `off` | When a tool call's arguments would have a value restored and name a host off this machine: `off` only counts it, `warn` logs and records it, `block` leaves the placeholders in that call's arguments, so the tool gets the placeholder ([ADR-0014](docs/adr/0014-tool-guard.md)) |
| `shape` | `false` | Send a key as a made-up key of its own form (same prefix, length and kinds of character) instead of a `{{…}}` placeholder; a value under 8 characters, or holding anything but letters, digits, `-`, `_` and `.`, keeps the placeholder; replies put it back the same way ([ADR-0015](docs/adr/0015-shape.md)) |
| `cookieNames` | `[]` | More cookie names to mask |
| `cookieKeep` | `['lang', 'locale', 'theme', 'tz']` | Cookie names never masked |
| `protectEnvBlock` | `true` | Send `<env>` … `</env>` blocks as written, for providers that check them; only in text the host writes (the system prompt, `system`, `instructions`, `systemInstruction`), never in a user message or a tool result ([ADR-0004](docs/adr/0004-protected-regions.md) supplement) |
| `protectTools` | `true` | Send the request's `tools` array as written |
| `excludeHosts` | `[]` | `host` or `host:port` entries that are never rewritten |
| `excludeProviders` | `[]` | Provider ids whose requests are not masked; checked on the Configure page from the providers registered now. Their requests go out as they are, replies are not restored, nothing is recorded, and the log says so once for each provider ([ADR-0018](docs/adr/0018-exclude-providers.md), [ADR-0034](docs/adr/0034-log-excluded-provider.md)) |
| `maxValues` | `5000` | Size of the in-memory value table; when full, the oldest half is dropped |
| `record` | `true` | Write the masking records to disk; when off, the statistics stay in memory |
| `keepDays` | `30` | Days of records kept |
| `recordContext` | `true` | Each value in a record keeps every place it was at (a user message, a tool result and so on, up to 8 a value) and about 80 characters each side of the first, taken from what was sent, with every masked value a placeholder ([ADR-0024](docs/adr/0024-record-context.md), [ADR-0028](docs/adr/0028-record-every-place.md)) |
| `keepMegabytes` | `100` | Megabytes of records kept; past it, the oldest days are deleted |
| `keepRecords` | `500` | Latest records kept in memory |
| `vendorView` | `false` | Keep in memory the body each recorded request went out with, for the side-by-side view in the statistics card; at most 100 bodies and 64 MiB in all, never on disk ([ADR-0016](docs/adr/0016-vendor-view.md)) |
| `showPanel` | `false` | Offer a 「隐私保护」 (Privacy) tab at the top of the session (after Chat / Trajectory / Git) with this session's records and counts ([ADR-0017](docs/adr/0017-sidebar-panel.md)) |

## The `/privacy` command

| Usage | What it does |
| --- | --- |
| `/privacy` or `/privacy status` | On or off, the value table's size, today's / 7 days' / 30 days' requests and places replaced, the counts by kind and finder, and warning signals |
| `/privacy off` | Stops masking for this run: requests go as written. The config is unchanged; a restart turns masking back on |
| `/privacy on` | Turns masking back on |
| `/privacy test <text>` | Shows how the text would go: the masked text, and each value's kind, finder, head and length. Nothing goes into the value table, and the text is not written to the session log |

No answer of the command has a value in it.

## Records and statistics

Only a model request that had something masked or restored makes a record, one each: its time and duration, host, model, session with its workspace and title, places replaced, each value's placeholder / kind / finder / head / length / every place it was at (up to 8 per value, the rest counted), the turn and step the request went out in, the turn and step the value was first sent in this run, the places restored in the reply (those in tool arguments counted apart), and the placeholders the value table does not know. A record never holds a value, nor a URL's query ([ADR-0008](docs/adr/0008-masking-records.md), [ADR-0020](docs/adr/0020-record-attribution.md)).

The head keeps a few characters to recognize it by: a key with a prefix keeps the prefix and the 4 characters after it, one without keeps its first 4, and a long value also keeps its last 2 (`sk-proj-g6sx…3QaZ`); shorter values keep fewer, and personal data and your words keep one ([ADR-0019](docs/adr/0019-hint.md)).

Records go to a `masking/YYYY-MM-DD.jsonl`, one file a day (directory 0700, files 0600); state lives in the current instance's own directory (`~/.dsh/profiles/<profile>/plugin-data/dsh-privacy-gateway/`), so instances never write into each other ([ADR-0027](docs/adr/0027-per-instance-state.md)). A failed write is a warning, and the request goes on.

The plugin's detail page has a statistics card: today / 7 days / 30 days, the counts, the distributions by kind / finder / host (six entries at most, the rest summed into one 「Other kinds / finders / hosts」 row; hovering a title or a name explains it) and the latest 200 records, 10 a page. Open one to see each value: placeholder, kind / finder, head, length, times, the message it went in (`messages.3`) and the text around it, plus the other places the same value was sent. Each record says which turn and step it went out in (`42·3`, numbered as the Trajectory tab; it is the step that SENT it), and each value says where it was first sent in this run. The kind and finder column heads filter the rows, changing only what is shown ([ADR-0035](docs/adr/0035-kind-finder-hints-and-filters.md)). 「清空数据」 (Clear data), once its box is checked, deletes every record and count and cannot be undone ([ADR-0022](docs/adr/0022-reset.md)). With `showPanel` on, the same view is a 「隐私保护」 (Privacy) tab at the top of the session, counting only that session; the tab's switch turns masking off for that session alone ([ADR-0023](docs/adr/0023-session-switch.md)).

With `vendorView` on (「保留发出内容，供对照查看」 on the config page), a record shows 「查看发出内容」: replaced places on the left (kind · head · length), the body the model service received on the right; neither side ever shows a value.

## Notes

- The session log holds the real values: replies are restored before the log is written ([ADR-0003](docs/adr/0003-restore-before-session-log.md)). Session sync, backups and shares carry the real values.
- Only traffic through the global `fetch()` is covered; direct `node:http`, worker threads and separate processes bypass the gateway ([ADR-0001](docs/adr/0001-intercept-at-undici-global-dispatcher.md)). Only JSON model requests it recognizes are rewritten (array `messages`, array or string `input`, `contents`, string `prompt`); multipart, forms and non-JSON bodies go as written and leave no record ([ADR-0001](docs/adr/0001-intercept-at-undici-global-dispatcher.md)).
- Compressed requests and replies are decompressed before they are masked or restored; a `content-encoding` with no decoder fails the request ([ADR-0025](docs/adr/0025-compression-and-upgrades.md)). An upgrade (the WebSocket handshake) or a `CONNECT` tunnel inside a model call is refused as well: Codex falls back to SSE the first time and takes SSE from then on in that session. One opened by a plugin outside a model call (dsh-im-infoflow's inbound, say) is let through, its messages unmasked, with one warning per host ([ADR-0032](docs/adr/0032-upgrade-scoped-to-masked-calls.md)) — a fail-closed to fail-open trade whose cost the ADR records; a host that needs a transparent link can still go into `excludeHosts`.
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
- State lives in the current instance's own directory (`plugin-data/dsh-privacy-gateway/` under `ctx.profileContext.dir`), falling back to `~/.dsh/privacy-gateway/` when there is no profile; the `DSH_PRIVACY_GATEWAY_HOME` environment variable wins over both ([ADR-0027](docs/adr/0027-per-instance-state.md)).
- The config schema holds no `.transform()` or other callback-bearing node.
- `scripts` declares no install-time lifecycle script.
- Other dispatcher plugins join under the gateway through the composition contract of [ADR-0012](docs/adr/0012-dispatcher-composition.md) (`chainTo`, `below`, `release`, `downstreams`).
- Architecture decisions are recorded in [docs/adr/](docs/adr/README.md).
- `README.en.md` follows `README.md` item by item.

## Acknowledgements

The redaction design follows [magpie](https://github.com/yetone/magpie): how placeholders are made and restored, the rule table, the JSON fields left untouched, and the handling of escaped JSON keep its semantics, rewritten in TypeScript.

## License

[MIT](LICENSE)
