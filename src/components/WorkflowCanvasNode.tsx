// One workflow node as it is drawn on the canvas, with every decision that
// depends on the run — tone, footer, and whether its handles may still be
// connected — made here, in a component that imports no xyflow.
//
// It exists so those decisions can be rendered flat in a test. Two of them
// were bugs found only by driving the real app:
//
//   * `isConnectable` must be FORWARDED to each handle. xyflow derives it
//     from `nodesConnectable` and hands it to the NODE, while `<Handle>`
//     defaults its own to `true` — so a read-only canvas that only set
//     `nodesConnectable={false}` still let a drag pull a new edge out of a
//     card. The canvas now injects its handle through `renderHandle`, and a
//     test renders a stub that echoes the flag it was given.
//   * A run action's answer belongs to the run AND node it was issued for;
//     `actionOn` is what decides that, and it is called here.
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { nodeTone } from "@/lib/workflow-observation";
import { actionOn, type WorkflowRunAction } from "@/lib/workflow-observe-mode";
import { WORKFLOW_TARGET_HANDLE, type WorkflowGraphNodeData } from "@/lib/workflow-graph";
import { WorkflowNodeCard, type WorkflowNodeCardProps } from "./WorkflowNodeCard";
import { WorkflowRunNodeFooter } from "./WorkflowRunNodeFooter";
import type { WorkflowRun } from "../../shared/workflow";

/** What the observation mode hands down to every card. The canvas passes it
 * through a context and not through node data on purpose: run state must
 * never enter the document ⇄ graph mapping, or a run frame would rebuild the
 * node array and un-measure the graph. `null` is the editor. */
export interface WorkflowObservation {
  run: WorkflowRun;
  /** The approve / reject / resume in flight, pinned to the run and node it
   * was issued for. */
  action: WorkflowRunAction | null;
  decide: (decision: "approved" | "rejected") => void;
  resume: () => void;
  openThread: (nodeId: string, threadId: string) => void;
}

/** Everything one handle needs, with no xyflow type in sight. The canvas
 * turns this into an actual `<Handle>`; a test turns it into an element that
 * simply reports what it was told. */
export interface WorkflowHandleSpec {
  key: string;
  side: "target" | "source";
  id: string;
  /** False whenever the canvas is read-only. Must reach the handle itself. */
  isConnectable: boolean;
  className: string;
}

export interface WorkflowCanvasNodeProps {
  data: WorkflowGraphNodeData;
  selected?: boolean;
  isConnectable?: boolean;
  bot?: WorkflowNodeCardProps["bot"];
  groupName?: string | null;
  observation?: WorkflowObservation | null;
  renderHandle: (spec: WorkflowHandleSpec) => ReactNode;
}

export function WorkflowCanvasNode({
  data,
  selected = false,
  isConnectable = true,
  bot,
  groupName,
  observation = null,
  renderHandle,
}: WorkflowCanvasNodeProps) {
  const { node } = data;
  const run = observation?.run ?? null;
  const acting = run ? actionOn(observation?.action, run.id, node.id) : null;

  return (
    <WorkflowNodeCard
      data={data}
      bot={bot}
      groupName={groupName}
      selected={selected}
      tone={nodeTone(run, node.id)}
      footer={
        observation && (
          <WorkflowRunNodeFooter
            run={observation.run}
            nodeId={node.id}
            busy={acting?.busy ?? false}
            error={acting?.error ?? null}
            onApprove={() => observation.decide("approved")}
            onReject={() => observation.decide("rejected")}
            onResume={observation.resume}
            onOpenThread={(threadId) => observation.openThread(node.id, threadId)}
          />
        )
      }
      renderTargetHandle={() =>
        renderHandle({
          key: WORKFLOW_TARGET_HANDLE,
          side: "target",
          id: WORKFLOW_TARGET_HANDLE,
          isConnectable,
          className: "wf-handle-target",
        })
      }
      renderSourceHandle={(handle) =>
        renderHandle({
          key: handle.outcome,
          side: "source",
          id: handle.outcome,
          isConnectable,
          className: cn("wf-handle-source", handle.implicit && "wf-handle-implicit"),
        })
      }
    />
  );
}
