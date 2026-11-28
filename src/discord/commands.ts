// `/autocraft account` (link, unlink, alerts, optout, optin), `status` (an item, or counts), `do` and `help`. Replies are visible to the caller only. Everything
// they say about items and counts comes from the public status layer (src/public/status.ts).
import { COMMAND_TEXT_MAX } from "../workflow/types.ts";
import { audit } from "./audit.ts";
import { publicRepoNames, publicStats, publicStatus, type PublicStats, type PublicStatus } from "../public/status.ts";
import type { Call, Interactions } from "./interactions.ts";
import type { DiscordKeys } from "./keys.ts";
import { forgetReporter } from "./file-issue.ts";
import { forgetVerifyRows } from "../data/discord/index.ts";
import { forgetLink, loginOf, mayCommand, redeemLinkCode } from "./links.ts";
import { t } from "../i18n/index.ts";
import type { ReadDeps } from "../workflow/read.ts";
import { settle } from "./context.ts";
import { followOf, threadTarget } from "./threads.ts";
import { prepareDo, runDo } from "./do.ts";
import { COMMANDS, WEIGHT_HELP } from "../workflow/vocab.ts";
import { deliver, IS_COMPONENTS_V2, plain, type Rendered } from "./reply.ts";
import type { Db } from "../db/index.ts";
import { envVar } from "../env.ts";
import { DISCORD_PRIVACY_PATH } from "../dash/server/discord-privacy.ts";
import { DISCORD_TERMS_PATH } from "../dash/server/discord-terms.ts";
import { optIn, optOut } from "./store.ts";
import type { ItemKey } from "./refs.ts";

const ATTEMPTS = { n: 5, ms: 60_000 };
const READ_LIMIT = { n: 10, ms: 60_000 };
const REF = /^\s*([\w.-]+)#(\d+)\s*$/;

export function formatStats(s: PublicStats): string {
  const median = s.medianOpenToMergeHours30Days === null ? "no merges" : `${s.medianOpenToMergeHours30Days} h`;
  return [
    `Public repos: ${s.repo ?? "all"}`,
    `Open issues: ${s.openIssues}, open pull requests: ${s.openPrs}`,
    `Merged in the last 7 days: ${s.mergedLast7Days} (${s.mergedByAutoCraftLast7Days} by AutoCraft)`,
    `Reviews posted in the last 7 days: ${s.reviewsPostedLast7Days}`,
    `Median open-to-merge time, last 30 days: ${median}`,
    `Merge queue: ${s.queueLength}`,
  ].join("\n");
}

export function formatStatus(s: PublicStatus): string {
  const place = s.queue ? ` (#${s.queue.position} of ${s.queue.of})` : "";
  return `${s.ref} ${plain(s.title).slice(0, 100)}\n${s.step}${place}`;
}

/** Most items one status answer shows: one row of link buttons. */
export const STATUS_ITEMS = 5;
const NO_ITEM = "No item found. Use the form repo#123.";

/**
 * The status answer for items (the first STATUS_ITEMS): each item's public status, and a link button per item found. An item of a
 * private or untracked repo, or one the public layer leaves out, reads as not found, so the answer is safe to post publicly.
 */
export async function statusReply(db: Db, refs: readonly ItemKey[]): Promise<{ content: string; components: unknown[] }> {
  const shown = refs.slice(0, STATUS_ITEMS);
  const found = await Promise.all(shown.map(async (r) => ({ r, s: await publicStatus(db, r.repo, r.number) })));
  const buttons = found.flatMap(({ s }) => s ? [{ type: 2, style: 5, label: s.ref.slice(0, 80), url: s.url }] : []);
  if (!buttons.length && shown.length <= 1) return { content: NO_ITEM, components: [] };
  const blocks = found.map(({ r, s }) => s ? formatStatus(s) : t("{ref}: no item found.", { ref: `${r.repo}#${r.number}` }));
  if (refs.length > shown.length) blocks.push(t("(+{n} more)", { n: refs.length - shown.length }));
  return { content: blocks.join("\n\n").slice(0, 1990), components: buttons.length ? [{ type: 1, components: buttons }] : [] };
}

/** The command words and weight words of Help, generated from the command vocabulary. */
export function doHelp(): string[] {
  return [
    t("Command words: {commands}", { commands: COMMANDS.map((c) => `\`${c.usage.replace(/\s*\[.*\]$/, "")}\``).join(" · ") }),
    t("Weight words: {words}", { words: WEIGHT_HELP.map((w) => `${w.word.startsWith("(") ? t("none") : `\`${w.word}\``} (${t(w.weight)})`).join(" · ") }),
  ];
}

/** The lines of Help on sending commands: privately, in a channel, as a reply, and in the thread AutoCraft answers in. */
export function atHelp(): string[] {
  return [
    t("`/autocraft do text:merge: photocraft#123 photocraft#456` sends it privately"),
    t("`@AutoCraft review photocraft#123` in a watched channel sends it in public"),
    t("Reply to a message that names items with `@AutoCraft review` for all of them, or name one"),
    t("Reply to a message with `@AutoCraft status` for the status of the items it names"),
    t("AutoCraft answers in a thread and posts each item's status and result there"),
    t("In that thread, `@AutoCraft fix-up and merge` or a reply to AutoCraft acts on the thread's items"),
  ];
}

/** Discord's limits: 4,000 characters of text across a Components V2 message, 2,000 of `content` in a plain one. */
export const V2_TEXT_CHARS = 4000;
export const CONTENT_CHARS = 2000;

/** The sections of `/autocraft help`, each a heading and its lines. */
function helpSections(): string[] {
  return [
    [
      `**${t("Find issues")}**`,
      t("`/autocraft search` searches existing issues by a few words"),
      t("`/autocraft report` reports a bug or asks for a feature; AutoCraft helps write it"),
      t("Right-click a message › Apps › Find issue searches with its text"),
      t("`@AutoCraft <question>` in a watched channel replies with matching issues, in public"),
      t("Reply to a message with `@AutoCraft` to search with its text"),
    ],
    [
      `**${t("Status")}**`,
      t("`/autocraft status item:photocraft#123` shows where an issue or pull request is"),
      t("`/autocraft status` alone shows counts for the public repos"),
    ],
    [`**${t("Commands")}** ${t("(linked account with write access)")}`, ...atHelp(), ...doHelp()],
    [
      `**${t("Your account")}**`,
      t("`/autocraft account action:link code:<code>` links your AutoCraft login (code: Link Discord in the dashboard menu)"),
      t("`/autocraft account action:unlink` removes the link"),
      t("`/autocraft account action:alerts state:on` (or off): direct messages when a workflow needs your answer"),
      t("`/autocraft account action:optout` stops recording your messages and deletes the records"),
      t("`/autocraft account action:optin` records them again"),
      t("Contributor role: press Verify in the role channel (needs a merged pull request)"),
    ],
    [
      `**${t("Privacy")}**`,
      t("AutoCraft's reaction means it counted the message for the items it names"),
      t("Deleting a message deletes its record"),
    ],
  ].map((lines) => lines.join("\n"));
}

/**
 * `/autocraft help`: one text display per section with separators between them, and the privacy notice and terms as
 * link buttons when the public base URL is known. The plain fallback keeps the whole sections that fit in `content`.
 */
export function helpReply(baseUrl: string | null): Rendered {
  const base = baseUrl?.replace(/\/+$/, "");
  const sections = helpSections();
  const links = base ? [{ type: 1, components: [
    { type: 2, style: 5, label: t("Privacy notice"), url: `${base}${DISCORD_PRIVACY_PATH}` },
    { type: 2, style: 5, label: t("Terms"), url: `${base}${DISCORD_TERMS_PATH}` },
  ] }] : [];
  const v2: unknown[] = [];
  let size = 0;
  for (const text of sections) {
    if (size + text.length > V2_TEXT_CHARS) break;
    if (v2.length) v2.push({ type: 14 });
    v2.push({ type: 10, content: text });
    size += text.length;
  }
  let content = "";
  for (const text of sections) {
    const next = content ? `${content}\n\n${text}` : text;
    if (next.length > CONTENT_CHARS) break;
    content = next;
  }
  return { components: [...v2, ...links], flags: IS_COMPONENTS_V2, legacy: { content, components: links } };
}

const ACCOUNT_ACTIONS = ["link", "unlink", "alerts", "optout", "optin"];

export function installAccountCommands(ix: Interactions, deps: { db: Db; keys: DiscordKeys; now?: () => number; read?: ReadDeps; baseUrl?: string | null }): void {
  const { db, keys } = deps;
  const help = helpReply(deps.baseUrl === undefined ? envVar("BASE_URL") ?? null : deps.baseUrl);
  const tries = new Map<string, number[]>();
  /** Sliding window per key: false when `lim.n` uses are already inside it. Keys whose uses have all expired are dropped. */
  const allow = (key: string, lim: { n: number; ms: number }): boolean => {
    const now = (deps.now ?? Date.now)();
    for (const [k, v] of tries) if (now - v[v.length - 1]! >= (k.startsWith("read:") ? READ_LIMIT.ms : ATTEMPTS.ms)) tries.delete(k);
    const live = (tries.get(key) ?? []).filter((t) => now - t < lim.ms);
    if (live.length >= lim.n) return false;
    tries.set(key, [...live, now]);
    return true;
  };
  /** Code entries per Discord user, so a code cannot be guessed by repeating the command. */
  const mayTry = (user: string): boolean => allow(`link:${user}`, ATTEMPTS);
  /** Stats and status lookups per Discord user. */
  const mayRead = (call: Call): boolean => allow(`read:${keys.hash("author", call.userId ?? "?")}`, READ_LIMIT);
  const TOO_MANY = "Too many requests just now. Try again in a minute.";
  const def = {
    name: "autocraft", type: 1 as const, description: "AutoCraft", dm_permission: false,
    options: [
      { type: 1, name: "account", description: "Your Discord link, alerts and message recording", options: [
        { type: 3, name: "action", description: "What to do", required: true, choices: ACCOUNT_ACTIONS.map((a) => ({ name: a, value: a })) },
        { type: 3, name: "code", description: "For link: the code from Link Discord in the dashboard menu", max_length: 20 },
        { type: 3, name: "state", description: "For alerts: on or off", choices: [{ name: "on", value: "on" }, { name: "off", value: "off" }] },
      ] },
      { type: 1, name: "status", description: "Where an issue or pull request is, or counts for the public repos", options: [
        { type: 3, name: "item", description: "For example photocraft#123; leave out for counts", max_length: 100 },
        { type: 3, name: "repo", description: "Counts for one repo; all public repos when both options are left out", autocomplete: true },
      ] },
      { type: 1, name: "do", description: "Send a command to AutoCraft, for example: merge: photocraft#123", options: [{ type: 3, name: "text", description: "The command, then a colon and the items: review, urgent: photocraft#123 photocraft#456", required: true, max_length: COMMAND_TEXT_MAX }] },
      { type: 1, name: "help", description: "What the AutoCraft bot can do" },
    ],
  };
  ix.command("autocraft account link", def, async (call) => {
    if (!call.userId) return void (await call.edit({ content: "This command needs a Discord user." }));
    if (!mayTry(keys.hash("author", call.userId))) return void (await call.edit({ content: "Too many tries. Wait a minute." }));
    const code = call.option("code");
    if (!code) return void (await call.edit({ content: "Link needs the option code." }));
    const login = await redeemLinkCode(db, keys, code, call.userId);
    if (!login) return void (await call.edit({ content: "That code is not valid, was already used, or has expired." }));
    await audit(db, login, "discord-link", login);
    await call.edit({ content: `Linked to ${plain(login)}` });
  });
  ix.command("autocraft account unlink", null, async (call) => {
    const n = call.userId ? await forgetLink(db, keys, call.userId) : 0;
    const signedIn = call.userId ? await forgetReporter(db, keys.hash("author", call.userId)) : false;
    const verify = call.userId ? await forgetVerifyRows(db, keys.hash("author", call.userId)) : 0;
    if (n || signedIn || verify) await audit(db, "discord", "discord-unlink", null, { by: "discord", link: n > 0, signedIn, verify });
    await call.edit({ content: n || signedIn || verify ? "Unlinked." : "This Discord account is not linked." });
  });
  ix.autocomplete("autocraft status", async (call) => {
    if (call.focused()?.name !== "repo") return [];
    const typed = (call.focused()?.value ?? "").toLowerCase();
    return (await publicRepoNames(db)).filter((r) => r.toLowerCase().includes(typed)).map((r) => ({ name: r, value: r }));
  });
  ix.command("autocraft do", null, async (call) => {
    if (!call.userId) return void (await call.edit({ content: "This command needs a Discord user." }));
    const login = await loginOf(db, keys, call.userId);
    if (!login) return void (await call.edit({ content: t("Link your account first with /autocraft account action:link.") }));
    if (!await mayCommand(db, keys, call.userId, login)) return void (await call.edit({ content: t("Commands need an AutoCraft login with write access. Nothing ran.") }));
    // Discord has no item the text was written on, so the items come from the list in the text; a bare number from the channel (context.ts).
    const channelId = call.interaction.channel_id;
    let d = prepareDo(call.option("text") ?? "");
    if (channelId) {
      const thread = await followOf(db, keys, threadTarget(keys, channelId));
      const settled = await settle(db, keys, d, { channelId, replied: [], thread, userId: call.userId, login, nowMs: Date.now() });
      if (settled.kind === "ask") return void (await call.edit({ content: settled.line }));
      d = settled.d;
    }
    const result = await runDo(db, keys, d, { userId: call.userId, login, messageId: call.interaction.id }, deps.read);
    await call.edit({ content: result.lines.join("\n").slice(0, 1990) || t("Nothing ran.") });
  });
  ix.command("autocraft help", null, async (call) => {
    await deliver(help, (b) => call.edit(b));
  });
  ix.command("autocraft account optout", null, async (call) => {
    if (!call.userId) return void (await call.edit({ content: "This command needs a Discord user." }));
    // Each opt-out opens every mention row to find the caller's: limited like code entries.
    if (!allow(`opt:${keys.hash("author", call.userId)}`, ATTEMPTS)) return void (await call.edit({ content: TOO_MANY }));
    const r = await optOut(db, keys, call.userId);
    if (r.changed || r.rows) await audit(db, "discord", "discord-optout", null, { rows: r.rows });
    const deleted = r.rows === 1 ? t("Deleted the record of 1 message that named an issue or pull request.") : t("Deleted {n} records of your messages that named issues or pull requests.", { n: r.rows });
    await call.edit({ content: [
      r.changed ? t("You are opted out. AutoCraft no longer records your messages, flags them or reacts to them.") : t("You were already opted out."),
      deleted,
      t("Commands and searches you send to AutoCraft still work. `/autocraft account action:optin` turns recording back on."),
    ].join("\n") });
  });
  ix.command("autocraft account optin", null, async (call) => {
    if (!call.userId) return void (await call.edit({ content: "This command needs a Discord user." }));
    const changed = await optIn(db, keys, call.userId);
    if (changed) await audit(db, "discord", "discord-optin", null);
    await call.edit({ content: changed ? t("You are opted in. AutoCraft records your new messages that name issues or pull requests again.") : t("You are not opted out.") });
  });
  ix.command("autocraft status", null, async (call) => {
    if (!mayRead(call)) return void (await call.edit({ content: TOO_MANY }));
    const item = call.option("item")?.trim();
    if (!item) {
      const s = await publicStats(db, call.option("repo")?.trim() || undefined);
      return void (await call.edit({ content: s ? formatStats(s) : "No public repo by that name." }));
    }
    const m = REF.exec(item);
    await call.edit(await statusReply(db, m ? [{ repo: m[1]!, number: Number(m[2]) }] : []));
  });
}
