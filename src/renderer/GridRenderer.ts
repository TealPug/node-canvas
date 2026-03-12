import type { ViewportState } from "../viewport/Viewport.js";

/**
 * Draws a background grid on the connections canvas.
 */
export class GridRenderer {
  private gridSize: number;
  private gridColor: string;

  constructor(gridSize = 20, gridColor = "rgba(255, 255, 255, 0.05)") {
    this.gridSize = gridSize;
    this.gridColor = gridColor;
  }

  render(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    viewport: ViewportState,
    dpr: number,
  ): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const size = this.gridSize * viewport.zoom;
    if (size < 4) return; // skip grid when zoomed out too far

    const offsetX = viewport.x % size;
    const offsetY = viewport.y % size;

    ctx.strokeStyle = this.gridColor;
    ctx.lineWidth = 1;

    ctx.beginPath();
    for (let x = offsetX; x < width; x += size) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let y = offsetY; y < height; y += size) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
  }
}
