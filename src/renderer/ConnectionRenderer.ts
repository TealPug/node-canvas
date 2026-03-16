import type {
  GraphConnection,
  GraphNode,
  ConnectionStyle,
} from "../types/index.js";
import type { ViewportState } from "../viewport/Viewport.js";
import {
  DEFAULT_NODE_WIDTH,
  ROW_HEIGHT,
  SLOT_START_Y,
} from "../constants/layout.js";

const DEFAULT_STYLE: Required<ConnectionStyle> = {
  color: "#888888",
  selectedColor: "#4a9eff",
  width: 2,
  curvature: 0.5,
};

/**
 * Renders connections (edges) between nodes onto an HTML5 Canvas.
 *
 * Row positions use the raw input/output array index directly, since the DOM
 * node renderer places every input and output at its original array index in a
 * unified row layout.
 */
export class ConnectionRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private style: Required<ConnectionStyle>;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement, style?: ConnectionStyle) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2d context from canvas");
    this.ctx = ctx;
    this.style = { ...DEFAULT_STYLE, ...style };
    this.dpr = window.devicePixelRatio || 1;
  }

  resize(width: number, height: number): void {
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = width * this.dpr;
    this.canvas.height = height * this.dpr;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  render(
    connections: GraphConnection[],
    nodeMap: Map<string, GraphNode>,
    viewport: ViewportState,
    selectedConnectionIds?: Set<string>,
  ): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.translate(viewport.x, viewport.y);
    ctx.scale(viewport.zoom, viewport.zoom);

    for (const conn of connections) {
      const source = nodeMap.get(conn.sourceNodeId);
      const target = nodeMap.get(conn.targetNodeId);
      if (!source || !target) continue;

      const isSelected = selectedConnectionIds?.has(conn.id) ?? false;
      this.drawConnection(
        ctx,
        source,
        conn.sourceOutputIndex,
        target,
        conn.targetInputIndex,
        isSelected,
      );
    }

    ctx.restore();
  }

  private drawConnection(
    ctx: CanvasRenderingContext2D,
    source: GraphNode,
    outputIndex: number,
    target: GraphNode,
    inputIndex: number,
    selected: boolean,
  ): void {
    const srcW = source.size?.width ?? DEFAULT_NODE_WIDTH;
    const srcX = source.position.x + srcW;
    const srcY =
      source.position.y +
      SLOT_START_Y +
      outputIndex * ROW_HEIGHT;

    const tgtX = target.position.x;
    const tgtY =
      target.position.y +
      SLOT_START_Y +
      inputIndex * ROW_HEIGHT;

    const dx = Math.abs(tgtX - srcX) * this.style.curvature;

    ctx.beginPath();
    ctx.moveTo(srcX, srcY);
    ctx.bezierCurveTo(srcX + dx, srcY, tgtX - dx, tgtY, tgtX, tgtY);

    ctx.strokeStyle = selected ? this.style.selectedColor : this.style.color;
    ctx.lineWidth = selected ? this.style.width + 1 : this.style.width;
    ctx.stroke();
  }

  /** Draw a temporary connection being dragged by the user. */
  renderDraft(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    viewport: ViewportState,
    valid: boolean,
  ): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(viewport.x, viewport.y);
    ctx.scale(viewport.zoom, viewport.zoom);

    const dx = Math.abs(endX - startX) * this.style.curvature;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.bezierCurveTo(startX + dx, startY, endX - dx, endY, endX, endY);

    ctx.strokeStyle = valid
      ? "rgba(74, 158, 255, 0.8)"
      : "rgba(255, 80, 80, 0.6)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}
