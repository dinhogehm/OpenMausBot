# Jev (TypeSafe) in OpenMausBot

[Jev](https://docs.typesafe.ai/) is TypeSafe's *System One* model. It is not a
chat model: it never writes prose or calls tools. You give it a `state` (any
text or JSON) and a map of typed questions, and it answers every question at
once with calibrated probabilities in ~100–500 ms, billed on input tokens only.

Three question types exist:

| type     | asks                                | answer                                  |
| -------- | ----------------------------------- | --------------------------------------- |
| `noul`   | a yes/no question                   | `noul` 0–1 (probability of yes)          |
| `choice` | pick one option from a set you name | `choice`, `probabilities`, `confidence` |
| `score`  | rate along ordered levels           | `score`, `legend`, `confidence`          |

Because it only decides, OpenMausBot uses it in three places. All three read
the same key.

## Setup

Two front doors reach the same model, at the same price:

- **An OpenRouter key** (the one the OpenRouter engine already uses). Jev is
  listed there as `~typesafe/jev-latest` / `typesafe/jev-1.13` and answered
  through OpenRouter's Decisions endpoint. Nothing else to configure: every
  Jev feature below lights up as soon as `openrouter.key` is saved.
- **A TypeSafe key** from <https://console.typesafe.ai/settings/keys>, pasted
  in **Settings → API keys → TypeSafe (Jev)** or put in the config. When both
  keys exist, the TypeSafe key wins.

```json
{ "typesafe": { "key": "…", "model": "jev-latest", "permissionReview": false } }
```

`TYPESAFE_API_KEY` / `TYPESAFE_MODEL` in the server's environment win over the
file, like every other credential. `model` is optional — `jev-latest` follows
the newest stable release; pin `jev-1.13.0` if you tuned thresholds against it
(through OpenRouter that resolves to `typesafe/jev-1.13`).

## 1. The `jev` engine (decision bot)

`Jev (TypeSafe)` appears in the model picker like any engine. A bot on it turns
every incoming message into the `state` and answers with one line per
question plus the raw JSON. Where the questions come from, in order:

1. **The message itself** — send a JSON object (bare or in a ```` ```json ````
   block) shaped `{ "state": …, "questions": { … } }`. `state` is optional;
   without it, the text around the block is evaluated.
2. **The bot's instructions** — a ```` ```json ```` block containing
   `{ "questions": { … } }` in the bot's description/system prompt makes that
   bot a fixed classifier: every message is judged against those questions.
3. **The instance config** — `"instances": { "jev": { "driver": "jev", "config": { "questions": { … } } } }`.
4. **A built-in triage set** — `intent` (choice), `urgency` (noul),
   `sentiment` (score) and `needs_human` (noul), when nothing else is set.

Example bot instructions:

````markdown
Route support tickets.

```json
{ "questions": {
  "department": { "type": "choice", "instructions": "Which team should handle this?",
    "criteria": { "billing": "Payments, invoicing, refunds", "technical": "Bugs, outages, integrations", "sales": "Pricing, upgrades" } },
  "is_urgent": { "type": "noul", "instructions": "Does this convey urgency?" }
} }
```
````

The engine has no tools, no images and no peer messaging; the picker never
offers what the driver cannot mount.

## 2. Permission review

Bots with **auto-review** set to *shadow* or *enforce* normally ask the same
provider that raised a permission card whether to approve it. Turn on **Let
Jev review permission requests** (or `"typesafe": { "permissionReview": true }`)
and Jev becomes the reviewer instead, for every engine — including API-key
engines that have no reviewer of their own.

Jev answers a `choice` (`allow` / `deny`) and a `noul` (*could this be
irreversible, external, or touch credentials, money or access?*). The card is
auto-approved only when it picks `allow` with confidence ≥ 0.6 **and** the risk
probability is < 0.5; anything else, an error, or a timeout leaves the card for
a human. The decision log records the verdict as
`jev-1.13.0: allow 91% (confidence 82%), risk 8%`.

This is opt-in on purpose: enabling it sends each permission summary (bot
persona, tool name, one-line action) to TypeSafe instead of keeping it inside
the provider that opened the request.

### Engines with no reviewer of their own

The chat-completions engines (OpenRouter, openai-compat, Grok API, MiniMax)
have no Auto reviewer, so in Auto mode every tool call opens a card marked
*the provider requires your approval*. With permission review on, Jev is that
engine's reviewer: those cards go to Jev first and only its denials reach
you. Engines with a native reviewer (Claude, Codex, Cursor, Grok CLI, Qwen)
keep their own declines for a person — Jev never overrules a reviewer that
already said no.

### Flagged actions

A cheap pattern guard sends actions that look destructive or touch
credentials straight to a person. **Let Jev judge flagged actions too**
(`"typesafe": { "reviewGuarded": true }`) hands those to Jev first, with the
guard's match in the state as evidence; the same confidence and risk bars
apply, so most of them still end up with you — but a `git push --force` to
your own branch no longer has to.

### Nobody watching

Scheduled routines, workflow nodes and webhooks run with nobody at the
keyboard. The harness fails closed there: Auto mode is withheld, only a named
`always-allow` grant fires, and a workflow node's card is denied on the spot
(`denied unattended: … — auto mode does not answer with nobody watching`).

A second switch, **Let Jev also answer while nobody is watching**
(`"typesafe": { "reviewUnattended": true }`, needs `permissionReview` too),
lets Jev stand in for the absent person on exactly those cards, under
stricter bars: `allow` with confidence ≥ 0.75 **and** risk < 0.3. It never
reaches past the destructive/sensitive guards, a sandbox widening, a
host-desktop request, or a provider that demands a person — those still deny
at once. A Jev denial falls through to the same fail-fast path, so a workflow
run still moves on inside the minute, and the decision log marks every such
row `unattended`.

## 3. Smart room routing

A room's default responder can be **Smart routing (Jev)**. When a message
carries no `@mention`, Jev is asked which member's persona (name, title,
description) best fits it. A pick with confidence ≥ 0.35 answers and the room
shows *Jev routed this to …*; a weaker pick, an error, or a missing key falls
back to the first active member. Explicit mentions and `@everyone` still win,
and goal mode keeps choosing its coordinator the usual way.
