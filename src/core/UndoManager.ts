import type { GraphData } from "../types/index.js";

/**
 * Snapshot-based undo/redo stack. Stores deep clones of the full graph state
 * before each discrete user action.
 */
export class UndoManager {
  private stack: GraphData[] = [];
  private pointer = -1;
  private maxSize: number;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  push(snapshot: GraphData): void {
    // Discard any redo history beyond current pointer
    this.stack.length = this.pointer + 1;
    this.stack.push(structuredClone(snapshot));
    if (this.stack.length > this.maxSize) {
      this.stack.shift();
    } else {
      this.pointer++;
    }
  }

  undo(): GraphData | null {
    if (this.pointer <= 0) return null;
    this.pointer--;
    return structuredClone(this.stack[this.pointer]);
  }

  redo(): GraphData | null {
    if (this.pointer >= this.stack.length - 1) return null;
    this.pointer++;
    return structuredClone(this.stack[this.pointer]);
  }

  canUndo(): boolean {
    return this.pointer > 0;
  }

  canRedo(): boolean {
    return this.pointer < this.stack.length - 1;
  }

  clear(): void {
    this.stack.length = 0;
    this.pointer = -1;
  }
}
