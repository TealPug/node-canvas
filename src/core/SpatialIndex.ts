import type { GraphNode } from "../types/index.js";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_NODE_WIDTH = 200;
const DEFAULT_NODE_HEIGHT = 100;

/**
 * Simple grid-based spatial index for fast viewport queries.
 *
 * Divides the 2D plane into cells of `cellSize` pixels and tracks which nodes
 * overlap each cell. Querying a viewport rectangle returns only the nodes
 * whose bounding boxes intersect that rectangle.
 */
export class SpatialIndex {
  private cellSize: number;
  private cells = new Map<string, Set<string>>();
  private nodeBounds = new Map<string, Rect>();

  constructor(cellSize = 256) {
    this.cellSize = cellSize;
  }

  private key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  private cellRange(rect: Rect) {
    const minCx = Math.floor(rect.x / this.cellSize);
    const minCy = Math.floor(rect.y / this.cellSize);
    const maxCx = Math.floor((rect.x + rect.width) / this.cellSize);
    const maxCy = Math.floor((rect.y + rect.height) / this.cellSize);
    return { minCx, minCy, maxCx, maxCy };
  }

  update(node: GraphNode): void {
    this.remove(node.id);

    const rect: Rect = {
      x: node.position.x,
      y: node.position.y,
      width: node.size?.width ?? DEFAULT_NODE_WIDTH,
      height: node.size?.height ?? DEFAULT_NODE_HEIGHT,
    };
    this.nodeBounds.set(node.id, rect);

    const { minCx, minCy, maxCx, maxCy } = this.cellRange(rect);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const k = this.key(cx, cy);
        if (!this.cells.has(k)) this.cells.set(k, new Set());
        this.cells.get(k)!.add(node.id);
      }
    }
  }

  remove(nodeId: string): void {
    const rect = this.nodeBounds.get(nodeId);
    if (!rect) return;
    const { minCx, minCy, maxCx, maxCy } = this.cellRange(rect);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        this.cells.get(this.key(cx, cy))?.delete(nodeId);
      }
    }
    this.nodeBounds.delete(nodeId);
  }

  /** Return IDs of nodes whose bounding boxes intersect `viewport`. */
  query(viewport: Rect): Set<string> {
    const result = new Set<string>();
    const { minCx, minCy, maxCx, maxCy } = this.cellRange(viewport);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const cell = this.cells.get(this.key(cx, cy));
        if (cell) {
          for (const id of cell) result.add(id);
        }
      }
    }
    return result;
  }

  clear(): void {
    this.cells.clear();
    this.nodeBounds.clear();
  }
}
