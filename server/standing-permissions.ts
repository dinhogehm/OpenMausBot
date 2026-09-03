/** The one line every turn of a bot carries about its standing merge/deploy
 * permissions — chat, room and workflow alike — so the bot never has to
 * guess and never tries: the engine refuses a node its bot may not run, and
 * this is how the bot learns the same thing before it is even asked. */
import type { BotCapabilities } from "../shared/workflow.ts";

/** Leading space: it is concatenated straight onto the persona like the
 * other policy lines. Anything but `true` is "not allowed" — a permission
 * nobody granted is not a permission. While something is not allowed, the
 * line also says what to do about it, so a workflow node or a chat request
 * asking for it ends in an honest stop rather than an attempt.
 *
 * Handing the step to a teammate who HOLDS the permission is not a
 * workaround, it is the design: a team keeps one merger and one deployer on
 * purpose, and their turns are checked against their own flags. What the
 * guard forbids is laundering — doing it yourself anyway, pushing it through
 * someone who also lacks it, or asking anyone to bypass the check. An
 * earlier wording banned delegation outright, and a coordinator obeying it
 * stopped a pipeline whose whole shape is "ask the bot that may". */
export function standingPermissionsPrompt(bot: BotCapabilities): string {
  const merge = bot.canMerge === true;
  const deploy = bot.canDeploy === true;
  const state = (allowed: boolean) => (allowed ? "allowed" : "not allowed");
  const guard =
    merge && deploy
      ? ""
      : " Never attempt what is not allowed here and never work around it. You may hand that step to a teammate who carries the permission — their turn is checked against their own standing permissions — but never to one who lacks it, and never by asking anyone to bypass the check. If nobody carries it, stop there and say which permission is missing.";
  return ` Standing permissions: merging pull requests: ${state(merge)}. Deploying to production: ${state(deploy)}.${guard}`;
}
