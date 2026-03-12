import type { GraphNode, GraphConnection, NodePosition } from "../types/index.js";

/**
 * Client-side interface to the layout Web Worker.
 *
 * Falls back to synchronous (main-thread) execution if workers are
 * unavailable.
 */
export class LayoutWorkerClient {
  private worker: Worker | null = null;
  private pending: ((positions: Record<string, NodePosition>) => void) | null =
    null;

  constructor(useWorker = true) {
    if (useWorker && typeof Worker !== "undefined") {
      try {
        this.worker = new Worker(
          new URL("./layout.worker.js", import.meta.url),
          { type: "module" },
        );
        this.worker.onmessage = (e: MessageEvent) => {
          if (e.data.type === "layout:result" && this.pending) {
            this.pending(e.data.positions);
            this.pending = null;
          }
        };
      } catch {
        this.worker = null;
      }
    }
  }

  computeLayout(
    nodes: GraphNode[],
    connections: GraphConnection[],
    iterations?: number,
  ): Promise<Record<string, NodePosition>> {
    return new Promise((resolve) => {
      if (this.worker) {
        this.pending = resolve;
        this.worker.postMessage({
          type: "layout",
          nodes,
          connections,
          iterations,
        });
      } else {
        // Synchronous fallback — import dynamically to avoid bundling
        // the worker code into the main bundle when not needed.
        resolve(this.syncFallback(nodes, connections, iterations));
      }
    });
  }

  private syncFallback(
    nodes: GraphNode[],
    _connections: GraphConnection[],
    _iterations?: number,
  ): Record<string, NodePosition> {
    // Simple grid layout as fallback
    const result: Record<string, NodePosition> = {};
    const cols = Math.ceil(Math.sqrt(nodes.length));
    nodes.forEach((node, i) => {
      result[node.id] = {
        x: (i % cols) * 300,
        y: Math.floor(i / cols) * 200,
      };
    });
    return result;
  }

  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
