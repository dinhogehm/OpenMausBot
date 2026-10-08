import { describe, expect, it } from "vitest";

import {
  BOT_CHATS_SECTION_ID,
  BOTS_SECTION_ID,
  CHANNELS_SECTION_ID,
  PINNED_SECTION_ID,
  mergeSectionOrder,
  moveSection,
  orderedSidebarSections,
  partitionSidebarBots,
  partitionSidebarGroups,
  pinnedCircleThreadListVisible,
  placeSection,
  sidebarConnectorPreview,
  sidebarLayoutInteractive,
  sidebarGoalRunPreview,
  sidebarRoutineRunPreview,
  sidebarSectionCollapsed,
  sidebarSectionLabel,
  userSectionId,
  userSectionName,
} from "./sidebar-layout";
import ptBr from "../locales/pt-br.json";

describe("sidebar virtual sections", () => {
  it("keeps reserved labels separate from identically named user sections", () => {
    for (const name of ["Pinned", "pinned", "channels", "bots", "bot-chats", "Bot Chats"]) {
      const id = userSectionId(name);
      expect([PINNED_SECTION_ID, CHANNELS_SECTION_ID, BOT_CHATS_SECTION_ID, BOTS_SECTION_ID]).not.toContain(id);
      expect(userSectionName(id)).toBe(name);
      expect(sidebarSectionLabel(id)).toBe(name);
    }
    expect(sidebarSectionLabel(CHANNELS_SECTION_ID)).toBe("Group chats");
    expect(sidebarSectionLabel(BOT_CHATS_SECTION_ID)).toBe("Bot threads");
  });

  it("round-trips every valid section name without URI encoding", () => {
    const maxLengthEmojiName = "🧠".repeat(30);
    expect(maxLengthEmojiName).toHaveLength(60);

    for (const name of ["Design / Research", "100%", "\ud800", maxLengthEmojiName]) {
      const id = userSectionId(name);
      expect(id).toBe(`section:${name}`);
      expect(userSectionName(id)).toBe(name);
      expect(sidebarSectionLabel(id)).toBe(name);
    }
  });

  it("shows pinned bots once without erasing their saved context", () => {
    const bot = { id: "writer", section: "Work", pinned: true };
    const parts = partitionSidebarBots([
      { id: "chief", chiefOfStaff: true },
      bot,
      { id: "plain" },
      { id: "hidden", hidden: true, pinned: true },
    ]);
    expect(parts.unsectionedChief?.id).toBe("chief");
    expect(parts.pinnedBots).toEqual([bot]);
    expect(parts.sectionedBots).toEqual([]);
    expect(parts.unsectionedBots.map((candidate) => candidate.id)).toEqual(["plain"]);
    expect(bot.section).toBe("Work");
  });

  it("shows DMs in Bot Chats without rewriting their comms context", () => {
    const dm = { id: "dm", dm: true, section: "Work" };
    const namedBotChats = { id: "named", section: "Bot Chats" };
    const parts = partitionSidebarGroups([
      dm,
      { id: "project", section: "Work" },
      namedBotChats,
      { id: "general" },
    ]);
    expect(parts.botChats).toEqual([dm]);
    expect(parts.sectionedRooms.map((room) => room.id)).toEqual(["project", "named"]);
    expect(parts.unsectionedRooms.map((room) => room.id)).toEqual(["general"]);
    expect(dm.section).toBe("Work");
    expect(namedBotChats.section).toBe("Bot Chats");
  });

  it("keeps section Chiefs in their actual section", () => {
    const chief = { id: "chief", chiefOfStaff: true, section: "Work", pinned: true };
    const parts = partitionSidebarBots([chief]);
    expect(parts.sectionChiefs).toEqual([chief]);
    expect(parts.pinnedBots).toEqual([]);
  });

  it("lifts pinned bots from every group when pins are universal", () => {
    const workChief = { id: "work-chief", chiefOfStaff: true, section: "Work", pinned: true };
    const home = { id: "home", section: "Home", pinned: true };
    const looseChief = { id: "loose", chiefOfStaff: true, pinned: true };
    const stay = { id: "stay", section: "Work" };
    const hidden = { id: "hidden", section: "Home", pinned: true, hidden: true };
    const parts = partitionSidebarBots(
      [workChief, home, looseChief, stay, hidden],
      { universalPins: true },
    );
    expect(parts.pinnedBots.map((bot) => bot.id)).toEqual(["work-chief", "home", "loose"]);
    expect(parts.sectionChiefs).toEqual([]);
    expect(parts.unsectionedChief).toBeNull();
    expect(parts.sectionedBots).toEqual([stay]);
    expect(workChief.section).toBe("Work");
    expect(home.section).toBe("Home");
  });

  it("shows pinned-circle thread rows only while the circle grid is showing", () => {
    expect(pinnedCircleThreadListVisible(true, "comfortable", 1)).toBe(true);
    expect(pinnedCircleThreadListVisible(true, "compact", 2)).toBe(true);
    expect(pinnedCircleThreadListVisible(false, "comfortable", 1)).toBe(false);
    expect(pinnedCircleThreadListVisible(true, "icons", 1)).toBe(false);
    expect(pinnedCircleThreadListVisible(true, "comfortable", 0)).toBe(false);
  });

  it("forces filtered and icon-only views open and non-reorderable", () => {
    expect(sidebarLayoutInteractive("comfortable", "")).toBe(true);
    expect(sidebarLayoutInteractive("comfortable", "writer")).toBe(false);
    expect(sidebarLayoutInteractive("icons", "")).toBe(false);
    expect(sidebarSectionCollapsed(PINNED_SECTION_ID, [PINNED_SECTION_ID], "compact", "")).toBe(true);
    expect(sidebarSectionCollapsed(PINNED_SECTION_ID, [PINNED_SECTION_ID], "compact", "writer")).toBe(false);
    expect(sidebarSectionCollapsed(PINNED_SECTION_ID, [PINNED_SECTION_ID], "icons", "")).toBe(false);
  });

  it("keeps a terminal channel goal meaningful in the sidebar", () => {
    expect(sidebarGoalRunPreview({
      runId: "run-1",
      goal: "Ship the launch post",
      status: "completed",
      coordinatorBotId: "lead",
      coordinatorName: "Lead",
      turnCount: 3,
      maxTurns: 13,
      detail: "Drafted and verified.",
      startedAt: 1,
      finishedAt: 2,
    })).toBe("Completed: Drafted and verified.");
  });

  it("previews a connection card by its app and state, not the phone fallback line", () => {
    const say = (key: string) => ({
      "connectors.card.connected": "Connected",
      "connectors.card.waiting": "Waiting for sign-in…",
      "connectors.card.connectSecurely": "Connect securely",
    })[key] ?? key;
    const card = { label: "GitHub", status: "required" as const };
    expect(sidebarConnectorPreview(card, say)).toBe("GitHub · Connect securely");
    expect(sidebarConnectorPreview({ ...card, status: "failed" }, say)).toBe("GitHub · Connect securely");
    expect(sidebarConnectorPreview({ ...card, status: "authorizing" }, say)).toBe("GitHub · Waiting for sign-in…");
    expect(sidebarConnectorPreview({ ...card, status: "connected" }, say)).toBe("GitHub · Connected");
    expect(sidebarConnectorPreview({ ...card, dismissed: true }, say)).toBe("GitHub");
  });

  // R13-visual N25: the Monitor's pinned row read 'Routine "Atendimento: Chat, planilha e i…' all day
  it("previews a routine run by what it said, else its state in the reader's language — never the English fallback line", () => {
    const say = (key: keyof typeof ptBr, params: { name: string }) => ptBr[key].replace("{name}", params.name);
    // the Monitor's real run of 06/10 23:00 (f8933c22), its summary as the card carries it
    const run = {
      routineName: "Atendimento: Chat, planilha e issues",
      status: "completed" as const,
      summary: "Terminei a passada das 23h e não postei nada no Chat. Não havia demanda nova nem mudança de status para avisar.\n\n- **Chat:** a última mensagem ainda é a sua das 18:58.\n- **GitHub:** a única novidade é um comentário das 22:09 na [#9395](https://github.com/dinhogehm/nuria-platform/issues/9395).",
    };
    expect(sidebarRoutineRunPreview(run, say)).toBe("Terminei a passada das 23h e não postei nada no Chat. Não havia demanda nova nem mudança de status para avisar. Chat: a última mensagem ainda é a sua das 18:58. GitHub: a única novidade é um comentário das 22:09 na #9395.");
    expect(sidebarRoutineRunPreview({ ...run, summary: undefined }, say)).toBe("Rotina “Atendimento: Chat, planilha e issues” concluída");
    expect(sidebarRoutineRunPreview({ ...run, summary: undefined, goalStatus: "needs-input" }, say)).toBe("Rotina “Atendimento: Chat, planilha e issues” precisa da sua resposta");
    // a failure says so in pt-BR; the provider's error is not the bot speaking
    expect(sidebarRoutineRunPreview({ ...run, status: "failed" }, say)).toBe("Rotina “Atendimento: Chat, planilha e issues” falhou");
    // a "completed" run whose goal did not complete says how it ended, never "concluída" (INSP-R13VIS A6)
    const ended = (goalStatus: "blocked" | "limit-reached" | "stopped" | "failed" | "paused") => sidebarRoutineRunPreview({ ...run, summary: undefined, goalStatus }, say);
    expect(ended("blocked")).toBe("Rotina “Atendimento: Chat, planilha e issues” travou");
    expect(ended("limit-reached")).toBe("Rotina “Atendimento: Chat, planilha e issues” chegou ao limite de passos");
    expect(ended("stopped")).toBe("Rotina “Atendimento: Chat, planilha e issues” interrompida");
    expect(ended("failed")).toBe("Rotina “Atendimento: Chat, planilha e issues” falhou");
    expect(ended("paused")).toBe("Rotina “Atendimento: Chat, planilha e issues” pausada");
    expect(sidebarRoutineRunPreview({ ...run, summary: undefined, goalStatus: "completed" }, say)).toBe("Rotina “Atendimento: Chat, planilha e issues” concluída");
    for (const status of ["queued", "running", "waiting", "completed", "failed", "cancelled", "missed"] as const) {
      expect(sidebarRoutineRunPreview({ ...run, status, summary: undefined }, say)).not.toMatch(/Routine/);
    }
  });
});

describe("sidebar section ordering", () => {
  const natural = [
    PINNED_SECTION_ID,
    CHANNELS_SECTION_ID,
    BOT_CHATS_SECTION_ID,
    BOTS_SECTION_ID,
    userSectionId("Work"),
  ];

  it("uses natural order when no preference exists", () => {
    expect(orderedSidebarSections(natural, [])).toEqual(natural);
  });

  it("preserves a user move and inserts a newly visible bucket naturally", () => {
    const withoutBotChats = natural.filter((id) => id !== BOT_CHATS_SECTION_ID);
    const saved = [userSectionId("Work"), PINNED_SECTION_ID, CHANNELS_SECTION_ID, BOTS_SECTION_ID];
    expect(orderedSidebarSections(withoutBotChats, saved)).toEqual(saved);
    expect(orderedSidebarSections(natural, saved)).toEqual([
      userSectionId("Work"),
      PINNED_SECTION_ID,
      CHANNELS_SECTION_ID,
      BOT_CHATS_SECTION_ID,
      BOTS_SECTION_ID,
    ]);
  });

  it("moves and drops sections without wrapping", () => {
    expect(moveSection(natural, CHANNELS_SECTION_ID, -1)).toEqual([
      CHANNELS_SECTION_ID,
      PINNED_SECTION_ID,
      BOT_CHATS_SECTION_ID,
      BOTS_SECTION_ID,
      userSectionId("Work"),
    ]);
    expect(moveSection(natural, PINNED_SECTION_ID, -1)).toBe(natural);
    expect(placeSection(natural, BOTS_SECTION_ID, PINNED_SECTION_ID, "before")).toEqual([
      BOTS_SECTION_ID,
      PINNED_SECTION_ID,
      CHANNELS_SECTION_ID,
      BOT_CHATS_SECTION_ID,
      userSectionId("Work"),
    ]);
  });

  it("retains empty sections in their saved slot", () => {
    const visible = natural.filter((id) => id !== CHANNELS_SECTION_ID);
    expect(mergeSectionOrder(natural, visible)).toEqual(natural);
  });

  it("retains leading empty sections before their next visible successor", () => {
    const work = userSectionId("Work");
    const personal = userSectionId("Personal");
    const saved = [work, personal, PINNED_SECTION_ID, CHANNELS_SECTION_ID];

    expect(mergeSectionOrder(saved, [PINNED_SECTION_ID, CHANNELS_SECTION_ID])).toEqual(saved);
  });

  it("preserves a leading empty section when visible sections were reordered", () => {
    const work = userSectionId("Work");
    const saved = [work, PINNED_SECTION_ID, CHANNELS_SECTION_ID];

    expect(mergeSectionOrder(saved, [CHANNELS_SECTION_ID, PINNED_SECTION_ID])).toEqual([
      CHANNELS_SECTION_ID,
      work,
      PINNED_SECTION_ID,
    ]);
  });
});
