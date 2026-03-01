# tunnrl

[![npm version](https://img.shields.io/npm/v/tunnrl)](https://www.npmjs.com/package/tunnrl)
[![npm downloads](https://img.shields.io/npm/dt/tunnrl)](https://www.npmjs.com/package/tunnrl)
[![license](https://img.shields.io/npm/l/tunnrl)](https://github.com/holyghostlol/tunnrl/blob/main/LICENSE)
[![github stars](https://img.shields.io/github/stars/holyghostlol/tunnrl)](https://github.com/holyghostlol/tunnrl)

Expose localhost to the internet. Free. No signup. No time limit.

```
npx tunnrl 3000
```

```
localhost:3000  →  https://kxp7mq.tunnrl.dev
```

---

## Why tunnrl?

- **No signup** — run the command, get a URL. That's it.
- **No session limits** — your tunnel stays up as long as you need it.
- **Auto-reconnect** — wifi drops? tunnrl reconnects with exponential backoff.
- **Request logging** — color-coded status, method, path, duration, and size for every request.
- **QR code** — share your tunnel from terminal to phone in one scan.
- **Keyboard shortcuts** — quit, replay, copy URL, open browser — all one keypress.
- **HTTPS included** — every tunnel gets a secure URL automatically.
- **Tiny** — minimal dependencies, installs in seconds.

---

## How it works

tunnrl establishes a WebSocket connection between your local CLI and a remote server at `tunnrl.dev`. The server acts as a public HTTPS proxy — it receives incoming requests on your tunnel URL, forwards them through the WebSocket to your machine, and sends responses back to the caller. Your local port never needs to be exposed directly.

---

## Install

```bash
npm install -g tunnrl
```

Or run without installing:

```bash
npx tunnrl 3000
```

---

## Usage

```bash
# Tunnel port 3000
tunnrl 3000

# Custom local host
tunnrl 8080 --host 127.0.0.1

# Show QR code on connect
tunnrl 3000 --qr
```

### Options

| Option | Default | Description |
|---|---|---|
| `[port]` | `$PORT` | Local port to expose |
| `--host` | `localhost` | Local hostname to forward to |
| `--qr` | off | Show QR code on connect |

---

## What you get

```
  ✔ Connected
  Forwarding  localhost:3000  →  https://kxp7mq.tunnrl.dev
  Shortcuts   q quit   r replay last request   c copy URL   o open browser

  ──────────────────────────────────────────────────────────────
  STATUS   METHOD   PATH                    DURATION   SIZE
  ──────────────────────────────────────────────────────────────
  [14:32:01] 200  GET     /api/users              12ms   1.4 KB
  [14:32:04] 201  POST    /api/posts              34ms   320 B
  [14:32:08] 404  GET     /not-found              8ms    89 B
```

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `q` | Quit and close the tunnel |
| `r` | Replay the last request locally |
| `c` | Copy the tunnel URL to clipboard |
| `o` | Open the tunnel URL in your browser |

---

## Node.js API

```js
import tunnrl from 'tunnrl'

const tunnel = await tunnrl({ port: 3000 })
console.log(tunnel.url)  // https://abc123.tunnrl.dev

tunnel.on('request', ({ method, path, status, duration }) => {
  console.log(method, path, status, `${duration}ms`)
})

tunnel.close()
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `port` | `number` | required | Local port to expose |
| `local_host` | `string` | `localhost` | Local hostname to forward to |

---

## License

MIT
