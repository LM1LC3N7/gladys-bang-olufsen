// -----------------------------------------------------------------------------
// A minimal WebSocket client (RFC 6455) over node:net, for the notification
// channel of a Mozart product (`ws://<ip>:9339/`). Only what that channel
// needs: plain ws:// (no TLS), text messages in, ping/pong/close, no
// extension, no subprotocol, no User-Agent.
//
// Everything that comes from the network is bounded: the handshake answer
// (8 KB), each message (LIMITS.message, fragments included), the bytes kept
// while a frame is incomplete. The bytes are kept as a list of chunks and
// copied once per frame: a peer sending one byte at a time costs linear time.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_HANDSHAKE = 8 * 1024;
const OP = Object.freeze({ CONT: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 });

/** The bytes received and not yet used, without copying them at every chunk. */
class ByteQueue {
  constructor() {
    this.chunks = [];
    this.head = 0;
    this.length = 0;
  }

  push(chunk) {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.length += chunk.length;
    }
  }

  /** The first `n` bytes (n small: a frame header), without consuming them. */
  peek(n) {
    const out = Buffer.alloc(n);
    let offset = 0;
    for (let i = this.head; i < this.chunks.length && offset < n; i += 1) {
      offset += this.chunks[i].copy(out, offset, 0, Math.min(this.chunks[i].length, n - offset));
    }
    return out;
  }

  /** Removes and returns the first `n` bytes (n <= length). */
  take(n) {
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.chunks[this.head];
      const count = Math.min(chunk.length, n - offset);
      chunk.copy(out, offset, 0, count);
      offset += count;
      if (count === chunk.length) {
        this.chunks[this.head] = undefined;
        this.head += 1;
      } else {
        this.chunks[this.head] = chunk.subarray(count);
      }
    }
    this.length -= n;
    if (this.head > 64 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    return out;
  }
}

export const acceptKey = (key) =>
  createHash('sha1')
    .update(key + GUID)
    .digest('base64');

/** A client frame: always masked (RFC 6455, 5.3). */
export function encodeFrame(opcode, payload = Buffer.alloc(0), mask = randomBytes(4)) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) {
    masked[i] = payload[i] ^ mask[i % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

/**
 * Opens a WebSocket. Callbacks: onOpen(), onMessage(text), onClose(reason)
 * (once, whatever ends it, including a failed opening).
 * @returns {{ close: () => void }}
 */
export function openWebSocket({
  host,
  port,
  path = '/',
  connectTimeout = 5_000,
  pingInterval = 20_000,
  idleTimeout = 50_000,
  maxMessage = 64 * 1024,
  onOpen = () => {},
  onMessage = () => {},
  onClose = () => {},
}) {
  const key = randomBytes(16).toString('base64');
  const socket = connect({ host, port });
  const queue = new ByteQueue();
  let handshake = Buffer.alloc(0);
  let open = false;
  let ended = false;
  /** The frame being read: its header once known, then its payload. */
  let frame;
  /** The fragments of the message being received. */
  let message;
  let pingTimer;
  let idleTimer;

  const end = (reason) => {
    if (ended) {
      return;
    }
    ended = true;
    clearTimeout(connectTimer);
    clearInterval(pingTimer);
    clearTimeout(idleTimer);
    socket.destroy();
    onClose(reason);
  };

  const send = (opcode, payload) => {
    if (!ended && socket.writable) {
      socket.write(encodeFrame(opcode, payload));
    }
  };

  const fail = (code, reason) => {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    send(OP.CLOSE, payload);
    end(reason);
  };

  const alive = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => end('silent'), idleTimeout);
    idleTimer.unref?.();
  };

  const connectTimer = setTimeout(() => end('timeout'), connectTimeout);

  socket.setNoDelay(true);
  socket.on('connect', () => {
    // No User-Agent and no Origin: nothing pretends to be a browser.
    socket.write(
      [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'),
    );
  });
  socket.on('error', (err) => end(err.code ?? 'error'));
  socket.on('close', () => end('closed'));
  socket.on('data', (chunk) => {
    if (ended) {
      return;
    }
    if (!open) {
      handshake = Buffer.concat([handshake, chunk]);
      const at = handshake.indexOf('\r\n\r\n');
      if (at === -1) {
        if (handshake.length > MAX_HANDSHAKE) {
          end('handshake too large');
        }
        return;
      }
      if (at > MAX_HANDSHAKE) {
        end('handshake too large');
        return;
      }
      if (!acceptHandshake(handshake.subarray(0, at).toString('latin1'))) {
        end('handshake refused');
        return;
      }
      open = true;
      clearTimeout(connectTimer);
      queue.push(handshake.subarray(at + 4));
      handshake = undefined;
      alive();
      pingTimer = setInterval(() => send(OP.PING), pingInterval);
      pingTimer.unref?.();
      onOpen();
    } else {
      queue.push(chunk);
    }
    alive();
    readFrames();
  });

  function acceptHandshake(text) {
    const [status, ...lines] = text.split('\r\n');
    if (!/^HTTP\/1\.1 101(?: |$)/.test(status)) {
      return false;
    }
    const headers = new Map();
    for (const line of lines.slice(0, 64)) {
      const colon = line.indexOf(':');
      if (colon > 0) {
        headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
      }
    }
    return (
      headers.get('upgrade')?.toLowerCase() === 'websocket' &&
      headers.get('sec-websocket-accept') === acceptKey(key) &&
      !headers.has('sec-websocket-extensions')
    );
  }

  function readFrames() {
    while (!ended) {
      if (!frame) {
        if (queue.length < 2) {
          return;
        }
        const [b0, b1] = queue.peek(2);
        const short = b1 & 0x7f;
        const headerLength = 2 + (short === 126 ? 2 : short === 127 ? 8 : 0);
        if (queue.length < headerLength) {
          return;
        }
        const header = queue.take(headerLength);
        let length = short;
        if (short === 126) {
          length = header.readUInt16BE(2);
        } else if (short === 127) {
          length = header.readUInt32BE(2) === 0 ? header.readUInt32BE(6) : Infinity;
        }
        const opcode = b0 & 0x0f;
        const fin = (b0 & 0x80) !== 0;
        if ((b0 & 0x70) !== 0 || (b1 & 0x80) !== 0) {
          // Reserved bits (no extension was agreed), or a masked server frame.
          fail(1002, 'protocol error');
          return;
        }
        if (opcode >= 8 && (!fin || length > 125)) {
          fail(1002, 'protocol error');
          return;
        }
        if (length > maxMessage) {
          fail(1009, 'message too large');
          return;
        }
        frame = { opcode, fin, length };
      }
      if (queue.length < frame.length) {
        return;
      }
      const payload = queue.take(frame.length);
      const current = frame;
      frame = undefined;
      handleFrame(current, payload);
    }
  }

  function handleFrame({ opcode, fin }, payload) {
    switch (opcode) {
      case OP.PING:
        send(OP.PONG, payload);
        return;
      case OP.PONG:
        return;
      case OP.CLOSE:
        send(OP.CLOSE, payload.subarray(0, 2));
        end('closed by the product');
        return;
      case OP.TEXT:
      case OP.BINARY:
        if (message) {
          fail(1002, 'protocol error');
          return;
        }
        message = { opcode, parts: [], size: 0 };
        break;
      case OP.CONT:
        if (!message) {
          fail(1002, 'protocol error');
          return;
        }
        break;
      default:
        fail(1002, 'protocol error');
        return;
    }
    message.size += payload.length;
    if (message.size > maxMessage) {
      fail(1009, 'message too large');
      return;
    }
    message.parts.push(payload);
    if (fin) {
      const done = message;
      message = undefined;
      if (done.opcode === OP.TEXT) {
        onMessage(Buffer.concat(done.parts, done.size).toString('utf8'));
      }
    }
  }

  return {
    close() {
      if (open && !ended) {
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(1000);
        send(OP.CLOSE, payload);
      }
      end('closed');
    },
  };
}
