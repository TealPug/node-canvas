/**
 * Core graph data types for tealpug-node-canvas.
 *
 * These types define the serializable graph structure. They are designed to be
 * compatible with ComfyUI workflow JSON but generic enough for any node graph.
 */

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

export interface NodeSlot {
  name: string;
  type: string;
  /** Optional link ID currently connected to this slot. */
  link?: string | null;
}

export interface NodeInput extends NodeSlot {}

export interface NodeOutput extends NodeSlot {
  /** A single output can fan out to multiple links. */
  links?: string[];
}

export interface NodePosition {
  x: number;
  y: number;
}

export interface NodeSize {
  width: number;
  height: number;
}

export interface GraphNode {
  id: string;
  type: string;
  title?: string;
  position: NodePosition;
  size?: NodeSize;
  inputs?: NodeInput[];
  outputs?: NodeOutput[];
  properties?: Record<string, unknown>;
  /** Arbitrary widget values (e.g. sampler settings, seeds). */
  widgets?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Connection (edge)
// ---------------------------------------------------------------------------

export interface GraphConnection {
  id: string;
  sourceNodeId: string;
  sourceOutputIndex: number;
  targetNodeId: string;
  targetInputIndex: number;
}

// ---------------------------------------------------------------------------
// Graph (top-level)
// ---------------------------------------------------------------------------

export interface GraphData {
  nodes: GraphNode[];
  connections: GraphConnection[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Visual / theme
// ---------------------------------------------------------------------------

export interface NodeStyle {
  headerColor?: string;
  bodyColor?: string;
  borderColor?: string;
  selectedBorderColor?: string;
  textColor?: string;
  borderRadius?: number;
  headerHeight?: number;
  slotRadius?: number;
}

export interface ConnectionStyle {
  color?: string;
  selectedColor?: string;
  width?: number;
  /** Curvature amount for bezier connections (0 = straight line). */
  curvature?: number;
}

export interface ThemeConfig {
  background?: string;
  gridColor?: string;
  gridSize?: number;
  selectionBoxColor?: string;
  node?: NodeStyle;
  connection?: ConnectionStyle;
}

// ---------------------------------------------------------------------------
// Editor configuration
// ---------------------------------------------------------------------------

export interface EditorConfig {
  /** Initial graph data to load. */
  data?: GraphData;
  /** Visual theme overrides. */
  theme?: ThemeConfig;
  /** Whether the graph is read-only (no editing interactions). */
  readOnly?: boolean;
  /** Minimum zoom level (default 0.1). */
  minZoom?: number;
  /** Maximum zoom level (default 5). */
  maxZoom?: number;
  /** Enable Web Worker for layout computation (default true). */
  useWorker?: boolean;
}

// ---------------------------------------------------------------------------
// Events emitted by the editor
// ---------------------------------------------------------------------------

export type EditorEventMap = {
  "node:select": { nodeId: string };
  "node:deselect": { nodeId: string };
  "node:move": { nodeId: string; position: NodePosition };
  "node:add": { node: GraphNode };
  "node:remove": { nodeId: string };
  "connection:add": { connection: GraphConnection };
  "connection:remove": { connectionId: string };
  "viewport:change": { x: number; y: number; zoom: number };
  "graph:change": { data: GraphData };
};

export type EditorEventType = keyof EditorEventMap;
export type EditorEventHandler<T extends EditorEventType> = (
  payload: EditorEventMap[T],
) => void;
