# Project skills and folder scope

Two ways a skill can say *where it belongs*.

## 1. `paths` — an installed skill that only offers itself somewhere

A skill installed into a bot can declare folders in its frontmatter:

```markdown
---
name: release-carrier
description: Cuts a release branch and writes the changelog.
paths: api-service, ~/Projetos/**
---
```

`paths` is a comma-separated list of folder globs:

| pattern | matches |
| --- | --- |
| `api-service` | any folder called `api-service`, anywhere |
| `~/Projetos/**` | `~/Projetos` and everything under it |
| `/srv/deploy` | exactly that folder |
| `api-*` | `api-web`, `api-jobs`, … (one segment) |

`*` stays inside one path segment, `**` crosses segments, `?` is one
character, `~` is the home directory, and matching is case-insensitive
because macOS and Windows compare paths that way. At most 10 globs, 240
characters each; surplus or over-long entries are dropped rather than
failing the import.

A skill with no `paths` is offered everywhere — that is the common case and
the existing behavior.

**`paths` is a relevance filter, not a boundary.** It decides what the
system prompt's skill index lists for the folder this turn runs in. The
skill is still installed, still enabled, and its files are still readable;
native `.claude/skills` discovery is unaffected. Use it to keep the index
short and on-topic, never to hide something from a bot you do not trust.

The bot's settings show the scope under each skill ("Only in …"), so a skill
that is missing from a folder is never a mystery.

## 2. `.openmausbot/skills` — skills the repo carries

A project folder can hold its own skills:

```
my-repo/
  .openmausbot/
    skills/
      release-carrier/
        SKILL.md
```

Every bot working in that folder sees them — after a person reads and
approves each one. Nothing is installed, copied, or enabled: the repo owns
the file, and the workspace owns the approval.

### The review rule

An approval names the **exact bytes** that were read: its sha256 is stored
in `~/.openmausbot/project-skills.json`, keyed by the folder's real path.

| state | what it means | in the prompt |
| --- | --- | --- |
| `pending` | nobody has read it here | invisible — not even its name |
| `changed` | approved once, then the file changed | invisible again |
| `approved` | the bytes on disk are the bytes that were read | listed |

A `git pull`, a teammate's commit, or a hostile branch changes the file and
therefore drops the skill out of every prompt until someone reads it again.
Approving passes the hash that was displayed, so a file that changes while
the review dialog is open cannot be blessed by accident.

Also enforced at discovery:

- `SKILL.md` must be a real file, not a symlink — a project skill is the
  repo's own text or it is nothing;
- the skill folder must be a real directory, not a symlink;
- the frontmatter `name` must equal the folder name, so a SKILL.md cannot
  impersonate a skill an approval was written for;
- the same scan warnings an import gets (base64 blobs, `curl | sh`,
  invisible Unicode) are shown before approving;
- at most 30 skills per folder, 256KB each, and the index block obeys the
  same byte budget as the installed-skills index.

Approvals are per **folder**, not per bot: the folder's files are already
shared by every bot that works there, so a per-bot decision would be
ceremony, not safety. Two checkouts of the same repo are two folders and are
approved separately.

A project skill may declare `paths` too; it is honoured exactly as above.

### API

| route | what it does |
| --- | --- |
| `GET /api/bots/:id/project-skills[?folder=…]` | what the folder carries, with each one's state |
| `GET /api/bots/:id/project-skills/:name` | the exact SKILL.md to review |
| `POST /api/bots/:id/project-skills/:name` | `{ sha256 }` approves those bytes |
| `DELETE /api/bots/:id/project-skills/:name` | withdraws the approval (the file stays) |

Implementation: `server/project-skills.ts`, scope matching in
`server/skills.ts` (`skillScopeMatches`), UI in
`src/components/bot-settings/SkillsSection.tsx`.
