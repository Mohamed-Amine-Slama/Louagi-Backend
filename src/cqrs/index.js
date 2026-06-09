// CQRS entry point. Wires all command/query handlers + projections, configures
// middleware, and exports the dispatch() function the GraphQL route calls.
//
// Architecture diagram:
//
//   HTTP POST /graphql
//        │
//        ▼
//   routes/graphql.js
//        │  dispatch(operationName, variables, ctx)
//        ▼
//   cqrs/index.js (this file)
//        │
//        ├── commandBus.dispatch(name, payload, ctx)
//        │     middleware: envelope → latency → auth → handler
//        │     handler runs business logic, writes DB, emits events
//        │
//        ├── queryBus.dispatch(name, payload, ctx)
//        │     middleware: envelope → latency → auth → cache → handler
//        │     handler reads DB (or returns cached value)
//        │
//        └── eventBus (singleton)
//              subscribers:
//                projections/cache-invalidation  (drops stale Redis keys)
//                [add more here: notifications, websocket push, analytics]
//
// Adding a new resolver:
//   1. Decide command vs query (writes vs reads).
//   2. Add the handler to the matching file in commands/ or queries/.
//   3. Add it to the `commands` / `queries` export at the bottom of that file.
//   4. (Optional) Add a meta entry — `{ public: true }` to bypass auth,
//      `{ cache: { key, ttl } }` to opt the query into Redis caching.
//   5. (Optional) Emit a domain event for the cache-invalidation projection.
//   No other file needs to change.

import { commandBus } from './command-bus.js';
import { queryBus } from './query-bus.js';
import { eventBus } from './event-bus.js';

import { commandEnvelope, queryEnvelope } from './middleware/envelope.js';
import { latencyMiddleware } from './middleware/latency.js';
import { authMiddleware } from './middleware/auth.js';
import { cacheMiddleware } from './middleware/cache.js';

import { commands as authCmds,         meta as authCmdMeta }         from './commands/auth.js';
import { commands as rideCmds,         meta as rideCmdMeta }         from './commands/rides.js';
import { commands as reservationCmds,  meta as reservationCmdMeta }  from './commands/reservations.js';
import { commands as paymentCmds,      meta as paymentCmdMeta }      from './commands/payments.js';
import { commands as driverCmds,       meta as driverCmdMeta }       from './commands/drivers.js';
import { commands as userCmds,         meta as userCmdMeta }         from './commands/users.js';
import { commands as adminCmds,        meta as adminCmdMeta }        from './commands/admin.js';
import { commands as messageCmds,      meta as messageCmdMeta }      from './commands/messages.js';
import { commands as deliveryCmds,     meta as deliveryCmdMeta }     from './commands/deliveries.js';
import { commands as reviewCmds,       meta as reviewCmdMeta }       from './commands/reviews.js';

import { queries as authQs,         meta as authQMeta }         from './queries/auth.js';
import { queries as rideQs,         meta as rideQMeta }         from './queries/rides.js';
import { queries as reservationQs,  meta as reservationQMeta }  from './queries/reservations.js';
import { queries as paymentQs,      meta as paymentQMeta }      from './queries/payments.js';
import { queries as driverQs,       meta as driverQMeta }       from './queries/drivers.js';
import { queries as userQs,         meta as userQMeta }         from './queries/users.js';
import { queries as adminQs,        meta as adminQMeta }        from './queries/admin.js';
import { queries as messageQs,      meta as messageQMeta }      from './queries/messages.js';
import { queries as deliveryQs,     meta as deliveryQMeta }     from './queries/deliveries.js';
import { queries as reviewQs,       meta as reviewQMeta }       from './queries/reviews.js';
import { queries as infraQs,        meta as infraQMeta }        from './queries/infra.js';

import { cacheInvalidationProjection } from './projections/cache-invalidation.js';

// ─── Middleware stacks ──────────────────────────────────────────────────────
// Order matters. Envelope must wrap everything else so errors are caught.

commandBus
  .use(commandEnvelope())
  .use(latencyMiddleware())
  .use(authMiddleware());

queryBus
  .use(queryEnvelope())
  .use(latencyMiddleware())
  .use(authMiddleware())
  .use(cacheMiddleware());

// ─── Handler registration ──────────────────────────────────────────────────-
function registerDomain(bus, ops, meta = {}) {
  for (const [name, handler] of Object.entries(ops)) {
    bus.register(name, handler, meta[name] ?? {});
  }
}

registerDomain(commandBus, authCmds,        authCmdMeta);
registerDomain(commandBus, rideCmds,        rideCmdMeta);
registerDomain(commandBus, reservationCmds, reservationCmdMeta);
registerDomain(commandBus, paymentCmds,     paymentCmdMeta);
registerDomain(commandBus, driverCmds,      driverCmdMeta);
registerDomain(commandBus, userCmds,        userCmdMeta);
registerDomain(commandBus, adminCmds,       adminCmdMeta);
registerDomain(commandBus, messageCmds,     messageCmdMeta);
registerDomain(commandBus, deliveryCmds,    deliveryCmdMeta);
registerDomain(commandBus, reviewCmds,      reviewCmdMeta);

registerDomain(queryBus, authQs,        authQMeta);
registerDomain(queryBus, rideQs,        rideQMeta);
registerDomain(queryBus, reservationQs, reservationQMeta);
registerDomain(queryBus, paymentQs,     paymentQMeta);
registerDomain(queryBus, driverQs,      driverQMeta);
registerDomain(queryBus, userQs,        userQMeta);
registerDomain(queryBus, adminQs,       adminQMeta);
registerDomain(queryBus, messageQs,     messageQMeta);
registerDomain(queryBus, deliveryQs,    deliveryQMeta);
registerDomain(queryBus, reviewQs,      reviewQMeta);
registerDomain(queryBus, infraQs,       infraQMeta);

// ─── Projections ────────────────────────────────────────────────────────────
cacheInvalidationProjection.register();

// ─── Unified dispatch ──────────────────────────────────────────────────────-
// The GraphQL route uses this — it doesn't need to know whether an operation
// is a command or query, only that it exists.

export async function dispatch(operationName, variables = {}, ctx = {}) {
  if (commandBus.has(operationName)) {
    return commandBus.dispatch(operationName, variables, ctx);
  }
  if (queryBus.has(operationName)) {
    return queryBus.dispatch(operationName, variables, ctx);
  }
  const err = new Error(`Unknown operation: ${operationName}`);
  err.status = 400;
  throw err;
}

export function hasOperation(operationName) {
  return commandBus.has(operationName) || queryBus.has(operationName);
}

export function listOperations() {
  return {
    commands: commandBus.list().sort(),
    queries: queryBus.list().sort(),
    events: eventBus.list().sort(),
  };
}

// Re-exports for tests / introspection.
export { commandBus, queryBus, eventBus };
