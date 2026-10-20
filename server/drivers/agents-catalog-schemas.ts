// The routine schedule and trigger schemas the routine tools share.

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

// One flat object without oneOf/const/format: several agent CLIs flatten or drop JSON-Schema
// composition when converting MCP tools, and a model that never saw the branches guesses shapes.
export const ROUTINE_SCHEDULE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description:
    'Use {"type":"cron","expression":"0 9 1 * *","timeZone":"Asia/Kolkata"} for 09:00 on the first of each month, once with at for one future run, weekly with time + weekdays, daily with time, or interval with every_minutes for elapsed-time repetition. Intervals can optionally be limited with weekdays, window_start + window_end, and ends_at.',
  properties: {
    type: {
      type: "string",
      enum: ["once", "weekly", "daily", "interval", "cron"],
      description: "once = a single future run; weekly = chosen weekdays; daily = every day; interval = every N elapsed minutes; cron = a calendar rule in an explicit timezone.",
    },
    expression: {
      type: "string",
      maxLength: 256,
      description: "Only for cron: five fields, minute hour day-of-month month weekday. Examples: 0 9 1 * * = monthly on day 1 at 09:00; 0 9 L * * = last day of each month; 0 9 * * MON#2 = second Monday of each month. Lists, ranges and steps are supported. No seconds, year, or @ macros. Never substitute daily AI date checks for a calendar rule.",
    },
    timeZone: {
      type: "string",
      maxLength: 128,
      description: "Required for cron: explicit IANA timezone, for example Asia/Kolkata, America/New_York, or UTC. Use the user's requested zone; resolve ambiguity before proposing. Do not send a numeric offset or local-time abbreviation.",
    },
    at: {
      type: "string",
      description:
        "Only for type once: future RFC3339 date-time with an explicit timezone offset, for example 2026-09-01T09:00:00+05:30 or 2026-09-01T03:30:00Z.",
    },
    time: {
      type: "string",
      description: "For type weekly or daily: local computer time in 24-hour HH:MM format, for example 09:00.",
    },
    weekdays: {
      type: "array",
      items: { type: "string", enum: WEEKDAYS },
      description:
        "For type weekly: required run days. For type interval: optional allowed days. Values use the computer's local timezone.",
    },
    every_minutes: {
      type: "integer",
      minimum: 5,
      maximum: 1_440,
      description: "Only for type interval: whole minutes between runs, from 5 to 1440.",
    },
    starts_at: {
      type: "string",
      description:
        "Optional for type interval: RFC3339 date-time with an explicit timezone offset that anchors the cadence. Omit to start one interval after the routine is applied.",
    },
    window_start: {
      type: "string",
      description:
        "Optional for type interval, together with window_end: local 24-hour HH:MM when runs may begin, inclusive.",
    },
    window_end: {
      type: "string",
      description:
        "Optional for type interval, together with window_start: local 24-hour HH:MM when the allowed window ends, exclusive. It must be later on the same day.",
    },
    ends_at: {
      type: "string",
      description:
        "Optional for type interval: inclusive RFC3339 date-time cutoff with an explicit timezone offset.",
    },
    every_day: {
      type: "boolean",
      description: "Only for an interval update: true removes an existing weekday restriction.",
    },
    all_day: {
      type: "boolean",
      description: "Only for an interval update: true removes an existing time-window restriction.",
    },
    never_ends: {
      type: "boolean",
      description: "Only for an interval update: true removes an existing end cutoff.",
    },
  },
  required: ["type"],
} as const;

// Written out in full on each tool: $ref/$defs do not survive provider conversions.
export const TRIGGER_FIELDS_SCHEMA = {
  name: { type: "string", minLength: 1, maxLength: 80, description: "Short name shown on the automation's card and the Automations page." },
  instructions: {
    type: "string",
    minLength: 1,
    maxLength: 20_000,
    description: "Complete steps for each run, which does NOT see this conversation, in the person's plain words (\"draft a reply\"), never \"event data\", \"payload\", \"webhook\" or \"trigger\". Put judgement here, e.g. \"if it is not about an order, stop\".",
  },
  schedule: { ...ROUTINE_SCHEDULE_SCHEMA, description: `Only for when=schedule. ${ROUTINE_SCHEDULE_SCHEMA.description}` },
  webhook_event_types: {
    type: "array",
    maxItems: 20,
    items: { type: "string", maxLength: 200 },
    description: "Only for when=webhook: optional event names to accept (from the caller's event-type header, e.g. push). Omit to accept every call.",
  },
  filter: {
    type: "object",
    additionalProperties: false,
    properties: {
      from: { type: "string", maxLength: 200 },
      subject_contains: { type: "string", maxLength: 200 },
      label: { type: "string", maxLength: 200 },
      contains: { type: "string", maxLength: 200 },
    },
    description: "app_event only: plain words, all must match. Gmail filters at the source.",
  },
  event_config: {
    type: "object",
    description: "app_event only: settings from list_trigger_events config_fields.",
  },
  run_on: {
    type: "string",
    // "box" is Boat's historical run_on destination id (agents wire contract).
    enum: ["maus", "box"],
    description: "Default maus keeps the bot's selected model and configured computer, INCLUDING a self-hosted VPS. Omit this field normally. box runs on the bot's cloud computer, same model; it needs cloud computers set up and is not the generic cloud/VPS option. Legacy cloud values from list_triggers mean box, not VPS.",
  },
  timeout_minutes: {
    type: "integer",
    minimum: 5,
    maximum: 240,
    description:
      "Schedules only: optional safety limit for active work, from 5 to 240 minutes. Omit for no limit.",
  },
  clear_timeout: {
    type: "boolean",
    description: "Only for updates: set true to remove an existing safety limit. Do not combine with timeout_minutes.",
  },
  continuity: {
    type: "boolean",
    description: "Schedules only: opt in to using the latest completed run's bounded report as historical context. Use it for recurring work that builds on last time, such as QA passes, monitoring or follow-ups. Defaults to false; set false in an update to start fresh again.",
  },
  overlap: {
    type: "string",
    enum: ["skip", "queue"],
    description: "Schedules only: while a run is still working, skip scheduled occurrences (default) or queue at most one run. Queue skips further occurrences until the pending run starts; it never builds an unlimited backlog.",
  },
  run_on_startup: {
    type: "boolean",
    description: "Repeating schedules only: also run once each time OpenMausBot starts, besides the schedule, for a computer often off when it is due. Defaults to false.",
  },
} as const;
