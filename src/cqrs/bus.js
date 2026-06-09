// Base bus class. Both CommandBus and QueryBus extend it. EventBus has its
// own shape because it's multi-subscriber and fire-and-forget.
//
// Design notes:
//   - Handlers are named functions registered by `name`. They're (payload, ctx)
//     functions that return a Promise. They know NOTHING about GraphQL, REST,
//     or any transport — they're plain logic units, testable in isolation.
//   - Middleware is an array of `({ name, payload, ctx }, next) => …` functions
//     applied left-to-right around the handler. The pattern mirrors Koa/Express
//     middleware so it's familiar.
//   - dispatch() throws if the name isn't registered, so unknown ops surface as
//     400-style errors at the GraphQL boundary.

export class Bus {
  constructor(label) {
    this.label = label;            // 'command' | 'query'
    this.handlers = new Map();     // name → handler
    this.middlewares = [];         // ordered list of middleware
    this.metadata = new Map();     // name → { tags, … } (e.g. requireAuth)
  }

  use(middleware) {
    if (typeof middleware !== 'function') {
      throw new Error(`${this.label}Bus.use: middleware must be a function`);
    }
    this.middlewares.push(middleware);
    return this;
  }

  register(name, handler, metadata = {}) {
    if (this.handlers.has(name)) {
      throw new Error(`${this.label}Bus: duplicate handler "${name}"`);
    }
    if (typeof handler !== 'function') {
      throw new Error(`${this.label}Bus: handler for "${name}" must be a function`);
    }
    this.handlers.set(name, handler);
    this.metadata.set(name, metadata);
    return this;
  }

  registerAll(map, metadata = {}) {
    for (const [name, handler] of Object.entries(map)) {
      this.register(name, handler, metadata);
    }
    return this;
  }

  has(name) {
    return this.handlers.has(name);
  }

  list() {
    return [...this.handlers.keys()];
  }

  getMetadata(name) {
    return this.metadata.get(name) ?? {};
  }

  async dispatch(name, payload, ctx) {
    const handler = this.handlers.get(name);
    if (!handler) {
      const err = new Error(`${this.label}Bus: no handler for "${name}"`);
      err.status = 400;
      throw err;
    }
    const metadata = this.metadata.get(name) ?? {};
    return this._runMiddleware(name, payload, ctx, metadata, handler);
  }

  async _runMiddleware(name, payload, ctx, metadata, handler) {
    let lastIdx = -1;
    const step = async (i) => {
      if (i <= lastIdx) {
        throw new Error(`${this.label}Bus("${name}"): next() called twice`);
      }
      lastIdx = i;
      const mw = this.middlewares[i];
      if (!mw) return handler(payload, ctx, { name, metadata });
      return mw({ name, payload, ctx, metadata, bus: this.label }, () => step(i + 1));
    };
    return step(0);
  }
}
