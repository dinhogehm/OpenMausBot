import { useState } from "react";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { CommandLine } from "./SettingsPrimitives";
import { ConfirmDialog } from "./ConfirmDialog";

export function ClaudeAccountForm({ instance, onSaved, onCancel }: {
  instance?: InstanceInfo;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const { refreshInstances } = useStore();
  const [displayName, setDisplayName] = useState(instance?.displayName ?? "");
  const [configDir, setConfigDir] = useState(instance?.claudeAccount?.configDir ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = !instance || displayName.trim() !== instance.displayName || configDir.trim() !== instance.claudeAccount?.configDir;
  // A blank default means Claude's normal configuration, including its
  // keychain namespace. Do not turn a name-only save into an explicit path.
  const missingDirectory = Boolean(instance?.claudeAccount?.configDir && !configDir.trim());

  const save = async () => {
    if (saving || !displayName.trim() || !dirty || missingDirectory) return;
    setSaving(true);
    setError(null);
    try {
      await api(instance ? `/api/instances/${encodeURIComponent(instance.instanceId)}` : "/api/instances/claude-accounts", {
        method: instance ? "PATCH" : "POST",
        body: JSON.stringify({ displayName: displayName.trim(), ...(configDir.trim() ? { configDir: configDir.trim() } : {}) }),
      });
      // The save has succeeded even if the subsequent catalog refresh fails.
      await refreshInstances().catch(() => {});
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="flex min-w-0 flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
        {t("engines.account.name")}
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder={t("engines.account.namePlaceholder")}
          maxLength={80}
          required
          disabled={saving}
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:border-hairline focus:outline-none disabled:opacity-50"
        />
      </label>
      <details>
        <summary className="cursor-pointer text-[12px] text-ink-secondary hover:text-ink">{t("engines.account.advanced")}</summary>
        <label className="mt-2 flex flex-col gap-1 text-[12px] text-ink-secondary">
          {t("engines.account.configDir")}
          <input
              value={configDir}
              onChange={(event) => setConfigDir(event.target.value)}
              placeholder={t(instance ? "engines.account.defaultDir" : "engines.account.configDirPlaceholder")}
              maxLength={4096}
              spellCheck={false}
              disabled={saving}
              className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink focus:border-hairline focus:outline-none disabled:opacity-50"
          />
        </label>
        <p className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">{t("engines.account.configDirHint")}</p>
        {instance && <p className="mt-1 text-[11.5px] leading-relaxed text-warning">{t("engines.account.changeDirHint")}</p>}
      </details>
      {!instance && <p className="text-[12px] leading-relaxed text-ink-secondary">{t("engines.account.addHint")}</p>}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && <button type="button" onClick={onCancel} disabled={saving} className="rounded-lg px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-raised/50 disabled:opacity-50">{t("common.cancel")}</button>}
        <button type="submit" disabled={saving || !displayName.trim() || !dirty || missingDirectory} className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50">
          {saving && <Loader2 size={13} className="animate-spin" />}
          {instance ? t("common.save") : t("engines.account.add")}
        </button>
      </div>
    </form>
  );
}

export function AddClaudeAccount() {
  const [open, setOpen] = useState(false);
  return open ? (
    <div className="rounded-xl border border-hairline/40 p-3">
      <ClaudeAccountForm onSaved={() => setOpen(false)} onCancel={() => setOpen(false)} />
    </div>
  ) : (
    <button type="button" onClick={() => setOpen(true)} className="flex w-fit items-center gap-1.5 rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-raised/50 hover:text-ink">
      <Plus size={13} />{t("engines.account.add")}
    </button>
  );
}

export function ClaudeAccountSettings({ instance }: { instance: InstanceInfo }) {
  const { state, refreshInstances } = useStore();
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const account = instance.claudeAccount;
  if (!account) return null;
  const assigned = state.bots.some((bot) => bot.modelSelection.instanceId === instance.instanceId);
  const authenticated = instance.snapshot.authenticated === true;
  const identity = authenticated ? [instance.snapshot.account?.email, instance.snapshot.account?.organization].filter(Boolean).join(" · ") : "";

  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await refreshInstances(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    setConfirmRemove(false);
    if (busy || account.isDefault || assigned) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, { method: "DELETE" });
      await refreshInstances().catch(() => {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 space-y-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={cn("min-w-0 break-words", authenticated ? "text-success" : "text-ink-secondary")}>
          {authenticated ? t("engines.account.connected") : instance.snapshot.authenticated === false ? t("model.signInRequired") : t("engines.account.unknown")}
          {identity && ` · ${identity}`}
        </span>
        {account.isDefault && <span className="text-[11px] text-ink-secondary">{t("engines.account.default")}</span>}
        <button type="button" onClick={() => void refresh()} disabled={busy} className="flex items-center gap-1 text-ink-secondary hover:text-ink disabled:opacity-50">
          <RefreshCw size={12} className={cn(busy && "animate-spin")} />{t("engines.account.check")}
        </button>
      </div>
      <details className="rounded-lg border border-hairline/40 px-3 py-2">
        <summary className="cursor-pointer text-ink-secondary hover:text-ink">{t("engines.account.manage")}</summary>
        <div className="mt-3 space-y-3">
          <p className="leading-relaxed text-ink-secondary">{t("engines.account.signInHint")}</p>
          {account.signInShell === "powershell" && <p className="text-ink-secondary">{t("engines.account.powershell")}</p>}
          <CommandLine command={account.signInCommand} copyLabel={t("engineSetup.copyCommand")} />
          <ClaudeAccountForm key={`${instance.displayName}:${account.configDir}`} instance={instance} onSaved={() => {}} />
          {!account.isDefault && (
            <div className="border-t border-hairline/40 pt-2">
              <button type="button" onClick={() => setConfirmRemove(true)} disabled={busy || assigned} className="text-danger hover:underline disabled:no-underline disabled:opacity-50">{t("engines.account.remove")}</button>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">{t(assigned ? "engines.account.assigned" : "engines.account.removeHint")}</p>
            </div>
          )}
        </div>
      </details>
      {error && <p role="alert" className="text-danger">{error}</p>}
      <ConfirmDialog
          open={confirmRemove}
          title={t("engines.account.removeTitle", { name: instance.displayName })}
          body={t("engines.account.removeHint")}
          confirmLabel={t("engines.account.remove")}
          tone="neutral"
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => void remove()}
      />
    </div>
  );
}
