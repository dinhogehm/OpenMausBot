// The pre-flight editor: the checks a run must pass before its first bot
// turn, and the button that runs them right now without starting a run.
// A popover beside the schedule editor, because both answer "under what
// conditions does this workflow start". Every edit goes to the document
// through `onChange` and rides the canvas's debounced save; the test runs
// against the SAVED definition, so the canvas flushes before it asks.
//
// Security note, said in the panel too: a command check runs as the app's
// own user, with its environment and its credentials. Anyone who can edit
// the workflow can run a command on this machine at the next run. Only the
// workflow's owner should edit these; the server never folds a run's
// input (a webhook payload, say) into the command string.
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Plus, ShieldAlert, Trash2, X, XCircle } from "lucide-react";

import { cn } from "@/lib/cn";
import {
  validateWorkflow,
  WORKFLOW_PREFLIGHT_TIMEOUT_DEFAULT_S,
  WORKFLOW_PREFLIGHT_TIMEOUT_MAX_S,
  WORKFLOW_PREFLIGHT_TIMEOUT_MIN_S,
  WORKFLOW_PREFLIGHT_WAIT_DEFAULT_MIN,
  WORKFLOW_PREFLIGHT_WAIT_MAX_MIN,
  type Workflow,
  type WorkflowPreflight,
  type WorkflowPreflightCheck,
  type WorkflowPreflightResult,
} from "../../shared/workflow";

const FIELD =
  "w-full rounded-lg border border-hairline/50 bg-inset px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent";
const LABEL = "block text-[10.5px] font-medium text-ink-secondary";

export interface WorkflowPreflightBot {
  id: string;
  name: string;
}

export interface WorkflowPreflightPanelProps {
  workflow: Workflow;
  bots: WorkflowPreflightBot[];
  onChange: (preflight: WorkflowPreflight | undefined) => void;
  /** Runs the saved checks and resolves with the verdict; rejects with the
   * reason it could not (an unsaved edit that failed to save, a 404). */
  onTest: () => Promise<WorkflowPreflightResult>;
  /** The last verdict the button produced for THIS workflow, if any. */
  lastResult: WorkflowPreflightResult | null;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}

const KIND_LABEL: Record<WorkflowPreflightCheck["kind"], string> = {
  command: "Command",
  "bots-ready": "Bots ready",
  "engine-health": "Engine health",
};

/** A fresh check of each kind, named so the list never holds a blank the
 * validator would flag on the very first keystroke. Names are unique
 * within the list because the validator insists on it. */
function newCheck(kind: WorkflowPreflightCheck["kind"], existing: WorkflowPreflightCheck[], firstBot: string | undefined): WorkflowPreflightCheck {
  const base = kind === "command" ? "check" : kind === "bots-ready" ? "bots ready" : "engine health";
  let name = base;
  for (let n = 2; existing.some((check) => check.name === name); n++) name = `${base} ${n}`;
  if (kind === "command") return { kind, name, command: "" };
  if (kind === "bots-ready") return { kind, name };
  return { kind, name, botId: firstBot ?? "" };
}

/** What a check's result line says beside its name. */
export function preflightResultLine(check: WorkflowPreflightResult["checks"][number]): string {
  return `${check.ok ? "Passed" : "Failed"} · ${check.detail} · ${check.durationMs} ms`;
}

export function WorkflowPreflightPanel({ workflow, bots, onChange, onTest, lastResult, onClose, anchorRef }: WorkflowPreflightPanelProps) {
  const preflight = workflow.preflight;
  const checks = preflight?.checks ?? [];
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [timeoutDraft, setTimeoutDraft] = useState<string | null>(null);
  // Checks carry no id, and a name is not a key: two are equal while one is
  // being typed. A parallel list of client-side keys, grown and cut with
  // the checks, keeps each row's inputs on their own DOM node across edits
  // — resynced by length so a frame from another window cannot desync it.
  const keysRef = useRef<string[]>([]);
  const keySeq = useRef(0);
  while (keysRef.current.length < checks.length) keysRef.current.push(`check-${++keySeq.current}`);
  if (keysRef.current.length > checks.length) keysRef.current.length = checks.length;
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const close = useCallback(
    (restoreFocus: boolean) => {
      closeRef.current();
      if (restoreFocus) anchorRef.current?.focus();
    },
    [anchorRef],
  );

  // Same dismissal contract as the schedule editor: Escape and a click
  // outside close it, without swallowing Escape from the canvas.
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

  // The shared validator on the document as it stands: the same messages
  // the badge and the server produce, painted here beside the fields.
  const issues = validateWorkflow(workflow).filter((issue) => issue.code === "bad-preflight");

  const commit = (next: WorkflowPreflightCheck[], timeoutSeconds = preflight?.timeoutSeconds) => {
    // No checks and no timeout is no pre-flight: the field goes away rather
    // than persisting an empty list forever.
    if (next.length === 0 && timeoutSeconds === undefined) onChange(undefined);
    else onChange({ checks: next, ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }) });
  };
  const update = (index: number, patch: WorkflowPreflightCheck) => commit(checks.map((check, at) => (at === index ? patch : check)));
  const remove = (index: number) => {
    keysRef.current.splice(index, 1);
    commit(checks.filter((_check, at) => at !== index));
  };
  const add = (kind: WorkflowPreflightCheck["kind"]) => commit([...checks, newCheck(kind, checks, bots[0]?.id)]);

  const test = async () => {
    setTesting(true);
    setTestError(null);
    try {
      await onTest();
    } catch (cause) {
      setTestError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="group"
      aria-label="Pre-flight"
      className="absolute right-0 top-full z-30 mt-2 w-[400px] rounded-2xl border border-hairline/50 bg-panel p-4 shadow-2xl outline-none"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-ink">Pre-flight</h2>
        <button
          type="button"
          onClick={() => close(true)}
          aria-label="Close pre-flight editor"
          className="rounded-lg p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={14} />
        </button>
      </div>
      <p className="mt-1 text-[10.5px] leading-relaxed text-ink-secondary">
        Checks that run before the first node of every run — by hand, on a schedule or from a webhook. Any failure
        stops the run before a bot turn is spent, with the check named on the receipt.
      </p>

      <div className="mt-3 max-h-[46vh] space-y-2 overflow-y-auto pr-0.5">
        {checks.length === 0 && (
          <p className="rounded-lg border border-dashed border-hairline/50 px-2.5 py-2 text-[11px] text-ink-secondary">
            No checks yet. A run starts without looking around.
          </p>
        )}
        {checks.map((check, index) => (
          <div key={keysRef.current[index]} className="space-y-1.5 rounded-lg border border-hairline/40 bg-inset p-2.5">
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 rounded-full bg-control px-1.5 py-px text-[10px] font-medium text-ink-secondary">
                {KIND_LABEL[check.kind]}
              </span>
              <input
                aria-label={`Check ${index + 1} name`}
                value={check.name}
                maxLength={120}
                onChange={(event) => update(index, { ...check, name: event.target.value })}
                className={cn(FIELD, "min-w-0 flex-1 bg-panel py-1")}
              />
              <button
                type="button"
                onClick={() => remove(index)}
                aria-label={`Remove check ${check.name || index + 1}`}
                className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-danger"
              >
                <Trash2 size={12} />
              </button>
            </div>

            {check.kind === "command" && (
              <>
                <div>
                  <label className={LABEL} htmlFor={`wf-preflight-${index}-command`}>
                    Command
                  </label>
                  <input
                    id={`wf-preflight-${index}-command`}
                    value={check.command}
                    maxLength={4_000}
                    spellCheck={false}
                    placeholder="gh auth status"
                    onChange={(event) => update(index, { ...check, command: event.target.value })}
                    className={cn(FIELD, "mt-0.5 bg-panel font-mono text-[11.5px]")}
                  />
                </div>
                <div className="grid grid-cols-[1fr_88px] gap-2">
                  <div>
                    <label className={LABEL} htmlFor={`wf-preflight-${index}-cwd`}>
                      Working directory
                    </label>
                    <input
                      id={`wf-preflight-${index}-cwd`}
                      value={check.cwd ?? ""}
                      maxLength={1_000}
                      spellCheck={false}
                      placeholder="(the app's own)"
                      onChange={(event) => {
                        const { cwd: _dropped, ...rest } = check;
                        update(index, event.target.value === "" ? rest : { ...rest, cwd: event.target.value });
                      }}
                      className={cn(FIELD, "mt-0.5 bg-panel font-mono text-[11.5px]")}
                    />
                  </div>
                  <div>
                    <label className={LABEL} htmlFor={`wf-preflight-${index}-exit`}>
                      Exit code
                    </label>
                    <input
                      id={`wf-preflight-${index}-exit`}
                      type="number"
                      inputMode="numeric"
                      value={check.expectExitCode ?? 0}
                      onChange={(event) => {
                        const code = Number(event.target.value);
                        const { expectExitCode: _dropped, ...rest } = check;
                        update(index, code === 0 || Number.isNaN(code) ? rest : { ...rest, expectExitCode: code });
                      }}
                      className={cn(FIELD, "mt-0.5 bg-panel tabular-nums")}
                    />
                  </div>
                </div>
                <div>
                  <label className={LABEL} htmlFor={`wf-preflight-${index}-match`}>
                    Stdout must match (regex, optional)
                  </label>
                  <input
                    id={`wf-preflight-${index}-match`}
                    value={check.expectStdoutMatch ?? ""}
                    maxLength={1_000}
                    spellCheck={false}
                    placeholder="^$ for an empty output"
                    onChange={(event) => {
                      const { expectStdoutMatch: _dropped, ...rest } = check;
                      update(index, event.target.value === "" ? rest : { ...rest, expectStdoutMatch: event.target.value });
                    }}
                    className={cn(FIELD, "mt-0.5 bg-panel font-mono text-[11.5px]")}
                  />
                </div>
              </>
            )}

            {check.kind === "bots-ready" && (
              <div>
                <span className={LABEL}>Bots</span>
                <p className="mt-0.5 text-[10.5px] text-ink-secondary">
                  {check.botIds === undefined
                    ? "Every bot an agent node uses must exist and be free."
                    : "Only the bots ticked below must exist and be free."}
                </p>
                <label className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-ink-secondary" htmlFor={`wf-preflight-${index}-wait`}>
                  Wait up to
                  <input
                    id={`wf-preflight-${index}-wait`}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={WORKFLOW_PREFLIGHT_WAIT_MAX_MIN}
                    value={check.waitMinutes ?? WORKFLOW_PREFLIGHT_WAIT_DEFAULT_MIN}
                    onChange={(event) => {
                      const minutes = Number(event.target.value);
                      const { waitMinutes: _dropped, ...rest } = check;
                      update(
                        index,
                        Number.isNaN(minutes) || minutes === WORKFLOW_PREFLIGHT_WAIT_DEFAULT_MIN ? rest : { ...rest, waitMinutes: minutes },
                      );
                    }}
                    className={cn(FIELD, "w-[64px] bg-panel py-0.5 tabular-nums")}
                  />
                  min for a busy bot to free up; a missing bot fails at once.
                </label>
                <div className="mt-1 flex flex-wrap gap-1">
                  <button
                    type="button"
                    aria-pressed={check.botIds === undefined}
                    onClick={() => {
                      const { botIds: _dropped, ...rest } = check;
                      update(index, rest);
                    }}
                    className={cn(
                      "rounded-lg px-2 py-0.5 text-[10.5px] font-medium",
                      check.botIds === undefined ? "bg-accent text-accent-ink" : "border border-hairline/50 text-ink-secondary hover:bg-raised",
                    )}
                  >
                    All in the workflow
                  </button>
                  {bots.map((bot) => {
                    const on = check.botIds?.includes(bot.id) ?? false;
                    return (
                      <button
                        key={bot.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => {
                          const current = check.botIds ?? [];
                          const botIds = on ? current.filter((id) => id !== bot.id) : [...current, bot.id];
                          update(index, { ...check, botIds });
                        }}
                        className={cn(
                          "rounded-lg px-2 py-0.5 text-[10.5px] font-medium",
                          on ? "bg-accent text-accent-ink" : "border border-hairline/50 text-ink-secondary hover:bg-raised",
                        )}
                      >
                        {bot.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {check.kind === "engine-health" && (
              <div>
                <label className={LABEL} htmlFor={`wf-preflight-${index}-bot`}>
                  Bot whose engine to check
                </label>
                <select
                  id={`wf-preflight-${index}-bot`}
                  value={bots.some((bot) => bot.id === check.botId) ? check.botId : ""}
                  onChange={(event) => update(index, { ...check, botId: event.target.value })}
                  className={cn(FIELD, "mt-0.5 bg-panel")}
                >
                  {!bots.some((bot) => bot.id === check.botId) && (
                    <option value="" disabled>
                      {check.botId ? `Missing bot ${check.botId}` : "Pick a bot"}
                    </option>
                  )}
                  {bots.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name}
                    </option>
                  ))}
                </select>
                <p className="mt-0.5 text-[10.5px] text-ink-secondary">
                  Asks the engine&apos;s driver for its status — CLI present, signed in. Costs no tokens.
                </p>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        <span className="mr-1 text-[10.5px] text-ink-secondary">Add</span>
        {(Object.keys(KIND_LABEL) as WorkflowPreflightCheck["kind"][]).map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => add(kind)}
            className="inline-flex items-center gap-1 rounded-lg border border-hairline/50 px-2 py-1 text-[10.5px] font-medium text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Plus size={10} aria-hidden />
            {KIND_LABEL[kind]}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-[10.5px] text-ink-secondary" htmlFor="wf-preflight-timeout">
          Timeout
          <input
            id="wf-preflight-timeout"
            type="number"
            inputMode="numeric"
            min={WORKFLOW_PREFLIGHT_TIMEOUT_MIN_S}
            max={WORKFLOW_PREFLIGHT_TIMEOUT_MAX_S}
            value={timeoutDraft ?? String(preflight?.timeoutSeconds ?? WORKFLOW_PREFLIGHT_TIMEOUT_DEFAULT_S)}
            onChange={(event) => setTimeoutDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            onBlur={() => {
              if (timeoutDraft === null) return;
              const seconds = Number(timeoutDraft);
              setTimeoutDraft(null);
              // The default is stored as an absence, so a file that never set
              // it and one reset to it are the same file.
              commit(checks, Number.isInteger(seconds) && seconds !== WORKFLOW_PREFLIGHT_TIMEOUT_DEFAULT_S ? seconds : undefined);
            }}
            className={cn(FIELD, "w-[64px] py-0.5 tabular-nums")}
          />
          s
        </label>
      </div>

      {issues.length > 0 && (
        <ul role="alert" className="mt-2 space-y-0.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
          {issues.map((issue) => (
            <li key={issue.message}>{issue.message}</li>
          ))}
        </ul>
      )}

      <div className="mt-3 border-t border-hairline/40 pt-2.5">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              if (!testing) void test();
            }}
            aria-disabled={testing ? true : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border border-hairline/50 px-2.5 py-1.5 text-[11.5px] font-medium",
              testing ? "cursor-wait text-ink-secondary opacity-60" : "text-ink hover:bg-raised",
            )}
          >
            {testing ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <CheckCircle2 size={12} aria-hidden />}
            {testing ? "Testing…" : "Test pre-flight"}
          </button>
          {lastResult && !testing && (
            <span
              role="status"
              className={cn(
                "rounded-full px-2 py-0.5 text-[10.5px] font-medium",
                lastResult.ok ? "bg-success/15 text-success" : "bg-danger/15 text-danger",
              )}
            >
              {lastResult.ok ? "All checks passed" : `${lastResult.checks.filter((check) => !check.ok).length} failed`}
            </span>
          )}
        </div>
        {testError && (
          <p role="alert" className="mt-2 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
            {testError}
          </p>
        )}
        {lastResult && (
          <ul className="mt-2 max-h-[30vh] space-y-1 overflow-y-auto pr-0.5" aria-label="Pre-flight results">
            {lastResult.checks.map((check) => (
              <li key={check.name} className="rounded-lg border border-hairline/40 px-2 py-1.5">
                <div className="flex items-start gap-1.5">
                  {check.ok ? (
                    <CheckCircle2 size={12} aria-hidden className="mt-0.5 shrink-0 text-success" />
                  ) : (
                    <XCircle size={12} aria-hidden className="mt-0.5 shrink-0 text-danger" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="min-w-0 truncate text-[11.5px] font-medium text-ink">{check.name}</span>
                      <span className="text-[10px] text-ink-secondary">{KIND_LABEL[check.kind]}</span>
                    </div>
                    <p className={cn("break-words text-[10.5px] leading-snug", check.ok ? "text-ink-secondary" : "text-danger")}>
                      {preflightResultLine(check)}
                    </p>
                    {check.stdout && (
                      <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-inset px-1.5 py-1 font-mono text-[10px] text-ink-secondary">
                        {check.stdout}
                      </pre>
                    )}
                    {check.stderr && (
                      <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-danger/5 px-1.5 py-1 font-mono text-[10px] text-danger">
                        {check.stderr}
                      </pre>
                    )}
                  </div>
                </div>
              </li>
            ))}
            {lastResult.checks.length === 0 && (
              <li className="text-[10.5px] text-ink-secondary">No checks to run — the pre-flight passes by definition.</li>
            )}
          </ul>
        )}
      </div>

      <p className="mt-3 flex gap-1.5 border-t border-hairline/40 pt-2.5 text-[10.5px] leading-relaxed text-ink-secondary">
        <ShieldAlert size={12} aria-hidden className="mt-0.5 shrink-0 text-warning" />
        <span>
          Commands run as this app&apos;s user, with its environment and credentials, on this computer, and again at
          every start — keep them read-only and idempotent. Only the workflow&apos;s owner should edit them. A
          run&apos;s input is never inserted into a command. Output is scrubbed of known token shapes, not of
          everything: do not print URLs with credentials or passwords in them.
        </span>
      </p>
    </div>
  );
}
