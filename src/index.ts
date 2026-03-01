#!/usr/bin/env node
import { program } from 'commander';
import WebSocket from 'ws';
import * as http from 'http';
import * as https from 'https';
import { exec } from 'child_process';
import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';

// ─── Chalk (ESM-only in v5, so we dynamic-import it) ─────────────────────────
// We use a lazy loader so we can keep the file as CommonJS (ts-node default).
let _chalk: typeof import('chalk').default | undefined;
async function getChalk() {
  if (!_chalk) {
    const mod = await import('chalk');
    _chalk = mod.default;
  }
  return _chalk;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface ForwardedRequest {
  type: 'request';
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string | string[]>;
  body: string; // base64
}

interface ForwardedResponse {
  type: 'response';
  requestId: string;
  status: number;
  headers: Record<string, string | string[]>;
  body: string; // base64
}

type ServerMessage =
  | { type: 'registered'; subdomain: string; url: string }
  | { type: 'error'; message: string };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timestamp(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

// Status color based on HTTP code
function statusColor(chalk: typeof import('chalk').default, code: number): string {
  if (code >= 500) return chalk.red(String(code));
  if (code >= 400) return chalk.yellow(String(code));
  if (code >= 300) return chalk.cyan(String(code));
  return chalk.green(String(code));
}

// Method color
function methodColor(chalk: typeof import('chalk').default, method: string): string {
  const m = method.toUpperCase();
  if (m === 'GET')    return chalk.green(m.padEnd(6));
  if (m === 'POST')   return chalk.blue(m.padEnd(6));
  if (m === 'PUT')    return chalk.yellow(m.padEnd(6));
  if (m === 'DELETE') return chalk.red(m.padEnd(6));
  if (m === 'PATCH')  return chalk.magenta(m.padEnd(6));
  return chalk.white(m.padEnd(6));
}

// Response size formatter
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// ─── Browser opener ──────────────────────────────────────────────────────────

function openInBrowser(url: string): void {
  let cmd: string;
  if (process.platform === 'darwin') {
    cmd = `open "${url}"`;
  } else if (process.platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, () => {});
}

// ─── Clipboard ───────────────────────────────────────────────────────────────

function copyToClipboard(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let cmd: string;
    if (process.platform === 'darwin') {
      cmd = `printf '%s' '${text}' | pbcopy`;
    } else if (process.platform === 'win32') {
      cmd = `echo|set /p="${text}"| clip`;
    } else {
      cmd = `printf '%s' '${text}' | xclip -selection clipboard 2>/dev/null || printf '%s' '${text}' | xsel --clipboard --input 2>/dev/null`;
    }
    exec(cmd, (err) => resolve(!err));
  });
}

// ─── Local HTTP forwarder ─────────────────────────────────────────────────────

function forwardToLocal(
  localHost: string,
  localPort: number,
  request: ForwardedRequest
): Promise<ForwardedResponse> {
  return new Promise((resolve) => {
    const bodyBuf = Buffer.from(request.body, 'base64');

    // Strip hop-by-hop headers and rewrite host
    const headers: Record<string, string | string[]> = {};
    for (const [key, val] of Object.entries(request.headers)) {
      const lower = key.toLowerCase();
      if (['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailers'].includes(lower)) continue;
      headers[key] = val;
    }
    headers['host'] = `${localHost}:${localPort}`;

    const options: http.RequestOptions = {
      hostname: localHost,
      port: localPort,
      path: request.path,
      method: request.method,
      headers: {
        ...headers,
        'content-length': bodyBuf.length,
      },
    };

    const isHttps = localHost.startsWith('https://');
    const transport = isHttps ? https : http;

    const localReq = transport.request(options, (localRes) => {
      const chunks: Buffer[] = [];
      localRes.on('data', (chunk: Buffer) => chunks.push(chunk));
      localRes.on('end', () => {
        const responseBody = Buffer.concat(chunks);
        resolve({
          type: 'response',
          requestId: request.requestId,
          status: localRes.statusCode ?? 200,
          headers: localRes.headers as Record<string, string | string[]>,
          body: responseBody.toString('base64'),
        });
      });
      localRes.on('error', () => {
        resolve({
          type: 'response',
          requestId: request.requestId,
          status: 502,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ error: 'Local service error' })).toString('base64'),
        });
      });
    });

    localReq.on('error', () => {
      // Local service is not running or refused connection
      resolve({
        type: 'response',
        requestId: request.requestId,
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({ error: 'Bad Gateway', message: `Could not connect to ${localHost}:${localPort}. Is your local service running?` })
        ).toString('base64'),
      });
    });

    localReq.setTimeout(25_000, () => {
      localReq.destroy();
      resolve({
        type: 'response',
        requestId: request.requestId,
        status: 504,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ error: 'Gateway Timeout', message: 'Local service took too long to respond' })).toString('base64'),
      });
    });

    if (bodyBuf.length > 0) {
      localReq.write(bodyBuf);
    }
    localReq.end();
  });
}

// ─── Main tunnel client ───────────────────────────────────────────────────────

interface TunnelOptions {
  host: string;
  qr?: boolean;
}

async function startTunnel(port: number, opts: TunnelOptions): Promise<void> {
  const chalk = await getChalk();

  let reconnectDelay = 1000; // ms
  let reconnectAttempts = 0;
  let shuttingDown = false;
  let ws: WebSocket | null = null;

  // Circular buffer of the last 10 forwarded requests (for replay)
  const recentRequests: ForwardedRequest[] = [];

  // Current tunnel URL (set on registration, used by keyboard shortcuts)
  let tunnelUrl = '';

  function connect(): void {
    if (shuttingDown) return;

    ws = new WebSocket('wss://tunnrl.dev/register');

    ws.on('open', () => {
      reconnectDelay = 1000;
      reconnectAttempts = 0;
      console.log(chalk.green(`  ✔ Connected to tunnel server`));
    });

    ws.on('message', async (data: Buffer) => {
      let msg: ServerMessage | ForwardedRequest;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === 'error') {
        console.log('');
        console.log(chalk.red(`  ✗ Server error: ${msg.message}`));
        shuttingDown = true;
        ws?.close();
        process.exit(1);
        return;
      }

      if (msg.type === 'registered') {
        tunnelUrl = msg.url;
        console.clear();
        if (opts.qr) {
          try {
            const qr = await QRCode.toString(msg.url, { type: 'terminal', small: true, margin: 1 });
            console.log(qr);
          } catch { /* ignore */ }
        }
        console.log(chalk.green(`  ✔ Connected`));
        console.log(`  ${chalk.gray('Forwarding')}  ${chalk.white(`localhost:${port}`)}  →  ${chalk.bold.yellow(msg.url)}`);
        console.log(`  ${chalk.gray('Shortcuts')}   ${chalk.white('q')} quit   ${chalk.white('r')} replay last request   ${chalk.white('c')} copy URL   ${chalk.white('o')} open browser`);
        console.log('');
        console.log(chalk.gray('─'.repeat(62)));
        console.log('');
        console.log(chalk.bold(`  ${chalk.cyan('STATUS')}   ${chalk.cyan('METHOD')}   ${chalk.cyan('PATH')}   ${chalk.cyan('DURATION')}   ${chalk.cyan('SIZE')}`));
        console.log(chalk.gray('─'.repeat(62)));
        return;
      }

      if (msg.type === 'request') {
        const request = msg as ForwardedRequest;
        const startMs = Date.now();

        const response = await forwardToLocal(opts.host, port, request);
        const durationMs = Date.now() - startMs;

        // Store for replay (keep last 10)
        recentRequests.push(request);
        if (recentRequests.length > 10) recentRequests.shift();

        // Log the request with size
        const sizeBytes = Buffer.from(response.body, 'base64').length;
        const statusStr = statusColor(chalk, response.status);
        const methodStr = methodColor(chalk, request.method);
        const pathStr = chalk.white(request.path);
        const durationStr = chalk.gray(`${durationMs}ms`);
        const sizeStr = chalk.gray(formatBytes(sizeBytes));
        const tsStr = chalk.gray(`[${timestamp()}]`);
        console.log(`  ${tsStr} ${statusStr}  ${methodStr}  ${pathStr}  ${durationStr}  ${sizeStr}`);

        // Send response back through the tunnel
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(response));
        }
      }
    });

    ws.on('close', (code: number, reason: Buffer) => {
      if (shuttingDown) return;
      const reasonStr = reason.length ? ` (${reason.toString()})` : '';
      console.log('');
      console.log(chalk.yellow(`  ⚠ Disconnected${reasonStr} — reconnecting in ${reconnectDelay / 1000}s…`));
      scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      if (shuttingDown) return;
      console.log('');
      console.log(chalk.red(`  ✗ WebSocket error: ${err.message}`));
    });

    ws.on('ping', () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.pong();
      }
    });
  }

  function scheduleReconnect(): void {
    reconnectAttempts++;
    const jitter = Math.random() * 500;
    const delay = Math.min(reconnectDelay + jitter, 30_000);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);

    setTimeout(() => {
      if (!shuttingDown) {
        console.log(chalk.gray(`  Reconnect attempt #${reconnectAttempts}…`));
        connect();
      }
    }, delay);
  }

  // ── Startup ──────────────────────────────────────────────────────────────
  connect();

  // Graceful shutdown
  process.on('SIGINT', async () => {
    shuttingDown = true;
    console.log('');
    console.log(chalk.gray('  Closing tunnel… bye!'));
    ws?.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    shuttingDown = true;
    ws?.close();
    process.exit(0);
  });

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', async (key: string) => {
      if (key === '\u0003' || key === 'q' || key === 'Q') { // Ctrl+C or q
        shuttingDown = true;
        console.log('');
        console.log(chalk.gray('  Closing tunnel… bye!'));
        ws?.close();
        process.exit(0);
      }
      if (key === 'o' || key === 'O') {
        if (!tunnelUrl) {
          console.log(chalk.gray('  Not connected yet'));
          return;
        }
        openInBrowser(tunnelUrl);
        console.log(chalk.gray(`  Opening ${tunnelUrl} in browser…`));
      }
      if (key === 'c' || key === 'C') {
        if (!tunnelUrl) {
          console.log(chalk.gray('  Not connected yet'));
          return;
        }
        const ok = await copyToClipboard(tunnelUrl);
        console.log(ok ? chalk.gray('  Copied to clipboard') : chalk.gray('  Could not copy to clipboard'));
      }
      if (key === 'r' || key === 'R') {
        if (recentRequests.length === 0) {
          console.log(chalk.gray('  No requests to replay yet'));
          return;
        }
        const last = recentRequests[recentRequests.length - 1];
        const replayReq: ForwardedRequest = { ...last, requestId: uuidv4() };
        console.log(chalk.cyan(`  ↺ Replaying ${last.method} ${last.path}…`));
        const startMs = Date.now();
        const response = await forwardToLocal(opts.host, port, replayReq);
        const durationMs = Date.now() - startMs;
        const sizeBytes = Buffer.from(response.body, 'base64').length;
        const statusStr = statusColor(chalk, response.status);
        const methodStr = methodColor(chalk, replayReq.method);
        console.log(`  ${chalk.cyan('[↺]')} ${statusStr}  ${methodStr}  ${chalk.white(replayReq.path)}  ${chalk.gray(`${durationMs}ms`)}  ${chalk.gray(formatBytes(sizeBytes))}`);
      }
    });
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

program
  .name('tunnrl')
  .description('Expose localhost to the internet')
  .version('1.0.0')
  .argument('[port]', 'Local port to tunnel (or set PORT env var)')
  .option('--host <host>', 'Local host to forward to', 'localhost')
  .option('--qr', 'Show QR code on connect')
  .action((portArg: string | undefined, options: TunnelOptions) => {
    const raw = portArg ?? process.env.PORT;
    if (!raw) {
      console.error('Error: port is required. Usage: tunnrl <port>  or  PORT=3000 tunnrl');
      process.exit(1);
    }
    const port = parseInt(raw, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error('Error: port must be a number between 1 and 65535');
      process.exit(1);
    }
    startTunnel(port, options).catch((err) => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
  });

program.parse(process.argv);
