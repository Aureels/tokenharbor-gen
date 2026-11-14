# TokenHarbor Account Generator

Automated signup for https://tokenharbor.ai using temporary emails.

## Install

```bash
npm install
npx playwright install chromium
```

## Usage

```bash
npm start 1                # 1 account, direct (no proxy)
npm start 5                # 5 accounts, direct
npm start 5 -- --proxy     # 5 accounts, use proxies.txt
npm start 1 -- --debug     # verbose logs
```

On Linux without a display, the script re-executes itself under `xvfb-run` automatically. `npm run start:xvfb` does the same explicitly.

## Features

- Headful Chromium (better Turnstile pass rate than headless)
- Temp email via `tempmail.ing` API
- Proxies optional: `--proxy` loads and validates the list in `proxies.txt` before use
- 100 random desktop user-agents generated in code
- Stealth plugin + `navigator.webdriver` override
- Fingerprint hygiene: timezone derived from proxy (or own IP) via `ip-api`, WebGL vendor/renderer spoofed, real Chrome used when installed
- 3 retries per account with a fresh proxy and context; a burned email is replaced after submit
- Fail-fast Turnstile wait (20s per attempt)
- Atomic save (`list.json.tmp` → `list.json`) with email dedupe

## Structure

```
index.js            CLI + orchestration
src/account.js      signup flow with retries
src/mail.js         tempmail client + code extraction
src/proxy.js        load, validate, pick proxies
src/geo.js          proxy/self geo lookup (timezone source)
src/fingerprint.js  init script (webdriver, WebGL, languages)
src/turnstile.js    challenge wait (fail-fast)
```

## Output

```json
[
  { "email": "abc@tempmail.ing", "password": "Str0ngP@ss!", "createdAt": "2026-...", "proxy": "none" }
]
```

## Limitations

**Cloudflare Turnstile** is the main blocker. Headful via Xvfb improves the pass rate, but a flagged IP (many attempts from the same address) will not pass regardless. Run from a clean residential/mobile IP for best results.

## Proxy Format (`proxies.txt`)

```
http://host:port
http://user:pass@host:port
socks5://user:pass@host:port
```

Free datacenter proxies are usually blocked by Cloudflare. Use residential/mobile proxies for multi-account runs.

## Legal

For educational/testing only. Automated signup may violate ToS. Use at your own risk.
