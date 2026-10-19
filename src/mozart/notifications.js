// -----------------------------------------------------------------------------
// The notifications of the WebSocket channel (`{ eventType, eventData }`, the
// WebSocketEvent* models of the Mozart API) -> a partial reading. Only the
// events this integration shows are read; every other one is ignored.
// -----------------------------------------------------------------------------

import { parseMetadata, parsePower, parseRendering, parseSource, parseVolume } from './client.js';

const defined = (object) =>
  Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

/**
 * @returns {object | undefined} the fields this notification says, or
 *   undefined when it says nothing this integration shows.
 */
export function parseNotification(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (json === null || typeof json !== 'object' || typeof json.eventType !== 'string') {
    return undefined;
  }
  const data = json.eventData;
  let partial;
  switch (json.eventType) {
    case 'WebSocketEventVolume': {
      const volume = parseVolume(data);
      partial = defined({ volume: volume.level, maximum: volume.maximum, muted: volume.muted });
      break;
    }
    case 'WebSocketEventPlaybackState':
      partial = defined({ playing: parseRendering(data) });
      break;
    case 'WebSocketEventPlaybackMetadata':
      // New metadata replace the old ones, missing fields included: the title
      // of a track that ended is never kept.
      return { ...parseMetadata(data), metadata: true };
    case 'WebSocketEventPowerState':
      partial = defined({ power: parsePower(data) });
      break;
    case 'WebSocketEventSourceChange':
    case 'WebSocketEventPlaybackSource':
      partial = defined({ source: parseSource(data)?.id });
      break;
    default:
      return undefined;
  }
  return Object.keys(partial).length > 0 ? partial : undefined;
}
