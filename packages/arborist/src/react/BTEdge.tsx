import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from "@xyflow/react";
import { memo } from "react";
import { nodeStatus, statusClass } from "../status.ts";
import { useViewer } from "./context.ts";

export type BTEdgeData = {
  childPath: string;
  childTree: string;
  childUid: string;
  liveMain: boolean;
  label?: string;
  /** Longer explanation of the label, shown on hover. */
  help?: string;
  dir: "TB" | "LR";
  bus?: number;
  /** Extra CSS classes for the edge, e.g. diff-added. */
  className?: string;
};

export type BTFlowEdge = Edge<BTEdgeData, "bt">;

function BTEdgeImpl(props: EdgeProps<Edge<BTEdgeData>>) {
  const { data } = props;
  const info = useViewer().useStatuses((s) => (data ? nodeStatus(s, data.childPath, data.childTree, data.childUid, data.liveMain) : undefined));
  // Turn on the row's shared bus line rather than halfway down this edge (see LayoutItem.edgeBus).
  const bus = data?.bus;
  const [path] = getSmoothStepPath({
    ...props,
    borderRadius: 10,
    ...(bus === undefined ? {} : data?.dir === "LR" ? { centerX: bus } : { centerY: bus }),
  });
  const status = [statusClass(info), data?.className ?? ""].join(" ");
  // Labels sit just above (or, left-right, just before) the child they lead to.
  const lr = data?.dir === "LR";
  return (
    <>
      <BaseEdge path={path} className={`bt-edge ${status}`} />
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            className={`bt-edge-label nodrag nopan ${status}`}
            title={data.help}
            style={{
              transform: lr
                ? `translate(-100%, -100%) translate(${props.targetX - 8}px, ${props.targetY - 3}px)`
                : `translate(-50%, -100%) translate(${props.targetX}px, ${props.targetY - 5}px)`,
            }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const BTEdge = memo(BTEdgeImpl);
