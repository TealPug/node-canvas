# tealpug-node-canvas

A lightweight, high-performance node graph editor for the browser. Uses hybrid DOM + Canvas rendering to handle large workflows without bogging down the main thread.

- **DOM nodes** — each node is a styled `<div>`, giving you native text rendering, accessibility, and CSS `content-visibility` virtualization for free
- **Canvas connections** — bezier curves drawn on an HTML5 Canvas layer underneath, keeping connection rendering fast at scale
- **Spatial indexing** — only nodes visible in the viewport are mounted to the DOM
- **Web Worker layout** — graph layout algorithms run off the main thread
- **31 KB** bundled (6.7 KB gzipped), zero runtime dependencies

## Install

```bash
pnpm add tealpug-node-canvas
```

## Quick Start

### Vanilla JS

```js
import { NodeCanvas } from "tealpug-node-canvas";

const editor = new NodeCanvas(document.getElementById("editor"), {
  data: {
    nodes: [
      {
        id: "1",
        type: "KSampler",
        title: "KSampler",
        position: { x: 100, y: 100 },
        inputs: [{ name: "model", type: "MODEL" }, { name: "latent", type: "LATENT" }],
        outputs: [{ name: "LATENT", type: "LATENT" }],
      },
      {
        id: "2",
        type: "VAEDecode",
        title: "VAE Decode",
        position: { x: 450, y: 120 },
        inputs: [{ name: "samples", type: "LATENT" }],
        outputs: [{ name: "IMAGE", type: "IMAGE" }],
      },
    ],
    connections: [
      {
        id: "c1",
        sourceNodeId: "1",
        sourceOutputIndex: 0,
        targetNodeId: "2",
        targetInputIndex: 0,
      },
    ],
  },
});

editor.on("node:select", ({ nodeId }) => console.log("selected", nodeId));
editor.on("graph:change", ({ data }) => console.log("graph updated", data));
```

### React

```tsx
import { NodeCanvasReact } from "tealpug-node-canvas/react";

function WorkflowEditor({ data }) {
  return (
    <NodeCanvasReact
      data={data}
      config={{ readOnly: false }}
      style={{ width: "100%", height: 600 }}
      on={{
        "node:select": ({ nodeId }) => console.log(nodeId),
        "graph:change": ({ data }) => saveWorkflow(data),
      }}
    />
  );
}
```

### Custom Node Rendering

```js
const editor = new NodeCanvas(container, { data });

editor.renderNode = (node, element) => {
  element.innerHTML = `
    <div class="my-node-header">${node.title ?? node.type}</div>
    <div class="my-node-body">
      <img src="${node.properties?.preview}" />
    </div>
  `;
};
```

## API

### `NodeCanvas`

| Method | Description |
|---|---|
| `loadGraph(data)` | Load a full graph from a `GraphData` object |
| `getGraphData()` | Serialize current graph state |
| `addNode(node)` | Add a single node |
| `removeNode(nodeId)` | Remove a node and its connections |
| `addConnection(conn)` | Add a connection between two nodes |
| `removeConnection(id)` | Remove a connection |
| `autoLayout(iterations?)` | Run force-directed layout via Web Worker |
| `zoomToFit(padding?)` | Zoom/pan to fit all nodes in view |
| `on(event, handler)` | Subscribe to an event (returns unsubscribe fn) |
| `destroy()` | Tear down the editor and free resources |

### Events

| Event | Payload |
|---|---|
| `node:select` | `{ nodeId }` |
| `node:deselect` | `{ nodeId }` |
| `node:move` | `{ nodeId, position }` |
| `node:add` | `{ node }` |
| `node:remove` | `{ nodeId }` |
| `connection:add` | `{ connection }` |
| `connection:remove` | `{ connectionId }` |
| `viewport:change` | `{ x, y, zoom }` |
| `graph:change` | `{ data }` |

## Roadmap

### v0.1 — Foundation (current)
- [x] Hybrid DOM + Canvas rendering architecture
- [x] Pan, zoom, node drag interactions
- [x] Spatial index with viewport culling
- [x] Bezier connection rendering
- [x] Web Worker force-directed layout
- [x] React component wrapper
- [x] Typed event system

### v0.2 — Editing
- [ ] Interactive connection creation (drag from output to input)
- [ ] Connection snapping and validation (type-compatible slots only)
- [ ] Node deletion via keyboard (Delete/Backspace)
- [ ] Undo/redo stack
- [ ] Multi-node selection (Shift+click, box select)
- [ ] Copy/paste nodes

### v0.3 — Theming & Node Widgets
- [ ] Built-in widget renderers (text fields, dropdowns, sliders, checkboxes)
- [ ] ComfyUI node type registry with per-type rendering
- [ ] CSS custom properties for full theme control
- [ ] Dark/light theme presets
- [ ] Minimap overlay

### v0.4 — Performance at Scale
- [ ] OffscreenCanvas for connection rendering on a worker thread
- [ ] WebGPU renderer path for 1000+ node graphs
- [ ] Level-of-detail rendering (simplified nodes when zoomed out)
- [ ] Virtualized slot lists for nodes with many inputs/outputs

### v0.5 — Diff & Version Control
- [ ] Side-by-side diff view (added/removed/modified nodes)
- [ ] Inline diff overlay on a single graph
- [ ] Merge conflict visualization
- [ ] Animation between workflow versions

### Future
- [ ] WASM layout engine (Rust) for heavy graphs
- [ ] Collaborative editing via CRDT
- [ ] Keyboard-driven node search and insertion
- [ ] Accessibility (ARIA roles, screen reader support, keyboard navigation)
- [ ] Vue and Svelte component wrappers

## Development

```bash
pnpm install
pnpm dev          # watch mode
pnpm build        # production build
pnpm typecheck    # type check without emitting
pnpm test         # run tests
```

## License

MIT
