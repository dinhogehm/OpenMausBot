import { useEffect, useState } from "react";
import { Check, ExternalLink, Globe, Loader2 } from "lucide-react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";

export interface CustomDomainStatus {
  publicUrl: string | null;
  customDomain: string | null;
  fallbackUrl: string | null;
  supported: boolean;
  appPort: number;
  webhookPort: number;
}

/** Fixed placeholder avoids turning a partially typed domain into shell or
 * Caddy configuration. Ports come from the running server, not the browser. */
export function customDomainProxyExample(status: Pick<CustomDomainStatus, "appPort" | "webhookPort">): string {
  return `bots.example.com {
    handle /hooks/* {
        reverse_proxy 127.0.0.1:${status.webhookPort}
    }
    handle {
        reverse_proxy 127.0.0.1:${status.appPort} {
            flush_interval -1
        }
    }
}`;
}

export function CustomDomainGuide({ status }: { status: CustomDomainStatus }) {
  return (
    <details className="rounded-lg border border-hairline/50 bg-inset px-3 py-2.5 text-[12px] text-ink-secondary">
      <summary className="cursor-pointer font-medium text-ink">{t("settings.domain.guide")}</summary>
      <ol className="mt-3 list-decimal space-y-3 pl-4 leading-relaxed">
        <li>{t("settings.domain.dns")}</li>
        <li>
          {t("settings.domain.proxy")}
          <pre className="mt-2 overflow-x-auto rounded-md bg-app p-3 text-[11px] leading-relaxed text-ink"><code>{customDomainProxyExample(status)}</code></pre>
          <p className="mt-2">{t("settings.domain.proxyHint")}</p>
        </li>
        <li>{t("settings.domain.verifyHint")}</li>
      </ol>
      <p className="mt-3 text-warning">{t("settings.domain.loopbackWarning")}</p>
      <a className="mt-3 inline-flex items-center gap-1.5 text-accent hover:underline" href="https://github.com/milind-soni/OpenMausBot/blob/main/docs/self-hosting.md#connect-a-custom-domain-in-settings" target="_blank" rel="noopener noreferrer">
        {t("settings.domain.fullGuide")} <ExternalLink size={12} />
      </a>
    </details>
  );
}

export function CustomDomainSettings() {
  const [status, setStatus] = useState<CustomDomainStatus | null>(null);
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState<"loading" | "saving" | "removing" | null>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void api("/api/settings/custom-domain", { signal: controller.signal })
      .then((next: CustomDomainStatus) => {
        if (controller.signal.aborted) return;
        setStatus(next);
        setDomain(next.customDomain ?? "");
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("settings.domain.failed"));
      })
      .finally(() => { if (!controller.signal.aborted) setBusy(null); });
    return () => controller.abort();
  }, []);

  const save = async (remove: boolean) => {
    setBusy(remove ? "removing" : "saving");
    setError(null);
    setNotice(null);
    try {
      const next: CustomDomainStatus = await api("/api/settings/custom-domain", {
        method: remove ? "DELETE" : "POST",
        ...(remove ? {} : { body: JSON.stringify({ domain: domain.trim() }) }),
      });
      setStatus(next);
      setDomain(next.customDomain ?? "");
      setNotice(remove ? t("settings.domain.removed") : t("settings.domain.saved"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.domain.failed"));
    } finally { setBusy(null); }
  };

  return (
    <Card title={t("settings.domain.title")} subtitle={t("settings.domain.subtitle")}>
      <div className="space-y-3" data-custom-domain-settings>
        {busy === "loading" && <p role="status" className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />{t("settings.domain.loading")}</p>}
        {status && !status.supported && <p className="text-[13px] leading-relaxed text-ink-secondary">{t("settings.domain.serverOnly")}</p>}
        {status?.supported && (
          <>
            {status.publicUrl && (
              <div className="rounded-lg bg-inset px-3 py-2.5">
                <p className="text-[11px] text-ink-secondary">{t("settings.domain.current")}</p>
                <p className="mt-1 break-all text-[13px] font-medium text-ink">{status.publicUrl}</p>
              </div>
            )}
            <CustomDomainGuide status={status} />
            <form onSubmit={(event) => { event.preventDefault(); if (domain.trim() && !busy) void save(false); }} className="space-y-2">
              <label htmlFor="custom-domain" className="block text-[13px] font-medium text-ink">{t("settings.domain.label")}</label>
              <input id="custom-domain" type="text" value={domain} disabled={busy !== null} onChange={(event) => { setDomain(event.target.value); setNotice(null); }} placeholder="bots.yourcompany.com" autoCapitalize="none" autoCorrect="off" spellCheck={false} className="w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none disabled:opacity-50" />
              <p className="text-[11.5px] leading-relaxed text-ink-secondary">{t("settings.domain.inputHint")}</p>
              <div className="flex flex-wrap gap-2 pt-1">
                <button type="submit" disabled={!domain.trim() || busy !== null} className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-50">
                  {busy === "saving" ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />}
                  {busy === "saving" ? t("settings.domain.verifying") : t("settings.domain.verify")}
                </button>
                {status.customDomain && <button type="button" disabled={busy !== null} onClick={() => void save(true)} className="rounded-lg bg-control px-3 py-2 text-[12px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50">{busy === "removing" ? t("settings.domain.removing") : t("settings.domain.remove")}</button>}
              </div>
            </form>
            {status.customDomain && <p className="text-[11.5px] leading-relaxed text-ink-secondary">{status.fallbackUrl ? t("settings.domain.fallback", { url: status.fallbackUrl }) : t("settings.domain.noFallback")}</p>}
            <p className="text-[11.5px] leading-relaxed text-ink-secondary">{t("settings.domain.scope")}</p>
          </>
        )}
        {notice && <p role="status" className="flex items-start gap-1.5 text-[12px] leading-relaxed text-success"><Check size={14} className="mt-0.5 shrink-0" />{notice}</p>}
        {error && <p role="alert" className="text-[12px] leading-relaxed text-danger">{error}</p>}
      </div>
    </Card>
  );
}
