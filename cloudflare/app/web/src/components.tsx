import type { ReactNode } from "react";

export type IconName = "arrow" | "building" | "check" | "chevron" | "key" | "logout" | "play" | "plus" | "refresh" | "shield" | "stop";

const paths: Record<IconName, ReactNode> = {
  arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
  building: <><path d="M4 21h16M7 21V3h10v18M10 7h4M10 11h4M10 15h4M11 21v-3h2v3" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m8 10 4 4 4-4" />,
  key: <><circle cx="8" cy="9" r="4" /><path d="m11 12 8 8 2-2-2-2 2-2-3-3-2 2" /></>,
  logout: <><path d="M10 4H4v16h6M9 12h12m-4-4 4 4-4 4" /></>,
  play: <path d="m8 4 12 8-12 8V4Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: <><path d="M20 8a8 8 0 0 0-14-2L3 9m0-5v5h5M4 16a8 8 0 0 0 14 2l3-3m0 5v-5h-5" /></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand${compact ? " compact" : ""}`} aria-label="Veltram">
    <svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" /><path d="m8 9 8 15 8-15h-5l-3 6-3-6z" /></svg>
    <span>veltram<span className="brand-period">.</span></span>
  </div>;
}

export function Notice({ children, kind = "error" }: { children: ReactNode; kind?: "error" | "success" | "info" }) {
  return <div className={`notice ${kind}`} role={kind === "error" ? "alert" : "status"}>{children}</div>;
}

export function Loading({ label = "Carregando dados" }: { label?: string }) {
  return <div className="loading-state" role="status" aria-label={label}>
    <span className="sr-only">{label}</span><div className="skeleton short" /><div className="skeleton" /><div className="skeleton medium" />
  </div>;
}

export function PageHeading({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return <header className="page-heading"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{children}</p></header>;
}
