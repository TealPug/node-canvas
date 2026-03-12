/**
 * Web Worker for off-main-thread graph layout computation.
 *
 * Currently implements a simple force-directed layout. Can be extended with
 * more sophisticated algorithms (Dagre, ELK-style layered layout, etc.).
 */

import type { GraphNode, GraphConnection, NodePosition } from "../types/index.js";

interface LayoutRequest {
  type: "layout";
  nodes: GraphNode[];
  connections: GraphConnection[];
  iterations?: number;
}

interface LayoutResponse {
  type: "layout:result";
  positions: Record<string, NodePosition>;
}

type WorkerMessage = LayoutRequest;
type WorkerResponse = LayoutResponse;

function forceDirectedLayout(
  nodes: GraphNode[],
  connections: GraphConnection[],
  iterations = 100,
): Record<string, NodePosition> {
  const positions = new Map<string, { x: number; y: number }>();

  // Initialize positions from current positions
  for (const node of nodes) {
    positions.set(node.id, { x: node.position.x, y: node.position.y });
  }

  const repulsionForce = 5000;
  const attractionForce = 0.01;
  const damping = 0.9;

  const velocities = new Map<string, { vx: number; vy: number }>();
  for (const node of nodes) {
    velocities.set(node.id, { vx: 0, vy: 0 });
  }

  for (let iter = 0; iter < iterations; iter++) {
    // Repulsion between all node pairs
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = positions.get(nodes[i].id)!;
        const b = positions.get(nodes[j].id)!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const force = repulsionForce / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        const va = velocities.get(nodes[i].id)!;
        const vb = velocities.get(nodes[j].id)!;
        va.vx -= fx;
        va.vy -= fy;
        vb.vx += fx;
        vb.vy += fy;
      }
    }

    // Attraction along connections
    for (const conn of connections) {
      const a = positions.get(conn.sourceNodeId);
      const b = positions.get(conn.targetNodeId);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const fx = dx * attractionForce;
      const fy = dy * attractionForce;

      const va = velocities.get(conn.sourceNodeId)!;
      const vb = velocities.get(conn.targetNodeId)!;
      va.vx += fx;
      va.vy += fy;
      vb.vx -= fx;
      vb.vy -= fy;
    }

    // Apply velocities with damping
    for (const node of nodes) {
      const pos = positions.get(node.id)!;
      const vel = velocities.get(node.id)!;
      vel.vx *= damping;
      vel.vy *= damping;
      pos.x += vel.vx;
      pos.y += vel.vy;
    }
  }

  const result: Record<string, NodePosition> = {};
  for (const [id, pos] of positions) {
    result[id] = { x: Math.round(pos.x), y: Math.round(pos.y) };
  }
  return result;
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;

  if (msg.type === "layout") {
    const positions = forceDirectedLayout(
      msg.nodes,
      msg.connections,
      msg.iterations,
    );
    const response: WorkerResponse = {
      type: "layout:result",
      positions,
    };
    self.postMessage(response);
  }
};
