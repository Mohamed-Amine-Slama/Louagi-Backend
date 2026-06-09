// Event bus.
//
// Commands emit events after committing. Subscribers run *asynchronously* by
// default (via queueMicrotask) so the command response isn't blocked by side
// effects (cache invalidation, notification fan-out, audit projections).
//
// Subscriber failures are logged but do NOT propagate back to the emitter —
// a failed cache invalidation should not 500 a successful reservation.
//
// For tests / strict consistency cases, `emitSync()` awaits all subscribers.

export class EventBus {
  constructor() {
    this.subscribers = new Map(); // name → handler[]
    this.wildcards = [];          // ({ name, payload, ctx }) => void
  }

  on(name, handler) {
    if (typeof handler !== 'function') throw new Error(`EventBus.on("${name}"): handler must be a function`);
    const list = this.subscribers.get(name) ?? [];
    list.push(handler);
    this.subscribers.set(name, list);
    return this;
  }

  // Subscribe to every event (used for audit log shipping, metrics).
  onAny(handler) {
    if (typeof handler !== 'function') throw new Error('EventBus.onAny: handler must be a function');
    this.wildcards.push(handler);
    return this;
  }

  // Fire-and-forget. Returns immediately; subscribers run async.
  emit(name, payload, ctx) {
    const subscribers = this.subscribers.get(name) ?? [];
    const event = { name, payload, ctx };
    for (const handler of subscribers) {
      queueMicrotask(() => {
        Promise.resolve()
          .then(() => handler(payload, ctx, event))
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error(`[events] handler for "${name}" failed:`, err?.message || err);
          });
      });
    }
    for (const wildcard of this.wildcards) {
      queueMicrotask(() => {
        Promise.resolve()
          .then(() => wildcard(event))
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error(`[events] wildcard handler failed for "${name}":`, err?.message || err);
          });
      });
    }
  }

  // Wait for every subscriber to settle. Use sparingly — most events should be
  // fire-and-forget. Returns an array of settled results so callers can inspect.
  async emitSync(name, payload, ctx) {
    const subscribers = this.subscribers.get(name) ?? [];
    const event = { name, payload, ctx };
    const all = [
      ...subscribers.map((h) => Promise.resolve().then(() => h(payload, ctx, event))),
      ...this.wildcards.map((h) => Promise.resolve().then(() => h(event))),
    ];
    return Promise.allSettled(all);
  }

  list() {
    return [...this.subscribers.keys()];
  }

  subscriberCount(name) {
    return this.subscribers.get(name)?.length ?? 0;
  }
}

export const eventBus = new EventBus();
