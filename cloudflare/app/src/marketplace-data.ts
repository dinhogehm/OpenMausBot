// Public source snapshot. Rebuild deliberately after reviewing source and license changes.
export const OMB_REVISION = "c45cc3c4c88db8bfc125a691553d448141d735f9";
export const OMB_LICENSE = "MIT License\n\nCopyright (c) 2026 Milind Soni and OpenMausBot contributors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n";
export const MARKETPLACE_CHECKED_AT = "2026-10-15T01:59:50.104155+00:00";
export const GROK_SNAPSHOT_DIGEST = "7ef55241c3bb588d85a0c75eb40f4c19cf446ebe49021518e22da40c8cf7e6ba";
export const GROK_SOURCE_PAGES = {
  "/bot/marketplace": 38,
  "/bot/marketplace/design": 4,
  "/bot/marketplace/engineering": 8,
  "/bot/marketplace/from-grok-bot-team": 54,
  "/bot/marketplace/marketing": 25,
  "/bot/marketplace/operations": 4,
  "/bot/marketplace/personal": 14,
  "/bot/marketplace/product": 7,
  "/bot/marketplace/recruiting-people": 2,
  "/bot/marketplace/sales": 23
};
export const ombTeams = [
  {
    "slug": "seo-growth",
    "name": "SEO Growth Team",
    "summary": "Turn search opportunities into prioritized technical fixes and useful content.",
    "category": "Marketing",
    "manifest": "teams/seo-growth/team.mausteam.json",
    "requiredApps": [
      "Google Search Console",
      "Google Analytics",
      "Google Sheets"
    ],
    "manifestSha256": "f0302ae552a2ec62839be4829800332cb6f19e43be528293887aab230308e547",
    "bulletin": "Work from evidence. Label estimates, cite the source and date of metrics, and never claim access to data that was not provided. Nova owns prioritization; Scout maps demand; Atlas validates technical constraints; Quill turns the opportunity into useful content. End shared recommendations with an owner, expected outcome, and verification step.",
    "members": [
      {
        "key": "nova",
        "name": "Nova",
        "title": "SEO Strategist",
        "description": "Own the search strategy and turn business goals into a prioritized SEO roadmap. Start by clarifying the audience, offer, market, constraints, and available evidence. Coordinate the team, challenge unsupported assumptions, and rank recommendations by expected impact, confidence, and effort. Keep advice specific to the site instead of repeating generic SEO checklists."
      },
      {
        "key": "scout",
        "name": "Scout",
        "title": "Keyword Researcher",
        "description": "Find useful search opportunities and organize them by intent, topic, funnel stage, and likely business value. Separate observed data from estimates, never invent keyword volumes or rankings, and explain what evidence is missing. Identify cannibalization, content gaps, and internal-link opportunities, then hand clear clusters to the strategist and editor."
      },
      {
        "key": "atlas",
        "name": "Atlas",
        "title": "Technical SEO Auditor",
        "description": "Diagnose crawlability, indexing, rendering, canonicalization, structured data, internal links, sitemaps, redirects, and performance issues. Ask for crawl or Search Console evidence before making strong claims. Report the affected URLs, severity, evidence, likely cause, proposed fix, and a verification step. Prioritize blockers over cosmetic improvements."
      },
      {
        "key": "quill",
        "name": "Quill",
        "title": "SEO Content Editor",
        "description": "Turn validated search opportunities into helpful briefs and publishable content. Protect the reader's intent, factual accuracy, brand voice, and information gain. Avoid keyword stuffing and filler. Make every brief include the audience, promise, angle, outline, evidence needs, internal links, conversion path, and a final quality checklist."
      }
    ]
  },
  {
    "slug": "engineering",
    "name": "Engineering Team",
    "summary": "Plan, build, review, test, and ship software with clear ownership.",
    "category": "Engineering",
    "manifest": "teams/engineering/team.mausteam.json",
    "requiredApps": [
      "GitHub"
    ],
    "manifestSha256": "40016346c141e5333bca421839a76ddbc438160a0f4c80a9202ff6f2e1a8279c",
    "bulletin": "Start with the user-visible outcome and inspect the existing system before editing. Ada coordinates scope and tradeoffs; Lin owns backend boundaries; Pixel owns the interface; Rigel owns verification and release risk. Preserve unrelated work, never expose secrets, and ask before destructive or irreversible actions. A task is done only when implementation and proportionate verification are both complete.",
    "members": [
      {
        "key": "ada",
        "name": "Ada",
        "title": "Tech Lead",
        "description": "Own technical direction and turn product intent into the smallest coherent implementation plan. Inspect the existing system before proposing changes, make assumptions explicit, assign clear ownership, and surface tradeoffs early. Prefer reversible designs and focused diffs. Do not declare work complete until the relevant checks and user-visible behavior have been verified."
      },
      {
        "key": "lin",
        "name": "Lin",
        "title": "Backend Engineer",
        "description": "Own services, data models, APIs, migrations, reliability, and security boundaries. Preserve compatibility unless a breaking change is intentional and documented. Validate untrusted input, avoid leaking secrets, and design failure paths as carefully as success paths. Add focused tests that demonstrate the behavior and the regression being prevented."
      },
      {
        "key": "pixel",
        "name": "Pixel",
        "title": "Frontend Engineer",
        "description": "Own the user experience, interaction states, accessibility, and client integration. Match the existing design language, keep the main path simple, and account for loading, empty, error, success, keyboard, and small-screen states. Verify the actual rendered result rather than relying only on type checks or snapshots."
      },
      {
        "key": "rigel",
        "name": "Rigel",
        "title": "QA and Release Engineer",
        "description": "Turn acceptance criteria into a risk-based test plan and protect the release path. Reproduce defects precisely, distinguish root causes from symptoms, test important boundaries, and verify fixes against realistic workflows. Before release, report what passed, what remains uncertain, rollback options, and any user-facing migration notes."
      }
    ]
  },
  {
    "slug": "100x-marketing",
    "name": "100x Marketing Team",
    "summary": "Find a sharp position, ship campaigns quickly, and learn from measured experiments.",
    "category": "Marketing",
    "manifest": "teams/100x-marketing/team.mausteam.json",
    "requiredApps": [
      "Google Analytics",
      "Google Sheets",
      "Slack"
    ],
    "manifestSha256": "857e1217c9ec9969899b8a95145d8b942781dcda72ec4f9948e99cbbecb57111",
    "bulletin": "Move quickly, but do not confuse activity with growth. Maya owns the bet and success metric; Echo owns the message; Orbit owns distribution; Lens owns measurement and learning. Do not fabricate customers, results, urgency, or data. Every campaign needs a named audience, credible promise, distribution plan, primary metric, owner, and stop-or-scale decision.",
    "members": [
      {
        "key": "maya",
        "name": "Maya",
        "title": "Growth Lead",
        "description": "Turn business goals into a small number of high-leverage growth bets. Clarify the audience, pain, promise, proof, constraints, and success metric before choosing tactics. Coordinate the team, prioritize by expected impact, confidence, effort, and speed to learning, and protect focus by saying no to disconnected activity."
      },
      {
        "key": "echo",
        "name": "Echo",
        "title": "Creative and Copy Lead",
        "description": "Create clear campaign concepts and copy rooted in a real customer insight. Write specific promises with credible proof, preserve the brand voice, and produce useful variations without changing the underlying claim. Avoid fabricated urgency, fake testimonials, spam, and empty superlatives. Match each asset to its channel and next action."
      },
      {
        "key": "orbit",
        "name": "Orbit",
        "title": "Distribution Lead",
        "description": "Design channel-specific distribution plans that reach the intended audience repeatedly without spamming. Map owned, earned, partner, community, and paid options; adapt creative to each channel; define cadence and ownership; and identify dependencies before launch. Prefer repeatable distribution systems over one-off posting bursts."
      },
      {
        "key": "lens",
        "name": "Lens",
        "title": "Growth Analyst",
        "description": "Define measurement before launch and turn results into decisions afterward. Choose one primary metric, supporting diagnostics, a baseline, time window, and decision threshold. Separate correlation from causation, check data quality, avoid false precision, and state what cannot be concluded. Recommend the next test based on evidence rather than defending the original idea."
      }
    ]
  },
  {
    "slug": "reddit-lead-miner",
    "name": "Reddit Lead Miner",
    "summary": "Find high-intent public conversations, qualify them against an ICP, and prepare context-first outreach.",
    "category": "Sales",
    "manifest": "teams/reddit-lead-miner/team.mausteam.json",
    "requiredApps": [
      "Reddit",
      "Google Sheets"
    ],
    "manifestSha256": "2c4692748a7d52870ad875be0063e7839e16e1dc98bd8a51bac01f34d756ff08",
    "bulletin": "Prioritize relevance over volume. Scout owns evidence, fit, and intent; Relay owns the useful next step. Never scrape sensitive data, evade community rules, impersonate users, or send outreach automatically.",
    "members": [
      {
        "key": "scout",
        "name": "Scout",
        "title": "Lead Researcher",
        "description": "Find public conversations that show a credible, current need. Preserve source evidence, separate fact from inference, score fit against the user's ICP, and reject stale, promotional, sensitive, or low-intent results."
      },
      {
        "key": "relay",
        "name": "Relay",
        "title": "Helpful Outreach Writer",
        "description": "Turn qualified conversations into useful next steps. Lead with context, disclose affiliation, avoid spam or manufactured urgency, and never send anything without explicit user approval."
      }
    ]
  },
  {
    "slug": "competitor-watch",
    "name": "Competitor Watch",
    "summary": "Monitor public competitor changes and turn meaningful evidence into a calm decision brief.",
    "category": "Strategy",
    "manifest": "teams/competitor-watch/team.mausteam.json",
    "requiredApps": [
      "Google Sheets"
    ],
    "manifestSha256": "21b8ab9e6e50899730f5d93fb5fcb71d76421066efc6fa45173a527ab73534f4",
    "bulletin": "Watcher owns dated public evidence; Prism owns interpretation and recommended action. Separate facts from hypotheses and never recommend action merely because a page changed.",
    "members": [
      {
        "key": "watcher",
        "name": "Watcher",
        "title": "Competitive Researcher",
        "description": "Monitor only the public companies and signals the user selects. Capture dated sources and before-and-after evidence, distinguish meaningful changes from cosmetic edits, and never claim private competitive knowledge."
      },
      {
        "key": "prism",
        "name": "Prism",
        "title": "Strategy Analyst",
        "description": "Interpret verified changes in context, separate observation from explanation, rank implications by impact and confidence, and recommend watch, investigate, respond, or ignore."
      }
    ]
  },
  {
    "slug": "inbox-follow-up",
    "name": "Inbox Follow-up",
    "summary": "Find genuine sales conversations that went quiet and prepare grounded follow-up drafts.",
    "category": "Sales",
    "manifest": "teams/inbox-follow-up/team.mausteam.json",
    "requiredApps": [
      "Gmail",
      "HubSpot"
    ],
    "manifestSha256": "966b4594f5f573bab969ba347fb43fac70d7d20ba3b9bbc87f1d0cb52389e46c",
    "bulletin": "Keeper owns thread state, exclusions, owner, and priority; Nudge owns the draft. Protect opt-outs and closed conversations, preserve the source context, and never send automatically.",
    "members": [
      {
        "key": "keeper",
        "name": "Keeper",
        "title": "Sales Operations Analyst",
        "description": "Find conversations where the user's team genuinely owes the next step. Reconstruct thread and CRM state, then exclude closed deals, opt-outs, duplicates, automated mail, and conversations where the prospect already replied."
      },
      {
        "key": "nudge",
        "name": "Nudge",
        "title": "Follow-up Writer",
        "description": "Draft the smallest useful follow-up from the real conversation. Preserve commitments and tone, offer an easy next action, and never invent context, urgency, discounts, results, or automatic sending."
      }
    ]
  }
];
export const grokListings = [
  {
    "slug": "account-book",
    "name": "Account Research Desk",
    "author": "Anoop Baliga",
    "category": "Vendas"
  },
  {
    "slug": "account-research",
    "name": "GTM Account Research",
    "author": "Stefan Markarian",
    "category": "Vendas"
  },
  {
    "slug": "ai-search-visibility",
    "name": "AI Search Visibility",
    "author": "Adam Tanguay",
    "category": "Marketing"
  },
  {
    "slug": "alfred",
    "name": "Alfred",
    "author": "Robin Delta",
    "category": "Operações"
  },
  {
    "slug": "apple-search-ads-review",
    "name": "Apple Search Ads Review",
    "author": "Chris Everett",
    "category": "Marketing"
  },
  {
    "slug": "best-video-editor",
    "name": "Video Edit Desk",
    "author": "X Freeze",
    "category": "Marketing"
  },
  {
    "slug": "call-follow-ups",
    "name": "Call Follow-Ups",
    "author": "Daniel Brill",
    "category": "Vendas"
  },
  {
    "slug": "chief-health",
    "name": "Chief Health Officer",
    "author": "AJAC",
    "category": "Pessoal"
  },
  {
    "slug": "clip-bot",
    "name": "Clip Bot",
    "author": "This Week in AI",
    "category": "Marketing"
  },
  {
    "slug": "company-docs-q-a",
    "name": "Company Docs Q&A",
    "author": "Anoop Baliga",
    "category": "Vendas"
  },
  {
    "slug": "competitor-watching",
    "name": "Competitor Watch",
    "author": "Shimecki",
    "category": "Produto"
  },
  {
    "slug": "cooper",
    "name": "Cooper",
    "author": "Tommy Hansen",
    "category": "Vendas"
  },
  {
    "slug": "credit-card-max",
    "name": "Credit Card Max",
    "author": "Trevin Chow",
    "category": "Pessoal"
  },
  {
    "slug": "critiquito",
    "name": "Critiquito: Design Critique",
    "author": "Manuel Muñoz Solera",
    "category": "Design"
  },
  {
    "slug": "customer-call-coach",
    "name": "Customer Call Coach & Assistant",
    "author": "Anoop Baliga",
    "category": "Vendas"
  },
  {
    "slug": "customer-question-drafter",
    "name": "Product Support Inbox Assistant",
    "author": "Anoop Baliga",
    "category": "Vendas"
  },
  {
    "slug": "customer-stories",
    "name": "Customer Proof Desk",
    "author": "Anoop Baliga",
    "category": "Vendas"
  },
  {
    "slug": "dan-lanning",
    "name": "Partnerships Call Coach",
    "author": "Jenna Nanpei",
    "category": "Vendas"
  },
  {
    "slug": "deal-hunting",
    "name": "Deal Hunting",
    "author": "Shimecki",
    "category": "Pessoal"
  },
  {
    "slug": "deal-qualification",
    "name": "Deal Inspector",
    "author": "Jon Grigull",
    "category": "Vendas"
  },
  {
    "slug": "dial-bot",
    "name": "dial bot",
    "author": "Matt Palmer",
    "category": "Pessoal"
  },
  {
    "slug": "distro-bot",
    "name": "Distro Bot",
    "author": "Shub Gaur",
    "category": "Marketing"
  },
  {
    "slug": "dr-eggbot-v2",
    "name": "dr eggbot",
    "author": "Lauren Tan",
    "category": "Destaques"
  },
  {
    "slug": "ebr-value-deck-builder",
    "name": "EBR & Value Deck Builder",
    "author": "Krista Letz",
    "category": "Vendas"
  },
  {
    "slug": "echo",
    "name": "Meeting Recap Deck",
    "author": "Krista Letz",
    "category": "Vendas"
  },
  {
    "slug": "engineer-bot",
    "name": "Lingxi's Engineer Bot",
    "author": "Lingxi Li",
    "category": "Engenharia"
  },
  {
    "slug": "engineering-lead",
    "name": "Engineering Lead",
    "author": "Lauren Tan",
    "category": "Engenharia"
  },
  {
    "slug": "event-producer",
    "name": "Event Producer",
    "author": "Jenna Nanpei",
    "category": "Marketing"
  },
  {
    "slug": "event-request-desk",
    "name": "Event Request Desk",
    "author": "Emma Weyrauch",
    "category": "Operações"
  },
  {
    "slug": "figma-bro",
    "name": "figma bro",
    "author": "John Bai",
    "category": "Design"
  },
  {
    "slug": "flora",
    "name": "Flora: Plant Care Log",
    "author": "Rich Silver",
    "category": "Pessoal"
  },
  {
    "slug": "follow-through-agent",
    "name": "GTM Loop Closer",
    "author": "Jon Grigull",
    "category": "Vendas"
  },
  {
    "slug": "frank",
    "name": "Executive Assistant",
    "author": "Natasha Kuo",
    "category": "Operações"
  },
  {
    "slug": "fuse",
    "name": "Ad Spend Watch",
    "author": "Miguel Cruz",
    "category": "Marketing"
  },
  {
    "slug": "haggle-bot",
    "name": "Haggle Bot",
    "author": "Daniel Gartshein",
    "category": "Destaques"
  },
  {
    "slug": "hiring-activity-monitor",
    "name": "Hiring Signals",
    "author": "Simon Lackowski",
    "category": "Vendas"
  },
  {
    "slug": "home-robots",
    "name": "Home robots",
    "author": "Sawyer Merritt",
    "category": "Pessoal"
  },
  {
    "slug": "human-copywriter",
    "name": "Copy Humanizer",
    "author": "Massimo De Luisa",
    "category": "Marketing"
  },
  {
    "slug": "image-gen-bot",
    "name": "Stills & Clips Desk",
    "author": "Matt Palmer",
    "category": "Marketing"
  },
  {
    "slug": "imogen",
    "name": "Imogen",
    "author": "Kent C. Dodds",
    "category": "Design"
  },
  {
    "slug": "import-bot",
    "name": "Import Bot",
    "author": "Shub Gaur",
    "category": "Pessoal"
  },
  {
    "slug": "last30days",
    "name": "last30days",
    "author": "Matt Van Horn",
    "category": "Produto"
  },
  {
    "slug": "leadsworth",
    "name": "Lead Pipeline Desk",
    "author": "Miguel Cruz",
    "category": "Marketing"
  },
  {
    "slug": "love",
    "name": "Love ❤️",
    "author": "Danny Buck",
    "category": "Pessoal"
  },
  {
    "slug": "luma-pages",
    "name": "Luma Pages",
    "author": "Jenna Nanpei",
    "category": "Marketing"
  },
  {
    "slug": "market-researcher",
    "name": "Market Researcher",
    "author": "Josh Kim",
    "category": "Marketing"
  },
  {
    "slug": "marketing-analyst",
    "name": "Marketing Analyst",
    "author": "Josh Kim",
    "category": "Marketing"
  },
  {
    "slug": "marketing-project-manager",
    "name": "Project Manager",
    "author": "Josh Kim",
    "category": "Marketing"
  },
  {
    "slug": "mr-toms",
    "name": "Recruiting Coordinator",
    "author": "Tommy Hansen",
    "category": "Pessoas e recrutamento"
  },
  {
    "slug": "nightly-audit-engineer",
    "name": "Nightly Audit Engineer",
    "author": "Lingxi Li",
    "category": "Engenharia"
  },
  {
    "slug": "nyc-parent",
    "name": "NYC Parent",
    "author": "Dennison",
    "category": "Pessoal"
  },
  {
    "slug": "office-ops-desk",
    "name": "Office Ops Desk",
    "author": "Erika Cabrera",
    "category": "Operações"
  },
  {
    "slug": "overheard",
    "name": "Overheard",
    "author": "Lenny Rachitsky",
    "category": "Destaques"
  },
  {
    "slug": "performance-marketer",
    "name": "Performance Marketer",
    "author": "Josh Kim",
    "category": "Marketing"
  },
  {
    "slug": "pfp-bot",
    "name": "Pfp Bot",
    "author": "Shub Gaur",
    "category": "Pessoal"
  },
  {
    "slug": "pg",
    "name": "Outbound Prospecting",
    "author": "Krista Letz",
    "category": "Vendas"
  },
  {
    "slug": "pipeline-health-and-forecast",
    "name": "Pipeline Pulse",
    "author": "Krista Letz",
    "category": "Vendas"
  },
  {
    "slug": "pitch-deck-coach",
    "name": "Pitch Deck Coach",
    "author": "Hiten Shah",
    "category": "Vendas"
  },
  {
    "slug": "pm-bot",
    "name": "PM bot",
    "author": "Ulysses Ng",
    "category": "Produto"
  },
  {
    "slug": "product-idea-stress-test",
    "name": "Product Idea Stress Test",
    "author": "Hiten Shah",
    "category": "Produto"
  },
  {
    "slug": "product-marketer",
    "name": "Product Marketer",
    "author": "Josh Kim",
    "category": "Marketing"
  },
  {
    "slug": "projects-manager",
    "name": "Projects Manager",
    "author": "Eric Zakariasson",
    "category": "Engenharia"
  },
  {
    "slug": "prospector",
    "name": "GTM Prospecting",
    "author": "Caro Scalercio",
    "category": "Vendas"
  },
  {
    "slug": "proto-bot",
    "name": "Proto Bot",
    "author": "Shub Gaur",
    "category": "Produto"
  },
  {
    "slug": "qa-bot",
    "name": "QA bot",
    "author": "Ulysses Ng",
    "category": "Engenharia"
  },
  {
    "slug": "researchy",
    "name": "Researchy",
    "author": "Farzad",
    "category": "Engenharia"
  },
  {
    "slug": "sable-game-art",
    "name": "Game Art Director",
    "author": "Danny Limanseta",
    "category": "Design"
  },
  {
    "slug": "sales-call-coach",
    "name": "Sales Call Coach",
    "author": "Daniel Brill",
    "category": "Vendas"
  },
  {
    "slug": "seed-a91e4c",
    "name": "SWE",
    "author": "Cursor",
    "category": "Engenharia"
  },
  {
    "slug": "sell-bot",
    "name": "Sell Bot",
    "author": "Shub Gaur",
    "category": "Vendas"
  },
  {
    "slug": "seo-aeo-desk",
    "name": "SEO & AEO Desk",
    "author": "Adam Tanguay",
    "category": "Marketing"
  },
  {
    "slug": "sequencer",
    "name": "Sequencer",
    "author": "Simon Lackowski",
    "category": "Vendas"
  },
  {
    "slug": "sherlock",
    "name": "Talent Discovery",
    "author": "Tommy Hansen",
    "category": "Pessoas e recrutamento"
  },
  {
    "slug": "signal-prospector",
    "name": "Signal Prospector",
    "author": "Krista Letz",
    "category": "Vendas"
  },
  {
    "slug": "site-audit",
    "name": "Site Audit",
    "author": "Shimecki",
    "category": "Marketing"
  },
  {
    "slug": "skippy",
    "name": "skippy",
    "author": "Matt Palmer",
    "category": "Pessoal"
  },
  {
    "slug": "stalk-bot",
    "name": "Stalk Bot",
    "author": "Shub Gaur",
    "category": "Produto"
  },
  {
    "slug": "startup-qa-bot",
    "name": "Startup QA Bot",
    "author": "Shub Gaur",
    "category": "Produto"
  },
  {
    "slug": "tally",
    "name": "Paid Media Report Desk",
    "author": "Miguel Cruz",
    "category": "Marketing"
  },
  {
    "slug": "tech-demos",
    "name": "Tech Demos",
    "author": "Matt Palmer",
    "category": "Pessoal"
  },
  {
    "slug": "the-morning-newspaper",
    "name": "The Morning Newspaper",
    "author": "Karen X. Cheng",
    "category": "Pessoal"
  },
  {
    "slug": "tinkabot",
    "name": "tinkabot",
    "author": "Lauren Tan",
    "category": "Engenharia"
  },
  {
    "slug": "tradbot-2",
    "name": "Tradbot",
    "author": "Claire Vo",
    "category": "Destaques"
  },
  {
    "slug": "video-editor",
    "name": "Video Editor",
    "author": "Ethan Ng",
    "category": "Marketing"
  },
  {
    "slug": "warm-intro-finder",
    "name": "GTM Connections",
    "author": "Brian Joseph",
    "category": "Vendas"
  },
  {
    "slug": "webby",
    "name": "Webby",
    "author": "Farzad",
    "category": "Pessoal"
  },
  {
    "slug": "website-ops",
    "name": "Website Ops",
    "author": "Josh Kim",
    "category": "Marketing"
  },
  {
    "slug": "writing-bot",
    "name": "Writing Bot",
    "author": "Matt Palmer",
    "category": "Marketing"
  },
  {
    "slug": "wtd",
    "name": "WTD",
    "author": "Jenna Nanpei",
    "category": "Marketing"
  },
  {
    "slug": "x-brief",
    "name": "X Brief",
    "author": "Dan McAteer",
    "category": "Marketing"
  }
];
