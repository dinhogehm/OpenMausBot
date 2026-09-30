import { useEffect, useState } from "react";
import { ChevronDown, Cloud, Laptop } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** The dropdown is native: a remote workspace cannot choose a destination
 * itself or read the other workspaces saved on this computer. */
export function DesktopWorkspaceSwitcher({ compact = false }: { compact?: boolean }) {
  const bridge = window.ogb?.workspaces;
  const [current, setCurrent] = useState<{ local: boolean; name: string; origin?: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void bridge?.state().then((state) => { if (alive) setCurrent(state); }).catch(() => {});
    return () => { alive = false; };
  }, [bridge]);
  if (!bridge) return null;
  // this computer reads "This computer" in the person's language
  const name = current ? (current.local ? t("place.local") : current.name) : t("workspaceSwitcher.servers");
  const Icon = current?.local === false ? Cloud : Laptop;
  return <div className={cn("py-1.5", compact ? "px-2" : "px-3")}>
    <button type="button" aria-label={t("workspaceSwitcher.aria", { name })} aria-haspopup="menu" aria-expanded={open}
      title={current?.origin ? `${name} · ${current.origin}` : name}
      onClick={() => {
        if (open) return;
        setError(""); setOpen(true);
        void bridge.menu().catch(() => setError(t("workspaceSwitcher.menuError"))).finally(() => setOpen(false));
      }}
      className={cn("flex w-full items-center gap-2 rounded-lg py-2 text-left text-[13px] font-medium text-ink hover:bg-control focus-visible:outline focus-visible:outline-accent", compact ? "justify-center px-1" : "px-2")}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <Icon size={16} className="shrink-0 text-ink-secondary" />
      {!compact && <><span className="min-w-0 flex-1 truncate">{name}</span><ChevronDown size={13} className="shrink-0 text-ink-secondary" /></>}
    </button>
    {error && <p role="alert" className="mt-1 text-[11px] text-danger">{error}</p>}
  </div>;
}
