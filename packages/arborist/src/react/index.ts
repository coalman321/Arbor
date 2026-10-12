// Arborist's React views. Peer dependencies: react, react-dom and @xyflow/react; import
// "@coalman321/arborist/style.css" once.

export { ViewerContext, useViewer, type NodeMark, type ViewerContextValue } from "./context.ts";
export { BTNodeView, FrameView, WindowView, type BTFlowNode, type BTNodeData } from "./BTNodeView.tsx";
export { BTEdge, type BTEdgeData, type BTFlowEdge } from "./BTEdge.tsx";
export {
  boxesByPath,
  edgeTypes,
  flowEdges,
  flowNodes,
  nodeRect,
  nodeTypes,
  problemsByNode,
  type FlowEdgeOptions,
  type FlowNodeOptions,
  type Problem,
} from "./flow.ts";
export { TreeViewer, type TreeViewerHandle, type TreeViewerProps } from "./TreeViewer.tsx";
export { diffEdgeClass, diffLinesFor, diffMark } from "./diff.ts";
