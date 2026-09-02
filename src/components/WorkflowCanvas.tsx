// The workflow editor: a node graph over the shared `Workflow` document.
//
// One rule shapes the whole file — the local document is the single source of
// truth while it is dirty, and every edit is a pure call into
// `@/lib/workflow-graph`. Validation runs on that local document with the
// same `validateWorkflow` the server uses, so the badges never drift from
// what a save would report. Drafts are saveable by design: the PATCH goes out
// even when the graph is broken, and only running is gated.
//
// Observation decorates this without touching either of those rules. The
// mode switch pauses the same save queue (`setPaused`) rather than teaching
// the save path about modes, the run is read from the store's live
// `workflowRuns` rather than copied, and the decoration reaches the drawing
// through the two seams that were left for it: `WorkflowNodeCard`'s `tone`
// and `footer` props, and `toGraphEdges`'s `decorate` callback.
//
// Node tone is derived in the NODE RENDERER, not in the document ⇄ graph
// mapping. The renderer already subscribes to the store, so a `workflow-run`
// frame repaints the cards on its own — while putting run state into
// `WorkflowGraphNodeData` would rebuild the node array on every frame, and a
// rebuilt node object loses the `measured` size xyflow keys off identity
// (the whole graph blinks). Edges have no such identity contract, so they go
// through `decorate` exactly as designed.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
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
  Eye,
  Loader2,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  ShieldQuestion,
  Square,
  Trash2,
  UserRound,
  X,
} from "lucide-react";

import "@xyflow/react/dist/base.css";
import "./workflow-canvas.css";

import { api, openNotificationTarget, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { validationSummary, type WorkflowListItem } from "@/lib/workflow-state";
import { capabilityLookup } from "@/lib/workflow-capabilities";
import { createSaveQueue, type SaveStatus } from "@/lib/workflow-save-queue";
import {
  isActiveWorkflowRun,
  observedRunFor,
  runEdgeDecorator,
  runStatusPhrase,
  workflowRunsFor,
} from "@/lib/workflow-observation";
import {
  createObserveMode,
  initialObserveModeState,
  type ObserveModeState,
} from "@/lib/workflow-observe-mode";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { WorkflowCanvasNode, type WorkflowObservation } from "./WorkflowCanvasNode";
import { WorkflowRunTimeline } from "./WorkflowRunTimeline";
import { WorkflowNodePanel, type WorkflowPanelBot } from "./WorkflowNodePanel";
import {
  WORKFLOW_NODE_TYPE,
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
  outcomeHandles,
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
  capabilityIssues,
  validateWorkflow,
  type Workflow,
  type WorkflowNodeResult,
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

const ObservationContext = createContext<WorkflowObservation | null>(null);

/** Resolves its own roster references so the mapping stays pure and a bot
 * rename repaints the card without rebuilding the graph. The same
 * subscription is what makes a `workflow-run` frame repaint the run
 * decoration: `WorkflowCanvasNode` derives tone and footer per render from
 * whatever the store currently holds.
 *
 * Everything below this line is xyflow-specific and nothing else: the roster
 * lookups, and turning a `WorkflowHandleSpec` into a real `<Handle>`. The
 * decisions live in `WorkflowCanvasNode`, where they can be tested. */
function WorkflowFlowNodeRenderer({ data, selected, isConnectable }: NodeProps<WorkflowFlowNode>) {
  const { state } = useStore();
  const observation = useContext(ObservationContext);
  const { node } = data;
  const bot = node.kind === "agent" ? (state.bots.find((candidate) => candidate.id === node.botId) ?? null) : null;
  const groupName =
    node.kind === "notify"
      ? (state.groups.find((group) => group.id === node.targetGroupId)?.name ?? null)
      : null;

  return (
    <WorkflowCanvasNode
      data={data}
      bot={bot}
      groupName={groupName}
      selected={selected}
      isConnectable={isConnectable}
      observation={observation}
      renderHandle={(handle) => (
        <Handle
          key={handle.key}
          type={handle.side}
          position={handle.side === "target" ? Position.Left : Position.Right}
          id={handle.id}
          isConnectable={handle.isConnectable}
          className={handle.className}
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
  anchorRef,
}: {
  workflow: Workflow;
  onChange: (triggers: WorkflowTriggers | undefined) => void;
  onClose: () => void;
  /** The toggle that opened this, so a click on it is not treated as an
   * outside click (which would close and immediately reopen), and so focus
   * has somewhere to go back to. */
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const schedule = workflow.triggers?.schedule;
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const close = useCallback(
    (restoreFocus: boolean) => {
      closeRef.current();
      // Only a deliberate dismissal pulls focus back; a click elsewhere on
      // the page has already chosen where focus belongs.
      if (restoreFocus) anchorRef.current?.focus();
    },
    [anchorRef],
  );

  // Escape and click-outside both dismiss it — a panel only the mouse can
  // close is a keyboard trap, and one that ignores outside clicks is a
  // sticky overlay. Escape is deliberately NOT preventDefault-ed: the canvas
  // uses the same key to clear its selection, and swallowing it globally
  // would break that everywhere the popover happens to be open.
  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as globalThis.Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      close(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [close, anchorRef]);

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
    <div
      ref={panelRef}
      tabIndex={-1}
      role="group"
      aria-label="Schedule"
      className="absolute right-0 top-full z-30 mt-2 w-[320px] rounded-2xl border border-hairline/50 bg-panel p-4 shadow-2xl outline-none"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-ink">Schedule</h2>
        <button
          type="button"
          onClick={() => close(true)}
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
  const scheduleButtonRef = useRef<HTMLButtonElement>(null);

  const [doc, setDoc] = useState<Workflow>(() => toDocument(row));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveStatus>("clean");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  /** A half-typed (or momentarily empty) name the document must not adopt. */
  const [nameDraft, setNameDraft] = useState<string | null>(null);

  // ── observation ─────────────────────────────────────────────────────
  // One state object, because `createObserveMode` owns the transitions
  // between its fields: the mode, the pick, and the action in flight all
  // move together and their ordering rules are tested in the lib.
  const [mode, setMode] = useState<ObserveModeState>(initialObserveModeState);
  const { observing, switching, pickedRunId, action: nodeAction } = mode;
  const [cancelling, setCancelling] = useState(false);

  // The document is owned locally while it is dirty; refs carry the pieces
  // the debounced save and the unmount flush need without re-subscribing.
  const docRef = useRef(doc);
  docRef.current = doc;
  /** A drag moved something since the last drop; armed by the position
   * frames, disarmed by the drop that saves them. */
  const draggedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const pendingKindRef = useRef<SaveKind | null>(null);
  const workflowId = row.id;

  // One PATCH at a time, newest document wins, failures reported. Those rules
  // live in `createSaveQueue` so they can be tested without a React tree; the
  // debounce below stays here, because which edits are worth coalescing is a
  // UI decision.
  const sendRef = useRef<() => Promise<void>>(async () => {});
  sendRef.current = async () => {
    const { workflow } = await api(`/api/workflows/${workflowId}`, {
      method: "PATCH",
      body: JSON.stringify(workflowPatchBody(docRef.current)),
    });
    // The response carries the saved definition AND its fresh issues; the
    // store adopts it so the list badge and the canvas agree.
    if (workflow) dispatch({ type: "workflowPatched", workflow });
  };
  const [queue] = useState(() =>
    createSaveQueue({
      send: () => sendRef.current(),
      onStatus: (status, failure) => {
        setSaveState(status);
        setSaveError(failure);
        // "Not started — the changes could not be saved" is only true until
        // they are; leaving it up after a good save is a stale accusation.
        if (status === "saved") setRunError(null);
      },
    }),
  );

  const bots = useMemo<WorkflowPanelBot[]>(
    () =>
      state.bots
        .filter((bot) => !bot.hidden)
        .map(({ id, name, color, avatarUrl, avatarCrop, mascotBody, canMerge, canDeploy }) => ({
          id,
          name,
          color,
          avatarUrl,
          avatarCrop,
          mascotBody,
          canMerge,
          canDeploy,
        })),
    [state.bots],
  );
  const groups = useMemo(() => state.groups.map(({ id, name }) => ({ id, name })), [state.groups]);

  // The same validators the server runs, on the document as it stands right
  // now — that is what keeps a badge from lying between two saves. The
  // capability pass reads the roster as the STORE holds it (hidden bots
  // included: a node may still point at one), so flipping "can merge" in a
  // profile repaints the node that requires it with no save in between.
  const lookup = useMemo(() => capabilityLookup(state.bots), [state.bots]);
  const issues = useMemo(() => [...validateWorkflow(doc), ...capabilityIssues(doc, lookup)], [doc, lookup]);
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
  // The observed run is DERIVED from the store on every render — there is no
  // second copy of it here, so a `workflow-run` SSE frame and the response to
  // an approve/resume/cancel land the same way and cannot disagree.
  const workflowRuns = useMemo(
    () => workflowRunsFor(state.workflowRuns, workflowId),
    [state.workflowRuns, workflowId],
  );
  const observedRun = useMemo(
    () => (observing ? observedRunFor(workflowRuns, workflowId, pickedRunId) : null),
    [observing, workflowRuns, workflowId, pickedRunId],
  );
  const liveRun = observedRun !== null && isActiveWorkflowRun(observedRun);
  // A live run's elapsed time would otherwise only move when a frame lands;
  // this is a clock, not a poll — nothing is asked of the server.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!liveRun) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [liveRun]);

  const edges = useMemo(
    // Guarded on the RUN, not the mode: with no run to compare against,
    // muting every edge would make an un-run workflow read as a disabled
    // one. Nothing to decorate, so the editor's own mapping stands.
    () => toGraphEdges(doc, selectedEdgeId, observedRun ? runEdgeDecorator(observedRun) : undefined),
    [doc, selectedEdgeId, observedRun],
  );
  const selectedNode = observing ? null : (doc.nodes.find((node) => node.id === selectedNodeId) ?? null);
  // Every node is a legal destination, itself included — review loops are a
  // supported shape, not a mistake.
  const routeTargets = useMemo(
    () =>
      doc.nodes.map((node) => ({
        id: node.id,
        label:
          node.kind === "agent"
            ? `${node.id} · ${bots.find((bot) => bot.id === node.botId)?.name ?? "missing bot"}`
            : node.kind === "notify"
              ? `${node.id} · ${groups.find((group) => group.id === node.targetGroupId)?.name ?? "missing room"}`
              : `${node.id} · approval`,
      })),
    [doc.nodes, bots, groups],
  );
  const routesFrom = useCallback(
    (nodeId: string) => {
      const routes: Record<string, string> = {};
      for (const edge of doc.edges) if (edge.from === nodeId) routes[edge.outcome] = edge.to;
      return routes;
    },
    [doc.edges],
  );
  const selectedEdge = !observing && selectedEdgeId ? findEdgeByGraphId(doc, selectedEdgeId) : null;

  /** Cancels a pending debounce; the caller is about to flush by hand. */
  const cancelDebounce = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingKindRef.current = null;
  }, []);

  // ── mode and run actions ────────────────────────────────────────────
  // The ordering rules — save before pausing, refuse rather than park an
  // unsaved edit, unpause and drain on the way out, and pin an action's
  // answer to the run AND node it was issued for — live in
  // `@/lib/workflow-observe-mode`, where they are unit-tested against the
  // real save queue. What is left here is wiring.
  const observeMode = useMemo(
    () =>
      createObserveMode({
        queue,
        cancelDebounce,
        patch: (next) => setMode((current) => ({ ...current, ...next })),
        send: async (runId, path, body) => {
          const { run: next } = await api(`/api/workflow-runs/${runId}/${path}`, { method: "POST", body });
          return next ?? null;
        },
        adopt: (next) => dispatch({ type: "workflowRunPatched", run: next }),
      }),
    [queue, cancelDebounce, dispatch],
  );

  const schedule = useCallback(
    (kind: SaveKind) => {
      // A structural edit pulls the whole pending batch forward: layout noise
      // must never hold a real change hostage.
      pendingKindRef.current = pendingKindRef.current === "structure" ? "structure" : kind;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        pendingKindRef.current = null;
        void queue.flush();
      }, SAVE_DEBOUNCE_MS[pendingKindRef.current]);
    },
    [queue],
  );

  /** Every edit funnels through here: pure change in, one save schedule out.
   * A change that returns the same document schedules nothing. */
  const commit = useCallback(
    (change: (current: Workflow) => Workflow, kind: SaveKind = "structure") => {
      const next = change(docRef.current);
      if (next === docRef.current) return;
      docRef.current = next;
      setDoc(next);
      queue.markDirty();
      schedule(kind);
    },
    [queue, schedule],
  );

  // A server frame is adopted only while nothing local is outstanding —
  // otherwise a live SSE update would silently undo what is being typed.
  //
  // The flip side is deliberate last-write-wins ACROSS sessions: a `workflow`
  // frame that lands while this canvas is dirty is dropped, so the next PATCH
  // overwrites whatever another window (or the phone) saved in the meantime,
  // with nothing shown to either author. A workflow is a single-author
  // document in practice, and making concurrent editing safe needs a version
  // precondition on the API — a server change, not a canvas one.
  useEffect(() => {
    const { dirty, saving } = queue.snapshot();
    if (dirty || saving) return;
    setDoc(toDocument(row));
  }, [row, queue]);

  // Leaving the canvas must not drop a debounced edit — and must not race the
  // PATCH that may already be in flight, so it drains the same queue instead
  // of firing a second whole-document write with no ordering guarantee. The
  // component is gone by then, so a failure is reported through the app-level
  // error banner rather than the header.
  useEffect(
    () => () => {
      cancelDebounce();
      // Unpause first: leaving the canvas while observing must still write
      // anything that was outstanding, and a paused queue's flush sends
      // nothing at all.
      observeMode.release();
      if (!queue.snapshot().dirty) return;
      void queue.flush().then((result) => {
        if (!result.ok) dispatch({ type: "error", message: `Workflow not saved: ${result.error}` });
      });
    },
    [queue, cancelDebounce, dispatch],
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
          draggedRef.current = true;
          setDoc(next);
          queue.markDirty();
        }
      }
      // The drop's own change carries `dragging: false` and no position, so
      // the save cannot be armed inside the branch above — it would never run.
      if (settled && draggedRef.current) {
        draggedRef.current = false;
        schedule("layout");
      }
      if (removed.length > 0) {
        if (selectedNodeId && removed.includes(selectedNodeId)) setSelectedNodeId(null);
        commit((current) => removeNodes(current, removed));
      }
    },
    [commit, queue, schedule, selectedNodeId],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      // Selection is an EDITING affordance: while observing, accent means
      // "the run walked this", and a selected edge would wear the same paint
      // with no panel to explain it — the edge panel is an editor's. Nothing
      // is removable here either, so the whole handler is a no-op.
      if (observing) return;
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
    [commit, selectedEdgeId, observing],
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

  // An agent node needs a bot and a notify node a room — both are foreign
  // keys the API refuses empty. Like the Run button, the reason is visible
  // text tied to the control with aria-describedby, never a `title` a
  // keyboard or touch user can never surface.
  const paletteBlocked: Partial<Record<WorkflowNodeKind, string>> = {
    ...(bots.length === 0 ? { agent: "Add a bot before you can add an agent node" } : {}),
    ...(groups.length === 0 ? { notify: "Create a room before you can add a notify node" } : {}),
  };

  const run = async () => {
    setRunning(true);
    setRunError(null);
    try {
      // The debounced document must reach the server before the run reads it,
      // and a run planned on a FAILED save would execute the previous graph —
      // so the flush is awaited to completion and its verdict is honoured.
      cancelDebounce();
      const flushed = await queue.flush();
      if (!flushed.ok) {
        setRunError(`Not started — the latest changes could not be saved: ${flushed.error}`);
        return;
      }
      const { run: started } = await api(`/api/workflows/${workflowId}/runs`, { method: "POST", body: "{}" });
      if (started) dispatch({ type: "workflowRunPatched", run: started });
    } catch (cause) {
      setRunError(errorText(cause));
    } finally {
      setRunning(false);
    }
  };

  const decide = (decision: "approved" | "rejected") => {
    if (observedRun) void observeMode.act(observedRun, "approval", JSON.stringify({ decision }));
  };

  const resume = () => {
    if (observedRun) void observeMode.act(observedRun, "resume", "{}");
  };

  const cancelRun = async () => {
    if (!observedRun) return;
    if (!window.confirm("Cancel this run? The node in flight stops where it is and the rest of the graph is skipped."))
      return;
    setCancelling(true);
    setRunError(null);
    try {
      const { run: cancelled } = await api(`/api/workflow-runs/${observedRun.id}/cancel`, {
        method: "POST",
        body: "{}",
      });
      if (cancelled) dispatch({ type: "workflowRunPatched", run: cancelled });
    } catch (cause) {
      setRunError(errorText(cause));
    } finally {
      setCancelling(false);
    }
  };

  /** A step's transcript lives in the bot's task thread. The node names the
   * bot; if the node is gone (a step of a graph that has since changed) the
   * thread's own owner is the fallback, and when neither resolves the canvas
   * says so instead of selecting an id that does not exist. */
  const openThread = (nodeId: string, threadId: string) => {
    const node = docRef.current.nodes.find((candidate) => candidate.id === nodeId);
    const botId =
      node?.kind === "agent"
        ? node.botId
        : (state.bots.find(
            (bot) => bot.threadId === threadId || (bot.tasks ?? []).some((task) => task.threadId === threadId),
          )?.id ?? null);
    if (!botId) {
      setRunError("That transcript is no longer available — its bot or task was deleted.");
      return;
    }
    setRunError(null);
    openNotificationTarget(dispatch, { botId, threadId }, state);
  };

  const openStep = (result: WorkflowNodeResult) => {
    if (result.threadId) openThread(result.nodeId, result.threadId);
  };

  // Deliberately not memoised: in Edit it is a stable `null`, and in Observe
  // the canvas only re-renders when the store (which every card already
  // subscribes to) or the clock moves, so a fresh object costs nothing.
  const observation: WorkflowObservation | null = observedRun
    ? { run: observedRun, action: nodeAction, decide, resume, openThread }
    : null;

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
            // The one editing control that is not in the palette. It locks
            // from the moment the switch STARTS, not once it lands: entering
            // Observe awaits a save, and a keystroke during that await is an
            // edit the flush already missed.
            readOnly={observing || switching}
            aria-describedby={
              observing ? "wf-canvas-mode-reason" : switching ? "wf-canvas-mode-busy" : undefined
            }
            onChange={(event) => {
              const next = event.target.value;
              setNameDraft(next);
              if (next.trim()) commit((current) => ({ ...current, name: next }));
            }}
            onBlur={() => setNameDraft(null)}
            className="min-w-[160px] max-w-[300px] flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-[16px] font-semibold text-ink outline-none hover:border-hairline/50 focus:border-accent focus:bg-inset"
          />

          {/* A status region: the save outcome is the one thing on this page
              that changes without the author doing anything. */}
          <span
            role="status"
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
          {/* A paused queue's flush sends nothing, so this button would be
              a lie while observing. Entering Observe already refuses on an
              unsaved document, so there is nothing here to retry. */}
          {saveState === "error" && !observing && (
            <button
              type="button"
              onClick={() => {
                cancelDebounce();
                void queue.flush();
              }}
              className="shrink-0 rounded-lg border border-danger/40 px-2 py-1 text-[11px] font-medium text-danger hover:bg-danger/10"
            >
              Retry save
            </button>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {/* Edit ⇄ Observe. Entering Observe saves first and can refuse,
                so it is a real action with a spinner, not a display toggle. */}
            <div role="group" aria-label="Canvas mode" className="mr-1 flex items-center gap-0.5 rounded-lg border border-hairline/50 p-0.5">
              <button
                type="button"
                aria-pressed={!observing}
                onClick={() => {
                  if (observing) observeMode.leave();
                }}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium",
                  observing ? "text-ink-secondary hover:bg-raised hover:text-ink" : "bg-accent/15 text-accent",
                )}
              >
                <Pencil size={12} aria-hidden />
                Edit
              </button>
              <button
                type="button"
                aria-pressed={observing}
                onClick={() => {
                  if (!observing && !switching) {
                    // Observe cannot deselect anything (onEdgesChange bails), so a
                    // selection carried in from Edit would stay painted accent and
                    // read as a traversed edge with no panel to explain it.
                    setSelectedEdgeId(null);
                    void observeMode.enter();
                  }
                }}
                aria-disabled={switching ? true : undefined}
                aria-describedby={switching ? "wf-canvas-mode-busy" : undefined}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium",
                  observing ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink",
                )}
              >
                {switching ? (
                  <Loader2 size={12} className="animate-spin" aria-hidden />
                ) : (
                  <Eye size={12} aria-hidden />
                )}
                Observe
              </button>
            </div>

            {observing && observedRun && isActiveWorkflowRun(observedRun) && (
              <button
                type="button"
                onClick={() => {
                  if (!cancelling) void cancelRun();
                }}
                aria-disabled={cancelling ? true : undefined}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg border border-danger/40 px-2.5 py-1.5 text-[11.5px] font-medium text-danger",
                  cancelling ? "cursor-not-allowed opacity-50" : "hover:bg-danger/10",
                )}
              >
                {cancelling ? (
                  <Loader2 size={13} className="animate-spin" aria-hidden />
                ) : (
                  <Square size={13} aria-hidden />
                )}
                Cancel run
              </button>
            )}

            {/* Everything that writes the document is gone in Observe — the
                palette, the schedule editor and Run. The mode line below
                says so in visible text. */}
            {!observing && (
              <>
                <span className="mr-1 text-[11px] text-ink-secondary">Add</span>
                {(Object.keys(NODE_KIND_META) as WorkflowNodeKind[]).map((kind) => {
                  const { label, icon: Icon } = NODE_KIND_META[kind];
                  const blocked = paletteBlocked[kind] ?? null;
                  return (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => {
                        if (!blocked) addNode(kind);
                      }}
                      aria-disabled={blocked ? true : undefined}
                      aria-describedby={blocked ? `wf-canvas-add-${kind}-reason` : undefined}
                      aria-label={`Add ${label.toLowerCase()} node`}
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
                    ref={scheduleButtonRef}
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
                      anchorRef={scheduleButtonRef}
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
              </>
            )}
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
          {!observing &&
            Object.entries(paletteBlocked).map(([kind, reason]) => (
              <span key={kind} id={`wf-canvas-add-${kind}-reason`} className="text-[11px] text-ink-secondary">
                {reason}
              </span>
            ))}
          {/* Why the palette and the name field are gone. Visible text, and
              the id the read-only name field points its description at. */}
          {observing && (
            <span id="wf-canvas-mode-reason" className="text-[11px] text-ink-secondary">
              Observing{observedRun ? ` a run that ${runStatusPhrase(observedRun)}` : ""} — the drawing is read-only.
              Switch to Edit to change it.
            </span>
          )}
          {switching && (
            <span id="wf-canvas-mode-busy" role="status" className="text-[11px] text-ink-secondary">
              Saving before it switches — Observe opens once the document is safely on the server.
            </span>
          )}
          {mode.error && (
            <span role="alert" className="min-w-0 text-[11px] text-danger">
              {mode.error}
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
        <div
          ref={paneRef}
          className={cn("workflow-canvas min-w-0 flex-1", observing && "workflow-canvas-observing")}
          style={windowNoDragStyle}
        >
          {/* The run reaches the cards through context rather than through
              their data, so a run frame never rebuilds the node array. */}
          <ObservationContext.Provider value={observation}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              defaultEdgeOptions={EDGE_DEFAULTS}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              // Read-only while observing: nothing drags, nothing connects and
              // Delete does nothing. Selection stays on, because clicking a
              // card to look at it is the point.
              nodesDraggable={!observing}
              nodesConnectable={!observing}
              deleteKeyCode={observing ? null : ["Delete", "Backspace"]}
              // Selection is single by design: the change handlers keep one
              // selected id, so a rubber-band or shift-click that looked like a
              // multi-selection would still delete just one node. Turning the
              // gestures off is honest; a real multi-select is a separate change.
              selectionKeyCode={null}
              multiSelectionKeyCode={null}
              fitView
              fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
              minZoom={0.25}
              maxZoom={1.75}
              proOptions={{ hideAttribution: false }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </ObservationContext.Provider>
        </div>

        {observing ? (
          <aside
            aria-label="Run observation"
            className="flex w-[320px] shrink-0 flex-col border-l border-hairline/40 bg-panel px-4 py-4"
          >
            <WorkflowRunTimeline
              runs={workflowRuns}
              run={observedRun}
              pickedId={pickedRunId}
              now={now}
              onPick={(runId) => {
                // `actionOn` already refuses to show one run's failure on
                // another's card; dropping it here also stops it coming back
                // when the author returns to the run it happened on.
                setMode((current) => ({ ...current, action: null, pickedRunId: runId }));
              }}
              onOpenStep={openStep}
            />
          </aside>
        ) : selectedNode ? (
          <WorkflowNodePanel
            node={selectedNode}
            issues={nodeIssues.get(selectedNode.id) ?? []}
            entry={doc.entryNodeId === selectedNode.id}
            bots={bots}
            groups={groups}
            outcomes={outcomeHandles(selectedNode)}
            targets={routeTargets}
            routes={routesFrom(selectedNode.id)}
            onRoute={(outcome, to) =>
              commit((current) =>
                to
                  ? connectEdge(current, { from: selectedNode.id, outcome, to })
                  : removeEdges(
                      current,
                      current.edges.filter((edge) => edge.from === selectedNode.id && edge.outcome === outcome),
                    ),
              )
            }
            onUpdate={(next) => commit((current) => updateNode(current, next.id, () => next))}
            onAddOutcome={(name) => commit((current) => addOutcome(current, selectedNode.id, name))}
            onRenameOutcome={(from, to) => commit((current) => renameOutcome(current, selectedNode.id, from, to))}
            onRemoveOutcome={(name) => commit((current) => removeOutcome(current, selectedNode.id, name))}
            onMakeEntry={() => commit((current) => setEntryNode(current, selectedNode.id))}
            onDelete={() => {
              // Deleting from the panel is a deliberate, named action that
              // cascades to every edge touching the node and can clear the
              // entry point — so it asks. The Delete KEY stays unconfirmed,
              // the way a canvas is expected to behave.
              const edges = doc.edges.filter(
                (edge) => edge.from === selectedNode.id || edge.to === selectedNode.id,
              ).length;
              const entryWarning = doc.entryNodeId === selectedNode.id ? " It is the entry node." : "";
              const edgeWarning = edges === 0 ? "" : ` ${edges} ${edges === 1 ? "edge" : "edges"} go with it.`;
              if (!window.confirm(`Delete node “${selectedNode.id}”?${edgeWarning}${entryWarning}`)) return;
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
