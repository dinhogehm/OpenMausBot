import type { Action } from "@/state/store";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { needsYouKey, type NeedsYouItem } from "@/lib/needs-you";
import { answerRequest, askQuestionSteps, decisionReply, delegateOwnerPending, remindOwnerPending, replyToOwnerPending, resolveOwnerPending, sendToConversation, unsupersedeOwnerPending } from "@/lib/needs-you-actions";
import { copyText } from "@/lib/copy-text";
import { openExternalLink } from "@/lib/app-links";
import { SidebarNeedsYou } from "./SidebarNeedsYou";
import { NeedsYouResolver } from "./NeedsYouResolver";

export function SidebarNeedsYouSection({ needsYou, needsYouClock, density, resolver, setResolver, dispatch }: {
  needsYou: NeedsYouItem[];
  needsYouClock: number;
  density: SidebarDensity;
  resolver: { open: boolean; key: string | null };
  setResolver: (next: { open: boolean; key: string | null }) => void;
  dispatch: (action: Action) => void;
}) {
  return (
    <>
      <SidebarNeedsYou
        items={needsYou}
        now={needsYouClock}
        density={density}
        onOpen={(item) => setResolver({ open: true, key: item ? needsYouKey(item) : null })}
        onResolve={(item) => {
          void resolveOwnerPending(item)
            .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
        }}
      />
      <NeedsYouResolver
        open={resolver.open}
        items={needsYou}
        initialKey={resolver.key}
        onClose={() => setResolver({ open: false, key: null })}
        onOpenConversation={(item) => {
          setResolver({ open: false, key: null });
          dispatch({ type: "switchTask", botId: item.botId, threadId: item.threadId });
        }}
        onOpenLink={(url) => void openExternalLink(url)}
        onCopy={(text) => void copyText(text)}
        onDecide={(item, option) => replyToOwnerPending(item, decisionReply(item, option), dispatch)}
        // a bot's bare question: the server asks the bot for the item, never in the person's words (lot J2)
        onAskSteps={(item) => item.pendingId ? replyToOwnerPending(item, { ask: "steps" }, dispatch) : askQuestionSteps(item)}
        onAskRecommend={(item) => replyToOwnerPending(item, { ask: "recommend" }, dispatch)}
        onReply={(item, text, resolve) => item.pendingId
          ? replyToOwnerPending(item, { text, resolve }, dispatch)
          // an approval or a question in the conversation: the answer is an ordinary message there, awaited
          : sendToConversation(item, text, dispatch)}
        onResolve={resolveOwnerPending}
        onRemind={remindOwnerPending}
        onDelegate={delegateOwnerPending}
        onUnsupersede={unsupersedeOwnerPending}
        // the card the conversation stopped on: the same /respond as the chat's card
        onRequest={(item, request, choice) => answerRequest(item, request, choice, dispatch)}
      />
    </>
  );
}
