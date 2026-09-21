# Skill catalogs

A skill catalog is an index someone publishes at an https URL: a list of
skills, each with a description and a pointer to where its `SKILL.md` lives.
The workspace lists the catalogs it trusts, the way a package manager lists
repositories — there is no single central store, so a team can publish its
own index in its own repo.

A catalog **only points**. It never ships skill content, never enables
anything, and adding one grants nothing on its own.

## Configuring a catalog

`~/.openmausbot/config.json`:

```json
{
  "marketplaces": [
    { "id": "acme", "name": "Acme skills", "url": "https://acme.example/skills.json" }
  ]
}
```

- `id` — lowercase letters, digits and hyphens. This is the stable handle
  recorded on every install, so renaming `name` never orphans what is
  already installed.
- `url` — must be `https`. Redirects are **not** followed: the index is
  fetched from exactly the host you configured.
- At most 20 catalogs.

## The index format

```json
{
  "format": "openmaus.marketplace",
  "version": 1,
  "name": "Acme skills",
  "description": "Skills the platform team maintains.",
  "skills": [
    {
      "id": "release-carrier",
      "name": "Release carrier",
      "description": "Cuts a release branch and writes the changelog.",
      "source": "https://github.com/acme/skills/tree/main/release-carrier",
      "version": "1.2.0",
      "tags": ["release"],
      "license": "MIT",
      "homepage": "https://acme.example/skills/release-carrier"
    }
  ]
}
```

- `source` is anything `skill-fetch` already understands: `owner/repo`, a
  `github.com/owner/repo/tree/<ref>/<folder>` URL, or a direct `SKILL.md`
  blob/raw URL.
- `version` is an opaque string the catalog owns; it defaults to `"0"`. It is
  compared for equality only — a change means "there is a newer release",
  nothing more.
- `id` must be unique. If it repeats, the first entry wins and the rest are
  dropped.
- At most 300 entries, 512KB total. A catalog that is unreachable, oversized
  or malformed degrades to a message beside that catalog; the others still
  list.

## Installing and updating

Installing from a catalog **refetches from the entry's own `source`** and
hands the files to the same reviewed install path a pasted URL uses. That
means the existing policy is unchanged:

- the skill lands **disabled**;
- its files are scanned, hashed and recorded in the bot's manifest;
- someone reads the full `SKILL.md` and explicitly enables it.

The install also records `{ marketplaceId, entryId, version }` on the
manifest entry. That provenance is what lets the catalog view tell three
states apart per bot:

| state | meaning |
| --- | --- |
| `available` | this bot has not installed this entry |
| `installed` | installed, and the recorded release matches the catalog |
| `outdated` | installed, but the catalog now lists a different release |

Matching is by `(marketplaceId, entryId)` — never by display name — so a
renamed entry does not read as a second skill, and a skill installed from
another catalog is not this catalog's business.

**An update is not an inherited decision.** Updating replaces the files and
lands the skill **disabled again**: new text is new text to read. Removal
happens only once the new files are in hand, so a failed fetch leaves the
working skill in place.

## API

| route | what it does |
| --- | --- |
| `GET /api/marketplaces` | the catalogs this workspace lists |
| `GET /api/marketplaces/:id/catalog?bot=<botId>` | the index, resolved against what that bot has installed |
| `POST /api/bots/:id/skills/catalog` | `{ marketplaceId, entryId }` installs; add `updateSkill: "<name>"` to replace an installed copy |

`GET /api/config` also echoes `marketplaces`, so the UI can show the picker
without a second round trip.

A package can also carry the catalogs its skills come from; see
[what a package brings with it](./package-capabilities.md).

Implementation: `server/skill-marketplace.ts`, provenance in
`server/skills.ts`, UI in `src/components/bot-settings/SkillsSection.tsx`.
