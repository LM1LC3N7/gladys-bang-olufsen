// -----------------------------------------------------------------------------
// A fake Mozart product on 127.0.0.1: the REST endpoints the integration uses,
// with a state the tests read and change, and the WebSocket notification
// channel on the same port (the tests point the app at it). Modes: `silent`
// (accepts the connection, never answers), `hostile` (huge answer), `legacy`
// (404 everywhere, like an older BeoLink product). close() makes it
// unreachable.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

export const SERIAL = '12345678';
export const JID = `2714.1200304.${SERIAL}@products.bang-olufsen.com`;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** A server frame: never masked. */
export function serverFrame(opcode, payload, { fin = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '', 'utf8');
  let header;
  if (data.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(data.length, 6);
  }
  return Buffer.concat([header, data]);
}

/** Decodes the masked client frames of `buffer` (complete frames only). */
export function clientFrames(buffer) {
  const frames = [];
  let at = 0;
  while (buffer.length - at >= 6) {
    const opcode = buffer[at] & 0x0f;
    let length = buffer[at + 1] & 0x7f;
    let offset = at + 2;
    if (length === 126) {
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      length = buffer.readUInt32BE(offset + 4);
      offset += 8;
    }
    if (buffer.length < offset + 4 + length) {
      break;
    }
    const mask = buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] ^= mask[i % 4];
    }
    frames.push({ opcode, masked: (buffer[at + 1] & 0x80) !== 0, payload });
    at = offset + 4 + length;
  }
  return frames;
}

export async function startFakeProduct(options = {}) {
  const state = {
    jid: JID,
    friendlyName: 'Living room',
    power: 'on',
    volume: 30,
    maximum: 100,
    muted: false,
    rendering: 'started',
    metadata: { artistName: 'Daft Punk', title: 'Get Lucky', albumName: 'RAM' },
    active: 'spotify',
    sources: [
      {
        id: 'spotify',
        name: 'Spotify',
        isEnabled: true,
        isPlayable: true,
        type: { value: 'spotify' },
      },
      {
        id: 'lineIn',
        name: 'Line-In',
        isEnabled: true,
        isPlayable: true,
        type: { value: 'lineIn' },
      },
      { id: 'tidal', name: 'TIDAL', isEnabled: false, isPlayable: true, type: { value: 'tidal' } },
      { id: '__proto__', name: 'Bad', isEnabled: true, isPlayable: true },
    ],
    silent: false,
    hostile: false,
    legacy: false,
    refuseUpgrade: false,
    requests: [],
    ...options,
  };
  const sockets = new Set();
  const channels = new Set();

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const error = (res, status = 400) =>
    json(res, status, { errorCode: 'invalid', errorId: 'x', errorMessage: 'refused' });
  const source = (id) => state.sources.find((s) => s.id === id);

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      state.requests.push({ method: req.method, path: req.url, body, headers: req.headers });
      if (state.silent) {
        return; // never answers
      }
      if (state.hostile) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(`{"jid":"${'x'.repeat(200 * 1024)}"}`);
        return;
      }
      if (state.legacy) {
        return error(res, 404);
      }
      const route = `${req.method} ${req.url}`;
      switch (route) {
        case 'GET /api/v1/beolink/self':
          return json(res, 200, { friendlyName: state.friendlyName, jid: state.jid });
        case 'GET /api/v1/state':
          return json(res, 200, {
            powerState: { value: state.power },
            volume: {
              level: { level: state.volume },
              maximum: { level: state.maximum },
              muted: { muted: state.muted },
            },
            playback: {
              metadata: state.metadata,
              state: { value: state.rendering },
              source: source(state.active) ?? {},
            },
            source: source(state.active) ?? {},
          });
        case 'GET /api/v1/playback/sources':
          if (state.failSources) {
            return error(res, 400);
          }
          return json(res, 200, { items: state.sources });
        case 'GET /api/v1/sound/volume':
          return json(res, 200, {
            level: { level: state.volume },
            maximum: { level: state.maximum },
            muted: { muted: state.muted },
          });
        case 'PUT /api/v1/sound/volume/level': {
          const parsed = JSON.parse(body || '{}');
          state.volume = parsed.level;
          res.writeHead(201);
          return res.end();
        }
        case 'PUT /api/v1/sound/volume/mute': {
          state.muted = JSON.parse(body || '{}').muted;
          res.writeHead(201);
          return res.end();
        }
        case 'PUT /api/v1/state/standby':
          state.power = 'standby';
          res.writeHead(200);
          return res.end();
        default: {
          const command = req.url.match(/^\/api\/v1\/playback\/command\/([a-z]+)$/);
          if (req.method === 'POST' && command) {
            if (command[1] === 'play') state.rendering = 'started';
            if (command[1] === 'pause') state.rendering = 'paused';
            res.writeHead(201);
            return res.end();
          }
          const active = req.url.match(/^\/api\/v1\/playback\/sources\/active\/([^/]+)$/);
          if (req.method === 'POST' && active) {
            const id = decodeURIComponent(active[1]);
            if (!source(id)) {
              return error(res, 400);
            }
            state.active = id;
            res.writeHead(201);
            return res.end();
          }
          return error(res, 404);
        }
      }
    });
  });

  server.on('upgrade', (req, socket) => {
    state.requests.push({ method: 'UPGRADE', path: req.url, headers: req.headers });
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    // The HTTP server keeps half-open sockets: the end of the client ends it.
    socket.on('end', () => socket.end());
    if (state.refuseUpgrade) {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const accept = createHash('sha1')
      .update(req.headers['sec-websocket-key'] + GUID)
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    );
    const channel = { socket, received: [], buffer: Buffer.alloc(0) };
    channels.add(channel);
    socket.on('data', (chunk) => {
      channel.buffer = Buffer.concat([channel.buffer, chunk]);
      const frames = clientFrames(channel.buffer);
      channel.received.push(...frames);
      for (const frame of frames) {
        if (frame.opcode === 9) {
          socket.write(serverFrame(10, frame.payload));
        }
      }
      if (frames.length > 0) {
        channel.buffer = Buffer.alloc(0);
      }
    });
    socket.on('close', () => channels.delete(channel));
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    state,
    channels,
    writes: () => state.requests.filter((r) => r.method === 'PUT' || r.method === 'POST'),
    /** Sends a notification `{ eventType, eventData }` to every open channel. */
    notify: (eventType, eventData) => {
      for (const { socket } of channels) {
        socket.write(serverFrame(1, JSON.stringify({ eventType, eventData })));
      }
    },
    /** Raw bytes to every open channel. */
    raw: (bytes) => {
      for (const { socket } of channels) {
        socket.write(bytes);
      }
    },
    dropChannels: () => {
      for (const { socket } of channels) {
        socket.destroy();
      }
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}
