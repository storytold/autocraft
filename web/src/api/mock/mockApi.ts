import type { Api } from "../client";
import type { Item, User } from "../types";
import { setClock } from "../../lib/format";
import { createAdminMock } from "./adminMock";
import { createMcpMock } from "./mcpMock";
import { createAgentsMock } from "./agentsMock";
import { createTraceMock } from "./traceMock";
import { createChatMock } from "./chatMock";
import { createHealthMock } from "./healthMock";
import { createMaintainMock } from "./maintainMock";
import { createMaintainItemMock } from "./maintainItemMock";
import { createActivityMock } from "./activityMock";
import { createAreasMock } from "./areasMock";
import { createSecurityMock } from "./securityMock";
import { createItemPagesMock, type ItemPagesApi } from "./itemPagesMock";
import { authorStatsFor } from "./browseMock";
import { createBuildMock } from "./buildMock";
import { createWorkspacesMock } from "./workspacesMock";
import { createNightlyMock } from "./nightlyMock";
import { createPipelineMock } from "./pipelineMock";
import { promptsReport } from "../../../../src/prompts/index.ts";
import { semanticHits } from "./similarFixtures";
import { downloadsReport } from "./downloadsMock";
import { classifierReport, costReport, disagreementList } from "./insightFixtures";
import { mockDiscordCount, mockDiscordLinks, settledFor } from "./itemsFixtures";
import type { DiscordFilingAdded, DiscordSetup } from "../types";
import { postmergeFor, premergeFor, prWorkFor } from "./verifyFixtures";
import { nextPageFixture } from "./nextMock";
import { batchDetailMock } from "./batchMock";
import { createQueueMock } from "./queueMock";
import { mainCi } from "./mainCiMock";
import { MOCK_USERS, MOCK_REPO_OWNERS, NOW, REPOS, SEARCH_POOL, itemFor, progress, type MockRole } from "./fixtures";

const wait = <T>(v: T, ms = 60) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const nowIso = () => new Date(NOW).toISOString();
const ROLE_KEY = "autocraft:mock-as";

/** Mock role: `?as=operator|maintainer|viewer`, else the last one picked, else operator. */
export function mockRole(): MockRole {
  const q = new URLSearchParams(location.search).get("as");
  let v: string | null = q;
  if (!v) {
    try {
      v = localStorage.getItem(ROLE_KEY);
    } catch {
      v = null;
    }
  }
  return v && v in MOCK_USERS ? (v as MockRole) : "operator";
}

export function setMockRole(r: MockRole) {
  try {
    localStorage.setItem(ROLE_KEY, r);
  } catch {
    /* storage blocked */
  }
  const u = new URL(location.href);
  u.searchParams.delete("as");
  location.replace(u.toString());
}

/** In-memory API over the fixture. Writes change the in-memory copy until reload. */
export function createMockApi(): Api {
  setClock(() => NOW);
  const me: User = MOCK_USERS[mockRole()];
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((fn) => fn());
  // `?discord=unlinked` starts without a linked account, for screenshots of the setup steps.
  let discordLinked = new URLSearchParams(location.search).get("discord") !== "unlinked";
  const discord: DiscordSetup = {
    state: "connected", detail: null, at: nowIso(), repos: ["photocraft", "pdfcraft", "wordcraft"],
    offer: {
      repos: [
        { name: "photocraft", label: "PhotoCraft", offered: true }, { name: "pdfcraft", label: "PDFCraft", offered: true }, { name: "wordcraft", label: "WordCraft", offered: true },
        { name: "sheetcraft", label: "SheetCraft", offered: true }, { name: "vector-core", label: "vector-core", offered: false }, { name: "codec-kit", label: "codec-kit", offered: false },
        { name: "font-engine", label: "font-engine", offered: false }, { name: "layout-lib", label: "layout-lib", offered: true },
      ],
      used: 6, max: 25,
    },
    filingRepos: [
      { owner: "example-studio", name: "sketchpad", addedBy: "mara-lindqvist", addedAt: new Date(Date.now() - 6 * 86_400_000).toISOString(), mode: "submit", why: null },
      { owner: "open-tools-collective", name: "vector-shapes-and-paths-library", addedBy: "mara-lindqvist", addedAt: new Date(Date.now() - 40 * 60_000).toISOString(), mode: "link", why: "The GitHub App is not installed on open-tools-collective." },
    ],
    contact: "discord-privacy@example.org", reactOn: true, reactEmoji: "bot", privacyPath: "/privacy",
    usage: {
      counts: { started: { day: 14, week: 63 }, junk: { day: 2, week: 9 }, filed: { day: 6, week: 31 }, link: { day: 3, week: 12 }, limits: { day: 1, week: 4 } },
      prompts: [
        { prompt: "discord.issue-draft", day: { calls: 9, usd: 0.0021 }, week: { calls: 41, usd: 0.0094 } },
        { prompt: "discord.issue-questions", day: { calls: 11, usd: 0.0019 }, week: { calls: 52, usd: 0.0088 } },
        { prompt: "discord.junk.jev", day: { calls: 14, usd: 0 }, week: { calls: 63, usd: 0 } },
        { prompt: "discord.junk.haiku", day: { calls: 3, usd: 0.0006 }, week: { calls: 11, usd: 0.0023 } },
        { prompt: "discord.signal.haiku", day: { calls: 120, usd: 0.0312 }, week: { calls: 806, usd: 0.2143 } },
      ],
      filed: [
        { repo: "sketchpad", number: 7731, login: "(app)", at: new Date(Date.now() - 10 * 60_000).toISOString(), githubUrl: "https://github.com/example-studio/sketchpad/issues/7731" },
        { repo: "photocraft", number: 4182, login: "(app)", at: new Date(Date.now() - 25 * 60_000).toISOString(), githubUrl: null },
        { repo: "pdfcraft", number: 977, login: "(app)", at: new Date(Date.now() - 3 * 3_600_000).toISOString(), githubUrl: null },
        { repo: "wordcraft", number: 311, login: "tomas-vale", at: new Date(Date.now() - 9 * 3_600_000).toISOString(), githubUrl: null },
      ],
      capacity: { ready: false, why: "1 Task Runner has Interactive slots, and it is quota-held" },
    },
    links: [
      { id: "l1", login: "mira-anders", linkedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() },
      { id: "l2", login: "tomas-vale", linkedAt: new Date(Date.now() - 40 * 3_600_000).toISOString() },
    ],
    channels: Array.from({ length: 70 }, (_, i) => {
      const first = i < 35;
      return {
        channelId: `${first ? "90" : "91"}0000000000${String(100 + i)}`,
        guildId: first ? "9000000000000001" : "9100000000000001",
        guildName: first ? "Glasswing Community" : "Open Tools Collective",
        name: `channel-${i + 1}`,
        watched: new URLSearchParams(location.search).get("inuse") === "1" && i === 3,
        defaultRepo: null,
        category: i % 10 < 5 ? "Community" : "Development",
      };
    }),
    rolePanel: new URLSearchParams(location.search).get("rolepanel") === "off"
      ? { channelId: null, roleId: null, guildId: null, posted: null }
      : { channelId: "900000000000102", roleId: "9000000000000777", guildId: "9000000000000001", posted: { messageId: "9000000000005555", error: null, at: new Date(Date.now() - 2 * 3_600_000).toISOString() } },
  };
  const mcpMock = createMcpMock(me, changed);
  const api: Omit<Api, keyof ItemPagesApi> = {
    me: Object.assign(() => wait(me, 10), {
      settings: mcpMock.meSettings,
    }),
    repos: () => wait(REPOS, 10),
    repoOwners: () => wait(MOCK_REPO_OWNERS, 10),
    authorStats: (login) => wait(authorStatsFor(login)),
    item: (repo, number) => {
      const it = itemFor(repo, number);
      const postmerge = postmergeFor(number, it.kind, mockRole() !== "viewer");
      const merged = postmerge ? { state: "merged" as const, mergedAt: postmerge.at, mergedBy: "pipeline" } : {};
      const full: Item = { ...it, ...merged, discord: { count: mockDiscordCount(number), links: mockDiscordLinks(number) }, settled: settledFor(number), ...prWorkFor(number, it.kind), premerge: premergeFor(number, it.kind), postmerge };
      // As on the server, viewers get states and verdicts without job errors or model text.
      if (mockRole() !== "viewer") return wait(full);
      return wait({
        ...full,
        fixups: full.fixups.map((f) => ({ ...f, reason: null, files: [] })),
        verification: full.verification && { ...full.verification, reason: "", summary: null, note: null, tasks: full.verification.tasks.map((t) => ({ ...t, results: [] })) },
        reviews: full.reviews && { ...full.reviews, opus: full.reviews.opus && { ...full.reviews.opus, reason: "", fixes: [], risks: [] }, final: { ...full.reviews.final, reason: "" } },
      });
    },
    discord: {
      setup: () => wait(structuredClone(discord)),
      setChannel(channelId, watched) {
        if (mockRole() !== "operator") throw new Error("only operators change the Discord settings");
        discord.channels.find((c) => c.channelId === channelId)!.watched = watched;
        changed();
        return wait(structuredClone(discord));
      },
      setChannelRepo(channelId, repo) {
        if (mockRole() !== "operator") throw new Error("only operators change the Discord settings");
        discord.channels.find((c) => c.channelId === channelId)!.defaultRepo = repo;
        changed();
        return wait(structuredClone(discord));
      },
      addFilingRepo(repo) {
        if (mockRole() !== "operator") throw new Error("only operators change the Discord settings");
        const [owner, name] = repo.trim().split("/");
        if (!owner || !name) throw new Error("Give the repo as owner/name.");
        if (owner === "private-org") throw new Error(`${owner}/${name} is not public.`);
        const added = owner === "example-studio" ? { owner, name, mode: "submit" as const, why: null } : { owner, name, mode: "link" as const, why: `The GitHub App is not installed on ${owner}.` };
        discord.filingRepos = [...discord.filingRepos, { owner, name, addedBy: "you", addedAt: nowIso(), mode: added.mode, why: added.why }];
        changed();
        return wait<DiscordFilingAdded>({ ...structuredClone(discord), added });
      },
      setOffer(repo, on) {
        if (mockRole() !== "operator") throw new Error("only operators change the Discord settings");
        discord.offer.repos.find((r) => r.name === repo)!.offered = on;
        discord.offer.used = Math.min(discord.offer.max, discord.offer.repos.filter((r) => r.offered).length + discord.filingRepos.length);
        changed();
        return wait(structuredClone(discord));
      },
      removeFilingRepo(repo) {
        if (mockRole() !== "operator") throw new Error("only operators change the Discord settings");
        discord.filingRepos = discord.filingRepos.filter((r) => `${r.owner}/${r.name}` !== repo);
        changed();
        return wait(structuredClone(discord));
      },
      removeLink(id) {
        if (mockRole() !== "operator") throw new Error("only operators change the Discord settings");
        discord.links = discord.links.filter((l) => l.id !== id);
        changed();
        return wait(structuredClone(discord));
      },
      account: () => wait({ linked: discordLinked, at: nowIso(), configured: new URLSearchParams(location.search).get("discord") !== "off" }),
      linkCode: () => wait({ code: "K7Q4MX2P", expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
      unlinkOwn() {
        discordLinked = false;
        changed();
        return wait({ linked: false, at: null, configured: true });
      },
      setReact(on) {
        if (mockRole() !== "operator") throw new Error("only operators change the Discord settings");
        discord.reactOn = on;
        changed();
        return wait(structuredClone(discord));
      },
      setReactEmoji(emoji) {
        if (mockRole() !== "operator") throw new Error("only operators change the Discord settings");
        if (!/^[A-Za-z0-9_]{2,32}$/.test(emoji.trim()) && !/^\p{Extended_Pictographic}/u.test(emoji.trim())) throw new Error("emoji must be a custom emoji name (2-32 letters, digits or underscores) or one Unicode emoji");
        discord.reactEmoji = emoji.trim();
        changed();
        return wait(structuredClone(discord));
      },
      setRolePanel(panel) {
        if (mockRole() !== "operator") throw new Error("only operators change the Discord settings");
        if (panel && (!/^\d{15,22}$/.test(panel.channelId) || !/^\d{15,22}$/.test(panel.roleId.trim()))) throw new Error("channel and role must be Discord ids (digits only)");
        const guildId = panel ? discord.channels.find((c) => c.channelId === panel.channelId)?.guildId ?? null : null;
        discord.rolePanel = panel ? { channelId: panel.channelId, roleId: panel.roleId.trim(), guildId, posted: null } : { channelId: null, roleId: null, guildId: null, posted: null };
        changed();
        return wait(structuredClone(discord));
      },
      setContact(contact) {
        if (mockRole() !== "operator") throw new Error("only operators change the Discord settings");
        discord.contact = contact.trim();
        changed();
        return wait(structuredClone(discord));
      },
    },
    search(q) {
      const s = q.trim().toLowerCase();
      if (!s) return Promise.resolve([]);
      const ref = s.match(/^([a-z-]+)?#(\d+)$/);
      const hits = SEARCH_POOL.filter((h) =>
        ref
          ? (!ref[1] || h.repo.startsWith(ref[1])) && String(h.number).startsWith(ref[2])
          : h.title.toLowerCase().includes(s) || h.author.toLowerCase().includes(s) || `${h.repo}#${h.number}`.includes(s),
      );
      return wait(hits.slice(0, 8), 40);
    },
    progress: () => wait(progress()),
    mainCi: () => wait(mainCi()),
    ...createAreasMock(me, changed),
    ...createAdminMock(me, changed),
    mcp: mcpMock.mcp,
    inference: mcpMock.inference,
    runners: mcpMock.runners,
    modelQueue: mcpMock.modelQueue,
    classifiers: {
      report: (sel) => wait(classifierReport(sel), 80),
      disagreements: (f) => wait(disagreementList(f), 60),
    },
    cost: (run) => wait(costReport(run), 80),
    downloads: (range, app) => wait(downloadsReport(range, app), 80),
    ...createPipelineMock(me, changed),
    ...createAgentsMock(),
    ...createTraceMock(),
    ...createHealthMock(() => MOCK_USERS[mockRole()].role),
    ...createActivityMock(),
    ...createBuildMock(me, changed),
    ...createWorkspacesMock(me),
    ...createNightlyMock(me, changed),
    ...createSecurityMock(me, changed),
    ...createQueueMock(me, changed),
    ...createMaintainMock(me),
    ...createMaintainItemMock(me, changed),
    ...createChatMock(me, changed),
    prompts: () => wait(promptsReport(null), 60),
    next: () => wait(nextPageFixture(), 60),
    mention: () => wait({ mention: "autocraftbot" }, 20),
    batch: (id) => wait(batchDetailMock(id), 60),
    signOut: () => wait(undefined),
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    semanticSearch: (q) => wait(semanticHits(q), 90),
  };
  return { ...api, ...createItemPagesMock(me, api) };
}
