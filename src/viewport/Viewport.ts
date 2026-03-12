import type { NodePosition } from "../types/index.js";

export interface ViewportState {
  /** Offset X in screen pixels. */
  x: number;
  /** Offset Y in screen pixels. */
  y: number;
  /** Current zoom level (1 = 100%). */
  zoom: number;
}

export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Manages pan/zoom transforms for the editor canvas.
 */
export class Viewport {
  private state: ViewportState = { x: 0, y: 0, zoom: 1 };
  private minZoom: number;
  private maxZoom: number;
  private containerWidth = 0;
  private containerHeight = 0;

  constructor(minZoom = 0.1, maxZoom = 5) {
    this.minZoom = minZoom;
    this.maxZoom = maxZoom;
  }

  setContainerSize(width: number, height: number): void {
    this.containerWidth = width;
    this.containerHeight = height;
  }

  getState(): ViewportState {
    return { ...this.state };
  }

  /** Convert screen coordinates to graph-space coordinates. */
  screenToGraph(screenX: number, screenY: number): NodePosition {
    return {
      x: (screenX - this.state.x) / this.state.zoom,
      y: (screenY - this.state.y) / this.state.zoom,
    };
  }

  /** Convert graph-space coordinates to screen coordinates. */
  graphToScreen(graphX: number, graphY: number): NodePosition {
    return {
      x: graphX * this.state.zoom + this.state.x,
      y: graphY * this.state.zoom + this.state.y,
    };
  }

  /** The visible rectangle in graph-space coordinates. */
  getVisibleRect(): ViewportRect {
    const topLeft = this.screenToGraph(0, 0);
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: this.containerWidth / this.state.zoom,
      height: this.containerHeight / this.state.zoom,
    };
  }

  pan(dx: number, dy: number): void {
    this.state.x += dx;
    this.state.y += dy;
  }

  /** Zoom towards a point in screen coordinates. */
  zoomAt(screenX: number, screenY: number, delta: number): void {
    const factor = delta > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(
      this.minZoom,
      Math.min(this.maxZoom, this.state.zoom * factor),
    );
    const ratio = newZoom / this.state.zoom;

    this.state.x = screenX - (screenX - this.state.x) * ratio;
    this.state.y = screenY - (screenY - this.state.y) * ratio;
    this.state.zoom = newZoom;
  }

  /** Set zoom and center on a graph-space point. */
  zoomToFit(rect: ViewportRect, padding = 50): void {
    if (rect.width === 0 || rect.height === 0) return;

    const scaleX = (this.containerWidth - padding * 2) / rect.width;
    const scaleY = (this.containerHeight - padding * 2) / rect.height;
    const zoom = Math.max(
      this.minZoom,
      Math.min(this.maxZoom, Math.min(scaleX, scaleY)),
    );

    this.state.zoom = zoom;
    this.state.x =
      this.containerWidth / 2 - (rect.x + rect.width / 2) * zoom;
    this.state.y =
      this.containerHeight / 2 - (rect.y + rect.height / 2) * zoom;
  }

  /** CSS transform string for the DOM node container. */
  toCSSTransform(): string {
    return `translate(${this.state.x}px, ${this.state.y}px) scale(${this.state.zoom})`;
  }
}
