// The two standing permissions a person grants a bot in its profile. They
// are not a workflow-only thing: every turn — chat, room or workflow step —
// the bot is told what it may and may not do, so an existing bot refuses
// "merge PR #12" in plain chat until the switch is on. Nothing is inferred:
// absent means not allowed. The flags ride the same coalesced PATCH lane as
// every other profile switch, so a server echo — or another window flipping
// the same switch — repaints them from the store, never from local state.
import type { BotCapabilities } from "../../shared/workflow";
import { Switch } from "./SettingsPrimitives";

export interface BotCapabilitiesCardProps {
  bot: BotCapabilities;
  onPatch: (patch: BotCapabilities) => void;
}

const ROWS: ReadonlyArray<{ flag: keyof BotCapabilities; label: string; hint: string }> = [
  {
    flag: "canMerge",
    label: "Can merge pull requests",
    hint: "Workflow steps that merge will refuse to run on this bot otherwise.",
  },
  {
    flag: "canDeploy",
    label: "Can deploy to production",
    hint: "Workflow steps that deploy will refuse to run on this bot otherwise.",
  },
];

export function BotCapabilitiesCard({ bot, onPatch }: BotCapabilitiesCardProps) {
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Standing permissions</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        What this bot is allowed to do — off unless you switch it on. Applies in chat and rooms too: the bot is told
        each turn what it may do.
      </div>
      <ul className="mt-3 divide-y divide-hairline/40">
        {ROWS.map(({ flag, label, hint }) => {
          const on = bot[flag] === true;
          return (
            <li key={flag} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <div>
                <div className="text-[13.5px] font-medium text-ink">{label}</div>
                <div className="mt-0.5 text-[12.5px] text-ink-secondary">{hint}</div>
              </div>
              <Switch
                checked={on}
                aria-label={label}
                onClick={() => {
                  const patch: BotCapabilities = {};
                  patch[flag] = !on;
                  onPatch(patch);
                }}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
