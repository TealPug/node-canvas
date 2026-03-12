import type {
  GraphNode,
  GraphConnection,
  GraphData,
} from "../types/index.js";

/**
 * In-memory graph model. Stores nodes and connections as Maps for O(1) lookups.
 * This is the single source of truth for graph state.
 */
export class Graph {
  private nodes = new Map<string, GraphNode>();
  private connections = new Map<string, GraphConnection>();

  /** Index: nodeId → connection IDs that touch this node. */
  private nodeConnections = new Map<string, Set<string>>();

  // ── Bulk operations ────────────────────────────────────────────────

  load(data: GraphData): void {
    this.nodes.clear();
    this.connections.clear();
    this.nodeConnections.clear();

    for (const node of data.nodes) {
      this.nodes.set(node.id, node);
      this.nodeConnections.set(node.id, new Set());
    }
    for (const conn of data.connections) {
      this.connections.set(conn.id, conn);
      this.nodeConnections.get(conn.sourceNodeId)?.add(conn.id);
      this.nodeConnections.get(conn.targetNodeId)?.add(conn.id);
    }
  }

  serialize(): GraphData {
    return {
      nodes: Array.from(this.nodes.values()),
      connections: Array.from(this.connections.values()),
    };
  }

  // ── Node operations ────────────────────────────────────────────────

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  getAllNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
    if (!this.nodeConnections.has(node.id)) {
      this.nodeConnections.set(node.id, new Set());
    }
  }

  removeNode(id: string): GraphConnection[] {
    this.nodes.delete(id);
    const removed: GraphConnection[] = [];
    const connIds = this.nodeConnections.get(id);
    if (connIds) {
      for (const connId of connIds) {
        const conn = this.connections.get(connId);
        if (conn) {
          removed.push(conn);
          this.removeConnection(connId);
        }
      }
    }
    this.nodeConnections.delete(id);
    return removed;
  }

  updateNodePosition(id: string, x: number, y: number): void {
    const node = this.nodes.get(id);
    if (node) {
      node.position = { x, y };
    }
  }

  // ── Connection operations ──────────────────────────────────────────

  getConnection(id: string): GraphConnection | undefined {
    return this.connections.get(id);
  }

  getAllConnections(): GraphConnection[] {
    return Array.from(this.connections.values());
  }

  getConnectionsForNode(nodeId: string): GraphConnection[] {
    const ids = this.nodeConnections.get(nodeId);
    if (!ids) return [];
    const result: GraphConnection[] = [];
    for (const id of ids) {
      const conn = this.connections.get(id);
      if (conn) result.push(conn);
    }
    return result;
  }

  addConnection(conn: GraphConnection): void {
    this.connections.set(conn.id, conn);
    this.nodeConnections.get(conn.sourceNodeId)?.add(conn.id);
    this.nodeConnections.get(conn.targetNodeId)?.add(conn.id);
  }

  removeConnection(id: string): void {
    const conn = this.connections.get(id);
    if (!conn) return;
    this.nodeConnections.get(conn.sourceNodeId)?.delete(id);
    this.nodeConnections.get(conn.targetNodeId)?.delete(id);
    this.connections.delete(id);
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  get connectionCount(): number {
    return this.connections.size;
  }
}
