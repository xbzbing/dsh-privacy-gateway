# Privacy Gateway

Adds a redaction gateway to the dsh process. When a request to a model has a secret in it, such as an API key, a token or a cookie, the value goes out as a placeholder; by default the placeholders in the model's reply reach the agent and the session log as they are, without replacing them with real values, and `restoreLog` puts them back before the log is written. User input and tool output are logged before the gateway acts and can still contain sensitive originals.

## Repository

[dsh-privacy-gateway](https://github.com/xbzbing/dsh-privacy-gateway): the configuration options, the design decisions (ADRs) and the full documentation are in the repository README.

If this project helps you, please give it a star 🌟

## Features

- **Masking**: API keys (OpenAI, Anthropic, GitHub, AWS, Alibaba Cloud, Tencent Cloud and other prefixes), JWTs, PEM private keys, passwords in URLs and fields, and cookies; optionally email addresses, phone numbers, ID card and bank card numbers, and your own words.
- **Reply placeholders stay unrestored by default**: a reply's placeholders reach the agent and the session log as they are; with `restoreLog` on, JSON replies are restored whole and SSE replies event by event, including a placeholder split between two events.
- **Cache-friendly**: one value is the same placeholder every turn, so the prompt cache still hits.
- **An action per kind**: mask, send as written and record (warn), or not send the request at all (block).
- **Exfiltration guard**: with `restoreLog` on, when a tool call's arguments would get a real value back and name a host off this machine, warn, or leave the placeholder in.
- **Look-alike keys**: optionally send a key as a made-up one with the same prefix, length and kinds of character, so the model cannot tell it was masked; a value under 8 characters, or with unusual characters, keeps the placeholder.
- **Records and statistics**: only requests with something masked or restored are recorded, and a record never holds a value. The `/privacy` command shows the state and a preview; the plugin's detail page has a statistics card, and a Privacy tab can be turned on at the top of the session.
- **History query**: the Record query section under the statistics card reads the kept days by range and by kind, not just the latest 200; a scan is sliced and resumable, a published page never changes, and opening a row checks that line on disk again.
- **What was sent**: optionally keep a copy in memory. Protected regions, allow entries and unmatched content may still contain sensitive originals; the copy is as sensitive as the session log, not a safe export of raw data.
- **Fails closed**: when masking fails, the request is not sent; `/privacy off` turns masking off for the moment.
- **Two working modes**: the default `dispatcher` sits in front of the undici global dispatcher and covers every model request through the global `fetch()`; the experimental `stream` masks at the `llm/stream` structured layer, for environments where a proxy plugin took over `fetch`, covers only the calls that go through it, and leaves `maskKeys` and “keep what was sent” off. The `intercept` field, first in the Masking group of the configuration page, switches between them; set it back to `dispatcher` to return to the default.
