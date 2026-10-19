// -----------------------------------------------------------------------------
// The minimal WebSocket client against a raw TCP server on 127.0.0.1: the
// handshake checks, fragments, ping/pong, close, and the bounds on what the
// network sends (oversized messages, masked or reserved frames, a peer that
// sends one byte at a time).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import {
  MAX_FRAGMENTS,
  MAX_PENDING_WRITE,
  acceptKey,
  encodeFrame,
  isValidCloseCode,
  openWebSocket,
} from '../src/mozart/websocket.js';
import { clientFrames, serverFrame } from './fixtures/fakeProduct.js';

/** A TCP server: `onClient(socket, key, request)` once the upgrade request is read. */
async function rawServer(t, onClient) {
  const server = createServer((socket) => {
    let text = '';
    const onData = (chunk) => {
      text += chunk.toString('latin1');
      const at = text.indexOf('\r\n\r\n');
      if (at !== -1) {
        socket.off('data', onData);
        const key = text.match(/Sec-WebSocket-Key: (.+)\r\n/)[1];
        onClient(socket, key, text.slice(0, at));
      }
    };
    socket.on('data', onData);
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

const accept = (socket, key, extra = '') =>
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n${extra}\r\n`,
  );

function client(port, options = {}) {
  const events = { open: 0, messages: [], closed: undefined };
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const ws = openWebSocket({
    host: '127.0.0.1',
    port,
    connectTimeout: 1_000,
    maxMessage: 1024,
    onOpen: () => {
      events.open += 1;
    },
    onMessage: (text) => events.messages.push(text),
    onClose: (reason) => {
      events.closed = reason;
      resolveClosed(reason);
    },
    ...options,
  });
  return { ws, events, closed };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the RFC 6455 example accept key', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('client frames are masked', () => {
  const frame = encodeFrame(1, Buffer.from('hi'), Buffer.from([1, 2, 3, 4]));
  assert.equal(frame[1] & 0x80, 0x80);
  const [decoded] = clientFrames(frame);
  assert.equal(decoded.payload.toString(), 'hi');
});

test('handshake: no User-Agent, a wrong accept key is refused', async (t) => {
  let request;
  const port = await rawServer(t, (socket, key, text) => {
    request = text;
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: wrong\r\n\r\n',
    );
  });
  const { events, closed } = client(port);
  assert.equal(await closed, 'handshake refused');
  assert.equal(events.open, 0);
  assert.match(request, /^GET \/ HTTP\/1\.1\r\n/);
  assert.doesNotMatch(request, /user-agent|origin/i);
});

test('handshake: an answer that is not 101, or extensions not asked for, are refused', async (t) => {
  for (const answer of [
    (socket) => socket.write('HTTP/1.1 404 Not Found\r\n\r\n'),
    (socket, key) => accept(socket, key, 'Sec-WebSocket-Extensions: permessage-deflate\r\n'),
  ]) {
    const port = await rawServer(t, answer);
    const { closed } = client(port);
    assert.equal(await closed, 'handshake refused');
  }
});

test('handshake: an endless answer is cut at 8 KB', async (t) => {
  const port = await rawServer(t, (socket) =>
    socket.write(`HTTP/1.1 101 OK\r\n${'X'.repeat(20_000)}`),
  );
  const { closed } = client(port);
  assert.equal(await closed, 'handshake too large');
});

test('no answer at all: closed after the connect timeout', async (t) => {
  const port = await rawServer(t, () => {});
  const { closed } = client(port, { connectTimeout: 50 });
  assert.equal(await closed, 'timeout');
});

test('unreachable: closed with the error code', async () => {
  const { closed } = client(1);
  assert.match(await closed, /ECONNREFUSED|EACCES|ETIMEDOUT/);
});

test('messages: whole, fragmented, sent with the handshake, one byte at a time', async (t) => {
  let peer;
  const port = await rawServer(t, (socket, key) => {
    peer = socket;
    // The handshake and a first message in the same packet.
    socket.write(
      Buffer.concat([
        Buffer.from(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
        ),
        serverFrame(1, 'first'),
      ]),
    );
  });
  const { events, ws } = client(port);
  t.after(() => ws.close());
  await wait(50);
  assert.equal(events.open, 1);
  peer.write(Buffer.concat([serverFrame(1, 'he', { fin: false }), serverFrame(0, 'llo')]));
  peer.write(serverFrame(2, Buffer.from([1, 2, 3])));
  const slow = serverFrame(1, 'é'.repeat(200));
  for (const byte of slow) {
    peer.write(Buffer.from([byte]));
  }
  await wait(100);
  assert.deepEqual(events.messages, ['first', 'hello', 'é'.repeat(200)], 'binary ignored');
});

test('ping is answered with a masked pong; close is answered and ends', async (t) => {
  let peer;
  const received = [];
  const port = await rawServer(t, (socket, key) => {
    peer = socket;
    socket.on('data', (chunk) => received.push(...clientFrames(chunk)));
    accept(socket, key);
  });
  const { closed } = client(port);
  await wait(50);
  peer.write(serverFrame(9, 'abc'));
  await wait(50);
  const pong = received.find((f) => f.opcode === 10);
  assert.ok(pong?.masked);
  assert.equal(pong.payload.toString(), 'abc');
  const code = Buffer.alloc(2);
  code.writeUInt16BE(1001);
  peer.write(serverFrame(8, code));
  assert.equal(await closed, 'closed by the product');
});

for (const [name, bytes, reason] of [
  ['an oversized frame', () => serverFrame(1, 'x'.repeat(2048)), 'message too large'],
  [
    'an oversized fragmented message',
    () =>
      Buffer.concat([
        serverFrame(1, 'x'.repeat(800), { fin: false }),
        serverFrame(0, 'x'.repeat(800)),
      ]),
    'message too large',
  ],
  [
    'a 64-bit length beyond 4 GB',
    () => Buffer.from([0x81, 127, 0, 0, 0, 1, 0, 0, 0, 0]),
    'message too large',
  ],
  ['a masked server frame', () => Buffer.from([0x81, 0x81, 1, 2, 3, 4, 5]), 'protocol error'],
  ['a reserved bit', () => Buffer.from([0xc1, 0]), 'protocol error'],
  ['a fragmented ping', () => Buffer.from([0x09, 0]), 'protocol error'],
  ['a continuation without a start', () => serverFrame(0, 'x'), 'protocol error'],
  ['an unknown opcode', () => Buffer.from([0x83, 0]), 'protocol error'],
]) {
  test(`${name} closes the channel`, async (t) => {
    let peer;
    const port = await rawServer(t, (socket, key) => {
      peer = socket;
      accept(socket, key);
    });
    const { events, closed } = client(port);
    await wait(50);
    peer.write(bytes());
    assert.equal(await closed, reason);
    assert.deepEqual(events.messages, []);
  });
}

test('a silent channel is closed after the idle timeout, pings are sent', async (t) => {
  const received = [];
  const port = await rawServer(t, (socket, key) => {
    // Answers nothing after the handshake, not even the pings.
    socket.on('data', (chunk) => received.push(...clientFrames(chunk)));
    accept(socket, key);
  });
  const { closed } = client(port, { pingInterval: 20, idleTimeout: 120 });
  assert.equal(await closed, 'silent');
  assert.ok(
    received.some((f) => f.opcode === 9),
    'a ping was sent',
  );
});

test('close() before and after the opening', async (t) => {
  const port = await rawServer(t, (socket, key) => accept(socket, key));
  const early = client(port);
  early.ws.close();
  assert.equal(await early.closed, 'closed');
  const late = client(port);
  await wait(50);
  late.ws.close();
  assert.equal(await late.closed, 'closed');
  late.ws.close();
});

// --- Review fixes ---------------------------------------------------------------

/** A peer that accepts, then collects every client frame (across chunks). */
async function collectingPeer(t, extra = '') {
  const state = { peer: undefined, frames: [], buffer: Buffer.alloc(0) };
  const port = await rawServer(t, (socket, key) => {
    state.peer = socket;
    socket.on('data', (chunk) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      const frames = clientFrames(state.buffer);
      if (frames.length > 0) {
        state.frames.push(...frames);
        const used = frames.reduce((n, f) => n + 6 + f.payload.length, 0);
        state.buffer = state.buffer.subarray(used);
      }
    });
    accept(socket, key, extra);
  });
  return { port, state };
}

test('B1: empty fragments are counted: past MAX_FRAGMENTS the message is refused', async (t) => {
  const { port, state } = await collectingPeer(t);
  const { events, closed } = client(port);
  await wait(50);
  const empty = Buffer.from([0x00, 0x00]);
  state.peer.write(
    Buffer.concat([
      Buffer.from([0x01, 0x00]),
      ...Array.from({ length: MAX_FRAGMENTS + 10 }, () => empty),
    ]),
  );
  assert.equal(await closed, 'message too large');
  assert.deepEqual(events.messages, []);
  await wait(30);
  const close = state.frames.find((f) => f.opcode === 8);
  assert.equal(close?.payload.readUInt16BE(0), 1009);
});

test('B1: a message of MAX_FRAGMENTS frames is still accepted', async (t) => {
  const { port, state } = await collectingPeer(t);
  const { events, ws } = client(port);
  t.after(() => ws.close());
  await wait(50);
  const parts = [serverFrame(1, 'a', { fin: false })];
  for (let i = 0; i < MAX_FRAGMENTS - 2; i += 1) {
    parts.push(serverFrame(0, '', { fin: false }));
  }
  parts.push(serverFrame(0, 'b'));
  state.peer.write(Buffer.concat(parts));
  await wait(50);
  assert.deepEqual(events.messages, ['ab']);
});

test('I1: a batch of pings gets one pong, the last one', async (t) => {
  const { port, state } = await collectingPeer(t);
  const { ws } = client(port);
  t.after(() => ws.close());
  await wait(50);
  state.peer.write(Buffer.concat(Array.from({ length: 200 }, (_, i) => serverFrame(9, `p${i}`))));
  await wait(80);
  const pongs = state.frames.filter((f) => f.opcode === 10);
  assert.ok(pongs.length >= 1 && pongs.length < 10, `${pongs.length} pongs`);
  assert.equal(pongs.at(-1).payload.toString(), 'p199');
});

test('I1: a peer that does not read what is sent back is dropped', async (t) => {
  const { port, state } = await collectingPeer(t);
  let socket;
  const { closed } = client(port, {
    connectSocket: (options) => {
      socket = connect(options);
      return socket;
    },
  });
  await wait(50);
  // What a peer that stopped reading leaves in the send buffer.
  Object.defineProperty(socket, 'writableLength', { get: () => MAX_PENDING_WRITE + 1 });
  state.peer.write(serverFrame(9, 'x'));
  assert.equal(await closed, 'peer not reading');
});

test('minor 1: no "Connection: Upgrade", or a subprotocol not asked for: refused', async (t) => {
  for (const answer of [
    (socket, key) =>
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
      ),
    (socket, key) => accept(socket, key, 'Sec-WebSocket-Protocol: chat\r\n'),
  ]) {
    const port = await rawServer(t, answer);
    const { events, closed } = client(port);
    assert.equal(await closed, 'handshake refused');
    assert.equal(events.open, 0);
  }
  // A list of tokens is fine.
  const port = await rawServer(t, (socket, key) =>
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    ),
  );
  const ok = client(port);
  await wait(50);
  assert.equal(ok.events.open, 1);
  ok.ws.close();
});

test('minor 1: invalid UTF-8 in a text message closes with 1007', async (t) => {
  const { port, state } = await collectingPeer(t);
  const { events, closed } = client(port);
  await wait(50);
  state.peer.write(serverFrame(1, Buffer.from([0x61, 0xff, 0xfe])));
  assert.equal(await closed, 'invalid UTF-8');
  assert.deepEqual(events.messages, []);
  await wait(30);
  assert.equal(state.frames.find((f) => f.opcode === 8)?.payload.readUInt16BE(0), 1007);
});

for (const [name, payload, answer] of [
  ['a 1-byte close', Buffer.from([0x03]), 1002],
  ['a reserved code (1005)', Buffer.from([0x03, 0xed]), 1002],
  ['a reserved code (1015)', Buffer.from([0x03, 0xf7]), 1002],
  ['a valid code (1001)', Buffer.from([0x03, 0xe9]), 1000],
  ['an empty close', Buffer.alloc(0), 1000],
]) {
  test(`minor 2: ${name} is answered ${answer}, flushed before the end`, async (t) => {
    const { port, state } = await collectingPeer(t);
    const { closed } = client(port);
    await wait(50);
    state.peer.write(serverFrame(8, payload));
    assert.equal(await closed, 'closed by the product');
    await wait(50);
    const close = state.frames.find((f) => f.opcode === 8);
    assert.equal(close?.payload.length, 2);
    assert.equal(close.payload.readUInt16BE(0), answer);
  });
}

test('minor 2: the close codes that may be sent', () => {
  for (const code of [1000, 1001, 1002, 1003, 1007, 1011, 3000, 4999]) {
    assert.equal(isValidCloseCode(code), true, String(code));
  }
  for (const code of [0, 999, 1004, 1005, 1006, 1015, 1016, 2999, 5000]) {
    assert.equal(isValidCloseCode(code), false, String(code));
  }
});

test('minor 3: a handshake sent one byte at a time, its end split across chunks', async (t) => {
  let peer;
  const port = await rawServer(t, async (socket, key) => {
    peer = socket;
    const answer = Buffer.from(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    for (const byte of Buffer.concat([answer, serverFrame(1, 'hi')])) {
      socket.write(Buffer.from([byte]));
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  const { events, ws } = client(port);
  t.after(() => ws.close());
  await wait(200);
  assert.ok(peer);
  assert.equal(events.open, 1);
  assert.deepEqual(events.messages, ['hi']);
});
