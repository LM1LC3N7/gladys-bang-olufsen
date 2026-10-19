// -----------------------------------------------------------------------------
// Frozen keys (external ids, features, manifest actions), limits and timings.
// Every key here is stored by Gladys or by its users: never rename one.
// -----------------------------------------------------------------------------

/** `gladys.externalIds(DEVICE_TYPE, <serial number of the product>)`. */
export const DEVICE_TYPE = 'product';

export const FEATURES = Object.freeze({
  /** Read only: 1 on, 0 standby, network standby or unreachable. */
  POWER: 'power',
  /** Push button: puts the product in standby (the API has no "power on"). */
  STANDBY: 'standby',
  VOLUME: 'volume',
  /** Push button: each press sets the opposite of the mute read from the product. */
  MUTE: 'mute',
  PLAY: 'play',
  PAUSE: 'pause',
  NEXT: 'next',
  PREVIOUS: 'previous',
  /** Read only: 1 playing, 0 paused, stopped or idle. */
  PLAYBACK: 'playback',
  SOURCE: 'source',
  /** Read only: "Artist - Title" of what plays. */
  TITLE: 'title',
});

export const ACTIONS = Object.freeze({
  FIND: 'find_products',
  CHECK: 'check_products',
});

/** The mDNS service the Mozart products announce (the one Home Assistant browses). */
export const MDNS_SERVICE = '_bangolufsen._tcp';

/** The Mozart REST API listens on plain HTTP, port 80; the notifications on 9339. */
export const DEFAULT_PORT = 80;
export const WEBSOCKET_PORT = 9339;

export const POLL_INTERVAL = Object.freeze({ min: 10, max: 300, default: 30 });

/** The volume cap of the configuration: commands above it are lowered to it. */
export const MAX_VOLUME = Object.freeze({ min: 1, max: 100, default: 70 });

export const TIMINGS = Object.freeze({
  /** One HTTP exchange while polling, probing or searching. */
  httpTimeout: 2_000,
  /**
   * Gladys waits 5 s for the ack of a command: the whole command (wait in the
   * per-product queue and every request included) gets `commandBudget`, the
   * state read just before a mute press `preRead` of it.
   */
  commandBudget: 3_500,
  preRead: 1_500,
  /** A product that does not answer is asked again after its interval doubled, up to this. */
  maxBackoff: 5 * 60_000,
  /** The source list and the identity of a product are read again after this. */
  sourcesRefresh: 10 * 60_000,
  /** After a command sent without confirmation (or a standby), the state is read again. */
  recheckDelay: 2_000,
  /** Writes to /data are grouped. */
  persistDelay: 1_000,
  /** mDNS listening time of a search. */
  scanSeconds: 5,
  /** No answer of a search is asked after this, `scanConcurrency` at a time. */
  scanBudget: 35_000,
  scanConcurrency: 4,
  /** While a created product has lost its address, an automatic search this often. */
  autoScanInterval: 10 * 60_000,
  /** Products asked at once by "Check the products". */
  checkConcurrency: 4,
  /** The notification channel: opening, keep-alive, silence, reconnection. */
  wsConnectTimeout: 5_000,
  wsPingInterval: 20_000,
  wsIdleTimeout: 50_000,
  wsRetryMin: 5_000,
  wsRetryMax: 5 * 60_000,
  /** Notifications are merged: one publication per product at most this often. */
  wsPublishDelay: 1_000,
});

export const LIMITS = Object.freeze({
  products: 20,
  addresses: 20,
  /** Sources kept from one answer, and in the dropdown. */
  sources: 32,
  /** Length of a published title, and of a name. */
  title: 200,
  name: 64,
  /** Largest REST answer read, and largest notification accepted. */
  body: 64 * 1024,
  message: 64 * 1024,
  /** Notifications handled per second and product; more are dropped. */
  messagesPerSecond: 50,
});

/** What a text feature shows when nothing plays. */
export const NOTHING = '—';
