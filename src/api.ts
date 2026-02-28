import { EventEmitter } from 'events';
import WebSocket from 'ws';
import * as http from 'http';
import * as https from 'https';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TunnelOptions {
  /** Local port to expose */
  port: number;
  /** Local hostname to forward to (default: localhost) */
  local_host?: string;
}

interface RequestInfo {
  method: string;
  path: string;
  status: number;
  duration: number;
}

interface ForwardedRequest {
  type: 'request';
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string | string[]>;
  body: string;
}

interface ForwardedResponse {
  type: 'response';
  requestId: string;
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
}

type ServerMessage =
  | { type: 'registered'; subdomain: string; url: string }
  | { type: 'error'; message: string };

const DEFAULT_HOST = 'wss://tunnrl.dev/register';

// ─── Tunnel instance ──────────────────────────────────────────────────────────

class Tunnel extends EventEmitter {
  /** The public tunnel URL, e.g. https://abc123.tunnrl.dev */
  url: string = '';

  private _ws: WebSocket | null = null;
  private _closed = false;

  /** @internal */
  _connect(ws: WebSocket): void {
    this._ws = ws;
  }

  /** Close the tunnel and release the connection */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    this._ws?.close();
    this.emit('close');
  }
}

// ─── Local HTTP forwarder ─────────────────────────────────────────────────────

function makeErrorResponse(requestId: string, status: number, message: string): ForwardedResponse {
  return {
    type: 'response',
    requestId,
    status,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ error: message })).toString('base64'),
  };
}

function forwardToLocal(
  localHost: string,
  localPort: number,
  request: ForwardedRequest
): Promise<ForwardedResponse> {
  return new Promise((resolve) => {
    const bodyBuf = Buffer.from(request.body, 'base64');

    const headers: Record<string, string | string[]> = {};
    for (const [key, val] of Object.entries(request.headers)) {
      const lower = key.toLowerCase();
      if (['connection', 'keep-alive', 'transfer-encoding', 'upgrade',
           'proxy-connection', 'te', 'trailers'].includes(lower)) continue;
      headers[key] = val;
    }
    headers['host'] = `${localHost}:${localPort}`;

    const options: http.RequestOptions = {
      hostname: localHost,
      port: localPort,
      path: request.path,
      method: request.method,
      headers: { ...headers, 'content-length': bodyBuf.length },
    };

    const transport = localHost.startsWith('https') ? https : http;

    const localReq = transport.request(options, (localRes) => {
      const chunks: Buffer[] = [];
      localRes.on('data', (chunk: Buffer) => chunks.push(chunk));
      localRes.on('end', () => {
        resolve({
          type: 'response',
          requestId: request.requestId,
          status: localRes.statusCode ?? 200,
          headers: localRes.headers as Record<string, string | string[]>,
          body: Buffer.concat(chunks).toString('base64'),
        });
      });
      localRes.on('error', () =>
        resolve(makeErrorResponse(request.requestId, 502, 'Local service error'))
      );
    });

    localReq.on('error', () =>
      resolve(makeErrorResponse(
        request.requestId, 502,
        `Could not connect to ${localHost}:${localPort}. Is your service running?`
      ))
    );

    localReq.setTimeout(25_000, () => {
      localReq.destroy();
      resolve(makeErrorResponse(request.requestId, 504, 'Local service timed out'));
    });

    if (bodyBuf.length > 0) localReq.write(bodyBuf);
    localReq.end();
  });
}

// ─── Main API ─────────────────────────────────────────────────────────────────

async function tunnrl(options: TunnelOptions): Promise<Tunnel> {
  if (!options || !options.port) {
    throw new Error('tunnrl: options.port is required');
  }

  const serverUrl = DEFAULT_HOST;
  const localHost = options.local_host ?? 'localhost';
  const localPort = options.port;

  return new Promise<Tunnel>((resolve, reject) => {
    const ws = new WebSocket(serverUrl);
    const tunnel = new Tunnel();
    tunnel._connect(ws);
    let resolved = false;

    const connectTimeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('tunnrl: connection timed out after 15s'));
    }, 15_000);

    ws.on('message', async (data: Buffer) => {
      let msg: ServerMessage | ForwardedRequest;
      try {
        msg = JSON.parse(data.toString()) as ServerMessage | ForwardedRequest;
      } catch {
        return;
      }

      if (msg.type === 'error') {
        clearTimeout(connectTimeout);
        ws.close();
        if (!resolved) reject(new Error(`tunnrl: ${(msg as { type: 'error'; message: string }).message}`));
        return;
      }

      if (msg.type === 'registered') {
        clearTimeout(connectTimeout);
        tunnel.url = (msg as { type: 'registered'; subdomain: string; url: string }).url;
        resolved = true;
        resolve(tunnel);
        return;
      }

      if (msg.type === 'request') {
        const request = msg as ForwardedRequest;
        const startMs = Date.now();
        const response = await forwardToLocal(localHost, localPort, request);
        const duration = Date.now() - startMs;

        tunnel.emit('request', {
          method: request.method,
          path: request.path,
          status: response.status,
          duration,
        } as RequestInfo);

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(response));
        }
      }
    });

    ws.on('close', () => {
      if (resolved) {
        tunnel.emit('close');
      } else {
        clearTimeout(connectTimeout);
        reject(new Error('tunnrl: connection closed before tunnel was established'));
      }
    });

    ws.on('error', (err: Error) => {
      clearTimeout(connectTimeout);
      if (!resolved) {
        reject(err);
      } else {
        tunnel.emit('error', err);
      }
    });

    ws.on('ping', () => {
      if (ws.readyState === WebSocket.OPEN) ws.pong();
    });
  });
}

// ─── Attach Tunnel class as a property so CJS users can do: ──────────────────
//   const { Tunnel } = require('tunnrl')
(tunnrl as unknown as { Tunnel: typeof Tunnel }).Tunnel = Tunnel;

// ─── Namespace — exposes types to TypeScript consumers ───────────────────────
namespace tunnrl {
  export type Options = TunnelOptions;
  export type RequestEvent = RequestInfo;
  // Tunnel type: use Awaited<ReturnType<typeof tunnrl>> or cast require('tunnrl').Tunnel
}

// Use export = so that:
//   CommonJS: const tunnrl = require('tunnrl'); await tunnrl({ port: 3000 })
//   ESM:      import tunnrl from 'tunnrl';      await tunnrl({ port: 3000 })
export = tunnrl;
