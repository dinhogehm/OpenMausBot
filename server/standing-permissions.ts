/** The one line every turn of a bot carries about its standing merge/deploy
 * permissions — chat, room and workflow alike — so the bot never has to
 * guess and never tries: the engine refuses a node its bot may not run, and
 * this is how the bot learns the same thing before it is even asked. */
import type { BotCapabilities } from "../shared/workflow.ts";

/** Leading space: it is concatenated straight onto the persona like the
 * other policy lines. Anything but `true` is "not allowed" — a permission
 * nobody granted is not a permission. While something is not allowed, the
 * line also says what to do about it, so a workflow node or a chat request
 * asking for it ends in an honest stop rather than an attempt. */
export function standingPermissionsPrompt(bot: BotCapabilities): string {
  const merge = bot.canMerge === true;
  const deploy = bot.canDeploy === true;
  const state = (allowed: boolean) => (allowed ? "allowed" : "not allowed");
  const guard =
    merge && deploy
      ? ""
      : " Never attempt, delegate, or work around anything not allowed here: stop at that step and say the permission is missing.";
  return ` Standing permissions: merging pull requests: ${state(merge)}. Deploying to production: ${state(deploy)}.${guard}`;
}
