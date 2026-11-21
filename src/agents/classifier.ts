// What answers Jev's typed decisions on this host, read from the environment on every call:
//
//   AUTOCRAFT_CLASSIFIER_PROVIDER=jev          Jev itself: the `jev` command, or Workers AI when it is configured (default)
//   AUTOCRAFT_CLASSIFIER_PROVIDER=compatible   a chat API (src/agents/compatible.ts)
//   AUTOCRAFT_CLASSIFIER_PROVIDER=decisions    a Decisions API endpoint (src/agents/decisions.ts)
//
// A value the environment cannot satisfy is `invalid` with its reason, never a silent fall back to Jev: the Accounts
// page, the health checks and `autocraft-server accounts providers` report it, and the fallback model decides meanwhile,
// as it does when Jev itself is unavailable.
import { envVar } from "../env.ts";
import { COMPATIBLE, compatibleClassifierConfig, PROVIDER_KEYS, type CompatibleConfig } from "./compatible.ts";
import { decisionsConfig, type DecisionsConfig } from "./decisions.ts";

/** What answers the typed decisions. `invalid` carries the reason, never the key or the base URL. */
export type ClassifierChoice =
  | { provider: "jev" }
  | { provider: "compatible"; config: CompatibleConfig; model: string }
  | { provider: "decisions"; config: DecisionsConfig; model: string }
  | { provider: "invalid"; reason: string };

/** The value of AUTOCRAFT_CLASSIFIER_PROVIDER that sends the decisions to a Decisions API endpoint. */
export const DECISIONS = "decisions";

export function classifierProvider(env: NodeJS.ProcessEnv = process.env): ClassifierChoice {
  const which = (envVar(PROVIDER_KEYS.classifier, env) ?? "").trim();
  if (!which || which === "jev") return { provider: "jev" };
  if (which === COMPATIBLE) {
    const c = compatibleClassifierConfig(env);
    return "problem" in c ? { provider: "invalid", reason: c.problem } : { provider: "compatible", config: c.config, model: c.model };
  }
  if (which === DECISIONS) {
    const d = decisionsConfig(env);
    return "problem" in d ? { provider: "invalid", reason: d.problem } : { provider: "decisions", config: d.config, model: d.config.model };
  }
  return { provider: "invalid", reason: `AUTOCRAFT_${PROVIDER_KEYS.classifier} is "${which}"; it must be jev, ${COMPATIBLE} or ${DECISIONS}` };
}

/** The model a classifier other than Jev answers with, or null when Jev answers (the CLI, Workers AI, or nothing). */
export function classifierModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const c = classifierProvider(env);
  return c.provider === "compatible" || c.provider === "decisions" ? c.model : null;
}
