// -----------------------------------------------------------------------------
// One plain HTTP/1.1 exchange with a product (node:http, no keep-alive, no
// redirect followed, bounded time and size). A product off the network does
// not answer: every failure to connect becomes a ProductError of kind
// 'unreachable', a product that accepted the connection and then said nothing
// a 'timeout' (something answered: the request may have been received).
// -----------------------------------------------------------------------------

import { request as httpRequest } from 'node:http';
import { LIMITS } from '../constants.js';

/** The kinds of failure the rest of the code tells apart. */
export const ERROR_KINDS = Object.freeze({
  /** Nothing accepted the connection: off or not on the network. Nothing was sent. */
  UNREACHABLE: 'unreachable',
  /** Connected, then silent: the request may have been received. */
  TIMEOUT: 'timeout',
  /** An HTTP status other than 2xx. */
  HTTP: 'http',
  /** Too large, not JSON, not the expected shape. */
  PROTOCOL: 'protocol',
  /** The time a command was given ran out before this request. */
  BUDGET: 'budget',
});

export class ProductError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'ProductError';
    this.kind = kind;
    Object.assign(this, details);
  }
}

/**
 * @param {{ host: string, port: number, method?: string, path: string,
 *   body?: string, timeoutMs?: number }} options
 * @returns {Promise<{ status: number, body: string }>}
 */
export function request({ host, port, method = 'GET', path, body, timeoutMs = 2000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
    let settled = false;
    let connected = false;
    const finish = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const failure = (err) =>
      connected
        ? new ProductError(ERROR_KINDS.TIMEOUT, `Connection lost: ${err.code ?? err.message}`)
        : new ProductError(ERROR_KINDS.UNREACHABLE, `Unreachable: ${err.code ?? err.message}`);
    const req = httpRequest(
      {
        host,
        port,
        method,
        path,
        agent: false,
        headers: {
          Connection: 'close',
          Accept: 'application/json',
          // A PUT or POST without a body says so (no chunked encoding).
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) }
            : method === 'GET'
              ? {}
              : { 'Content-Length': '0' }),
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > LIMITS.body) {
            req.destroy();
            finish(reject, new ProductError(ERROR_KINDS.PROTOCOL, 'Answer too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(resolve, {
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', (err) => finish(reject, failure(err)));
      },
    );
    req.on('socket', (socket) => {
      if (socket.connecting) {
        socket.once('connect', () => {
          connected = true;
        });
      } else {
        connected = true;
      }
    });
    // A plain (ref'd) timer: the exchange keeps the process alive until it ends.
    const timer = setTimeout(() => {
      req.destroy();
      finish(
        reject,
        connected
          ? new ProductError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout')
          : new ProductError(ERROR_KINDS.UNREACHABLE, 'Unreachable: timeout'),
      );
    }, timeoutMs);
    req.on('error', (err) => finish(reject, failure(err)));
    req.end(payload);
  });
}
