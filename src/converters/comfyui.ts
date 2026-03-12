/**
 * Converts between ComfyUI's native workflow JSON format and tealpug-node-canvas GraphData.
 *
 * ComfyUI native format (exported from the UI):
 * - nodes: array of objects with numeric id, type, pos: [x,y], size: {"0": w, "1": h},
 *   inputs: [{name, type, link}], outputs: [{name, type, links: [], slot_index}],
 *   widgets_values: any[]
 * - links: array of tuples [linkId, sourceNodeId, sourceSlot, targetNodeId, targetSlot, dataType]
 */

import type {
  GraphData,
  GraphNode,
  GraphConnection,
  NodeInput,
  NodeOutput,
} from "../types/index.js";

// -- ComfyUI native types ---------------------------------------------------

interface ComfyUIRawNode {
  id: number;
  type: string;
  pos: [number, number] | { "0": number; "1": number };
  size?: { "0": number; "1": number } | [number, number];
  flags?: Record<string, unknown>;
  order?: number;
  mode?: number;
  inputs?: {
    name: string;
    type: string;
    link: number | null;
    widget?: { name: string };
  }[];
  outputs?: {
    name: string;
    type: string;
    links: number[] | null;
    slot_index?: number;
  }[];
  title?: string;
  properties?: Record<string, unknown>;
  widgets_values?: unknown[] | Record<string, unknown>;
}

type ComfyUIRawLink = [
  linkId: number,
  sourceNodeId: number,
  sourceSlot: number,
  targetNodeId: number,
  targetSlot: number,
  dataType: string,
];

export interface ComfyUIRawWorkflow {
  last_node_id?: number;
  last_link_id?: number;
  nodes: ComfyUIRawNode[];
  links: ComfyUIRawLink[];
  groups?: unknown[];
  config?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  version?: number;
}

// -- Conversion --------------------------------------------------------------

function buildWidgets(n: ComfyUIRawNode): Record<string, unknown> | undefined {
  if (!n.widgets_values) return undefined;

  // If widgets_values is already an object (keyed by name), use it directly
  if (!Array.isArray(n.widgets_values)) {
    return n.widgets_values as Record<string, unknown>;
  }

  // Map array values to widget input names where possible
  const widgetInputNames = (n.inputs ?? [])
    .filter((inp) => inp.widget != null)
    .map((inp) => inp.widget!.name);

  if (widgetInputNames.length > 0) {
    const result: Record<string, unknown> = {};
    for (let i = 0; i < n.widgets_values.length; i++) {
      const key = i < widgetInputNames.length ? widgetInputNames[i] : String(i);
      result[key] = n.widgets_values[i];
    }
    return result;
  }

  // Fallback: numeric keys
  return Object.fromEntries(
    n.widgets_values.map((v, i) => [String(i), v]),
  );
}

export function comfyuiToGraphData(raw: ComfyUIRawWorkflow): GraphData {
  const nodes: GraphNode[] = raw.nodes.map((n) => {
    const inputs: NodeInput[] = (n.inputs ?? []).map((inp) => ({
      name: inp.name,
      type: inp.type,
      link: inp.link != null ? String(inp.link) : null,
      isWidget: inp.widget != null ? true : undefined,
    }));

    const outputs: NodeOutput[] = (n.outputs ?? []).map((out) => ({
      name: out.name,
      type: out.type,
      links: out.links?.map(String),
    }));

    return {
      id: String(n.id),
      type: n.type,
      title: n.title,
      position: Array.isArray(n.pos)
        ? { x: n.pos[0], y: n.pos[1] }
        : { x: n.pos["0"], y: n.pos["1"] },
      size: n.size
        ? Array.isArray(n.size)
          ? { width: n.size[0], height: n.size[1] }
          : { width: n.size["0"], height: n.size["1"] }
        : undefined,
      inputs,
      outputs,
      properties: n.properties,
      widgets: buildWidgets(n),
    };
  });

  const connections: GraphConnection[] = raw.links.map((link) => ({
    id: String(link[0]),
    sourceNodeId: String(link[1]),
    sourceOutputIndex: link[2],
    targetNodeId: String(link[3]),
    targetInputIndex: link[4],
  }));

  const metadata: Record<string, unknown> = {};
  if (raw.version != null) metadata.comfyuiVersion = raw.version;
  if (raw.extra) metadata.extra = raw.extra;
  if (raw.groups) metadata.groups = raw.groups;
  if (raw.config) metadata.config = raw.config;
  if (raw.last_node_id != null) metadata.last_node_id = raw.last_node_id;
  if (raw.last_link_id != null) metadata.last_link_id = raw.last_link_id;

  return {
    nodes,
    connections,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

export function graphDataToComfyUI(data: GraphData): ComfyUIRawWorkflow {
  let maxNodeId = 0;
  let maxLinkId = 0;

  const nodes: ComfyUIRawNode[] = data.nodes.map((n) => {
    const numId = Number(n.id);
    if (numId > maxNodeId) maxNodeId = numId;

    const result: ComfyUIRawNode = {
      id: numId,
      type: n.type,
      pos: [n.position.x, n.position.y],
    };

    if (n.size) {
      result.size = { "0": n.size.width, "1": n.size.height };
    }
    if (n.title) result.title = n.title;
    if (n.properties) result.properties = n.properties;

    if (n.inputs) {
      result.inputs = n.inputs.map((inp) => ({
        name: inp.name,
        type: inp.type,
        link: inp.link != null ? Number(inp.link) : null,
      }));
    }

    if (n.outputs) {
      result.outputs = n.outputs.map((out, idx) => ({
        name: out.name,
        type: out.type,
        links: out.links?.map(Number) ?? null,
        slot_index: idx,
      }));
    }

    if (n.widgets) {
      const keys = Object.keys(n.widgets);
      const allNumeric = keys.every((k) => /^\d+$/.test(k));
      if (allNumeric) {
        const entries = Object.entries(n.widgets).sort(
          ([a], [b]) => Number(a) - Number(b),
        );
        result.widgets_values = entries.map(([, v]) => v);
      } else {
        result.widgets_values = n.widgets as unknown as unknown[];
      }
    }

    return result;
  });

  const links: ComfyUIRawLink[] = data.connections.map((c) => {
    const linkId = Number(c.id);
    if (linkId > maxLinkId) maxLinkId = linkId;

    // Recover the dataType from the target node's input slot
    const targetNode = data.nodes.find((n) => n.id === c.targetNodeId);
    const dataType =
      targetNode?.inputs?.[c.targetInputIndex]?.type ?? "UNKNOWN";

    return [linkId, Number(c.sourceNodeId), c.sourceOutputIndex, Number(c.targetNodeId), c.targetInputIndex, dataType];
  });

  const result: ComfyUIRawWorkflow = {
    last_node_id: (data.metadata?.last_node_id as number) ?? maxNodeId,
    last_link_id: (data.metadata?.last_link_id as number) ?? maxLinkId,
    nodes,
    links,
    version: (data.metadata?.comfyuiVersion as number) ?? 1,
  };

  if (data.metadata?.groups) result.groups = data.metadata.groups as unknown[];
  if (data.metadata?.extra)
    result.extra = data.metadata.extra as Record<string, unknown>;
  if (data.metadata?.config)
    result.config = data.metadata.config as Record<string, unknown>;

  return result;
}
