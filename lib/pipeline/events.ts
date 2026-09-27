const log = require("../log");

const FIELDS = [
  "program_id",
  "channel_role",
  "addressed",
  "classifier",
  "intent",
  "should_engage",
  "retrieval_hit",
  "grounding_pass",
  "ticket_requested",
  "helper_escalated",
  "final_action",
  "reason",
  "latency_ms",
  "provider_error_kind",
];

const SAFE_VALUE = /^[A-Za-z0-9_.:-]{0,64}$/;
type EventValue = string | number | boolean | null | undefined;
interface EventFields { [key: string]: EventValue }
interface EventOptions { programId?: string | null; role?: string | null; addressed?: boolean }

function clean(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  const s = String(value);
  return SAFE_VALUE.test(s) ? s : "invalid";
}

function format(event: EventFields) {
  return FIELDS.map((k) => `${k}=${clean(event[k])}`).join(" ");
}

function start({ programId = null, role = null, addressed = false }: EventOptions = {}) {
  const startedAt = Date.now();
  const event: EventFields = { program_id: programId, channel_role: role, addressed: Boolean(addressed) };
  let done = false;
  return {
    set(fields: EventFields = {}) {
      if ("classifier" in fields) event.classifier = fields.classifier;
      if ("intent" in fields) event.intent = fields.intent;
      if ("shouldEngage" in fields) event.should_engage = fields.shouldEngage;
      if ("providerErrorKind" in fields) event.provider_error_kind = fields.providerErrorKind;
      if ("retrievalHit" in fields) event.retrieval_hit = fields.retrievalHit;
      if ("groundingPass" in fields) event.grounding_pass = fields.groundingPass;
      if ("ticketRequested" in fields) event.ticket_requested = fields.ticketRequested;
      if ("helperEscalated" in fields) event.helper_escalated = fields.helperEscalated;
    },
    finish(fields: EventFields = {}) {
      if (done) return event;
      done = true;
      this.set(fields);
      event.final_action = fields.finalAction || null;
      event.reason = fields.reason || null;
      event.latency_ms = Date.now() - startedAt;
      log.info("pipeline", `[pipeline] ${format(event)}`);
      return event;
    },
    event,
  };
}

export = { start, format, FIELDS };
