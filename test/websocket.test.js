// -----------------------------------------------------------------------------
// The minimal WebSocket client against a raw TCP server on 127.0.0.1: the
// handshake checks, fragments, ping/pong, close, and the bounds on what the
// network sends (oversized messages, masked or reserved frames, a peer that
// sends one byte at a time).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { acceptKey, encodeFrame, openWebSocket } from '../src/mozart/websocket.js';
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
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
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
