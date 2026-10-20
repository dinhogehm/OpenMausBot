// A room's held-turns banner and its default responder picker.
import { t } from "@/lib/i18n";
import { Pause } from "lucide-react";
import { useStore, type Bot, type Group, type GroupDefaultResponder } from "@/state/store";
import { defaultResponderName, effectiveDefaultResponder, jevRoomRoutingOn } from "@/lib/group-routing";
import { Select } from "./Select";

export function RoomHoldsBanner({ group, members }: { group: Group; members: Bot[] }) {
  const { dispatch } = useStore();
  const held = members.filter((member) => group.holds?.[member.id]);
  if (!held.length) return null;
  return (
    <div className="w-full px-5">
      <div data-testid="room-holds" className="mb-1 flex flex-wrap items-center gap-1.5 px-2 text-[12px] text-ink-secondary">
        <Pause size={12} aria-hidden="true" />
        <span>{t("room.holds.banner", { names: held.map((member) => member.name).join(", ") })}</span>
        {held.map((member) => (
          <button
            key={member.id}
            type="button"
            onClick={() => dispatch({ type: "setGroupHold", groupId: group.id, botId: member.id, held: false })}
            className="cursor-pointer text-accent hover:underline"
          >
            {t("room.holds.resume", { name: member.name })}
          </button>
        ))}
      </div>
    </div>
  );
}

export function DefaultResponderSelect({ group, members }: { group: Group; members: Bot[] }) {
  const { state, dispatch } = useStore();
  const jevOn = jevRoomRoutingOn(state.config);
  const responder = effectiveDefaultResponder(group, members);
  const value = responder.kind === "member" ? `member:${responder.botId}` : responder.kind;
  const lead = responder.kind === "member" ? members.find((member) => member.id === responder.botId) : undefined;
  const title =
    responder.kind === "everyone"
      ? t("room.responder.everyone")
      : responder.kind === "mentions"
        ? t("room.responder.mentions")
        : responder.kind === "auto"
          ? jevOn
            ? t("room.responder.auto")
            : t("room.responder.autoOff", { name: defaultResponderName(group, members) ?? t("room.responder.leadFallback") })
          : t("room.responder.lead", { name: lead?.name ?? t("room.responder.leadFallback") });

  const change = (nextValue: string) => {
    let next: GroupDefaultResponder;
    if (nextValue === "everyone") next = { kind: "everyone" };
    else if (nextValue === "mentions") next = { kind: "mentions" };
    else if (nextValue === "auto") next = responder.kind === "member" ? { kind: "auto", fallbackBotId: responder.botId } : { kind: "auto" };
    else next = { kind: "member", botId: nextValue.slice("member:".length) };
    dispatch({ type: "patchGroup", groupId: group.id, patch: { defaultResponder: next } });
  };

  return (
    <Select
      variant="pill"
      size="sm"
      className="shrink-0 max-w-[190px]"
      title={title}
      aria-label={t("room.responder.aria")}
      value={value}
      onChange={(event) => change(event.target.value)}
    >
      <optgroup label={t("room.responder.groupLead")}>
        {members.map((member) => (
          <option key={member.id} value={`member:${member.id}`}>
            {t("room.responder.leadOption", { name: member.name })}
          </option>
        ))}
      </optgroup>
      <optgroup label={t("room.responder.groupBehavior")}>
        <option value="auto">{jevOn ? t("room.responder.autoOption") : t("room.responder.autoOptionOff")}</option>
        <option value="everyone">{t("room.responder.everyoneOption")}</option>
        <option value="mentions">{t("room.responder.mentionsOption")}</option>
      </optgroup>
    </Select>
  );
}
