// Optional Discord mention counting, ping replies and issue search. It runs only when AUTOCRAFT_DISCORD_TOKEN_FILE and AUTOCRAFT_DISCORD_KEY_FILE
// are set; the runner starts it next to the worker server. See docs/pipeline.md.
import { loadConfig, type Config } from "../dash/server/config.ts";
import { bindSecrets, processAppKeys } from "../github/app-keys.ts";
import { audit } from "./audit.ts";
import { envVar } from "../env.ts";
import { localEmbedder } from "../embed/model.ts";
import { VectorIndex } from "../embed/vectors.ts";
import { guildPerms, type Overwrite, type Role } from "./perms.ts";
import { Gateway } from "./gateway.ts";
import { Interactions } from "./interactions.ts";
import { AtCommands } from "./at-commands.ts";
import { Pings } from "./pings.ts";
import { Signals, dropSignalTexts } from "./signals.ts";
import { deleteRepliesOf } from "./replies.ts";
import { RestClient } from "./rest.ts";
import { Reactor, reactEmoji, setReactEmoji, validReactEmoji } from "./react.ts";
import { forgetReporter } from "./file-issue.ts";
import { addFilingRepo, filingReposWithMode, FilingRepoError, offerState, removeFilingRepo, setOffered } from "./filing-repos.ts";
import { forgetLink } from "./links.ts";
import { Search } from "./search.ts";
import { installAccountCommands } from "./commands.ts";
import { Alerts, installAlertCommands } from "./alerts.ts";
import { installSearchCommands } from "./search-commands.ts";
import { dropIssueTexts, installIssueNew } from "./issue-new.ts";
import { installPanel, postPanel } from "./panel.ts";
import { installRolePanel, roleConfig, RoleConfigError, rolePanelState, setRoleConfig, watchRoleGrants, watchRolePanel } from "./role-panel.ts";
import { DiscordConfigError, readKeyFile, readTokenFile, type DiscordKeys } from "./keys.ts";
import { forgetAuthor, forgetMessages, handleDispatch, setStatus } from "./store.ts";
import { forgetFollowsOf } from "./threads.ts";
import { ThreadResults } from "./results.ts";
import { DiscordAnswers } from "./answers.ts";
import { forgetVerifyRows, listChannelBriefs, markWatched, removeChannelTree, saveCategories, saveChannels, setViewable, type CategoryRow, type ChannelReport } from "../data/discord/index.ts";
import type { Db } from "../db/index.ts";
import { openDb } from "../db/open.ts";

type Channel = { id: string; name?: string; type?: number; parent_id?: string | null; position?: number; permission_overwrites?: Overwrite[] };
const CATEGORY = 4;
// Text, announcement and forum channels can be watched; their threads and forum posts count under them.
const LISTED = new Set([0, 5, 15]);

/** Keeps the channel list the admin page shows; no message is involved. Rows of deleted channels are removed by handleDispatch, which runs first. */
export async function handleMeta(db: Db, type: string, d: unknown): Promise<void> {
  const x = d as { id?: string; name?: string; guild_id?: string; type?: number; parent_id?: string | null; position?: number; unavailable?: boolean; channels?: Channel[]; threads?: Channel[]; roles?: Role[]; role?: Role; role_id?: string; user?: { id?: string }; members?: { user?: { id?: string }; roles?: string[] }[]; permission_overwrites?: Overwrite[] };
  const threads = (guildId: string, list: Channel[]): ChannelReport[] =>
    list.flatMap((t) => t.parent_id ? [{ channelId: t.id, guildId, guildName: null, name: t.name ?? null, parentId: t.parent_id }] : []);
  const category = (guildId: string, c: { id: string; name?: string; position?: number }): CategoryRow => ({ categoryId: c.id, guildId, name: c.name ?? "", position: c.position ?? 0 });
  const reviewGuild = async (guildId: string): Promise<void> => {
    await setViewable(db, guildPerms.channelIds(guildId).map((channelId) => ({ channelId, viewable: guildPerms.viewable(guildId, channelId) })));
  };
  if (type === "READY") {
    guildPerms.botId = x.user?.id ?? null;
  } else if (type === "GUILD_ROLE_CREATE" || type === "GUILD_ROLE_UPDATE") {
    if (x.guild_id && x.role) { guildPerms.setRole(x.guild_id, x.role); await reviewGuild(x.guild_id); }
  } else if (type === "GUILD_ROLE_DELETE") {
    if (x.guild_id && x.role_id) { guildPerms.deleteRole(x.guild_id, x.role_id); await reviewGuild(x.guild_id); }
  } else if (type === "GUILD_MEMBER_UPDATE") {
    if (x.guild_id && x.user?.id && x.user.id === guildPerms.botId) { guildPerms.setBotRoles(x.guild_id, (x as { roles?: string[] }).roles ?? []); await reviewGuild(x.guild_id); }
  } else if (type === "GUILD_CREATE" && x.id) {
    guildPerms.setGuild(x.id, x.roles ?? [], x.members, x.channels ?? []);
    const guildId = x.id;
    const channels = x.channels ?? [];
    await db.write(async () => {
      await saveCategories(db, channels.filter((c) => c.type === CATEGORY).map((c) => category(guildId, c)));
      await saveChannels(db, [
        ...channels.filter((c) => c.type !== CATEGORY && (c.type === undefined || LISTED.has(c.type)))
          .map((c): ChannelReport => ({ channelId: c.id, guildId, guildName: x.name ?? null, name: c.name ?? null, position: c.position, categoryId: c.parent_id, viewable: guildPerms.viewable(guildId, c.id) })),
        ...threads(guildId, x.threads ?? []),
      ]);
    });
  } else if ((type === "CHANNEL_CREATE" || type === "CHANNEL_UPDATE") && x.id && x.guild_id && x.type === CATEGORY) {
    await saveCategories(db, [category(x.guild_id, { id: x.id, name: x.name, position: x.position })]);
  } else if ((type === "CHANNEL_CREATE" || type === "CHANNEL_UPDATE") && x.id && x.guild_id && (x.type === undefined || LISTED.has(x.type))) {
    guildPerms.setChannel(x.guild_id, x.id, x.permission_overwrites);
    await saveChannels(db, [{ channelId: x.id, guildId: x.guild_id, guildName: null, name: x.name ?? null, position: x.position, categoryId: x.parent_id, viewable: guildPerms.viewable(x.guild_id, x.id) }]);
  } else if ((type === "THREAD_CREATE" || type === "THREAD_UPDATE") && x.id && x.guild_id) {
    await saveChannels(db, threads(x.guild_id, [x as Channel]));
  } else if (type === "THREAD_LIST_SYNC" && x.guild_id) {
    await saveChannels(db, threads(x.guild_id, x.threads ?? []));
  } else if ((type === "CHANNEL_DELETE" || type === "THREAD_DELETE") && x.id) {
    await removeChannelTree(db, { channelOrParentId: x.id });
  } else if (type === "GUILD_DELETE" && x.id && !x.unavailable) {
    await removeChannelTree(db, { guildId: x.id });
  }
}

/**
 * The one handler of gateway events. Order matters: the mention rows and channel list change first; the pings then see
 * `discord_replies` intact, so a deleted ping or quoted message finds our reply and deletes it in Discord.
 */
export function dispatcher(db: Db, keys: DiscordKeys, interactions: Interactions, pings: Pings, signals?: Signals, reactor?: Reactor): (type: string, d: unknown) => Promise<void> {
  return async (type, d) => {
    const recorded = await handleDispatch(db, keys, type, d);
    reactor?.observe(type, d);
    if (recorded) await reactor?.recorded(recorded.channelId, recorded.messageId, recorded.guildId);
    await handleMeta(db, type, d);
    interactions.dispatch(type, d);
    await pings.dispatch(type, d);
    await signals?.dispatch(type, d);
  };
}

/** Workflow alerts by direct message. The GitHub permissions of a linked login are read as the dashboard reads them, from the dashboard's configuration when this process has it, else from the cached permissions only. */
function installAlerts(db: Db, keys: DiscordKeys, rest: RestClient, interactions: Interactions, signal: AbortSignal, log: (l: string) => void): void {
  let config: Config | null = null;
  try { config = loadConfig(process.env); } catch (e) { log(`runner: Discord alerts use cached permissions only: ${(e as Error).message}`); }
  const appKeys = processAppKeys();
  if (config && appKeys) bindSecrets(config.secrets, appKeys);
  const alerts = new Alerts({ db, keys, rest, log, baseUrl: config?.baseUrl ?? envVar("BASE_URL") ?? null });
  installAlertCommands(interactions, alerts);
  alerts.start(signal);
}

/** Starts the gateway when configured. A bad configuration or a failed connection is logged and never stops the caller. */
export async function startDiscord(db: Db, signal: AbortSignal, log: (l: string) => void): Promise<void> {
  const tokenFile = envVar("DISCORD_TOKEN_FILE");
  if (!tokenFile) return;
  let token: string, keys: DiscordKeys;
  try {
    token = readTokenFile(tokenFile);
    const keyFile = envVar("DISCORD_KEY_FILE");
    if (!keyFile) throw new DiscordConfigError("AUTOCRAFT_DISCORD_KEY_FILE is not set");
    keys = readKeyFile(keyFile);
  } catch (e) {
    log(`runner: Discord not started: ${(e as Error).message}`);
    await setStatus(db, "failed", (e as Error).message);
    return;
  }
  const rest = new RestClient({ token });
  const embedder = localEmbedder({ threads: 2 });
  const index = new VectorIndex(embedder);
  // Start the model and index loads now so the first search is warm. Nothing waits for them; a search arriving earlier awaits the same in-flight loads.
  for (const [what, load] of [["embedding model", async () => void await embedder.embed(["warm"], "query")], ["vector index", () => index.ready(db)]] as const) {
    void Promise.resolve().then(load).catch((e) => log(`runner: Discord ${what} warm-up failed: ${(e as Error).message}`));
  }
  const search = new Search({ db, embedder, index, log });
  const interactions = new Interactions(rest, log);
  installSearchCommands(interactions, { db, keys, search });
  installAccountCommands(interactions, { db, keys });
  installPanel(interactions, db, installIssueNew(interactions, { db, keys, search, log }));
  installAlerts(db, keys, rest, interactions, signal, log);
  installRolePanel(interactions, { db, keys, rest, log, baseUrl: envVar("BASE_URL") ?? null });
  watchRolePanel(db, rest, log, signal);
  watchRoleGrants(db, keys, rest, log, signal);
  const results = new ThreadResults({ db, keys, rest, log });
  results.start(signal);
  new DiscordAnswers({ db, keys, rest, log }).start(signal);
  const pings = new Pings({ db, keys, rest, search, log, commands: new AtCommands({ db, keys, rest, log, followed: () => void results.sync() }) });
  const signals = new Signals({ db, keys, log });
  const reactor = new Reactor({ db, rest, log });
  // A crash during a call can leave the question in a recorded prompt.
  try { await dropIssueTexts(db, true); await dropSignalTexts(db, true); } catch (e) { log(`runner: removing search texts failed: ${(e as Error).message}`); }
  const gw = new Gateway({
    token,
    log,
    onState: async (state, detail) => await setStatus(db, state, detail),
    onDispatch: dispatcher(db, keys, interactions, pings, signals, reactor),
  });
  log("runner: Discord mention counting, pings, commands and search started");
  void gw.run(signal).catch((e: Error) => log(`runner: Discord stopped: ${e.message}`));
}

const USAGE = `usage: autocraft-server discord forget --message <message link or id> | --user <user id>
       autocraft-server discord channels
       autocraft-server discord watch <channel id> | unwatch <channel id>
       autocraft-server discord panel post <channel id>
       autocraft-server discord role-panel | role-panel set <channel id> <role id> | role-panel off
       autocraft-server discord filing list | add <owner/name> | remove <owner/name>
       autocraft-server discord offer list | hide <name> | show <name>`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function keysOrDie(): DiscordKeys {
  const f = envVar("DISCORD_KEY_FILE");
  if (!f) die("AUTOCRAFT_DISCORD_KEY_FILE is not set");
  try {
    return readKeyFile(f);
  } catch (e) {
    return die((e as Error).message);
  }
}

// Recorded in the audit log as `cli`: only someone with a shell on the host can run this.
async function discord(args: string[]): Promise<void> {
  const [sub, a, b] = args;
  const db = await openDb();
  if (sub === "forget" && (a === "--message" || a === "--user") && b) {
    const keys = keysOrDie();
    const id = a === "--message" ? (/\/channels\/\d+\/\d+\/(\d+)\/?(?:[?#].*)?$/.exec(b)?.[1] ?? (/^\d+$/.test(b) ? b : die("not a Discord message link or id"))) : /^\d+$/.test(b) ? b : die("not a Discord user id");
    if (a === "--message") {
      const n = await forgetMessages(db, keys, [id]);
      // Our reply to the message goes too: deleted in Discord first, then its row.
      const tokenFile = envVar("DISCORD_TOKEN_FILE");
      let replies = 0;
      if (tokenFile) {
        try {
          replies = await deleteRepliesOf(db, keys, new RestClient({ token: readTokenFile(tokenFile) }), [id], (l) => console.error(l));
        } catch (e) {
          console.error((e as Error).message);
        }
      }
      await audit(db, "cli", "discord-forget", "message", { rows: n, replies });
      console.log(`deleted ${n} mention ${n === 1 ? "row" : "rows"} and ${replies} ${replies === 1 ? "reply" : "replies"}`);
    } else {
      const n = await forgetAuthor(db, keys, id);
      const follows = await forgetFollowsOf(db, keys, id);
      const links = await forgetLink(db, keys, id);
      const signedIn = await forgetReporter(db, keys.hash("author", id));
      const verify = await forgetVerifyRows(db, keys.hash("author", id));
      await audit(db, "cli", "discord-forget", "user", { rows: n, follows, links, signedIn, verify });
      console.log(`deleted ${n} mention ${n === 1 ? "row" : "rows"}, ${follows} thread ${follows === 1 ? "row" : "rows"} and ${links} ${links === 1 ? "link" : "links"}${signedIn ? " and the GitHub sign-in" : ""}`);
    }
  } else if (sub === "channels") {
    for (const c of await listChannelBriefs(db))
      console.log(`${c.watched ? "watched " : "-       "} ${c.channelId} ${c.guildName ?? "?"} / #${c.name ?? "?"}`);
  } else if ((sub === "watch" || sub === "unwatch") && a) {
    if (!await markWatched(db, a, sub === "watch")) die("no such channel; the bot has not reported it");
    await audit(db, "cli", sub === "watch" ? "discord-watch" : "discord-unwatch", a);
    console.log(`${sub === "watch" ? "watching" : "no longer watching"} ${a}`);
  } else if (sub === "panel" && a === "post" && b) {
    const tokenFile = envVar("DISCORD_TOKEN_FILE");
    if (!tokenFile) die("AUTOCRAFT_DISCORD_TOKEN_FILE is not set");
    let token: string;
    try { token = readTokenFile(tokenFile); } catch (e) { die((e as Error).message); }
    const r = await postPanel(db, new RestClient({ token }), b).catch((e: Error) => die(`posting the panel failed: ${e.message}`));
    if (!r) die("no such channel; the bot has not reported it");
    await audit(db, "cli", "discord-panel", b, { message: r.messageId, created: r.created });
    console.log(`${r.created ? "posted" : "updated"} the panel in ${b} (message ${r.messageId})${r.pinError ? `; not pinned: ${r.pinError}` : ""}`);
  } else if (sub === "role-panel" && !a) {
    const [cfg, st] = await Promise.all([roleConfig(db), rolePanelState(db)]);
    if (!cfg) console.log("the contributor role panel is off");
    else console.log(`contributor role ${cfg.roleId} in server ${cfg.guildId}, panel in ${cfg.channelId}: ${st?.channelId === cfg.channelId ? (st.error ? `not posted: ${st.error}` : `message ${st.messageId}`) : "not posted yet"}`);
  } else if (sub === "role-panel" && a === "set" && b && args[3]) {
    const cfg = await setRoleConfig(db, "cli", { channelId: b, roleId: args[3] }).catch((e: Error) => die(e instanceof RoleConfigError ? e.message : `saving failed: ${e.message}`));
    console.log(`the runner posts the contributor role panel in ${cfg!.channelId}; Verify gives role ${cfg!.roleId}`);
  } else if (sub === "role-panel" && a === "off") {
    await setRoleConfig(db, "cli", null);
    console.log("the contributor role panel is off; the runner removes the posted panel");
  } else if (sub === "react-emoji") {
    if (!a) {
      console.log(await reactEmoji(db));
    } else {
      if (!validReactEmoji(a)) die("give a custom emoji name (2-32 letters, digits or underscores) or one Unicode emoji");
      await setReactEmoji(db, a);
      await audit(db, "cli", "discord-react-emoji", a);
      console.log(`the bot reacts with ${a}`);
    }
  } else if (sub === "filing" && a === "list") {
    for (const r of await filingReposWithMode(db)) console.log(`${r.owner}/${r.name}  ${r.mode === "submit" ? "Submit for me" : "link only"}  added ${r.addedAt.slice(0, 16).replace("T", " ")} by ${r.addedBy}`);
  } else if (sub === "filing" && a === "add" && b) {
    const r = await addFilingRepo(db, "cli", b).catch((e: Error) => die(e instanceof FilingRepoError ? e.message : `adding failed: ${e.message}`));
    console.log(r.mode === "submit" ? `the Discord bot files into ${r.owner}/${r.name} as the GitHub App (Submit for me)`
      : `the Discord bot offers ${r.owner}/${r.name} link only (${(r.why ?? "the GitHub App does not cover it").replace(/\.$/, "")}): drafts get only the GitHub link until the app covers it`);
  } else if (sub === "filing" && a === "remove" && b) {
    if (!await removeFilingRepo(db, "cli", b)) die(`${b} is not a filing-only repo`);
    console.log(`the Discord bot no longer files into ${b}`);
  } else if (sub === "offer" && a === "list") {
    const o = await offerState(db);
    for (const r of o.repos) console.log(`${r.offered ? "offered" : "hidden "}  ${r.name}${r.label !== r.name ? `  (${r.label})` : ""}`);
    console.log(`${o.used} of ${o.max} places used`);
  } else if (sub === "offer" && (a === "hide" || a === "show") && b) {
    if (!await setOffered(db, "cli", b, a === "show")) die(`${b} is not a public tracked repo`);
    console.log(`the Discord bot ${a === "show" ? "offers" : "no longer offers"} ${b}`);
  } else die(USAGE);
}

export const commands = {
  discord: { summary: "Discord mentions: forget --message|--user | channels | watch | unwatch | panel post | role-panel [set|off] | filing list|add|remove | offer list|hide|show", run: (args: string[]) => discord(args) },
};
