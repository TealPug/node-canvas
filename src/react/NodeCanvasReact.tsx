import { useRef, useEffect } from "react";
import type {
  EditorConfig,
  GraphData,
  GraphNode,
  EditorEventType,
  EditorEventMap,
} from "../types/index.js";
import { NodeCanvas } from "../core/NodeCanvas.js";

export interface NodeCanvasReactProps {
  /** Graph data to display. When this changes the graph is reloaded. */
  data?: GraphData;
  /** Editor configuration (theme, read-only, zoom limits, etc.). */
  config?: Omit<EditorConfig, "data">;
  /** Custom node renderer. */
  renderNode?: (node: GraphNode, element: HTMLDivElement) => void;
  /** CSS class name for the container. */
  className?: string;
  /** Inline styles for the container. */
  style?: React.CSSProperties;
  /** Event callbacks keyed by event type. */
  on?: {
    [K in EditorEventType]?: (payload: EditorEventMap[K]) => void;
  };
}

/**
 * React component wrapper for tealpug-node-canvas.
 *
 * @example
 * ```tsx
 * <NodeCanvasReact
 *   data={workflowData}
 *   config={{ readOnly: true }}
 *   style={{ width: "100%", height: 600 }}
 *   on={{ "node:select": ({ nodeId }) => console.log(nodeId) }}
 * />
 * ```
 */
export function NodeCanvasReact({
  data,
  config,
  renderNode,
  className,
  style,
  on,
}: NodeCanvasReactProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<NodeCanvas | null>(null);

  // Initialize editor
  useEffect(() => {
    if (!containerRef.current) return;

    const editor = new NodeCanvas(containerRef.current, {
      ...config,
      data,
    });

    if (renderNode) {
      editor.renderNode = renderNode;
    }

    editorRef.current = editor;

    return () => {
      editor.destroy();
      editorRef.current = null;
    };
    // Only re-create on mount/unmount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload data when it changes
  useEffect(() => {
    if (data && editorRef.current) {
      editorRef.current.loadGraph(data);
    }
  }, [data]);

  // Bind event listeners
  useEffect(() => {
    if (!editorRef.current || !on) return;

    const unsubs: (() => void)[] = [];
    for (const [type, handler] of Object.entries(on)) {
      if (handler) {
        unsubs.push(
          editorRef.current.on(type as EditorEventType, handler as never),
        );
      }
    }

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [on]);

  // Update renderNode callback
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.renderNode = renderNode ?? null;
    }
  }, [renderNode]);

  return <div ref={containerRef} className={className} style={style} />;
}
