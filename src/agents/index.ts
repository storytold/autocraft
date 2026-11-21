// autocraft-server accounts list | set <id> [--label X] [--enabled yes|no] [--max-concurrent N] | jev [N | on | off] | providers | pause [show | --five-hour N --weekly N]
import { connect } from "../db.ts";
import { classifierProvider } from "./classifier.ts";
import { modelProviderReport } from "./compatible.ts";
import { jevEnabled, jevOutage, setJevEnabled } from "./jev.ts";
import { AccountError, jevParallel, listAccounts, setJevParallel, setUsagePause, updateAccount, usagePause } from "./accounts.ts";

const USAGE = `usage: autocraft-server accounts list
       autocraft-server accounts set <id> [--label <text>] [--enabled yes|no] [--max-concurrent <N>]   (N from 1 to 100)
       autocraft-server accounts jev [<N> | on | off]   classifier calls at once (1 to 100), or switch the classifier on or off; shows the setting and what answers
       autocraft-server accounts providers   which provider makes model calls and which answers the typed decisions
       autocraft-server accounts pause [show]   usage levels (%) at which an account stops taking calls
       autocraft-server accounts pause --five-hour <N> --weekly <N>   set them (each 1 to 100)`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const pct = (n: number | null) => (n === null ? "  - " : `${String(Math.round(n)).padStart(3)}%`);

function print(): void {
  const list = listAccounts(connect());
  if (!list.length) console.log("no accounts in the box config (AUTOCRAFT_ACCOUNTS)");
  for (const a of list) {
    console.log(`${a.id.padEnd(10)} ${a.enabled ? "enabled " : "disabled"} ${a.label.padEnd(24)} ${a.running}/${a.maxConcurrent} running  5h ${pct(a.usage.fiveHourPct)}  week ${pct(a.usage.weeklyPct)}${a.pausedReason ? `  ${a.pausedReason}` : ""}`);
  }
}

// Recorded as `cli`: only someone with a shell on the host can run this.
function set(args: string[]): void {
  const [id, ...rest] = args;
  if (!id) die(USAGE);
  const input: { label?: string; enabled?: boolean; maxConcurrent?: number } = {};
  for (let i = 0; i < rest.length; i += 2) {
    const v = rest[i + 1];
    if (v === undefined) die(USAGE);
    switch (rest[i]) {
      case "--label": input.label = v; break;
      case "--enabled": if (v !== "yes" && v !== "no") die(USAGE); input.enabled = v === "yes"; break;
      case "--max-concurrent": input.maxConcurrent = Number(v); break;
      default: die(USAGE);
    }
  }
  try {
    updateAccount(connect(), id, input, "cli");
  } catch (e) {
    if (e instanceof AccountError) die(e.message);
    throw e;
  }
  print();
}

function jev(args: string[]): void {
  const db = connect();
  if (args.length > 1) die(USAGE);
  if (args[0] === "on" || args[0] === "off") setJevEnabled(db, args[0] === "on", "cli");
  else if (args[0] !== undefined) {
    try {
      setJevParallel(db, Number(args[0]), "cli");
    } catch (e) {
      if (e instanceof AccountError) die(e.message);
      throw e;
    }
  }
  console.log(`Classifier calls at once: ${jevParallel(db)}`);
  const c = classifierProvider();
  const who = c.provider === "compatible" || c.provider === "decisions" ? c.model : "Jev";
  const o = jevOutage(db);
  const by = c.provider === "compatible" ? `the compatible classifier (${who})` : c.provider === "decisions" ? `the decisions endpoint (${who})` : c.provider === "invalid" ? `nothing: ${c.reason}` : "Jev";
  console.log(`The typed decisions are answered by ${by}`);
  // An invalid provider is not "Jev in use": the fallback model answers while the configuration is wrong.
  if (!o && c.provider === "invalid") return;
  if (o) console.log(`${who} unavailable (${o.reason}) since ${o.since}; the fallback model does its work`);
  else console.log(jevEnabled(db) ? `${who} in use` : `${who} switched off; the fallback model does its work`);
}

/** Which provider makes model calls and which answers the typed decisions, read from the environment only. */
function providers(): void {
  const m = modelProviderReport();
  if (m.provider === "compatible") {
    console.log(`Model calls: the compatible provider, ${m.models.top} / ${m.models.mid} / ${m.models.small} (top / mid / small) at ${m.baseUrl}${m.problem ? `; ${m.problem}` : ""}`);
  } else if (m.provider === "invalid") console.log(`Model calls cannot run: ${m.reason}`);
  else console.log("Model calls: Claude accounts (the claude command on this host)");
  const c = classifierProvider();
  console.log(c.provider === "compatible" ? `Typed decisions: the compatible classifier, ${c.model}`
    : c.provider === "decisions" ? `Typed decisions: the decisions endpoint at ${c.config.baseUrl}, ${c.model}`
    : c.provider === "invalid" ? `Typed decisions cannot run: ${c.reason}` : "Typed decisions: Jev");
}

function pause(args: string[]): void {
  const db = connect();
  if (args.length && args[0] !== "show") {
    const cur = usagePause(db);
    const input = { fiveHour: cur.fiveHour, weekly: cur.weekly };
    for (let i = 0; i < args.length; i += 2) {
      const v = args[i + 1];
      if (v === undefined) die(USAGE);
      if (args[i] === "--five-hour") input.fiveHour = Number(v);
      else if (args[i] === "--weekly") input.weekly = Number(v);
      else die(USAGE);
    }
    try {
      setUsagePause(db, input, "cli");
    } catch (e) {
      if (e instanceof AccountError) die(e.message);
      throw e;
    }
  } else if (args.length > 1) die(USAGE);
  const p = usagePause(db);
  console.log(`Pause at: 5-hour ${p.fiveHour} %, weekly ${p.weekly} %`);
}

export const commands = {
  accounts: {
    summary: "Claude accounts: list | set <id> [--label X] [--enabled yes|no] [--max-concurrent N] | jev [N | on | off] | providers | pause [show | --five-hour N --weekly N]",
    run: (args: string[]) => {
      if (args[0] === "list") print();
      else if (args[0] === "set") set(args.slice(1));
      else if (args[0] === "jev") jev(args.slice(1));
      else if (args[0] === "providers") providers();
      else if (args[0] === "pause") pause(args.slice(1));
      else die(USAGE);
    },
  },
};
