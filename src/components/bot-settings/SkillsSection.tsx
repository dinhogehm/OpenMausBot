// Skills: durable behavior the bot learned or imported, so the user needs a
// normal way to inspect, disable, and remove it after the one-time approval
// card is gone. Moved from SettingsPanel.tsx's LearnedSkillsCard (79-295),
// its nested review dialog raised from z-[80] to z-[90] to float above this
// dialog's own z-50, plus: an Import from GitHub row, a static "when it's
// used" line on every row (learned skills have no triggers to show), and a
// read-only click-through view of a skill's full text.
import { BookOpen, FolderGit2, Store, Trash2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";

import { api, useStore, type Bot } from "@/state/store";
import { skillAuthoringEnabled } from "@/lib/feature-flags";
import { Switch } from "../SettingsPrimitives";
import { inputCls } from "./field";

interface ManagedSkill {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  /** Folder globs from the skill's frontmatter. Empty = offered everywhere;
   * otherwise the index only lists it when the turn runs inside one. */
  paths?: string[];
  warnings: string[];
}

interface StagedSkillSummary {
  id: string;
  name: string;
  gist: string;
}

/** A skill the bot's current folder carries in .openmausbot/skills. Not
 * installed anywhere: the repo owns the file, the person owns the approval. */
interface ProjectSkill {
  name: string;
  description: string;
  paths: string[];
  sha256: string;
  state: "approved" | "pending" | "changed";
  warnings: string[];
  file: string;
}

/** One row of a configured catalog, as the server already resolved it
 * against what this bot has installed. */
interface CatalogEntry {
  id: string;
  name?: string;
  description: string;
  version: string;
  state: "available" | "installed" | "outdated";
  installedAs?: string;
  installedVersion?: string;
}

export function SkillsSection({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const featureEnabled = skillAuthoringEnabled(state.config);
  const [skills, setSkills] = useState<ManagedSkill[]>([]);
  const [staged, setStaged] = useState<StagedSkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [reviewing, setReviewing] = useState<{ skill: ManagedSkill; text: string } | null>(null);
  const [viewing, setViewing] = useState<{ name: string; text: string } | null>(null);
  const [source, setSource] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const marketplaces = state.config?.marketplaces ?? [];
  const [catalogId, setCatalogId] = useState(marketplaces[0]?.id ?? "");
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [projectSkills, setProjectSkills] = useState<ProjectSkill[]>([]);
  const [projectFolder, setProjectFolder] = useState("");
  const [projectReviewing, setProjectReviewing] = useState<{ skill: ProjectSkill; text: string } | null>(null);
  const skillDialogRef = useRef<HTMLDivElement>(null);
  const skillDialogOpen = Boolean(viewing || reviewing || projectReviewing);

  useEffect(() => {
    if (!skillDialogOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = skillDialogRef.current;
    const parentDialog = dialog?.parentElement?.closest<HTMLElement>('[role="dialog"]');
    dialog?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!working) {
          setViewing(null);
          setReviewing(null);
          setProjectReviewing(null);
        }
      }
      if (event.key !== "Tab" || !dialog) return;
      const controls = dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]');
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (previousFocus && previousFocus !== document.body && previousFocus.isConnected) previousFocus.focus();
      else parentDialog?.focus();
    };
  }, [skillDialogOpen, working]);

  const refresh = async (cancelled?: () => boolean) => {
    try {
      const result = (await api(`/api/bots/${bot.id}/skills`)) as {
        skills?: ManagedSkill[];
        staged?: StagedSkillSummary[];
      };
      if (cancelled?.()) return;
      setSkills(result.skills ?? []);
      setStaged(result.staged ?? []);
      setError("");
      const project = (await api(`/api/bots/${bot.id}/project-skills`)) as {
        folder?: string;
        skills?: ProjectSkill[];
      };
      if (cancelled?.()) return;
      setProjectFolder(project.folder ?? "");
      setProjectSkills(project.skills ?? []);
    } catch (cause) {
      if (!cancelled?.()) setError(cause instanceof Error ? cause.message : t("botSkills.loadError"));
    } finally {
      if (!cancelled?.()) setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setReviewing(null);
    setViewing(null);
    setProjectReviewing(null);
    void refresh(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [bot.id]);

  const toggle = async (skill: ManagedSkill) => {
    setWorking(skill.name);
    setError("");
    try {
      if (!skill.enabled) {
        // A disabled import has not necessarily been reviewed. Fetch the
        // integrity-checked bytes and require one explicit review step before
        // they can reach the bot's prompt or native skill discovery.
        const result = (await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`)) as { text?: string };
        if (!result.text) throw new Error(t("botSkills.contentsUnavailable"));
        setReviewing({ skill, text: result.text });
        return;
      }
      await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("botSkills.updateError"));
    } finally {
      setWorking("");
    }
  };

  const enableReviewed = async () => {
    if (!reviewing) return;
    const { skill } = reviewing;
    setWorking(skill.name);
    setError("");
    try {
      await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: true }),
      });
      setReviewing(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("botSkills.enableError"));
    } finally {
      setWorking("");
    }
  };

  const remove = async (skill: ManagedSkill) => {
    if (!window.confirm(`Remove the learned skill “${skill.name}”?`)) return;
    setWorking(skill.name);
    setError("");
    try {
      await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`, { method: "DELETE" });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("botSkills.removeError"));
    } finally {
      setWorking("");
    }
  };

  const view = async (skill: ManagedSkill) => {
    setError("");
    try {
      const result = (await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`)) as { text?: string };
      setViewing({ name: skill.name, text: result.text ?? "" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("botSkills.viewError"));
    }
  };

  const importSkill = async () => {
    const trimmed = source.trim();
    if (!trimmed) return;
    setImporting(true);
    setError("");
    setImportMessage("");
    try {
      const result = (await api(`/api/bots/${bot.id}/skills`, {
        method: "POST",
        body: JSON.stringify({ source: trimmed }),
      })) as { installed?: unknown[] };
      const count = (result.installed ?? []).length;
      setImportMessage(`Imported ${count} skill${count === 1 ? "" : "s"} — review and enable below.`);
      setSource("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("botSkills.importError"));
    } finally {
      setImporting(false);
    }
  };

  const browseCatalog = async (id: string) => {
    setCatalogId(id);
    setCatalog(null);
    setCatalogError("");
    if (!id) return;
    setCatalogLoading(true);
    try {
      const result = (await api(`/api/marketplaces/${encodeURIComponent(id)}/catalog?bot=${bot.id}`)) as {
        entries?: CatalogEntry[];
      };
      setCatalog(result.entries ?? []);
    } catch (cause) {
      setCatalogError(cause instanceof Error ? cause.message : t("botSkills.catalogError"));
    } finally {
      setCatalogLoading(false);
    }
  };

  /** Install, or replace an installed copy with the catalog's current
   * release. Either way the skill lands disabled: the review step below is
   * the only thing that turns one on. */
  const installFromCatalog = async (entry: CatalogEntry) => {
    setWorking(`catalog:${entry.id}`);
    setCatalogError("");
    setImportMessage("");
    try {
      await api(`/api/bots/${bot.id}/skills/catalog`, {
        method: "POST",
        body: JSON.stringify({
          marketplaceId: catalogId,
          entryId: entry.id,
          ...(entry.state === "outdated" && entry.installedAs ? { updateSkill: entry.installedAs } : {}),
        }),
      });
      setImportMessage(t("botSkills.catalogInstalled"));
      await Promise.all([refresh(), browseCatalog(catalogId)]);
    } catch (cause) {
      setCatalogError(cause instanceof Error ? cause.message : t("botSkills.catalogInstallError"));
    } finally {
      setWorking("");
    }
  };

  /** Read the repo's SKILL.md before deciding anything about it. The hash
   * that comes back is the one the approval will name, so approving cannot
   * silently bless a file that changed while the dialog was open. */
  const reviewProjectSkill = async (skill: ProjectSkill) => {
    setError("");
    try {
      const result = (await api(
        `/api/bots/${bot.id}/project-skills/${encodeURIComponent(skill.name)}`,
      )) as { text?: string };
      if (!result.text) throw new Error(t("botSkills.contentsUnavailable"));
      setProjectReviewing({ skill, text: result.text });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("botSkills.viewError"));
    }
  };

  const approveProjectSkill = async () => {
    if (!projectReviewing) return;
    const { skill } = projectReviewing;
    setWorking(`project:${skill.name}`);
    setError("");
    try {
      await api(`/api/bots/${bot.id}/project-skills/${encodeURIComponent(skill.name)}`, {
        method: "POST",
        body: JSON.stringify({ sha256: skill.sha256 }),
      });
      setProjectReviewing(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("botSkills.projectApproveError"));
    } finally {
      setWorking("");
    }
  };

  const revokeProjectSkill = async (skill: ProjectSkill) => {
    setWorking(`project:${skill.name}`);
    setError("");
    try {
      await api(`/api/bots/${bot.id}/project-skills/${encodeURIComponent(skill.name)}`, { method: "DELETE" });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("botSkills.projectRevokeError"));
    } finally {
      setWorking("");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-card p-4">
        <div className="flex items-center gap-2">
          <BookOpen size={16} className="text-ink-secondary" />
          <div className="text-[15px] font-medium text-ink">{t("botSkills.title")}</div>
        </div>
        <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
          {featureEnabled ? t("skills.learned.hintOn") : t("skills.learned.hintOff")}
        </div>

        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void importSkill();
          }}
        >
          <input
            className={inputCls}
            placeholder={t("botSkills.importPlaceholder")}
            aria-label={t("botSkills.importAria")}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <button
            type="submit"
            disabled={importing || !source.trim()}
            className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
          >
            {importing ? t("botSkills.importing") : t("botSkills.import")}
          </button>
        </form>
        {importMessage && <div className="mt-1 text-[12px] text-ink-secondary">{importMessage}</div>}

        {marketplaces.length > 0 && (
          <div className="mt-3 rounded-lg border border-hairline/40 p-3">
            <div className="flex items-center gap-2">
              <Store size={14} className="text-ink-secondary" />
              <div className="text-[12.5px] font-medium text-ink">{t("botSkills.catalogTitle")}</div>
            </div>
            <div className="mt-1 text-[11.5px] text-ink-secondary">{t("botSkills.catalogHint")}</div>
            <div className="mt-2 flex items-center gap-2">
              <select
                className={inputCls}
                aria-label={t("botSkills.catalogPickAria")}
                value={catalogId}
                onChange={(e) => setCatalogId(e.target.value)}
              >
                {marketplaces.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.name || entry.id}</option>
                ))}
              </select>
              <button
                type="button"
                disabled={catalogLoading || !catalogId}
                onClick={() => void browseCatalog(catalogId)}
                className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {catalogLoading ? t("botSkills.catalogLoading") : t("botSkills.catalogBrowse")}
              </button>
            </div>
            {catalogError && <div role="alert" className="mt-2 text-[11.5px] text-danger">{catalogError}</div>}
            {catalog?.length === 0 && (
              <div className="mt-2 text-[11.5px] text-ink-secondary">{t("botSkills.catalogEmpty")}</div>
            )}
            {catalog && catalog.length > 0 && (
              <div className="mt-2 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
                {catalog.map((entry) => (
                  <div key={entry.id} className="flex items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[12px] text-ink">{entry.name || entry.id}</div>
                      <div className="mt-0.5 line-clamp-2 text-[11px] text-ink-secondary">{entry.description}</div>
                      <div className="mt-0.5 text-[10.5px] text-ink-secondary">
                        {entry.state === "outdated"
                          ? t("botSkills.catalogOutdated", { installed: entry.installedVersion ?? "", available: entry.version })
                          : t("botSkills.catalogVersion", { version: entry.version })}
                      </div>
                    </div>
                    {entry.state === "installed" ? (
                      <span className="shrink-0 text-[11px] text-ink-secondary">{t("botSkills.catalogInstalledTag")}</span>
                    ) : (
                      <button
                        type="button"
                        disabled={working === `catalog:${entry.id}`}
                        onClick={() => void installFromCatalog(entry)}
                        className="shrink-0 rounded-lg bg-control px-2.5 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50"
                      >
                        {entry.state === "outdated" ? t("botSkills.catalogUpdate") : t("botSkills.catalogInstall")}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {projectSkills.length > 0 && (
          <div className="mt-3 rounded-lg border border-hairline/40 p-3">
            <div className="flex items-center gap-2">
              <FolderGit2 size={14} className="text-ink-secondary" />
              <div className="text-[12.5px] font-medium text-ink">{t("botSkills.projectTitle")}</div>
            </div>
            <div className="mt-1 break-all text-[11px] text-ink-secondary">
              {t("botSkills.projectHint", { folder: projectFolder })}
            </div>
            <div className="mt-2 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
              {projectSkills.map((skill) => (
                <div key={skill.name} className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[12px] text-ink">{skill.name}</div>
                      <div className="mt-0.5 line-clamp-2 text-[11px] text-ink-secondary">{skill.description}</div>
                      <div className="mt-0.5 text-[10.5px] text-ink-secondary">
                        {skill.state === "approved"
                          ? t("botSkills.projectApproved")
                          : skill.state === "changed"
                            ? t("botSkills.projectChanged")
                            : t("botSkills.projectPending")}
                      </div>
                    </div>
                    {skill.state === "approved" ? (
                      <button
                        type="button"
                        disabled={working === `project:${skill.name}`}
                        onClick={() => void revokeProjectSkill(skill)}
                        className="shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-raised disabled:opacity-50"
                      >
                        {t("botSkills.projectRevoke")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={working === `project:${skill.name}`}
                        onClick={() => void reviewProjectSkill(skill)}
                        className="shrink-0 rounded-lg bg-control px-2.5 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50"
                      >
                        {t("botSkills.projectReview")}
                      </button>
                    )}
                  </div>
                  {skill.warnings.length > 0 && (
                    <div className="mt-1 text-[10.5px] text-warning">{skill.warnings.join(" · ")}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {loading ? (
          <div className="mt-3 text-[12px] text-ink-secondary">{t("botSkills.loading")}</div>
        ) : skills.length === 0 ? (
          <div className="mt-3 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">{t("botSkills.empty")}</div>
        ) : (
          <div className="mt-3 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
            {skills.map((skill) => (
              <div key={skill.name} className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void view(skill)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate font-mono text-[12.5px] text-ink">{skill.name}</div>
                    <div className="mt-0.5 line-clamp-2 text-[11.5px] text-ink-secondary">{skill.description}</div>
                    <div className="mt-0.5 text-[10.5px] text-ink-secondary">{t("botSkills.usedWhen")}</div>
                  </button>
                  <Switch
                    checked={skill.enabled}
                    aria-label={skill.enabled ? t("botSkills.disableAria", { name: skill.name }) : t("botSkills.enableAria", { name: skill.name })}
                    disabled={working === skill.name}
                    onClick={() => void toggle(skill)}
                  />
                  <button
                    aria-label={t("botSkills.removeAria", { name: skill.name })}
                    title={t("botSkills.removeTitle")}
                    disabled={working === skill.name}
                    onClick={() => void remove(skill)}
                    className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <div className="mt-1 truncate text-[10.5px] text-ink-secondary" title={skill.source}>{t("botSkills.source", { source: skill.source })}</div>
                {skill.paths && skill.paths.length > 0 && (
                  <div className="mt-0.5 truncate text-[10.5px] text-ink-secondary">
                    {t("botSkills.scope", { paths: skill.paths.join(", ") })}
                  </div>
                )}
                {skill.warnings.length > 0 && (
                  <div className="mt-1 text-[10.5px] text-warning">{skill.warnings.join(" · ")}</div>
                )}
              </div>
            ))}
          </div>
        )}
        {staged.length > 0 && (
          <div className="mt-2 text-[11.5px] text-warning">
            {staged.length === 1 ? t("botSkills.stagedOne") : t("botSkills.stagedMany", { count: staged.length })}
          </div>
        )}
        {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
      </div>

      {reviewing && (
        <div
          ref={skillDialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="skill-review-title"
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-6"
        >
          <div className="flex max-h-[min(760px,90vh)] w-full max-w-2xl flex-col rounded-2xl bg-card p-5 shadow-2xl">
            <div id="skill-review-title" className="text-[16px] font-semibold text-ink">
              {t("botSkills.reviewTitle", { name: reviewing.skill.name })}
            </div>
            <div className="mt-1 break-all text-[11.5px] text-ink-secondary">
              {t("botSkills.source", { source: reviewing.skill.source })}
            </div>
            {reviewing.skill.warnings.length > 0 && (
              <div className="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-[11.5px] text-warning">
                {reviewing.skill.warnings.join(" · ")}
              </div>
            )}
            <pre
              tabIndex={0}
              aria-label={t("botSkills.fullSkillAria", { name: reviewing.skill.name })}
              className="mt-3 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-inset p-3 font-mono text-[12px] leading-relaxed text-ink"
            >
              {reviewing.text}
            </pre>
            {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={working === reviewing.skill.name}
                onClick={() => setReviewing(null)}
                className="rounded-lg px-4 py-2 text-[13px] font-medium text-ink-secondary hover:bg-raised disabled:opacity-40"
              >
                {t("botSkills.cancel")}
              </button>
              <button
                type="button"
                disabled={working === reviewing.skill.name}
                onClick={() => void enableReviewed()}
                className="rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
              >
                {t("botSkills.enableReviewed")}
              </button>
            </div>
          </div>
        </div>
      )}

      {projectReviewing && (
        <div
          ref={skillDialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="project-skill-review-title"
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-6"
        >
          <div className="flex max-h-[min(760px,90vh)] w-full max-w-2xl flex-col rounded-2xl bg-card p-5 shadow-2xl">
            <div id="project-skill-review-title" className="text-[16px] font-semibold text-ink">
              {t("botSkills.reviewTitle", { name: projectReviewing.skill.name })}
            </div>
            <div className="mt-1 break-all text-[11.5px] text-ink-secondary">
              {t("botSkills.source", { source: projectReviewing.skill.file })}
            </div>
            {projectReviewing.skill.warnings.length > 0 && (
              <div className="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-[11.5px] text-warning">
                {projectReviewing.skill.warnings.join(" · ")}
              </div>
            )}
            <pre
              tabIndex={0}
              aria-label={t("botSkills.fullSkillAria", { name: projectReviewing.skill.name })}
              className="mt-3 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-inset p-3 font-mono text-[12px] leading-relaxed text-ink"
            >
              {projectReviewing.text}
            </pre>
            {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={working === `project:${projectReviewing.skill.name}`}
                onClick={() => setProjectReviewing(null)}
                className="rounded-lg px-4 py-2 text-[13px] font-medium text-ink-secondary hover:bg-raised disabled:opacity-40"
              >
                {t("botSkills.cancel")}
              </button>
              <button
                type="button"
                disabled={working === `project:${projectReviewing.skill.name}`}
                onClick={() => void approveProjectSkill()}
                className="rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
              >
                {t("botSkills.projectApprove")}
              </button>
            </div>
          </div>
        </div>
      )}

      {viewing && (
        <div
          ref={skillDialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="skill-view-title"
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-6"
        >
          <div className="flex max-h-[min(760px,90vh)] w-full max-w-2xl flex-col rounded-2xl bg-card p-5 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
              <div id="skill-view-title" className="text-[16px] font-semibold text-ink">{viewing.name}</div>
              <button
                type="button"
                onClick={() => setViewing(null)}
                className="rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
              >
                {t("botSkills.close")}
              </button>
            </div>
            <pre
              tabIndex={0}
              aria-label={t("botSkills.fullSkillAria", { name: viewing.name })}
              className="mt-3 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-inset p-3 font-mono text-[12px] leading-relaxed text-ink"
            >
              {viewing.text}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
