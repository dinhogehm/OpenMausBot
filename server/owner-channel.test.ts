import { describe, expect, it } from "vitest";
import { channelTurnThread, leadingVocative, ownerFirstName, routedReplyText, routedWakeNote, routesToChannel, saidToOwner } from "./owner-channel.ts";

// The Chief's real messages of 02/10 in the channel and outside it (R10-followup
// #1), redacted: the owner is "Renata", PRs and clients are placeholders.
const CHANNEL = [
  "Renata, o release d5bb1f70b falhou pela 6ª vez no mesmo ponto (script-contracts). A ação é sua: o14.",
  "Pronto, a resposta está conferida no código: Configurações → Unidades de negócio.",
  "Renata, a #NNNN foi mesclada e o carrier novo está na main.",
  "**Monitor**, confira a conversa do cliente antes de responder.",
];

describe("the one conversation with the owner", () => {
  it("a standing watch or an answer runs in the channel, unless its conversation runs a goal", () => {
    expect(channelTurnThread({ channel: "52417e4a", from: "dbb9f1cf", goalActive: false })).toBe("52417e4a");
    expect(channelTurnThread({ channel: "52417e4a", from: "dbb9f1cf", goalActive: true })).toBe("dbb9f1cf");
    expect(channelTurnThread({ channel: null, from: "dbb9f1cf", goalActive: false })).toBe("dbb9f1cf");
    expect(channelTurnThread({ channel: "52417e4a", from: "52417e4a", goalActive: false })).toBe("52417e4a");
  });

  it("says where the watch lives and which item an answer is about", () => {
    expect(routedWakeNote({ fromTitle: "Vigias  da\nesteira", fromThread: "dbb9f1cf-0000", label: "main" })).toBe("[Nota do OpenMausBot] Quem disparou foi o vigia permanente \"main\" da conversa \"Vigias da esteira\" (dbb9f1cf). Você foi acordado aqui porque esta é a conversa que o dono definiu para falar com ele: responda aqui. O vigia continua naquela conversa e é lá que se muda o motivo dele ou se desliga; não arme outro igual aqui.");
    // INSP-J r1 #5: never teach the gesture that makes a second watch
    expect(routedWakeNote({ fromTitle: "x", fromThread: "y" })).not.toMatch(/arme-o de novo|o que o move/);
    expect(routedReplyText("Sobre \"X\" (o13): Pode fechar.", { id: "o13", threadId: "dc38193b-1111" }, "Atendimento")).toBe("Sobre \"X\" (o13): Pode fechar.\n\n(Pendência o13, aberta na conversa \"Atendimento\" (dc38193b); respondida pela tela \"Precisa de você\".)");
  });

  // INSP-J r1 #6: the real standing watches of 02/10 (ids redacted). Only the
  // Chief's 'main'/'prod' (alone in dbb9f1cf) are the owner's news; the
  // Monitor's 'chat' (clients) and its 'tag' (beside its intake watches) stay.
  it("only the owner's kind of watch, from a conversation that is not intake, fires in the channel", () => {
    const main = ["gh", "api", "repos/o/r/commits/main", "--jq", ".sha"];
    const prod = ["gh", "api", "repos/o/r/git/ref/tags/nuria-production-deployed", "--jq", ".object.sha"];
    const chat = ["gog", "chat", "messages", "list", "spaces/AAAAexample", "--max", "10", "--order", "createTime desc", "--plain"];
    const issues = ["gh", "issue", "list", "-R", "o/r", "--state", "all", "--limit", "50"];
    const sheet = ["gog", "sheets", "get", "SHEET_ID", "Atendimento!A1:G400", "--plain"];
    expect(routesToChannel(main, [main, prod])).toBe(true);
    expect(routesToChannel(prod, [main, prod])).toBe(true);
    expect(routesToChannel(chat, [chat])).toBe(false);
    expect(routesToChannel(prod, [prod, issues, sheet])).toBe(false);
    expect(routesToChannel(["gh", "api", "repos/o/r/issues/9307/comments"], [])).toBe(false);
    expect(routesToChannel(["curl", "-s", "https://docs.google.com/spreadsheets/d/X/export?format=csv"], [])).toBe(false);
  });

  it("knows the owner's name without a profile name: the vocative the bot uses in the channel", () => {
    expect(leadingVocative(CHANNEL[0]!)).toBe("Renata");
    expect(leadingVocative(CHANNEL[1]!)).toBeNull();
    expect(leadingVocative(CHANNEL[3]!)).toBe("Monitor");
    expect(leadingVocative("Renata: feito")).toBeNull();
    // the real profile on this Mac: no name, an aboutMe the bots filled
    const aboutMe = "- 2026-09-29 · learned by Monitor · Renata tem responsabilidade de tomar decisões sobre pontos abertos.";
    const bots = ["Chief of Staff", "Monitor Chat Atendimento", "Delivery PRODEV"];
    expect(ownerFirstName({ profileName: "", aboutMe: "", channelReplies: CHANNEL, botNames: bots })).toBe("Renata");
    // seen once: only when what the bots learned names them
    expect(ownerFirstName({ profileName: undefined, aboutMe: "", channelReplies: CHANNEL.slice(0, 2), botNames: bots })).toBeNull();
    expect(ownerFirstName({ profileName: undefined, aboutMe, channelReplies: CHANNEL.slice(0, 2), botNames: bots })).toBe("Renata");
    // a bot's name is never the owner's, even twice
    expect(ownerFirstName({ aboutMe: "", channelReplies: [CHANNEL[3]!, CHANNEL[3]!], botNames: bots })).toBeNull();
    // the profile, when it has one, wins
    expect(ownerFirstName({ profileName: "Renata Souza", aboutMe: "", channelReplies: [], botNames: bots })).toBe("Renata");
  });

  it("a message is to the owner when it opens with their name, asks them, or says the decision is theirs", () => {
    const outside = "Renata, a #NNNN foi mesclada às 04:13 e a sessão foi arquivada.";
    expect(saidToOwner(outside, { asked: false, ownerName: "Renata" })).toBe(true);
    expect(saidToOwner("**Renata** — a main andou.", { asked: false, ownerName: "Renata" })).toBe(true);
    expect(saidToOwner(outside, { asked: false, ownerName: null })).toBe(false);
    expect(saidToOwner("Renatão, ok", { asked: false, ownerName: "Renata" })).toBe(false);
    expect(saidToOwner("A #NNNN depende de uma decisão sua.", { asked: false, ownerName: null })).toBe(true);
    expect(saidToOwner("Monitor, confira o cliente.", { asked: false, ownerName: "Renata" })).toBe(false);
    expect(saidToOwner("qualquer", { asked: true, ownerName: null })).toBe(true);
  });
});
