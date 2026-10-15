import type { ReactNode } from "react";

export type IconName = "browser" | "store" | "chart" | "arrow" | "building" | "check" | "chevron" | "code" | "key" | "logout" | "play" | "plus" | "refresh" | "repository" | "shield" | "stop" | "team";

const paths: Record<IconName, ReactNode> = {
  browser: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></>,
  store: <><path d="M3 9h18l-2-6H5L3 9ZM5 13v8h14v-8M9 21v-6h6v6M3 9v1a3 3 0 0 0 6 0V9m0 1a3 3 0 0 0 6 0V9m0 1a3 3 0 0 0 6 0V9" /></>,
  chart: <><path d="M4 3v18h17M8 16v-4M13 16V7M18 16v-7" /></>,
  arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
  building: <><path d="M4 21h16M7 21V3h10v18M10 7h4M10 11h4M10 15h4M11 21v-3h2v3" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m8 10 4 4 4-4" />,
  code: <><path d="m7 6-5 6 5 6m10-12 5 6-5 6M14 4l-4 16" /></>,
  key: <><circle cx="8" cy="9" r="4" /><path d="m11 12 8 8 2-2-2-2 2-2-3-3-2 2" /></>,
  logout: <><path d="M10 4H4v16h6M9 12h12m-4-4 4 4-4 4" /></>,
  play: <path d="m8 4 12 8-12 8V4Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: <><path d="M20 8a8 8 0 0 0-14-2L3 9m0-5v5h5M4 16a8 8 0 0 0 14 2l3-3m0 5v-5h-5" /></>,
  repository: <><path d="M6 3h14v18H6a3 3 0 0 1 0-6h14M3 18V6a3 3 0 0 1 3-3M8 7h8M8 10h5" /></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
  team: <><circle cx="9" cy="7" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 4v2" /></>,
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
