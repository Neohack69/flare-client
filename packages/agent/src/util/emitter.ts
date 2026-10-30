type UntypedHandler = (...args: unknown[]) => void;

/**
 * Minimal typed event emitter. Kept dependency-free on purpose: the agent must
 * run inside Electron/Node without extra runtime packages.
 */
export class TypedEmitter<EventMap extends object> {
  private readonly handlers = new Map<keyof EventMap, Set<UntypedHandler>>();

  on<K extends keyof EventMap>(event: K, handler: EventMap[K]): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set<UntypedHandler>();
      this.handlers.set(event, set);
    }
    set.add(handler as unknown as UntypedHandler);
  }

  off<K extends keyof EventMap>(event: K, handler: EventMap[K]): void {
    this.handlers.get(event)?.delete(handler as unknown as UntypedHandler);
  }

  protected emit<K extends keyof EventMap>(event: K, ...args: unknown[]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      handler(...args);
    }
  }

  protected removeAllListeners(): void {
    this.handlers.clear();
  }
}
