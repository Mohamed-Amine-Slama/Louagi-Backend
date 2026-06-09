import { Bus } from './bus.js';

export class CommandBus extends Bus {
  constructor() {
    super('command');
  }
}

// Singleton — every command handler in the app registers here.
export const commandBus = new CommandBus();
