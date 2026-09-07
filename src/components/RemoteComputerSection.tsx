import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { Laptop, Loader2, Unplug } from "lucide-react";
import { Card } from "./SettingsPrimitives";

const inputClass =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

function errorText(error: unknown): string {
  return String((error as { message?: string })?.message ?? error).replace(
    /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/,
    "",
  );
}

export function RemoteComputerSection() {
  const bridge = window.ogb?.remoteClient;
  const [state, setState] = useState<DesktopRemoteClientState>({ active: bridge?.active === true });
  const [endpoint, setEndpoint] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    void bridge?.state().then((next) => alive && setState(next)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [bridge]);

  const pair = async () => {
    if (!bridge) return;
    setBusy(true);
    setError("");
    try {
      const next = await bridge.pair(endpoint, code);
      setState(next);
    } catch (nextError) {
      setError(errorText(nextError));
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!bridge) return;
    setBusy(true);
    setError("");
    try {
      await bridge.disconnect();
    } catch (nextError) {
      setError(errorText(nextError));
      setBusy(false);
    }
  };

  return (
    <Card
      title={state.active ? t("remote.client.active") : t("remote.client.idle")}
      subtitle={t("remote.client.subtitle")}
    >
      {!bridge ? (
        <p className="text-[13px] text-ink-secondary">{t("remote.client.desktopOnly")}</p>
      ) : state.active ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3 rounded-lg border border-success/25 bg-success/10 px-3 py-3">
            <Laptop size={18} className="mt-0.5 shrink-0 text-success" />
            <div className="min-w-0">
              <div className="text-[14px] font-medium text-ink">
                {t("remote.client.connected", { name: state.serverName || t("remote.client.fallbackName") })}
              </div>
              <div className="mt-1 break-all text-[12px] text-ink-secondary">{state.endpoint}</div>
            </div>
          </div>
          <p className="text-[12.5px] leading-relaxed text-ink-secondary">
            {t("remote.client.mode")}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void disconnect()}
            className="flex w-fit items-center gap-2 rounded-lg border border-danger/30 px-3 py-2 text-[13px] text-danger hover:bg-danger/10 disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Unplug size={14} />}
            {t("remote.client.disconnect")}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[12.5px] leading-relaxed text-ink-secondary">
            {t("remote.client.hostHint")}
          </p>
          <label className="flex flex-col gap-1.5 text-[12px] text-ink-secondary">
            {t("remote.client.hostAddress")}
            <input
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://…openmausbot.com or computer.tailnet.ts.net"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[12px] text-ink-secondary">
            {t("remote.client.pairingCode")}
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              inputMode="numeric"
              autoComplete="one-time-code"
              className={`${inputClass} max-w-40 font-mono tracking-[0.2em]`}
            />
          </label>
          {error ? <p role="alert" className="text-[12.5px] text-danger">{error}</p> : null}
          <button
            type="button"
            disabled={busy || endpoint.trim() === "" || code.length !== 6}
            onClick={() => void pair()}
            className="flex w-fit items-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Laptop size={14} />}
            {t("remote.client.pair")}
          </button>
          <p className="text-[11.5px] leading-relaxed text-ink-secondary">
            {t("remote.client.restartNote")}
          </p>
        </div>
      )}
      {state.active && error ? <p role="alert" className="mt-3 text-[12.5px] text-danger">{error}</p> : null}
    </Card>
  );
}
