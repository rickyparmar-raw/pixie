export type CoreProgramPosture = "active" | "passive" | "muted";
export type CoreProgramScope = "any" | "program";
export type CoreIncidentMode = "ANSWER_ONLY" | "ANSWER_AND_TRACK" | "NORMAL_TICKET";

export interface CoreProgramChannel {
  id: string;
  kind: string;
}

export interface CoreDocSource {
  name: string;
  type?: string;
  url?: string | null;
  public?: boolean;
  [key: string]: unknown;
}

export interface CoreProgramSyncPatch {
  name?: string;
  description?: string | null;
  workspaceId?: string;
  workspace_id?: string;
  supportName?: string | null;
  iconUrl?: string | null;
  replySignature?: string | null;
  helpChannel?: string;
  organizerChannel?: string | null;
  channels?: string[];
  posture?: CoreProgramPosture;
  scope?: CoreProgramScope;
  aiAnswers?: boolean;
  ticketsEnabled?: boolean;
  autoEscalate?: boolean;
  incidentMode?: CoreIncidentMode;
  publicTicketsEnabled?: boolean;
  autoAssign?: boolean;
  sensitiveCategories?: string[];
  sources?: CoreDocSource[];
  claimedBy?: string | null;
  programChannels?: CoreProgramChannel[];
  [key: string]: unknown;
}

export interface CoreSyncValidationError {
  code: "invalid_program_id" | "invalid_payload" | "invalid_field";
  message: string;
  field?: string;
}

export type CoreSyncValidation =
  | { ok: true; value: CoreProgramSyncPatch }
  | { ok: false; error: CoreSyncValidationError };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function validateCoreProgramSyncPatch(programId: string, payload: unknown): CoreSyncValidation {
  if (!programId.trim()) return { ok: false, error: { code: "invalid_program_id", message: "program id is required" } };
  if (!isPlainObject(payload)) return { ok: false, error: { code: "invalid_payload", message: "program sync payload must be an object" } };

  const enumFields: Array<[keyof CoreProgramSyncPatch, readonly string[]]> = [
    ["posture", ["active", "passive", "muted"]],
    ["scope", ["any", "program"]],
    ["incidentMode", ["ANSWER_ONLY", "ANSWER_AND_TRACK", "NORMAL_TICKET"]],
  ];
  for (const [field, values] of enumFields) {
    if (payload[field] !== undefined && (typeof payload[field] !== "string" || !values.includes(payload[field] as string))) {
      return { ok: false, error: { code: "invalid_field", field: String(field), message: `${String(field)} is invalid` } };
    }
  }

  for (const field of ["aiAnswers", "ticketsEnabled", "autoEscalate", "publicTicketsEnabled", "autoAssign"] as const) {
    if (payload[field] !== undefined && typeof payload[field] !== "boolean") {
      return { ok: false, error: { code: "invalid_field", field, message: `${field} must be boolean` } };
    }
  }

  for (const field of ["channels", "sensitiveCategories"] as const) {
    if (payload[field] !== undefined && !validStringArray(payload[field])) {
      return { ok: false, error: { code: "invalid_field", field, message: `${field} must be an array of strings` } };
    }
  }

  if (payload.programChannels !== undefined) {
    if (!Array.isArray(payload.programChannels) || payload.programChannels.some((channel) => !isPlainObject(channel) || typeof channel.id !== "string" || !channel.id.trim() || typeof channel.kind !== "string")) {
      return { ok: false, error: { code: "invalid_field", field: "programChannels", message: "programChannels contains an invalid channel" } };
    }
  }

  if (payload.sources !== undefined && (!Array.isArray(payload.sources) || payload.sources.some((source) => !isPlainObject(source) || typeof source.name !== "string" || !source.name.trim()))) {
    return { ok: false, error: { code: "invalid_field", field: "sources", message: "sources contains an invalid source" } };
  }

  return { ok: true, value: payload as CoreProgramSyncPatch };
}
