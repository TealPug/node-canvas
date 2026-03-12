import type {
  EditorConfig,
  EditorEventType,
  EditorEventHandler,
  GraphData,
  GraphNode,
  GraphConnection,
} from "../types/index.js";
import { EventEmitter } from "./EventEmitter.js";
import { SpatialIndex } from "./SpatialIndex.js";
import { Graph } from "../graph/Graph.js";
import { Viewport } from "../viewport/Viewport.js";
import { ConnectionRenderer } from "../renderer/ConnectionRenderer.js";
import { GridRenderer } from "../renderer/GridRenderer.js";
import { LayoutWorkerClient } from "../worker/LayoutWorkerClient.js";

const DEFAULT_NODE_WIDTH = 200;
const DEFAULT_NODE_HEIGHT = 100;

/**
 * The main editor controller. Orchestrates the hybrid DOM + Canvas rendering:
 *
 * - DOM layer: a transformed container `<div>` that holds individual node
 *   elements. Each node is a positioned `<div>` inside this container. The
 *   browser handles text rendering, accessibility, and CSS styling.
 *
 * - Canvas layer: an `<HTMLCanvasElement>` underneath the DOM layer that draws
 *   connections (bezier curves) and the background grid.
 *
 * The editor uses a spatial index so that only nodes visible in the current
 * viewport are mounted to the DOM.
 */
export class NodeCanvas {
  private container: HTMLElement;
  private canvasEl: HTMLCanvasElement;
  private nodeLayer: HTMLDivElement;
  private graph: Graph;
  private viewport: Viewport;
  private spatialIndex: SpatialIndex;
  private connectionRenderer: ConnectionRenderer;
  private gridRenderer: GridRenderer;
  private events: EventEmitter;
  private layoutWorker: LayoutWorkerClient;
  private config: EditorConfig;

  private mountedNodes = new Map<string, HTMLDivElement>();
  private selectedNodeIds = new Set<string>();
  private rafId: number | null = null;
  private dirty = true;

  // Interaction state
  private isDragging = false;
  private isPanning = false;
  private dragNodeId: string | null = null;
  private dragStart = { x: 0, y: 0 };
  private dragNodeStart = { x: 0, y: 0 };
  private resizeObserver: ResizeObserver | null = null;

  /** Custom render function for node content. */
  renderNode:
    | ((node: GraphNode, element: HTMLDivElement) => void)
    | null = null;

  constructor(container: HTMLElement, config: EditorConfig = {}) {
    this.container = container;
    this.config = config;
    this.graph = new Graph();
    this.viewport = new Viewport(config.minZoom, config.maxZoom);
    this.spatialIndex = new SpatialIndex();
    this.events = new EventEmitter();
    this.gridRenderer = new GridRenderer(
      config.theme?.gridSize,
      config.theme?.gridColor,
    );
    this.layoutWorker = new LayoutWorkerClient(config.useWorker ?? true);

    // --- Build DOM structure ---
    container.style.position = "relative";
    container.style.overflow = "hidden";
    container.style.background = config.theme?.background ?? "#1a1a2e";

    this.canvasEl = document.createElement("canvas");
    this.canvasEl.style.position = "absolute";
    this.canvasEl.style.inset = "0";
    this.canvasEl.style.pointerEvents = "none";
    container.appendChild(this.canvasEl);

    this.nodeLayer = document.createElement("div");
    this.nodeLayer.style.position = "absolute";
    this.nodeLayer.style.inset = "0";
    this.nodeLayer.style.transformOrigin = "0 0";
    container.appendChild(this.nodeLayer);

    this.connectionRenderer = new ConnectionRenderer(
      this.canvasEl,
      config.theme?.connection,
    );

    // --- Size ---
    this.updateSize();
    this.resizeObserver = new ResizeObserver(() => {
      this.updateSize();
      this.markDirty();
    });
    this.resizeObserver.observe(container);

    // --- Events ---
    this.bindEvents();

    // --- Initial data ---
    if (config.data) {
      this.loadGraph(config.data);
    }

    this.startRenderLoop();
  }

  // ════════════════════════════════════════════════════════════════════
  // Public API
  // ════════════════════════════════════════════════════════════════════

  loadGraph(data: GraphData): void {
    this.graph.load(data);
    this.spatialIndex.clear();
    for (const node of this.graph.getAllNodes()) {
      this.spatialIndex.update(node);
    }
    this.markDirty();
    this.events.emit("graph:change", { data: this.graph.serialize() });
  }

  getGraphData(): GraphData {
    return this.graph.serialize();
  }

  addNode(node: GraphNode): void {
    this.graph.addNode(node);
    this.spatialIndex.update(node);
    this.markDirty();
    this.events.emit("node:add", { node });
    this.events.emit("graph:change", { data: this.graph.serialize() });
  }

  removeNode(nodeId: string): void {
    const removedConns = this.graph.removeNode(nodeId);
    this.spatialIndex.remove(nodeId);
    this.unmountNode(nodeId);
    for (const conn of removedConns) {
      this.events.emit("connection:remove", { connectionId: conn.id });
    }
    this.markDirty();
    this.events.emit("node:remove", { nodeId });
    this.events.emit("graph:change", { data: this.graph.serialize() });
  }

  addConnection(connection: GraphConnection): void {
    this.graph.addConnection(connection);
    this.markDirty();
    this.events.emit("connection:add", { connection });
    this.events.emit("graph:change", { data: this.graph.serialize() });
  }

  removeConnection(connectionId: string): void {
    this.graph.removeConnection(connectionId);
    this.markDirty();
    this.events.emit("connection:remove", { connectionId });
    this.events.emit("graph:change", { data: this.graph.serialize() });
  }

  async autoLayout(iterations?: number): Promise<void> {
    const positions = await this.layoutWorker.computeLayout(
      this.graph.getAllNodes(),
      this.graph.getAllConnections(),
      iterations,
    );
    for (const [id, pos] of Object.entries(positions)) {
      this.graph.updateNodePosition(id, pos.x, pos.y);
      const node = this.graph.getNode(id);
      if (node) this.spatialIndex.update(node);
    }
    this.markDirty();
    this.events.emit("graph:change", { data: this.graph.serialize() });
  }

  zoomToFit(padding?: number): void {
    const nodes = this.graph.getAllNodes();
    if (nodes.length === 0) return;

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + (n.size?.width ?? DEFAULT_NODE_WIDTH));
      maxY = Math.max(maxY, n.position.y + (n.size?.height ?? DEFAULT_NODE_HEIGHT));
    }
    this.viewport.zoomToFit(
      { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      padding,
    );
    this.markDirty();
    this.events.emit("viewport:change", this.viewport.getState());
  }

  on<T extends EditorEventType>(type: T, handler: EditorEventHandler<T>): () => void {
    return this.events.on(type, handler);
  }

  off<T extends EditorEventType>(type: T, handler: EditorEventHandler<T>): void {
    this.events.off(type, handler);
  }

  getSelectedNodeIds(): string[] {
    return Array.from(this.selectedNodeIds);
  }

  destroy(): void {
    this.stopRenderLoop();
    this.resizeObserver?.disconnect();
    this.layoutWorker.destroy();
    this.events.removeAllListeners();
    this.unbindEvents();
    this.container.removeChild(this.canvasEl);
    this.container.removeChild(this.nodeLayer);
    this.mountedNodes.clear();
  }

  // ════════════════════════════════════════════════════════════════════
  // Rendering
  // ════════════════════════════════════════════════════════════════════

  private markDirty(): void {
    this.dirty = true;
  }

  private startRenderLoop(): void {
    const loop = () => {
      if (this.dirty) {
        this.render();
        this.dirty = false;
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private stopRenderLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private render(): void {
    const vpState = this.viewport.getState();

    // Update DOM node layer transform
    this.nodeLayer.style.transform = this.viewport.toCSSTransform();

    // Determine visible nodes via spatial index
    const visibleRect = this.viewport.getVisibleRect();
    // Add buffer around viewport for smoother scrolling
    const buffer = 200 / vpState.zoom;
    const queryRect = {
      x: visibleRect.x - buffer,
      y: visibleRect.y - buffer,
      width: visibleRect.width + buffer * 2,
      height: visibleRect.height + buffer * 2,
    };
    const visibleIds = this.spatialIndex.query(queryRect);

    // Mount/unmount nodes
    for (const id of visibleIds) {
      if (!this.mountedNodes.has(id)) {
        const node = this.graph.getNode(id);
        if (node) this.mountNode(node);
      }
    }
    for (const [id] of this.mountedNodes) {
      if (!visibleIds.has(id)) {
        this.unmountNode(id);
      }
    }

    // Update mounted node positions
    for (const id of visibleIds) {
      const node = this.graph.getNode(id);
      const el = this.mountedNodes.get(id);
      if (node && el) {
        el.style.transform = `translate(${node.position.x}px, ${node.position.y}px)`;
      }
    }

    // Draw grid + connections on canvas
    const ctx = this.canvasEl.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvasEl.width, this.canvasEl.height);

    this.gridRenderer.render(
      ctx,
      this.container.clientWidth,
      this.container.clientHeight,
      vpState,
      dpr,
    );

    // Build node map for connection rendering
    const nodeMap = new Map<string, GraphNode>();
    for (const node of this.graph.getAllNodes()) {
      nodeMap.set(node.id, node);
    }

    this.connectionRenderer.render(
      this.graph.getAllConnections(),
      nodeMap,
      vpState,
    );
  }

  // ════════════════════════════════════════════════════════════════════
  // DOM node management
  // ════════════════════════════════════════════════════════════════════

  private mountNode(node: GraphNode): void {
    const el = document.createElement("div");
    el.dataset.nodeId = node.id;
    el.style.position = "absolute";
    el.style.left = "0";
    el.style.top = "0";
    el.style.width = `${node.size?.width ?? DEFAULT_NODE_WIDTH}px`;
    el.style.transform = `translate(${node.position.x}px, ${node.position.y}px)`;
    el.style.willChange = "transform";
    el.style.contentVisibility = "auto";
    el.style.contain = "layout style paint";
    el.classList.add("tnc-node");

    if (this.selectedNodeIds.has(node.id)) {
      el.classList.add("tnc-node--selected");
    }

    // Default rendering — consumer can override via renderNode
    if (this.renderNode) {
      this.renderNode(node, el);
    } else {
      this.defaultRenderNode(node, el);
    }

    this.nodeLayer.appendChild(el);
    this.mountedNodes.set(node.id, el);
  }

  private unmountNode(nodeId: string): void {
    const el = this.mountedNodes.get(nodeId);
    if (el) {
      el.remove();
      this.mountedNodes.delete(nodeId);
    }
  }

  private defaultRenderNode(node: GraphNode, el: HTMLDivElement): void {
    const style = this.config.theme?.node;

    el.style.background = style?.bodyColor ?? "#16213e";
    el.style.border = `1px solid ${style?.borderColor ?? "#0f3460"}`;
    el.style.borderRadius = `${style?.borderRadius ?? 6}px`;
    el.style.color = style?.textColor ?? "#e0e0e0";
    el.style.fontSize = "12px";
    el.style.fontFamily = "system-ui, sans-serif";
    el.style.overflow = "hidden";

    // Header
    const header = document.createElement("div");
    header.style.background = style?.headerColor ?? "#0f3460";
    header.style.padding = "4px 8px";
    header.style.fontWeight = "600";
    header.style.fontSize = "11px";
    header.style.userSelect = "none";
    header.textContent = node.title ?? node.type;
    el.appendChild(header);

    // Slots
    const body = document.createElement("div");
    body.style.padding = "4px 8px";
    body.style.display = "flex";
    body.style.justifyContent = "space-between";

    const inputs = document.createElement("div");
    for (const input of node.inputs ?? []) {
      const row = document.createElement("div");
      row.style.fontSize = "10px";
      row.style.padding = "2px 0";
      row.textContent = `● ${input.name}`;
      inputs.appendChild(row);
    }

    const outputs = document.createElement("div");
    outputs.style.textAlign = "right";
    for (const output of node.outputs ?? []) {
      const row = document.createElement("div");
      row.style.fontSize = "10px";
      row.style.padding = "2px 0";
      row.textContent = `${output.name} ●`;
      outputs.appendChild(row);
    }

    body.appendChild(inputs);
    body.appendChild(outputs);
    el.appendChild(body);
  }

  // ════════════════════════════════════════════════════════════════════
  // Interaction handling
  // ════════════════════════════════════════════════════════════════════

  private onPointerDown = (e: PointerEvent): void => {
    if (this.config.readOnly) return;

    const target = (e.target as HTMLElement).closest<HTMLDivElement>(
      "[data-node-id]",
    );

    if (target && target.dataset.nodeId) {
      // Start dragging a node
      const nodeId = target.dataset.nodeId;
      const node = this.graph.getNode(nodeId);
      if (!node) return;

      this.isDragging = true;
      this.dragNodeId = nodeId;
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.dragNodeStart = { ...node.position };

      if (!e.shiftKey) {
        this.clearSelection();
      }
      this.selectNode(nodeId);

      this.container.setPointerCapture(e.pointerId);
      e.preventDefault();
    } else {
      // Start panning
      this.isPanning = true;
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.container.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.isDragging && this.dragNodeId) {
      const zoom = this.viewport.getState().zoom;
      const dx = (e.clientX - this.dragStart.x) / zoom;
      const dy = (e.clientY - this.dragStart.y) / zoom;
      const newX = this.dragNodeStart.x + dx;
      const newY = this.dragNodeStart.y + dy;

      this.graph.updateNodePosition(this.dragNodeId, newX, newY);
      const node = this.graph.getNode(this.dragNodeId);
      if (node) this.spatialIndex.update(node);
      this.markDirty();
    } else if (this.isPanning) {
      const dx = e.clientX - this.dragStart.x;
      const dy = e.clientY - this.dragStart.y;
      this.viewport.pan(dx, dy);
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.markDirty();
      this.events.emit("viewport:change", this.viewport.getState());
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.isDragging && this.dragNodeId) {
      const node = this.graph.getNode(this.dragNodeId);
      if (node) {
        this.events.emit("node:move", {
          nodeId: this.dragNodeId,
          position: { ...node.position },
        });
        this.events.emit("graph:change", { data: this.graph.serialize() });
      }
    }

    this.isDragging = false;
    this.isPanning = false;
    this.dragNodeId = null;
    this.container.releasePointerCapture(e.pointerId);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.container.getBoundingClientRect();
    this.viewport.zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY);
    this.markDirty();
    this.events.emit("viewport:change", this.viewport.getState());
  };

  private selectNode(nodeId: string): void {
    this.selectedNodeIds.add(nodeId);
    const el = this.mountedNodes.get(nodeId);
    if (el) el.classList.add("tnc-node--selected");
    this.events.emit("node:select", { nodeId });
  }

  private clearSelection(): void {
    for (const id of this.selectedNodeIds) {
      const el = this.mountedNodes.get(id);
      if (el) el.classList.remove("tnc-node--selected");
      this.events.emit("node:deselect", { nodeId: id });
    }
    this.selectedNodeIds.clear();
  }

  private bindEvents(): void {
    this.container.addEventListener("pointerdown", this.onPointerDown);
    this.container.addEventListener("pointermove", this.onPointerMove);
    this.container.addEventListener("pointerup", this.onPointerUp);
    this.container.addEventListener("wheel", this.onWheel, { passive: false });
  }

  private unbindEvents(): void {
    this.container.removeEventListener("pointerdown", this.onPointerDown);
    this.container.removeEventListener("pointermove", this.onPointerMove);
    this.container.removeEventListener("pointerup", this.onPointerUp);
    this.container.removeEventListener("wheel", this.onWheel);
  }

  // ════════════════════════════════════════════════════════════════════
  // Internal
  // ════════════════════════════════════════════════════════════════════

  private updateSize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.viewport.setContainerSize(w, h);
    this.connectionRenderer.resize(w, h);
  }
}
