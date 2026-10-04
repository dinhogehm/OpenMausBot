import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { BellRing, ChevronRight, ClipboardCopy, ExternalLink, Radar, X } from "lucide-react";
import { openExternalLink } from "@/lib/app-links";
import { serverNotifiedSince } from "@/lib/notify";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  clockText, nowLines, nowLocal, nowMarkdown, nowNews, nowNotificationKeys, nowNotifications, nowSince, seenKeys,
  type NowLine, type NowLineId, type NowTarget, type NowTone,
} from "@/lib/now-status";
import { useStore } from "@/state/store";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { NOW_TICK_MS, type NowSeen, type NowServerStatus } from "../../shared/now-status";
import { useMenuMotion } from "./MenuMotion";

const DOT: Record<NowTone, string> = {
  ok: "bg-success",
  info: "bg-accent",
  warn: "bg-warning",
  danger: "bg-danger",
  muted: "bg-ink-tertiary",
};

/** The panel itself: the lines, what changed since the owner last looked,
 * "Copiar resumo" and the notification switch. Pure render, for tests and
 * the harness; SidebarNow holds the state. */
export function NowPanel({ lines, news, since, firstLook, updatedAt, offline, disabled, notify, canNotify = false, copied, onOpen, onCopy, onToggleNotify, onClose }: {
  lines: NowLine[];
  news: ReadonlySet<NowLineId>;
  /** "Desde 08:30: +1 em produção" (null on the first look). */
  since: string | null;
  firstLook: boolean;
  /** When the server built what is shown; null before the first answer. */
  updatedAt: number | null;
  /** The last request failed: what is shown is from `updatedAt`. */
  offline: boolean;
  /** This Mac does not run the Nuria release. */
  disabled: boolean;
  notify: boolean;
  /** macOS notifications exist here (the desktop app on a Mac): the switch is shown only then. */
  canNotify?: boolean;
  copied: boolean;
  onOpen: (line: NowLine) => void;
  onCopy: () => void;
  onToggleNotify: (on: boolean) => void;
  onClose: () => void;
}) {
  return (
    <div data-now-panel="" className="flex max-h-[inherit] flex-col">
      <div className="flex items-center gap-2 border-b border-hairline/40 py-2 pl-3.5 pr-2">
        <Radar size={15} aria-hidden="true" className="shrink-0 text-ink-secondary" />
        <h2 id="now-panel-title" className="text-[13.5px] font-semibold text-ink">{t("now.title")}</h2>
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-secondary" data-now-updated="">
          {offline ? (updatedAt ? t("now.offline", { at: clockText(updatedAt) }) : t("now.offlineNever")) : updatedAt ? t("now.updated", { at: clockText(updatedAt) }) : t("now.loading")}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("now.close")}
          title={t("now.close")}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {(since || firstLook || disabled) && (
        <p data-now-since="" className="border-b border-hairline/30 px-3.5 py-1.5 text-[11.5px] leading-snug text-ink-secondary">
          {disabled ? t("now.disabled") : firstLook ? t("now.firstLook") : since}
        </p>
      )}
      <ul aria-label={t("now.listAria")} className="min-h-0 flex-1 overflow-y-auto py-1">
        {lines.map((line) => {
          const isNew = news.has(line.id);
          const external = line.target?.kind === "url";
          const body = (
            <>
              <span aria-hidden="true" className={cn("mt-[5px] size-2 shrink-0 rounded-full", DOT[line.tone])} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-ink-secondary">{line.label}</span>
                  {isNew && (
                    <span data-now-new="" className="rounded-full border border-accent-border px-1.5 text-[10px] font-semibold leading-4 text-ink">
                      {t("now.newBadge")}
                      <span className="sr-only"> — {t("now.newAria")}</span>
                    </span>
                  )}
                </span>
                <span className="block break-words text-[12.5px] leading-snug text-ink tabular-nums">{line.text}</span>
                {/* whole, never clamped: a cut detail hides exactly its last fact, and a touch has no tooltip */}
                {line.detail && <span className="block break-words text-[11px] leading-snug text-ink-secondary">{line.detail}</span>}
              </span>
              {line.target && (external
                ? <ExternalLink size={12} aria-hidden="true" className="mt-1 shrink-0 text-ink-secondary" />
                : <ChevronRight size={13} aria-hidden="true" className="mt-1 shrink-0 text-ink-secondary" />)}
            </>
          );
          return (
            <li key={line.id} data-now-line={line.id} data-now-tone={line.tone}>
              {line.target ? (
                <button
                  type="button"
                  onClick={() => onOpen(line)}
                  aria-label={t("now.openLine", { label: line.label, text: [line.text, line.detail].filter(Boolean).join(" · ") }) + (isNew ? ` (${t("now.newAria")})` : "")}
                  title={line.detail ? `${line.text}\n${line.detail}` : line.text}
                  className="flex w-full items-start gap-2.5 px-3.5 py-1.5 text-left outline-none hover:bg-raised/60 focus-visible:bg-raised/60 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus/60"
                >
                  {body}
                </button>
              ) : (
                <div className="flex w-full items-start gap-2.5 px-3.5 py-1.5" title={line.detail ? `${line.text}\n${line.detail}` : line.text}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-1 border-t border-hairline/40 px-2 py-1.5">
        <button
          type="button"
          data-now-copy=""
          onClick={onCopy}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium text-ink hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
        >
          <ClipboardCopy size={13} aria-hidden="true" className="text-ink-secondary" />
          <span aria-live="polite">{copied ? t("now.copied") : t("now.copy")}</span>
        </button>
        {/* only where macOS notifications exist: the desktop app on a Mac (not a phone, not a browser) */}
        {canNotify && <label className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] text-ink hover:bg-raised" title={t("now.notifyHint")}>
          <BellRing size={13} aria-hidden="true" className="text-ink-secondary" />
          {t("now.notify")}
          <input
            type="checkbox"
            data-now-notify=""
            checked={notify}
            onChange={(event) => onToggleNotify(event.target.checked)}
            className="size-3.5 accent-[var(--color-accent)]"
          />
        </label>}
      </div>
    </div>
  );
}

// ── the container: the button at the top of the sidebar, ⌘⇧A, the data ──

const NOTIFY_KEY = "omb-now-notify";
const SENT_KEY = "omb-now-notified";

function storage(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
const readNotify = (): boolean => { try { return storage()?.getItem(NOTIFY_KEY) !== "0"; } catch { return true; } };
const readSent = (): Set<string> | null => {
  try {
    const raw = storage()?.getItem(SENT_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : null;
  } catch { return null; }
};
const writeSent = (sent: Set<string>) => { try { storage()?.setItem(SENT_KEY, JSON.stringify([...sent].slice(-300))); } catch { /* memory keeps it */ } };

/** macOS notifications exist here: the desktop app (its bridge) on a Mac — not a phone, not a browser tab. */
export function macDesktop(env: { bridge: boolean; platform: string } = { bridge: typeof window !== "undefined" && Boolean(window.ogb), platform: typeof navigator === "undefined" ? "" : navigator.platform }): boolean {
  return env.bridge && /^Mac/i.test(env.platform);
}

/** Tab and Shift+Tab stay inside the panel: from its last control to its first, and back. */
export function trapTab(event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">, controls: readonly HTMLElement[], active: Element | null): HTMLElement | null {
  if (event.key !== "Tab" || !controls.length) return null;
  const first = controls[0]!;
  const last = controls.at(-1)!;
  const inside = controls.includes(active as HTMLElement);
  if (event.shiftKey && (active === first || !inside)) { event.preventDefault(); return last; }
  if (!event.shiftKey && (active === last || !inside)) { event.preventDefault(); return first; }
  return null;
}

/** ⌘⇧A (Ctrl+Shift+A): open or close "Agora". */
export const isNowShortcut = (event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): boolean =>
  (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "a";

/** The panel's box: 26rem wide (the window less 12 px a side when narrower),
 * 4 px under the button, tall enough for its lines and never past the
 * bottom; over the sidebar from its left edge (`fromLeft`, the expanded
 * sidebar), or from the button's left (the 80 px icon rail), never past the window. */
export function nowPanelPlace(button: Pick<DOMRect, "left" | "bottom">, viewport: { width: number; height: number }, fromLeft = true): { left: number; top: number; width: number; maxHeight: number } {
  const margin = 12;
  const width = Math.min(416, viewport.width - 2 * margin);
  const left = Math.max(margin, Math.min(fromLeft ? margin : button.left, viewport.width - width - margin));
  const top = button.bottom + 4;
  return { left, top, width, maxHeight: Math.max(240, viewport.height - top - margin) };
}

/** Where a line goes. */
export function openNowTarget(target: NowTarget, actions: { url: (url: string) => void; thread: (botId: string, threadId: string) => void; needsYou: () => void; report: () => void }): void {
  if (target.kind === "url") actions.url(target.url);
  else if (target.kind === "thread") actions.thread(target.botId, target.threadId);
  else if (target.kind === "needsYou") actions.needsYou();
  else actions.report();
}

export function SidebarNow({ density, onOpenNeedsYou }: { density: SidebarDensity; onOpenNeedsYou: () => void }) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<NowSeen | null>(null);
  const [seenLoaded, setSeenLoaded] = useState(false);
  const [offline, setOffline] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [notify, setNotify] = useState(readNotify);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const motion = useMenuMotion(open);
  const server = state.nowStatus;
  const canNotify = macDesktop();

  const load = useCallback(async (refresh = false) => {
    try {
      const res = await fetch(`/api/now${refresh ? "?refresh=1" : ""}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json() as { status: NowServerStatus; seen: NowSeen | null };
      dispatch({ type: "nowStatus", status: body.status });
      setSeen(body.seen);
      setSeenLoaded(true);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [dispatch]);

  // the server pushes a frame when something changes; the minute tick keeps ages true and covers a lost frame
  useEffect(() => {
    if (!state.connected) return;
    void load();
    const timer = window.setInterval(() => { setClock(Date.now()); void load(); }, NOW_TICK_MS);
    return () => window.clearInterval(timer);
  }, [state.connected, load]);
  useEffect(() => { setClock(Date.now()); }, [server]);

  const local = nowLocal(state.bots, clock);
  const lines = nowLines(server, local, clock);
  const news = nowNews(lines, seen);
  const since = nowSince(server, local, seen);

  // discreet notifications: a delivery in production, a new item waiting on the owner — once each
  useEffect(() => {
    if (!server || !seenLoaded) return;
    let sent = readSent();
    if (!sent) {
      // the first look ever: what is already there is not news
      writeSent(new Set(nowNotificationKeys(server, local)));
      return;
    }
    const fresh = nowNotifications(server, local, sent, {
      botNotifies: (botId) => state.bots.find((bot) => bot.id === botId)?.notifications !== false,
      serverNotified: serverNotifiedSince,
    });
    if (!fresh.length) return;
    sent = new Set([...sent, ...fresh.map((each) => each.key)]);
    writeSent(sent);
    if (!canNotify || !notify || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (open && document.hasFocus()) return;
    // what the bot's own turn already announced (or its switch is off) is recorded, not shown twice
    for (const each of fresh.filter((one) => !one.quiet).slice(0, 3)) {
      const shown = new Notification(each.title, { body: each.body, tag: `openmausbot:now:${each.key}`, silent: true });
      shown.onclick = () => { window.focus(); go(each.target); };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the facts, not by every render
  }, [server, seenLoaded, lines.find((line) => line.id === "needsYou")?.fingerprint]);

  const go = (target: NowTarget) => openNowTarget(target, {
    url: (url) => void openExternalLink(url),
    thread: (botId, threadId) => dispatch({ type: "switchTask", botId, threadId }),
    needsYou: onOpenNeedsYou,
    report: () => dispatch({ type: "showReport" }),
  });

  const close = useCallback((focusButton = true) => {
    setOpen(false);
    // what the owner just saw is the base for "novo" next time
    const keys = seenKeys(nowLines(state.nowStatus, nowLocal(state.bots, Date.now()), Date.now()));
    setSeen({ at: Date.now(), keys });
    void fetch("/api/now/seen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keys }) }).catch(() => {});
    if (focusButton) buttonRef.current?.focus();
  }, [state.nowStatus, state.bots]);

  const toggle = useCallback(() => {
    if (open) close();
    else { setOpen(true); void load(true); }
  }, [open, close, load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (isNowShortcut(event)) { event.preventDefault(); toggle(); return; }
      if (open && event.key === "Escape") { event.preventDefault(); close(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, toggle, close]);

  // where the panel sits: under the button, as wide as reads well, inside the window
  const [place, setPlace] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) setPlace(nowPanelPlace(rect, { width: window.innerWidth, height: window.innerHeight }, density !== "icons"));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, density]);

  // focus the panel on open, so the keyboard lands in it (Tab reaches the lines, Esc closes)
  useEffect(() => {
    if (open) window.setTimeout(() => panelRef.current?.focus(), 0);
  }, [open]);

  const copy = () => {
    void navigator.clipboard?.writeText(nowMarkdown(lines, clock, since)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    }).catch(() => {});
  };

  const count = news.size;
  return (
    <div className={density === "icons" ? "relative" : "contents"}>
      <button
        ref={buttonRef}
        type="button"
        data-now-button=""
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={count ? t("now.buttonAriaNews", { count }) : t("now.buttonAria")}
        title={`${t("now.title")} (⌘⇧A)`}
        className="relative flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
      >
        <Radar size={20} strokeWidth={2} aria-hidden="true" />
        {count > 0 && (
          <span data-now-news="" aria-hidden="true" className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-accent px-0.5 text-[9.5px] font-semibold leading-4 text-accent-ink">{count > 9 ? "9+" : count}</span>
        )}
      </button>
      {/* in a portal, fixed under the button: wider than the sidebar, never cut by its edge nor by the phone drawer's transform */}
      {motion.shown && createPortal(
        <>
          <div className={cn("fixed inset-0 z-40", motion.closing && "pointer-events-none")} onMouseDown={() => close(false)} />
          <div
            ref={panelRef}
            role="dialog"
            aria-labelledby="now-panel-title"
            tabIndex={-1}
            // the panel itself takes focus to land the keyboard in it; its lines carry the visible ring
            style={{ ...place, outline: "none" }}
            // the keyboard stays in the panel while it is open (Esc closes it)
            onKeyDown={(event) => {
              const controls = [...(panelRef.current?.querySelectorAll<HTMLElement>("button, input, [href]") ?? [])];
              trapTab(event.nativeEvent, controls, document.activeElement)?.focus();
            }}
            className={cn(
              "fixed z-50 overflow-hidden rounded-xl outline-none border border-hairline/50 bg-menu shadow-2xl shadow-black/60",
              motion.className,
            )}
            {...motion.exitProps}
          >
            <NowPanel
              lines={lines}
              news={news}
              since={since}
              firstLook={seenLoaded && !seen}
              updatedAt={server?.generatedAt ?? null}
              offline={offline}
              disabled={Boolean(server && !server.enabled)}
              notify={notify}
              canNotify={canNotify}
              copied={copied}
              onOpen={(line) => { if (line.target) { close(false); go(line.target); } }}
              onCopy={copy}
              onToggleNotify={(on) => {
                setNotify(on);
                try { storage()?.setItem(NOTIFY_KEY, on ? "1" : "0"); } catch { /* this session only */ }
                if (on && typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
              }}
              onClose={() => close()}
            />
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
