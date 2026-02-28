# tunnrl

Expose `localhost` to the internet — instant HTTPS tunnels, no signup.

```
localhost:3000  →  https://kxp7mq.tunnrl.dev
```

---

## Quick start

```bash
npx tunnrl 3000
```

---

## Install

```bash
npm install -g tunnrl
```

---

## Usage

```bash
# Tunnel port 3000
tunnrl 3000

# Short alias
tr 3000

# Use PORT env var
PORT=3000 tunnrl

# Custom local host
tunnrl 8080 --host 127.0.0.1
```

### Options

| Option | Default | Description |
|---|---|---|
| `[port]` | `$PORT` | Local port to expose |
| `--host` | `localhost` | Local hostname to forward to |

---

## URLs

Each time you start tunnrl you get a new random URL. There is no subdomain persistence — if you disconnect and reconnect, your URL changes. Share the new URL each session.

---

## Node.js API

```js
const tunnrl = require('tunnrl')
// or: import tunnrl from 'tunnrl'

const tunnel = await tunnrl({ port: 3000 })

console.log(tunnel.url)  // https://abc123.tunnrl.dev

tunnel.on('request', ({ method, path, status, duration }) => {
  console.log(method, path, status, `${duration}ms`)
})

tunnel.on('close', () => console.log('tunnel closed'))

tunnel.close()
```

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `port` | `number` | required | Local port to expose |
| `local_host` | `string` | `localhost` | Local hostname to forward to |

---

## Output

```
  [QR code]

  ✔ Connected
  Forwarding  localhost:3000  →  https://kxp7mq.tunnrl.dev
  Shortcuts   q quit   r replay last request   c copy URL   o open browser

  ──────────────────────────────────────────────────────────────
  STATUS   METHOD   PATH   DURATION   SIZE
  ──────────────────────────────────────────────────────────────
  [14:32:01] 200  GET     /api/users   12ms   1.4 KB
  [14:32:04] 201  POST    /api/posts   34ms   320 B
  [14:32:08] 404  GET     /not-found   8ms    89 B
```

---

## License

MIT
