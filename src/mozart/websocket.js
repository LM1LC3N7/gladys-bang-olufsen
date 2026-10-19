// -----------------------------------------------------------------------------
// A minimal WebSocket client (RFC 6455) over node:net, for the notification
// channel of a Mozart product (`ws://<ip>:9339/`). Only what that channel
// needs: plain ws:// (no TLS), text messages in, ping/pong/close, no
// extension, no subprotocol, no User-Agent.
//
// Everything that comes from the network is bounded: the handshake answer
// (8 KB, searched in linear time), each message (LIMITS.message and
// MAX_FRAGMENTS frames, fragments included), the bytes kept while a frame is
// incomplete, and what waits to be written back (a peer that never reads its
// pongs is dropped past MAX_PENDING_WRITE). The bytes are kept as a list of
// chunks and copied once per frame: a peer sending one byte at a time costs
// linear time.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_HANDSHAKE = 8 * 1024;
/** Frames of one message (empty continuations count too). */
export const MAX_FRAGMENTS = 1024;
/** Bytes waiting to be sent (pongs to a peer that does not read): above, the channel is dropped. */
export const MAX_PENDING_WRITE = 64 * 1024;
const OP = Object.freeze({ CONT: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 });
const UTF8 = new TextDecoder('utf-8', { fatal: true });

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
 * The close code a peer may send (RFC 6455, 7.4): 1000-1003, 1007-1014,
 * 3000-4999. 1004-1006, 1015 and the rest are reserved, never on the wire.
 */
export const isValidCloseCode = (code) =>
  (code >= 1000 && code <= 1003) ||
  (code >= 1007 && code <= 1014) ||
  (code >= 3000 && code <= 4999);

/** The list of tokens of a header such as `Connection: keep-alive, Upgrade`. */
const tokens = (value) =>
  String(value ?? '')
    .toLowerCase()
    .split(',')
    .map((t) => t.trim());

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
  /** node:net connect, replaceable in the tests. */
  connectSocket = connect,
}) {
  const key = randomBytes(16).toString('base64');
  const socket = connectSocket({ host, port });
  const queue = new ByteQueue();
  /** The handshake answer, as chunks, and the last 3 bytes seen (a split "\r\n\r\n"). */
  let handshake = [];
  let handshakeLength = 0;
  let handshakeTail = Buffer.alloc(0);
  let open = false;
  let ended = false;
  /** The frame being read: its header once known, then its payload. */
  let frame;
  /** The fragments of the message being received. */
  let message;
  /** The payload of the last ping of the bytes being read: one pong per batch. */
  let pendingPong;
  let pingTimer;
  let idleTimer;

  /**
   * Ends the channel. `graceful`: what was written (a close frame) is flushed
   * first, the socket destroyed a second later at most; otherwise at once (a
   * peer that does not read gets nothing more).
   */
  const end = (reason, { graceful = false } = {}) => {
    if (ended) {
      return;
    }
    ended = true;
    clearTimeout(connectTimer);
    clearInterval(pingTimer);
    clearTimeout(idleTimer);
    if (graceful && socket.writable) {
      socket.end();
      const kill = setTimeout(() => socket.destroy(), 1_000);
      kill.unref?.();
    } else {
      socket.destroy();
    }
    onClose(reason);
  };

  const send = (opcode, payload) => {
    if (ended || !socket.writable) {
      return;
    }
    socket.write(encodeFrame(opcode, payload));
    if (socket.writableLength > MAX_PENDING_WRITE) {
      // The peer does not read what is sent back (pongs to a ping flood).
      end('peer not reading');
    }
  };

  const closePayload = (code) => {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    return payload;
  };

  const fail = (code, reason) => {
    send(OP.CLOSE, closePayload(code));
    end(reason, { graceful: true });
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
      readHandshake(chunk);
      if (!open) {
        return;
      }
    } else {
      queue.push(chunk);
    }
    alive();
    readFrames();
  });

  /** Each byte of the answer is looked at once: the end is searched in the new chunk only. */
  function readHandshake(chunk) {
    const before = handshakeLength;
    const probe = Buffer.concat([handshakeTail, chunk]);
    const found = probe.indexOf('\r\n\r\n');
    handshake.push(chunk);
    handshakeLength += chunk.length;
    if (found === -1) {
      if (handshakeLength > MAX_HANDSHAKE) {
        end('handshake too large');
        return;
      }
      handshakeTail = probe.subarray(Math.max(0, probe.length - 3));
      return;
    }
    // Position of the end in the whole answer.
    const at = before - handshakeTail.length + found;
    if (at > MAX_HANDSHAKE) {
      end('handshake too large');
      return;
    }
    const whole = Buffer.concat(handshake, handshakeLength);
    handshake = undefined;
    handshakeTail = undefined;
    if (!acceptHandshake(whole.subarray(0, at).toString('latin1'))) {
      end('handshake refused');
      return;
    }
    open = true;
    clearTimeout(connectTimer);
    queue.push(whole.subarray(at + 4));
    pingTimer = setInterval(() => send(OP.PING), pingInterval);
    pingTimer.unref?.();
    onOpen();
  }

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
      tokens(headers.get('connection')).includes('upgrade') &&
      headers.get('sec-websocket-accept') === acceptKey(key) &&
      // Neither an extension nor a subprotocol was asked for.
      !headers.has('sec-websocket-extensions') &&
      !headers.has('sec-websocket-protocol')
    );
  }

  function readFrames() {
    try {
      readFrameLoop();
    } finally {
      // One pong for the last ping of what was read: a ping flood costs one
      // answer per batch, not one per ping.
      if (pendingPong !== undefined) {
        const payload = pendingPong;
        pendingPong = undefined;
        send(OP.PONG, payload);
      }
    }
  }

  function readFrameLoop() {
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

  function handleClose(payload) {
    if (payload.length === 0) {
      send(OP.CLOSE, closePayload(1000));
    } else if (payload.length === 1 || !isValidCloseCode(payload.readUInt16BE(0))) {
      // A 1-byte close or a reserved code: a protocol error, never echoed.
      send(OP.CLOSE, closePayload(1002));
    } else {
      send(OP.CLOSE, closePayload(1000));
    }
    end('closed by the product', { graceful: true });
  }

  function handleFrame({ opcode, fin }, payload) {
    switch (opcode) {
      case OP.PING:
        pendingPong = payload;
        return;
      case OP.PONG:
        return;
      case OP.CLOSE:
        handleClose(payload);
        return;
      case OP.TEXT:
      case OP.BINARY:
        if (message) {
          fail(1002, 'protocol error');
          return;
        }
        message = { opcode, parts: [], size: 0, frames: 0 };
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
    message.frames += 1;
    // Empty fragments weigh nothing in bytes: they are counted as frames.
    if (message.size > maxMessage || message.frames > MAX_FRAGMENTS) {
      fail(1009, 'message too large');
      return;
    }
    if (payload.length > 0) {
      message.parts.push(payload);
    }
    if (fin) {
      const done = message;
      message = undefined;
      if (done.opcode === OP.TEXT) {
        let text;
        try {
          text = UTF8.decode(Buffer.concat(done.parts, done.size));
        } catch {
          fail(1007, 'invalid UTF-8');
          return;
        }
        onMessage(text);
      }
    }
  }

  return {
    close() {
      if (open && !ended) {
        send(OP.CLOSE, closePayload(1000));
        end('closed', { graceful: true });
        return;
      }
      end('closed');
    },
  };
}
