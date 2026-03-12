import type { EditorEventMap, EditorEventType } from "../types/index.js";

type Listener<T extends EditorEventType> = (
  payload: EditorEventMap[T],
) => void;

/**
 * Typed event emitter for editor events.
 */
export class EventEmitter {
  private listeners = new Map<EditorEventType, Set<Listener<never>>>();

  on<T extends EditorEventType>(type: T, handler: Listener<T>): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    const set = this.listeners.get(type)!;
    set.add(handler as Listener<never>);

    return () => set.delete(handler as Listener<never>);
  }

  off<T extends EditorEventType>(type: T, handler: Listener<T>): void {
    this.listeners.get(type)?.delete(handler as Listener<never>);
  }

  emit<T extends EditorEventType>(type: T, payload: EditorEventMap[T]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const handler of set) {
      (handler as Listener<T>)(payload);
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
