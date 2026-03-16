import type {
  EditorConfig,
  EditorEventType,
  EditorEventHandler,
  GraphData,
  GraphNode,
  GraphConnection,
  NodePosition,
} from "../types/index.js";
import { EventEmitter } from "./EventEmitter.js";
import { SpatialIndex } from "./SpatialIndex.js";
import { Graph } from "../graph/Graph.js";
import { Viewport } from "../viewport/Viewport.js";
import { ConnectionRenderer } from "../renderer/ConnectionRenderer.js";
import { GridRenderer } from "../renderer/GridRenderer.js";
import { LayoutWorkerClient } from "../worker/LayoutWorkerClient.js";
import { UndoManager } from "./UndoManager.js";
import {
  DEFAULT_NODE_WIDTH,
  DEFAULT_NODE_HEIGHT,
  SLOT_START_Y,
  ROW_HEIGHT,
  SLOT_HIT_RADIUS,
} from "../constants/layout.js";

function formatWidgetValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string")
    return value.length > 30 ? value.slice(0, 27) + "…" : value;
  if (typeof value === "object") return JSON.stringify(value).slice(0, 30);
  return String(value);
}

interface SlotHit {
  nodeId: string;
  slotType: "input" | "output";
  slotIndex: number;
  x: number;
  y: number;
}

interface ConnectionDraft {
  sourceNodeId: string;
  sourceOutputIndex: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

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
  private undoManager: UndoManager;
  private config: EditorConfig;

  private mountedNodes = new Map<string, HTMLDivElement>();
  private selectedNodeIds = new Set<string>();
  private rafId: number | null = null;
  private dirty = true;

  // Interaction state
  private isDragging = false;
  private isPanning = false;
  private isConnecting = false;
  private isBoxSelecting = false;
  private dragNodeId: string | null = null;
  private dragStart = { x: 0, y: 0 };
  private dragGroupStarts = new Map<string, NodePosition>();
  private connectionDraft: ConnectionDraft | null = null;
  private snapTarget: SlotHit | null = null;
  private boxSelectStart = { x: 0, y: 0 };
  private boxSelectEnd = { x: 0, y: 0 };
  private resizeObserver: ResizeObserver | null = null;

  // Clipboard
  private clipboard: {
    nodes: GraphNode[];
    connections: GraphConnection[];
  } | null = null;

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
    this.undoManager = new UndoManager();
    this.gridRenderer = new GridRenderer(
      config.theme?.gridSize,
      config.theme?.gridColor,
    );
    this.layoutWorker = new LayoutWorkerClient(config.useWorker ?? true);

    // --- Build DOM structure ---
    container.style.position = "relative";
    container.style.overflow = "hidden";
    container.style.background = config.theme?.background ?? "#1a1a2e";
    container.tabIndex = -1;
    container.style.outline = "none";

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
    // Unmount all existing DOM nodes and rebuild
    for (const [id] of this.mountedNodes) {
      this.unmountNode(id);
    }
    this.undoManager.push(this.graph.serialize());
    this.markDirty();
    this.events.emit("graph:change", { data: this.graph.serialize() });
  }

  getGraphData(): GraphData {
    return this.graph.serialize();
  }

  addNode(node: GraphNode): void {
    this.pushUndo();
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
    this.selectedNodeIds.delete(nodeId);
    for (const conn of removedConns) {
      this.events.emit("connection:remove", { connectionId: conn.id });
    }
    this.markDirty();
    this.events.emit("node:remove", { nodeId });
    this.events.emit("graph:change", { data: this.graph.serialize() });
  }

  addConnection(connection: GraphConnection): void {
    this.pushUndo();
    this.graph.addConnection(connection);
    this.markDirty();
    this.events.emit("connection:add", { connection });
    this.events.emit("graph:change", { data: this.graph.serialize() });
  }

  removeConnection(connectionId: string): void {
    this.pushUndo();
    this.graph.removeConnection(connectionId);
    this.markDirty();
    this.events.emit("connection:remove", { connectionId });
    this.events.emit("graph:change", { data: this.graph.serialize() });
  }

  undo(): void {
    const snapshot = this.undoManager.undo();
    if (snapshot) {
      this.graph.load(snapshot);
      this.rebuildSpatialIndex();
      this.clearSelection();
      for (const [id] of this.mountedNodes) {
        this.unmountNode(id);
      }
      this.markDirty();
      this.events.emit("graph:change", { data: this.graph.serialize() });
    }
  }

  redo(): void {
    const snapshot = this.undoManager.redo();
    if (snapshot) {
      this.graph.load(snapshot);
      this.rebuildSpatialIndex();
      this.clearSelection();
      for (const [id] of this.mountedNodes) {
        this.unmountNode(id);
      }
      this.markDirty();
      this.events.emit("graph:change", { data: this.graph.serialize() });
    }
  }

  async autoLayout(iterations?: number): Promise<void> {
    this.pushUndo();
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
      maxX = Math.max(
        maxX,
        n.position.x + (n.size?.width ?? DEFAULT_NODE_WIDTH),
      );
      maxY = Math.max(
        maxY,
        n.position.y + (n.size?.height ?? DEFAULT_NODE_HEIGHT),
      );
    }
    this.viewport.zoomToFit(
      { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      padding,
    );
    this.markDirty();
    this.events.emit("viewport:change", this.viewport.getState());
  }

  on<T extends EditorEventType>(
    type: T,
    handler: EditorEventHandler<T>,
  ): () => void {
    return this.events.on(type, handler);
  }

  off<T extends EditorEventType>(
    type: T,
    handler: EditorEventHandler<T>,
  ): void {
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
  // Undo helpers
  // ════════════════════════════════════════════════════════════════════

  private pushUndo(): void {
    this.undoManager.push(this.graph.serialize());
  }

  private rebuildSpatialIndex(): void {
    this.spatialIndex.clear();
    for (const node of this.graph.getAllNodes()) {
      this.spatialIndex.update(node);
    }
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

    // Draft connection
    if (this.isConnecting && this.connectionDraft) {
      const draft = this.connectionDraft;
      this.connectionRenderer.renderDraft(
        draft.startX,
        draft.startY,
        draft.currentX,
        draft.currentY,
        vpState,
        this.snapTarget !== null,
      );
    }

    // Box selection rectangle
    if (this.isBoxSelecting) {
      this.renderSelectionBox(ctx, vpState, dpr);
    }
  }

  private renderSelectionBox(
    ctx: CanvasRenderingContext2D,
    viewport: { x: number; y: number; zoom: number },
    dpr: number,
  ): void {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(viewport.x, viewport.y);
    ctx.scale(viewport.zoom, viewport.zoom);

    const x = Math.min(this.boxSelectStart.x, this.boxSelectEnd.x);
    const y = Math.min(this.boxSelectStart.y, this.boxSelectEnd.y);
    const w = Math.abs(this.boxSelectEnd.x - this.boxSelectStart.x);
    const h = Math.abs(this.boxSelectEnd.y - this.boxSelectStart.y);

    const color = this.config.theme?.selectionBoxColor ?? "rgba(74, 158, 255, 0.15)";
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "rgba(74, 158, 255, 0.6)";
    ctx.lineWidth = 1 / viewport.zoom;
    ctx.strokeRect(x, y, w, h);

    ctx.restore();
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

    // Header — fixed 24px height to match ConnectionRenderer.HEADER_HEIGHT
    const header = document.createElement("div");
    header.style.background = style?.headerColor ?? "#0f3460";
    header.style.height = "24px";
    header.style.lineHeight = "24px";
    header.style.padding = "0 8px";
    header.style.fontWeight = "600";
    header.style.fontSize = "11px";
    header.style.userSelect = "none";
    header.textContent = node.title ?? node.type;
    el.appendChild(header);

    const inputs = node.inputs ?? [];
    const outputs = node.outputs ?? [];
    const rowCount = Math.max(inputs.length, outputs.length);

    // Show standalone widget values for nodes with no inputs/outputs (e.g. Note)
    if (rowCount === 0 && node.widgets) {
      const values = Object.values(node.widgets).filter(
        (v) => v !== undefined && v !== null && v !== "",
      );
      if (values.length > 0) {
        const body = document.createElement("div");
        body.style.padding = "6px 8px";
        body.style.fontSize = "10px";
        body.style.whiteSpace = "pre-wrap";
        body.style.wordBreak = "break-word";
        body.style.color = "#ccc";
        body.textContent = values.map(String).join("\n");
        el.appendChild(body);
      }
      return;
    }

    if (rowCount === 0) return;

    const body = document.createElement("div");
    body.style.padding = "4px 8px";

    for (let i = 0; i < rowCount; i++) {
      const input = i < inputs.length ? inputs[i] : null;
      const output = i < outputs.length ? outputs[i] : null;

      const isWidgetOnly = input?.isWidget && input.link == null;

      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.justifyContent = "space-between";
      row.style.alignItems = "center";
      row.style.height = "18px";
      row.style.fontSize = "10px";
      row.style.gap = "8px";

      // Left side: input
      const left = document.createElement("span");
      left.style.whiteSpace = "nowrap";
      if (input && isWidgetOnly) {
        left.style.display = "flex";
        left.style.gap = "8px";
        left.style.flex = "1";
        left.style.justifyContent = "space-between";
        const label = document.createElement("span");
        label.style.color = "#888";
        label.textContent = input.name;
        const val = document.createElement("span");
        val.style.color = "#aad";
        val.style.overflow = "hidden";
        val.style.textOverflow = "ellipsis";
        val.style.maxWidth = "120px";
        val.textContent = node.widgets
          ? formatWidgetValue(node.widgets[input.name])
          : "";
        left.appendChild(label);
        left.appendChild(val);
      } else if (input) {
        left.textContent = `● ${input.name}`;
      }

      // Right side: output
      const right = document.createElement("span");
      right.style.whiteSpace = "nowrap";
      right.style.textAlign = "right";
      if (output) {
        right.textContent = `${output.name} ●`;
      }

      row.appendChild(left);
      row.appendChild(right);
      body.appendChild(row);
    }

    el.appendChild(body);
  }

  // ════════════════════════════════════════════════════════════════════
  // Slot hit detection
  // ════════════════════════════════════════════════════════════════════

  private hitTestSlot(graphX: number, graphY: number): SlotHit | null {
    // Query nearby nodes from spatial index
    const queryRect = {
      x: graphX - SLOT_HIT_RADIUS * 2,
      y: graphY - SLOT_HIT_RADIUS * 2,
      width: SLOT_HIT_RADIUS * 4,
      height: SLOT_HIT_RADIUS * 4,
    };
    const nearbyIds = this.spatialIndex.query(queryRect);

    let bestHit: SlotHit | null = null;
    let bestDist = SLOT_HIT_RADIUS;

    for (const nodeId of nearbyIds) {
      const node = this.graph.getNode(nodeId);
      if (!node) continue;

      const nodeW = node.size?.width ?? DEFAULT_NODE_WIDTH;

      // Check output slots (right edge)
      const outputs = node.outputs ?? [];
      for (let i = 0; i < outputs.length; i++) {
        const sx = node.position.x + nodeW;
        const sy = node.position.y + SLOT_START_Y + i * ROW_HEIGHT;
        const dist = Math.hypot(graphX - sx, graphY - sy);
        if (dist < bestDist) {
          bestDist = dist;
          bestHit = { nodeId, slotType: "output", slotIndex: i, x: sx, y: sy };
        }
      }

      // Check input slots (left edge) — skip widget-only inputs
      const inputs = node.inputs ?? [];
      for (let i = 0; i < inputs.length; i++) {
        const inp = inputs[i];
        if (inp.isWidget && inp.link == null) continue;
        const sx = node.position.x;
        const sy = node.position.y + SLOT_START_Y + i * ROW_HEIGHT;
        const dist = Math.hypot(graphX - sx, graphY - sy);
        if (dist < bestDist) {
          bestDist = dist;
          bestHit = { nodeId, slotType: "input", slotIndex: i, x: sx, y: sy };
        }
      }
    }

    return bestHit;
  }

  // ════════════════════════════════════════════════════════════════════
  // Clipboard
  // ════════════════════════════════════════════════════════════════════

  private copySelection(): void {
    if (this.selectedNodeIds.size === 0) return;

    const nodes: GraphNode[] = [];
    for (const id of this.selectedNodeIds) {
      const node = this.graph.getNode(id);
      if (node) nodes.push(structuredClone(node));
    }

    // Only include connections where both endpoints are selected
    const connections = this.graph
      .getAllConnections()
      .filter(
        (c) =>
          this.selectedNodeIds.has(c.sourceNodeId) &&
          this.selectedNodeIds.has(c.targetNodeId),
      )
      .map((c) => structuredClone(c));

    this.clipboard = { nodes, connections };
  }

  private pasteClipboard(): void {
    if (!this.clipboard || this.clipboard.nodes.length === 0) return;

    this.pushUndo();

    const idMap = new Map<string, string>();
    for (const node of this.clipboard.nodes) {
      idMap.set(node.id, crypto.randomUUID());
    }

    this.clearSelection();

    // Add nodes with new IDs and offset positions
    for (const orig of this.clipboard.nodes) {
      const newNode: GraphNode = {
        ...structuredClone(orig),
        id: idMap.get(orig.id)!,
        position: { x: orig.position.x + 30, y: orig.position.y + 30 },
      };
      this.graph.addNode(newNode);
      this.spatialIndex.update(newNode);
      this.selectNode(newNode.id);
      this.events.emit("node:add", { node: newNode });
    }

    // Add remapped connections
    for (const orig of this.clipboard.connections) {
      const newConn: GraphConnection = {
        id: crypto.randomUUID(),
        sourceNodeId: idMap.get(orig.sourceNodeId)!,
        sourceOutputIndex: orig.sourceOutputIndex,
        targetNodeId: idMap.get(orig.targetNodeId)!,
        targetInputIndex: orig.targetInputIndex,
      };
      this.graph.addConnection(newConn);
      this.events.emit("connection:add", { connection: newConn });
    }

    // Update clipboard positions so subsequent pastes cascade
    for (const node of this.clipboard.nodes) {
      node.position.x += 30;
      node.position.y += 30;
    }

    this.markDirty();
    this.events.emit("graph:change", { data: this.graph.serialize() });
  }

  // ════════════════════════════════════════════════════════════════════
  // Interaction handling
  // ════════════════════════════════════════════════════════════════════

  private onPointerDown = (e: PointerEvent): void => {
    if (this.config.readOnly) return;
    this.container.focus();

    // Convert to graph space for slot hit test
    const rect = this.container.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const graphPos = this.viewport.screenToGraph(screenX, screenY);

    // 1. Check for slot hit (connection creation / rewiring)
    const slotHit = this.hitTestSlot(graphPos.x, graphPos.y);
    if (slotHit && slotHit.slotType === "output") {
      // Drag from output → start new connection
      this.isConnecting = true;
      this.connectionDraft = {
        sourceNodeId: slotHit.nodeId,
        sourceOutputIndex: slotHit.slotIndex,
        startX: slotHit.x,
        startY: slotHit.y,
        currentX: graphPos.x,
        currentY: graphPos.y,
      };
      this.container.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (slotHit && slotHit.slotType === "input") {
      // Drag from connected input → disconnect and rewire from original source
      const existingConn = this.graph
        .getAllConnections()
        .find(
          (c) =>
            c.targetNodeId === slotHit.nodeId &&
            c.targetInputIndex === slotHit.slotIndex,
        );
      if (existingConn) {
        this.pushUndo();
        const sourceNode = this.graph.getNode(existingConn.sourceNodeId);
        const sourceW = sourceNode?.size?.width ?? DEFAULT_NODE_WIDTH;
        const startX = (sourceNode?.position.x ?? 0) + sourceW;
        const startY =
          (sourceNode?.position.y ?? 0) +
          SLOT_START_Y +
          existingConn.sourceOutputIndex * ROW_HEIGHT;

        this.graph.removeConnection(existingConn.id);
        this.events.emit("connection:remove", {
          connectionId: existingConn.id,
        });
        this.events.emit("graph:change", { data: this.graph.serialize() });

        this.isConnecting = true;
        this.connectionDraft = {
          sourceNodeId: existingConn.sourceNodeId,
          sourceOutputIndex: existingConn.sourceOutputIndex,
          startX,
          startY,
          currentX: graphPos.x,
          currentY: graphPos.y,
        };
        this.container.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
    }

    // 2. Check for node hit (dragging)
    const target = (e.target as HTMLElement).closest<HTMLDivElement>(
      "[data-node-id]",
    );

    if (target && target.dataset.nodeId) {
      const nodeId = target.dataset.nodeId;
      const node = this.graph.getNode(nodeId);
      if (!node) return;

      this.isDragging = true;
      this.dragNodeId = nodeId;
      this.dragStart = { x: e.clientX, y: e.clientY };

      if (!e.shiftKey) {
        if (!this.selectedNodeIds.has(nodeId)) {
          this.clearSelection();
        }
      }
      this.selectNode(nodeId);

      // Store start positions for all selected nodes (multi-drag)
      this.dragGroupStarts.clear();
      for (const id of this.selectedNodeIds) {
        const n = this.graph.getNode(id);
        if (n) this.dragGroupStarts.set(id, { ...n.position });
      }

      this.container.setPointerCapture(e.pointerId);
      e.preventDefault();
    } else {
      // 3. Empty space: box select (Ctrl) or pan
      if (e.ctrlKey || e.metaKey) {
        this.isBoxSelecting = true;
        this.boxSelectStart = graphPos;
        this.boxSelectEnd = graphPos;
        if (!e.shiftKey) this.clearSelection();
      } else {
        this.isPanning = true;
        this.clearSelection();
      }
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.container.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.isConnecting && this.connectionDraft) {
      const rect = this.container.getBoundingClientRect();
      const graphPos = this.viewport.screenToGraph(
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
      this.connectionDraft.currentX = graphPos.x;
      this.connectionDraft.currentY = graphPos.y;

      // Check for snap target
      const hit = this.hitTestSlot(graphPos.x, graphPos.y);
      if (
        hit &&
        hit.slotType === "input" &&
        this.graph.canConnect(
          this.connectionDraft.sourceNodeId,
          this.connectionDraft.sourceOutputIndex,
          hit.nodeId,
          hit.slotIndex,
        )
      ) {
        this.snapTarget = hit;
        this.connectionDraft.currentX = hit.x;
        this.connectionDraft.currentY = hit.y;
      } else {
        this.snapTarget = null;
      }

      this.markDirty();
    } else if (this.isDragging && this.dragNodeId) {
      const zoom = this.viewport.getState().zoom;
      const dx = (e.clientX - this.dragStart.x) / zoom;
      const dy = (e.clientY - this.dragStart.y) / zoom;

      // Move all selected nodes together
      for (const [id, startPos] of this.dragGroupStarts) {
        const newX = startPos.x + dx;
        const newY = startPos.y + dy;
        this.graph.updateNodePosition(id, newX, newY);
        const node = this.graph.getNode(id);
        if (node) this.spatialIndex.update(node);
      }

      this.markDirty();
    } else if (this.isBoxSelecting) {
      const rect = this.container.getBoundingClientRect();
      this.boxSelectEnd = this.viewport.screenToGraph(
        e.clientX - rect.left,
        e.clientY - rect.top,
      );

      // Select nodes within the box
      const minX = Math.min(this.boxSelectStart.x, this.boxSelectEnd.x);
      const minY = Math.min(this.boxSelectStart.y, this.boxSelectEnd.y);
      const maxX = Math.max(this.boxSelectStart.x, this.boxSelectEnd.x);
      const maxY = Math.max(this.boxSelectStart.y, this.boxSelectEnd.y);

      // Get candidates from spatial index, then filter to nodes actually inside the box
      const candidates = this.spatialIndex.query({
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      });
      const inBox = new Set<string>();
      for (const id of candidates) {
        const node = this.graph.getNode(id);
        if (!node) continue;
        const nw = node.size?.width ?? DEFAULT_NODE_WIDTH;
        const nh = node.size?.height ?? DEFAULT_NODE_HEIGHT;
        // Node must be fully or partially inside the selection box
        if (
          node.position.x + nw >= minX &&
          node.position.x <= maxX &&
          node.position.y + nh >= minY &&
          node.position.y <= maxY
        ) {
          inBox.add(id);
        }
      }

      // Update selection to match box contents
      for (const id of this.selectedNodeIds) {
        if (!inBox.has(id)) {
          this.selectedNodeIds.delete(id);
          const el = this.mountedNodes.get(id);
          if (el) el.classList.remove("tnc-node--selected");
          this.events.emit("node:deselect", { nodeId: id });
        }
      }
      for (const id of inBox) {
        if (!this.selectedNodeIds.has(id)) {
          this.selectNode(id);
        }
      }

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
    if (this.isConnecting && this.connectionDraft) {
      if (this.snapTarget) {
        this.pushUndo();
        const connection: GraphConnection = {
          id: crypto.randomUUID(),
          sourceNodeId: this.connectionDraft.sourceNodeId,
          sourceOutputIndex: this.connectionDraft.sourceOutputIndex,
          targetNodeId: this.snapTarget.nodeId,
          targetInputIndex: this.snapTarget.slotIndex,
        };
        this.graph.addConnection(connection);
        this.events.emit("connection:add", { connection });
        this.events.emit("graph:change", { data: this.graph.serialize() });
      }
      this.isConnecting = false;
      this.connectionDraft = null;
      this.snapTarget = null;
      this.markDirty();
    } else if (this.isDragging && this.dragNodeId) {
      // Push undo only if position actually changed
      const startPos = this.dragGroupStarts.get(this.dragNodeId);
      const node = this.graph.getNode(this.dragNodeId);
      if (
        node &&
        startPos &&
        (node.position.x !== startPos.x || node.position.y !== startPos.y)
      ) {
        this.pushUndo();
        for (const id of this.selectedNodeIds) {
          const n = this.graph.getNode(id);
          if (n) {
            this.events.emit("node:move", {
              nodeId: id,
              position: { ...n.position },
            });
          }
        }
        this.events.emit("graph:change", { data: this.graph.serialize() });
      }
    }

    this.isDragging = false;
    this.isPanning = false;
    this.isBoxSelecting = false;
    this.dragNodeId = null;
    this.dragGroupStarts.clear();
    this.container.releasePointerCapture(e.pointerId);
    this.markDirty();
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.container.getBoundingClientRect();
    this.viewport.zoomAt(
      e.clientX - rect.left,
      e.clientY - rect.top,
      e.deltaY,
    );
    this.markDirty();
    this.events.emit("viewport:change", this.viewport.getState());
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.config.readOnly) return;

    const ctrl = e.ctrlKey || e.metaKey;

    // Delete selected nodes
    if (e.key === "Delete" || e.key === "Backspace") {
      if (this.selectedNodeIds.size === 0) return;
      e.preventDefault();
      this.pushUndo();
      const ids = [...this.selectedNodeIds];
      for (const id of ids) {
        this.removeNode(id);
      }
      this.selectedNodeIds.clear();
      return;
    }

    // Undo
    if (ctrl && e.key === "z" && !e.shiftKey) {
      e.preventDefault();
      this.undo();
      return;
    }

    // Redo
    if (ctrl && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
      e.preventDefault();
      this.redo();
      return;
    }

    // Copy
    if (ctrl && e.key === "c") {
      e.preventDefault();
      this.copySelection();
      return;
    }

    // Paste
    if (ctrl && e.key === "v") {
      e.preventDefault();
      this.pasteClipboard();
      return;
    }

    // Cut
    if (ctrl && e.key === "x") {
      e.preventDefault();
      this.copySelection();
      if (this.selectedNodeIds.size > 0) {
        this.pushUndo();
        const ids = [...this.selectedNodeIds];
        for (const id of ids) {
          this.removeNode(id);
        }
        this.selectedNodeIds.clear();
      }
      return;
    }

    // Select all
    if (ctrl && e.key === "a") {
      e.preventDefault();
      for (const node of this.graph.getAllNodes()) {
        this.selectNode(node.id);
      }
      return;
    }
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
    this.container.addEventListener("keydown", this.onKeyDown);
  }

  private unbindEvents(): void {
    this.container.removeEventListener("pointerdown", this.onPointerDown);
    this.container.removeEventListener("pointermove", this.onPointerMove);
    this.container.removeEventListener("pointerup", this.onPointerUp);
    this.container.removeEventListener("wheel", this.onWheel);
    this.container.removeEventListener("keydown", this.onKeyDown);
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
