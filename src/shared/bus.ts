import type { EventMap, EventName } from "./events.js";

type Listener<T> = (payload: T) => void;

/** Synchronous in-process event bus. Listener failures are logged and isolated. */
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
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        (listener as Listener<EventMap[K]>)(payload);
      } catch (error) {
        console.error(`[event bus] listener for ${event} failed:`, error);
      }
    }
  }
}
