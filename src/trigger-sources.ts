// Loads everything that registers a live topic source or a planner input, so the trigger generators (src/db/live.ts,
// src/db/plan-triggers.ts) see them all. src/db imports nothing from src/data; the entry points that generate triggers
// (src/db.ts, scripts/gen-pg-schema.ts) import this file.
import "./data/mirror/triggers.ts";
import "./data/access/triggers.ts";
import "./data/control/triggers.ts";
import "./data/triage/triggers.ts";
import "./data/planner/triggers.ts";
import "./data/merge/triggers.ts";
import "./data/changes/triggers.ts";
import "./data/review/triggers.ts";
import "./data/workflow/triggers.ts";
import "./data/intake/triggers.ts";
import "./data/jobs/triggers.ts";
import "./data/inference/triggers.ts";
import "./data/build/triggers.ts";
import "./data/conversations/triggers.ts";
import "./data/chat/triggers.ts";
import "./data/implement/triggers.ts";
import "./data/issuereview/triggers.ts";
import "./data/discord/triggers.ts";
import "./data/security/triggers.ts";
import "./data/runners/triggers.ts";
import "./data/prompts/triggers.ts";
import { registerPlanInputs } from "./db/plan-triggers.ts";
import { planInputsWith } from "./db/plan-inputs.ts";
import { PERM_READ_TTL } from "./data/access/index.ts";

/** The planner's inputs, as the change log's triggers are made from them. */
export const PLAN_INPUTS = planInputsWith({ permReadTtlMs: PERM_READ_TTL });
registerPlanInputs(PLAN_INPUTS);
