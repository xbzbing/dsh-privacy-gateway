# Privacy Gateway

Adds a redaction gateway to the dsh process. When a request to a model has a secret in it, such as an API key, a token or a cookie, the value goes out as a placeholder; placeholders in the model's reply are replaced with the real values before the agent sees them. The gateway sits on undici's global dispatcher, so every provider that goes through `fetch()` passes it, adapters from plugins included, and neither the agent nor the providers need any change.

## Features

- **Masking**: API keys (OpenAI, Anthropic, GitHub, AWS, Alibaba Cloud, Tencent Cloud and other prefixes), JWTs, PEM private keys, passwords in URLs and fields, and cookies; optionally email addresses, phone numbers, ID card and bank card numbers, and your own words.
- **Restoring**: JSON replies are restored whole and SSE replies event by event, including a placeholder split between two events.
- **Cache-friendly**: one value is the same placeholder every turn, so the prompt cache still hits.
- **An action per kind**: mask, send as written and record (warn), or not send the request at all (block).
- **Exfiltration guard**: when a tool call's arguments would get a real value back and name a host off this machine, warn, or leave the placeholder in.
- **Look-alike keys**: optionally send a key as a made-up one with the same prefix, length and kinds of character, so the model cannot tell it was masked.
- **Records and statistics**: only requests with something masked or restored are recorded, and a record never holds a value. The `/privacy` command shows the state and a preview; the plugin's detail page has a statistics card, and a Privacy tab can be turned on at the top of the session.
- **Fails closed**: when masking fails, the request is not sent; `/privacy off` turns masking off for the moment.

## Repository

[github.com/xbzbing/dsh-privacy-gateway](https://github.com/xbzbing/dsh-privacy-gateway): the README there has the configuration, the design decisions (ADRs) and the full documentation.
