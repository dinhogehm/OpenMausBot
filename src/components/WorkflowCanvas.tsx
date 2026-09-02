// The workflow editor: a node graph over the shared `Workflow` document.
//
// One rule shapes the whole file — the local document is the single source of
// truth while it is dirty, and every edit is a pure call into
// `@/lib/workflow-graph`. Validation runs on that local document with the
// same `validateWorkflow` the server uses, so the badges never drift from
// what a save would report. Drafts are saveable by design: the PATCH goes out
// even when the graph is broken, and only running is gated.
//
// A later observation mode decorates this without a rewrite: node visuals are
// driven entirely by `WorkflowNodeCard` props (`tone`, `footer`), and the
// document ⇄ graph mapping knows nothing about editing.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  Check,
  CircleAlert,
  Loader2,
  MessageSquare,
  Play,
  Plus,
  ShieldQuestion,
  Trash2,
  UserRound,
  X,
} from "lucide-react";

import "@xyflow/react/dist/base.css";
import "./workflow-canvas.css";

import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { validationSummary, type WorkflowListItem } from "@/lib/workflow-state";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { WorkflowNodeCard } from "./WorkflowNodeCard";
import { WorkflowNodePanel, type WorkflowPanelBot } from "./WorkflowNodePanel";
import {
  WORKFLOW_NODE_TYPE,
  WORKFLOW_TARGET_HANDLE,
  addOutcome,
  connectEdge,
  connectionToWorkflowEdge,
  createWorkflowNode,
  documentIssues,
  findEdgeByGraphId,
  insertNode,
  issuesByNode,
  moveNodes,
  nextFreePosition,
  nextNodeId,
  reconcileGraphNodes,
  removeEdges,
  removeNodes,
  removeOutcome,
  renameOutcome,
  setEntryNode,
  toGraphEdges,
  toGraphNodes,
  updateNode,
  workflowPatchBody,
  type WorkflowGraphNode,
  type WorkflowGraphNodeData,
  type WorkflowNodeKind,
  type XY,
} from "@/lib/workflow-graph";
import {
  WORKFLOW_SCHEDULE_TIME_RE,
  validateWorkflow,
  type Workflow,
  type WorkflowSchedule,
  type WorkflowTriggers,
} from "../../shared/workflow";

/** Structural edits settle quickly; a drag is layout noise nobody is waiting
 * for, so it waits longer and rides along with the next real edit. */
const SAVE_DEBOUNCE_MS = { structure: 600, layout: 1_200 } as const;
type SaveKind = keyof typeof SAVE_DEBOUNCE_MS;

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** The store row carries server-computed issues; the document the canvas
 * edits (and PATCHes) must not. */
function toDocument(row: WorkflowListItem): Workflow {
  const { issues: _issues, ...definition } = row;
  return definition;
}

const NODE_KIND_META: Record<WorkflowNodeKind, { label: string; icon: typeof UserRound }> = {
  agent: { label: "Agent", icon: UserRound },
  approval: { label: "Approval", icon: ShieldQuestion },
  notify: { label: "Notify", icon: MessageSquare },
};

// ── the custom node ───────────────────────────────────────────────────
type WorkflowFlowNode = Node<WorkflowGraphNodeData, typeof WORKFLOW_NODE_TYPE>;

/** Resolves its own roster references so the mapping stays pure and a bot
 * rename repaints the card without rebuilding the graph. */
function WorkflowFlowNodeRenderer({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const { state } = useStore();
  const { node } = data;
  const bot = node.kind === "agent" ? (state.bots.find((candidate) => candidate.id === node.botId) ?? null) : null;
  const groupName =
    node.kind === "notify"
      ? (state.groups.find((group) => group.id === node.targetGroupId)?.name ?? null)
      : null;

  return (
    <WorkflowNodeCard
      data={data}
      bot={bot}
      groupName={groupName}
      selected={selected}
      renderTargetHandle={() => (
        <Handle type="target" position={Position.Left} id={WORKFLOW_TARGET_HANDLE} className="wf-handle-target" />
      )}
      renderSourceHandle={(handle) => (
        <Handle
          key={handle.outcome}
          type="source"
          position={Position.Right}
          id={handle.outcome}
          className={cn("wf-handle-source", handle.implicit && "wf-handle-implicit")}
        />
      )}
    />
  );
}

const NODE_TYPES: NodeTypes = { [WORKFLOW_NODE_TYPE]: WorkflowFlowNodeRenderer };

const EDGE_DEFAULTS = {
  type: "smoothstep",
  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
} as const;

// ── the schedule editor ───────────────────────────────────────────────
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function toLocalInput(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Writes `triggers.schedule`. Every candidate goes through the shared
 * validator's `bad-schedule` rule first: the API refuses a malformed schedule
 * at the door, so an unarmable one must never reach the debounced save. */
function TriggersPanel({
  workflow,
  onChange,
  onClose,
}: {
  workflow: Workflow;
  onChange: (triggers: WorkflowTriggers | undefined) => void;
  onClose: () => void;
}) {
  const schedule = workflow.triggers?.schedule;
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Escape closes the popover the way it closes every other overlay here; a
  // panel that only the mouse can dismiss is a keyboard trap.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const commit = (next: WorkflowSchedule | undefined) => {
    const triggers = next ? { schedule: next } : undefined;
    const bad = validateWorkflow({ ...workflow, triggers }).find((issue) => issue.code === "bad-schedule");
    if (bad) {
      setError(bad.message);
      return;
    }
    setError(null);
    onChange(triggers);
  };

  const setMode = (mode: "none" | "daily" | "once") => {
    if (mode === "none") commit(undefined);
    else if (mode === "daily") commit({ type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] });
    else commit({ type: "once", at: Date.now() + 60 * 60_000 });
  };

  const mode = schedule?.type ?? "none";

  return (
    <div className="absolute right-0 top-full z-30 mt-2 w-[320px] rounded-2xl border border-hairline/50 bg-panel p-4 shadow-2xl">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-ink">Schedule</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close schedule editor"
          className="rounded-lg p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={14} />
        </button>
      </div>

      <div className="mt-3 flex items-center gap-1 rounded-lg border border-hairline/50 p-0.5">
        {(["none", "daily", "once"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={mode === option}
            onClick={() => setMode(option)}
            className={cn(
              "flex-1 rounded-md px-2 py-1 text-[11.5px] font-medium capitalize",
              mode === option ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink",
            )}
          >
            {option === "none" ? "Manual" : option}
          </button>
        ))}
      </div>

      {schedule?.type === "daily" && (
        <div className="mt-3 space-y-2.5">
          <div>
            <label className="block text-[11px] font-medium text-ink-secondary" htmlFor="wf-schedule-time">
              Time
            </label>
            <input
              id="wf-schedule-time"
              type="time"
              value={schedule.time}
              onChange={(event) => {
                const time = event.target.value;
                if (!WORKFLOW_SCHEDULE_TIME_RE.test(time)) {
                  setError("Schedule time must be HH:MM (24-hour).");
                  return;
                }
                commit({ ...schedule, time });
              }}
              className="mt-1 w-full rounded-lg border border-hairline/50 bg-inset px-2.5 py-1.5 text-[12.5px] tabular-nums text-ink outline-none focus:border-accent"
            />
          </div>
          <div>
            <span className="block text-[11px] font-medium text-ink-secondary">Days</span>
            <div className="mt-1 flex gap-1">
              {WEEKDAYS.map((label, day) => {
                const on = schedule.weekdays.includes(day);
                return (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={on}
                    aria-label={label}
                    onClick={() =>
                      commit({
                        ...schedule,
                        weekdays: on
                          ? schedule.weekdays.filter((value) => value !== day)
                          : [...schedule.weekdays, day].sort((a, b) => a - b),
                      })
                    }
                    className={cn(
                      "size-8 rounded-lg text-[10.5px] font-medium",
                      on ? "bg-accent text-accent-ink" : "border border-hairline/50 text-ink-secondary hover:bg-raised",
                    )}
                  >
                    {label.slice(0, 1)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {schedule?.type === "once" && (
        <div className="mt-3">
          <label className="block text-[11px] font-medium text-ink-secondary" htmlFor="wf-schedule-at">
            Runs at
          </label>
          <input
            id="wf-schedule-at"
            type="datetime-local"
            value={toLocalInput(schedule.at)}
            onChange={(event) => {
              const at = new Date(event.target.value).getTime();
              if (!Number.isFinite(at)) {
                setError("A one-time schedule needs a finite timestamp.");
                return;
              }
              commit({ type: "once", at });
            }}
            className="mt-1 w-full rounded-lg border border-hairline/50 bg-inset px-2.5 py-1.5 text-[12.5px] tabular-nums text-ink outline-none focus:border-accent"
          />
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[11.5px] text-danger">
          {error}
        </p>
      )}

      <p className="mt-3 border-t border-hairline/40 pt-2.5 text-[11px] leading-relaxed text-ink-secondary">
        Webhook triggers live with the webhook itself — add one under Calendar → Webhooks and point it at this
        workflow.
      </p>
    </div>
  );
}

// ── the editor ────────────────────────────────────────────────────────
export interface WorkflowCanvasProps {
  workflow: WorkflowListItem;
  onBack: () => void;
}

function WorkflowCanvasInner({ workflow: row, onBack }: WorkflowCanvasProps) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const { screenToFlowPosition } = useReactFlow();
  const paneRef = useRef<HTMLDivElement>(null);

  const [doc, setDoc] = useState<Workflow>(() => toDocument(row));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"clean" | "dirty" | "saving" | "saved" | "error">("clean");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  /** A half-typed (or momentarily empty) name the document must not adopt. */
  const [nameDraft, setNameDraft] = useState<string | null>(null);

  // The document is owned locally while it is dirty; refs carry the pieces
  // the debounced save and the unmount flush need without re-subscribing.
  const docRef = useRef(doc);
  docRef.current = doc;
  const dirtyRef = useRef(false);
  /** A drag moved something since the last drop; armed by the position
   * frames, disarmed by the drop that saves them. */
  const draggedRef = useRef(false);
  const revisionRef = useRef(0);
  const savingRef = useRef(false);
  const resaveRef = useRef(false);
  const aliveRef = useRef(true);
  const timerRef = useRef<number | null>(null);
  const pendingKindRef = useRef<SaveKind | null>(null);
  const workflowId = row.id;

  const bots = useMemo<WorkflowPanelBot[]>(
    () => state.bots.filter((bot) => !bot.hidden).map(({ id, name, color, avatarUrl, avatarCrop, mascotBody }) => ({
      id,
      name,
      color,
      avatarUrl,
      avatarCrop,
      mascotBody,
    })),
    [state.bots],
  );
  const groups = useMemo(() => state.groups.map(({ id, name }) => ({ id, name })), [state.groups]);

  // The same validator the server runs, on the document as it stands right
  // now — that is what keeps a badge from lying between two saves.
  const issues = useMemo(() => validateWorkflow(doc), [doc]);
  const { errors, warnings } = validationSummary(issues);
  const headerIssues = useMemo(() => documentIssues(issues), [issues]);
  const nodeIssues = useMemo(() => issuesByNode(issues), [issues]);
  // xyflow re-reads a node's measured size off object identity, so an array
  // of fresh objects on every keystroke un-measures the graph and hides it
  // for a frame. Reconciling identity is what keeps the canvas from blinking.
  const graphNodesRef = useRef<WorkflowGraphNode[]>([]);
  /** What xyflow last measured each card to be, kept from its own `dimensions`
   * changes — the controlled equivalent of what `applyNodeChanges` stores. */
  const measuredRef = useRef(new Map<string, { width: number; height: number }>());
  const nodes = useMemo(() => {
    const mapped = toGraphNodes(doc, issues, selectedNodeId).map((node) => {
      // A node the mapping had to rebuild (it moved, or an issue changed)
      // would otherwise arrive unmeasured, which xyflow renders hidden until
      // its observer fires again — and refuses to drag in the meantime.
      const measured = measuredRef.current.get(node.id);
      return measured ? { ...node, measured } : node;
    });
    graphNodesRef.current = reconcileGraphNodes(graphNodesRef.current, mapped);
    return graphNodesRef.current;
  }, [doc, issues, selectedNodeId]);
  const edges = useMemo(() => toGraphEdges(doc, selectedEdgeId), [doc, selectedEdgeId]);
  const selectedNode = doc.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = selectedEdgeId ? findEdgeByGraphId(doc, selectedEdgeId) : null;

  const save = useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingKindRef.current = null;
    // One PATCH at a time: a second one queues behind the first rather than
    // racing it, so the server's last write is always the newest document.
    if (savingRef.current) {
      resaveRef.current = true;
      return;
    }
    const revision = revisionRef.current;
    savingRef.current = true;
    setSaveState("saving");
    try {
      const { workflow } = await api(`/api/workflows/${workflowId}`, {
        method: "PATCH",
        body: JSON.stringify(workflowPatchBody(docRef.current)),
      });
      // The response carries the saved definition AND its fresh issues; the
      // store adopts it so the list badge and the canvas agree.
      if (workflow) dispatch({ type: "workflowPatched", workflow });
      if (!aliveRef.current) return;
      if (revisionRef.current === revision) dirtyRef.current = false;
      setSaveError(null);
      setSaveState(revisionRef.current === revision ? "saved" : "dirty");
    } catch (cause) {
      if (!aliveRef.current) return;
      setSaveError(errorText(cause));
      setSaveState("error");
    } finally {
      savingRef.current = false;
      if (resaveRef.current && aliveRef.current) {
        resaveRef.current = false;
        void save();
      }
    }
  }, [workflowId, dispatch]);

  const schedule = useCallback(
    (kind: SaveKind) => {
      // A structural edit pulls the whole pending batch forward: layout noise
      // must never hold a real change hostage.
      pendingKindRef.current = pendingKindRef.current === "structure" ? "structure" : kind;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => void save(), SAVE_DEBOUNCE_MS[pendingKindRef.current]);
    },
    [save],
  );

  /** Every edit funnels through here: pure change in, one save schedule out.
   * A change that returns the same document schedules nothing. */
  const commit = useCallback(
    (change: (current: Workflow) => Workflow, kind: SaveKind = "structure") => {
      const next = change(docRef.current);
      if (next === docRef.current) return;
      docRef.current = next;
      dirtyRef.current = true;
      revisionRef.current += 1;
      setDoc(next);
      setSaveState("dirty");
      schedule(kind);
    },
    [schedule],
  );

  // A server frame is adopted only while nothing local is outstanding —
  // otherwise a live SSE update would silently undo what is being typed.
  useEffect(() => {
    if (dirtyRef.current || savingRef.current) return;
    setDoc(toDocument(row));
  }, [row]);

  // Leaving the canvas must not drop a debounced edit. The flush is
  // fire-and-forget by necessity (the component is gone), so a failure is
  // reported through the app-level error banner rather than swallowed.
  useEffect(
    () => () => {
      aliveRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (!dirtyRef.current) return;
      void api(`/api/workflows/${workflowId}`, {
        method: "PATCH",
        body: JSON.stringify(workflowPatchBody(docRef.current)),
      }).catch((cause: unknown) => {
        dispatch({ type: "error", message: `Workflow not saved: ${errorText(cause)}` });
      });
    },
    [workflowId, dispatch],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<WorkflowFlowNode>[]) => {
      const moved: Record<string, XY> = {};
      const removed: string[] = [];
      let settled = false;
      let picked: string | null | undefined;
      for (const change of changes) {
        if (change.type === "position") {
          if (change.position) moved[change.id] = change.position;
          if (!change.dragging) settled = true;
        } else if (change.type === "dimensions") {
          if (change.dimensions) measuredRef.current.set(change.id, change.dimensions);
        } else if (change.type === "remove") {
          measuredRef.current.delete(change.id);
          removed.push(change.id);
        } else if (change.type === "select") {
          if (change.selected) picked = change.id;
          else if (picked === undefined) picked = null;
        }
      }
      if (picked !== undefined) {
        setSelectedNodeId(picked);
        if (picked !== null) setSelectedEdgeId(null);
      }
      if (Object.keys(moved).length > 0) {
        // Mid-drag frames move the document without arming a save; the drop
        // is what schedules one, so a whole drag costs a single PATCH.
        const next = moveNodes(docRef.current, moved);
        if (next !== docRef.current) {
          docRef.current = next;
          dirtyRef.current = true;
          draggedRef.current = true;
          revisionRef.current += 1;
          setDoc(next);
        }
      }
      // The drop's own change carries `dragging: false` and no position, so
      // the save cannot be armed inside the branch above — it would never run.
      if (settled && draggedRef.current) {
        draggedRef.current = false;
        setSaveState("dirty");
        schedule("layout");
      }
      if (removed.length > 0) {
        if (selectedNodeId && removed.includes(selectedNodeId)) setSelectedNodeId(null);
        commit((current) => removeNodes(current, removed));
      }
    },
    [commit, schedule, selectedNodeId],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      let picked: string | null | undefined;
      const removed: string[] = [];
      for (const change of changes) {
        if (change.type === "remove") removed.push(change.id);
        else if (change.type === "select") {
          if (change.selected) picked = change.id;
          else if (picked === undefined) picked = null;
        }
      }
      if (picked !== undefined) {
        setSelectedEdgeId(picked);
        if (picked !== null) setSelectedNodeId(null);
      }
      if (removed.length > 0) {
        if (selectedEdgeId && removed.includes(selectedEdgeId)) setSelectedEdgeId(null);
        commit((current) => {
          const doomed = removed.map((id) => findEdgeByGraphId(current, id)).filter((edge) => edge !== null);
          return removeEdges(current, doomed);
        });
      }
    },
    [commit, selectedEdgeId],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const edge = connectionToWorkflowEdge(connection);
      if (!edge) return;
      commit((current) => connectEdge(current, edge));
    },
    [commit],
  );

  const addNode = (kind: WorkflowNodeKind) => {
    const id = nextNodeId(docRef.current, kind);
    const node = createWorkflowNode(kind, id, { botId: bots[0]?.id, targetGroupId: groups[0]?.id });
    if (!node) return;
    const rect = paneRef.current?.getBoundingClientRect();
    const preferred = rect
      ? screenToFlowPosition({ x: rect.left + rect.width / 2 - 120, y: rect.top + rect.height / 3 })
      : { x: 80, y: 80 };
    commit((current) => insertNode(current, node, nextFreePosition(current, preferred)));
    setSelectedEdgeId(null);
    setSelectedNodeId(id);
  };

  const runBlockedReason =
    errors > 0
      ? `Fix ${errors} ${errors === 1 ? "error" : "errors"} before running`
      : running
        ? "A run is already starting"
        : null;

  const run = async () => {
    setRunning(true);
    setRunError(null);
    try {
      // The debounced document must reach the server before the run reads it.
      if (dirtyRef.current || timerRef.current !== null) await save();
      const { run: started } = await api(`/api/workflows/${workflowId}/runs`, { method: "POST", body: "{}" });
      if (started) dispatch({ type: "workflowRunPatched", run: started });
    } catch (cause) {
      setRunError(errorText(cause));
    } finally {
      setRunning(false);
    }
  };

  const macInset = capabilities.windowChrome === "mac-inset";
  const windowDragStyle = macInset ? ({ WebkitAppRegion: "drag" } as CSSProperties) : undefined;
  // The canvas surface itself must opt out, or dragging empty space moves the
  // OS window instead of panning the graph.
  const windowNoDragStyle = macInset ? ({ WebkitAppRegion: "no-drag" } as CSSProperties) : undefined;

  const saveLabel =
    saveState === "saving"
      ? "Saving…"
      : saveState === "error"
        ? "Save failed"
        : saveState === "dirty"
          ? "Unsaved changes"
          : "Saved";

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app text-ink">
      <header
        className={cn("shrink-0 border-b border-hairline/40 bg-app py-3 pr-4", macInset ? "pl-[86px]" : "pl-4")}
        style={windowDragStyle}
      >
        <div className="flex flex-wrap items-center gap-2" style={windowNoDragStyle}>
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to workflows"
            title="Back to workflows"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <ArrowLeft size={18} />
          </button>
          {/* The API refuses a blank name, so an empty field stays a local
              draft and never reaches the document — otherwise select-all-and-
              retype would fire a 400 halfway through the word. */}
          <input
            value={nameDraft ?? doc.name}
            maxLength={120}
            aria-label="Workflow name"
            onChange={(event) => {
              const next = event.target.value;
              setNameDraft(next);
              if (next.trim()) commit((current) => ({ ...current, name: next }));
            }}
            onBlur={() => setNameDraft(null)}
            className="min-w-[160px] max-w-[300px] flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-[16px] font-semibold text-ink outline-none hover:border-hairline/50 focus:border-accent focus:bg-inset"
          />

          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
              saveState === "error" ? "bg-danger/15 text-danger" : "bg-control text-ink-secondary",
            )}
          >
            {saveState === "saving" ? (
              <Loader2 size={11} className="animate-spin" aria-hidden />
            ) : saveState === "error" ? (
              <CircleAlert size={11} aria-hidden />
            ) : saveState === "dirty" ? (
              <span className="size-1.5 rounded-full bg-current" aria-hidden />
            ) : (
              <Check size={11} aria-hidden />
            )}
            {saveLabel}
          </span>
          {saveState === "error" && (
            <button
              type="button"
              onClick={() => void save()}
              className="shrink-0 rounded-lg border border-danger/40 px-2 py-1 text-[11px] font-medium text-danger hover:bg-danger/10"
            >
              Retry save
            </button>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <span className="mr-1 text-[11px] text-ink-secondary">Add</span>
            {(Object.keys(NODE_KIND_META) as WorkflowNodeKind[]).map((kind) => {
              const { label, icon: Icon } = NODE_KIND_META[kind];
              const blocked =
                kind === "agent" && bots.length === 0
                  ? "Create a bot first"
                  : kind === "notify" && groups.length === 0
                    ? "Create a room first"
                    : null;
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => {
                    if (!blocked) addNode(kind);
                  }}
                  aria-disabled={blocked ? true : undefined}
                  title={blocked ?? `Add ${label.toLowerCase()} node`}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg border border-hairline/50 px-2.5 py-1.5 text-[11.5px] font-medium",
                    blocked ? "cursor-not-allowed text-ink-secondary opacity-40" : "text-ink-secondary hover:bg-raised hover:text-ink",
                  )}
                >
                  <Icon size={13} aria-hidden />
                  {label}
                </button>
              );
            })}

            <div className="relative">
              <button
                type="button"
                onClick={() => setScheduleOpen((open) => !open)}
                aria-expanded={scheduleOpen}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg border border-hairline/50 px-2.5 py-1.5 text-[11.5px] font-medium",
                  doc.triggers?.schedule ? "text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink",
                )}
              >
                <CalendarClock size={13} aria-hidden />
                {doc.triggers?.schedule ? "Scheduled" : "Schedule"}
              </button>
              {scheduleOpen && (
                <TriggersPanel
                  workflow={doc}
                  onChange={(triggers) => commit((current) => ({ ...current, triggers }))}
                  onClose={() => setScheduleOpen(false)}
                />
              )}
            </div>

            <button
              type="button"
              onClick={() => {
                if (!runBlockedReason) void run();
              }}
              aria-disabled={runBlockedReason ? true : undefined}
              aria-describedby={runBlockedReason ? "wf-canvas-run-reason" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink",
                runBlockedReason ? "cursor-not-allowed opacity-40" : "hover:brightness-110",
              )}
            >
              {running ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Play size={13} aria-hidden />}
              Run
            </button>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-start gap-x-3 gap-y-1.5" style={windowNoDragStyle}>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
              errors > 0
                ? "bg-danger/15 text-danger"
                : warnings > 0
                  ? "bg-warning/15 text-warning"
                  : "bg-success/15 text-success",
            )}
          >
            {errors > 0 || warnings > 0 ? <AlertTriangle size={11} aria-hidden /> : <Check size={11} aria-hidden />}
            {errors > 0
              ? `${errors} ${errors === 1 ? "error" : "errors"}`
              : warnings > 0
                ? `${warnings} ${warnings === 1 ? "warning" : "warnings"}`
                : "Valid"}
          </span>
          {/* Both the reason and the failure are visible text, not tooltips:
              a disabled-looking button nobody can explain is the bug. */}
          {runBlockedReason && (
            <span id="wf-canvas-run-reason" className="text-[11px] text-danger">
              {runBlockedReason}
            </span>
          )}
          {headerIssues.length > 0 && (
            <ul className="min-w-0 flex-1 space-y-0.5 text-[11px] leading-relaxed">
              {headerIssues.map((issue, index) => (
                <li key={`${issue.code}:${index}`} className="flex gap-1.5">
                  <span
                    className={cn(
                      "shrink-0 font-medium",
                      issue.severity === "error" ? "text-danger" : "text-warning",
                    )}
                  >
                    {issue.severity === "error" ? "Error" : "Warning"}
                  </span>
                  <span className="min-w-0 text-ink-secondary">{issue.message}</span>
                </li>
              ))}
            </ul>
          )}
          {saveError && (
            <span role="alert" className="min-w-0 text-[11px] text-danger">
              {saveError}
            </span>
          )}
          {runError && (
            <span role="alert" className="min-w-0 text-[11px] text-danger">
              {runError}
            </span>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div ref={paneRef} className="workflow-canvas min-w-0 flex-1" style={windowNoDragStyle}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            defaultEdgeOptions={EDGE_DEFAULTS}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            deleteKeyCode={["Delete", "Backspace"]}
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            minZoom={0.25}
            maxZoom={1.75}
            proOptions={{ hideAttribution: false }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        {selectedNode ? (
          <WorkflowNodePanel
            node={selectedNode}
            issues={nodeIssues.get(selectedNode.id) ?? []}
            entry={doc.entryNodeId === selectedNode.id}
            bots={bots}
            groups={groups}
            onUpdate={(next) => commit((current) => updateNode(current, next.id, () => next))}
            onAddOutcome={(name) => commit((current) => addOutcome(current, selectedNode.id, name))}
            onRenameOutcome={(from, to) => commit((current) => renameOutcome(current, selectedNode.id, from, to))}
            onRemoveOutcome={(name) => commit((current) => removeOutcome(current, selectedNode.id, name))}
            onMakeEntry={() => commit((current) => setEntryNode(current, selectedNode.id))}
            onDelete={() => {
              setSelectedNodeId(null);
              commit((current) => removeNodes(current, [selectedNode.id]));
            }}
            onClose={() => setSelectedNodeId(null)}
          />
        ) : selectedEdge ? (
          <aside
            aria-label="Selected edge"
            className="flex w-[300px] shrink-0 flex-col gap-3 border-l border-hairline/40 bg-panel px-4 py-4"
          >
            <h2 className="text-[13.5px] font-semibold text-ink">Edge</h2>
            <p className="text-[12px] leading-relaxed text-ink-secondary">
              <span className="font-mono text-ink">{selectedEdge.from}</span> routes{" "}
              <span className="font-mono text-ink">{selectedEdge.outcome}</span> to{" "}
              <span className="font-mono text-ink">{selectedEdge.to}</span>.
            </p>
            <button
              type="button"
              onClick={() => {
                setSelectedEdgeId(null);
                commit((current) => removeEdges(current, [selectedEdge]));
              }}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-danger/40 px-2.5 py-1.5 text-[11.5px] font-medium text-danger hover:bg-danger/10"
            >
              <Trash2 size={13} aria-hidden />
              Delete edge
            </button>
          </aside>
        ) : (
          <aside
            aria-label="Canvas help"
            className="hidden w-[300px] shrink-0 flex-col gap-2 border-l border-hairline/40 bg-panel px-4 py-4 lg:flex"
          >
            <h2 className="text-[13.5px] font-semibold text-ink">Nothing selected</h2>
            <p className="text-[12px] leading-relaxed text-ink-secondary">
              Pick a node to edit it, or drag from an outcome handle on its right edge to the left edge of the node
              that should run next. Delete removes whatever is selected.
            </p>
            <p className="text-[12px] leading-relaxed text-ink-secondary">
              One node has to be the entry point — select it and choose <strong className="text-ink">Make entry
              node</strong>. The dashed red handle is the engine&apos;s own failure path; wiring it is optional.
            </p>
            <p className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
              <Plus size={12} aria-hidden />
              {doc.nodes.length} {doc.nodes.length === 1 ? "node" : "nodes"}, {doc.edges.length}{" "}
              {doc.edges.length === 1 ? "edge" : "edges"}
            </p>
          </aside>
        )}
      </div>
    </main>
  );
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      {/* Remount on a different workflow: the local document, the selection
          and the save queue are all per-workflow state. */}
      <WorkflowCanvasInner key={props.workflow.id} {...props} />
    </ReactFlowProvider>
  );
}

export default WorkflowCanvas;
