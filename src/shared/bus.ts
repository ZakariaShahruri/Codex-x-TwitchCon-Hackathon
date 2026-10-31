import type { EventMap, EventName } from "./events.js";

type Listener<T> = (payload: T) => void | Promise<void>;

/** Synchronous in-process event bus. Listener failures, sync or async, are logged and isolated. */
export class EventBus {
  private readonly listeners = new Map<EventName, Set<Listener<never>>>();

  on<K extends EventName>(event: K, listener: Listener<EventMap[K]>): void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener as Listener<never>);
  }

  off<K extends EventName>(event: K, listener: Listener<EventMap[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>);
  }

  emit<K extends EventName>(event: K, payload: EventMap[K]): void {
    const report = (error: unknown) => console.error(`[event bus] listener for ${event} failed:`, error);
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        (listener as Listener<EventMap[K]>)(payload)?.catch(report);
      } catch (error) {
        report(error);
      }
    }
  }
}
