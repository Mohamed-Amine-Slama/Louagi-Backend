import { Bus } from './bus.js';

export class QueryBus extends Bus {
  constructor() {
    super('query');
  }
}

// Singleton — every query handler in the app registers here. When read replicas
// are added later, this bus's handlers can be pointed at a replica connection
// pool via a `sql` injected through ctx — handlers don't need to change.
export const queryBus = new QueryBus();
