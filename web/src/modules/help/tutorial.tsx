// Help → Get started: what a new maintainer sets up and needs to know, as steps and bullets, each with a link to its reference page. The sample replies come
// from the workflow's own parser and confirmation (src/workflow), so they read as AutoCraft answers.
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeftIcon, CaretRightIcon, CheckSquareIcon } from "@phosphor-icons/react";
import { t } from "../../../../src/i18n/index.ts";
import { parse } from "../../../../src/workflow/parse.ts";
import { resolve } from "../../../../src/workflow/resolve.ts";
import { attributionLines, confirmLine, currentStep, stateLine, stepLines, workflowSteps } from "../../../../src/workflow/status.ts";
import type { ItemKind, ItemWorkflow } from "../../../../src/workflow/types.ts";
import { COMMANDS, WEIGHT_HELP } from "../../../../src/workflow/vocab.ts";
import { useQuery } from "../../api/client";
import type { ChatEntry } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { useSetupProgress, type SetupCheck } from "../../lib/setupProgress";
import { LinkDiscordDialog } from "../../shell/LinkDiscord";
import { Button } from "../../ui/atoms/Button";
import { ItemIcon } from "../../ui/atoms/ItemIcon";
import { CodeBlock } from "../../ui/molecules/CodeBlock";
import { Segmented } from "../../ui/molecules/Segmented";
import { AutoCraftMessage, AutoCraftTurn } from "../../ui/molecules/chat/AutoCraftMessage";
import { ChatBubble } from "../../ui/molecules/chat/ChatBubble";
import { ChannelMock } from "../../ui/organisms/ChannelMock";
import { CommentThreadMock } from "../../ui/organisms/CommentThreadMock";
import { TutorialStep } from "../../ui/organisms/TutorialStep";

const WHO = "mira";
const AT = "2026-11-28T09:31:00.000Z";
const REPO = "photocraft";
const ITEMS = [
  { number: 803, title: "Keep the alpha channel in PNG previews" },
  { number: 19, title: "Speed up the brush preview on large canvases" },
];
const SAID = "review and merge";

/** What AutoCraft answers `text` with on an item nobody started, read and resolved as the server does. */
function confirmation(text: string, kind: ItemKind = "pr"): string {
  const r = resolve(parse(text, { repo: REPO }), { kind, workflow: null });
  return r.kind === "run" ? confirmLine(r.run, WHO, AT) : r.understood;
}

/** The status comment of the sample pull request after `review and merge`, while the review runs. */
function statusLines(): { head: string; rest: string[] } {
  const wf: ItemWorkflow = {
    id: 1, repo: REPO, number: ITEMS[0]!.number, kind: "pr", entry: "review", weight: 5, state: "running",
    startedBy: WHO, startedAt: AT, startedVia: "github", baseHead: null, acceptedHead: null,
    approvedBy: WHO, approvedAt: AT, approvedVia: "github", stoppedBy: null, stoppedAt: null, takenBy: null,
    blocker: null, blockerParams: null, rec: null, recAt: null, recHead: null,
    plan: [], step: "review",
    prNumber: null, reviewAskedAt: null, legacyPreapprovalId: null, version: 3, updatedAt: AT,
  };
  const steps = workflowSteps(wf, "reviewing");
  return { head: stateLine(wf, currentStep(steps)), rest: [...attributionLines(wf), ...stepLines(steps)] };
}

const Code = ({ children }: { children: ReactNode }) => <code className="code rounded bg-ink/[0.07] px-1 py-0.5 text-[0.9em]">{children}</code>;
const ref = (n: number) => `${REPO}#${n}`;
const linkCls = "rounded text-accent-ink underline underline-offset-2";
const A = ({ to, children }: { to: string; children: ReactNode }) => <Link to={to} className={linkCls}>{children}</Link>;

/** A procedure: numbered, one action per line. */
const Steps = ({ children }: { children: ReactNode }) => <ol className="flex list-decimal flex-col gap-2 pl-6 marker:text-ink/60">{children}</ol>;
/** Facts: one per bullet. */
const Bullets = ({ children }: { children: ReactNode }) => <ul className="flex list-disc flex-col gap-1.5 pl-5 marker:text-ink/50">{children}</ul>;
/** `term`: what it does, one line. */
const Term = ({ term, children }: { term: ReactNode; children: ReactNode }) => (
  <li>
    <span className="font-semibold">{term}</span>: {children}
  </li>
);

type Harness = "linux" | "mac" | "codex";
const HARNESS: Record<Harness, string> = {
  linux: "autocraft harness claude --config-dir",
  mac: "autocraft harness claude --keychain",
  codex: "autocraft harness codex\n# on a machine without a browser: autocraft harness codex --device-auth",
};

function RunnerStep({ done }: { done?: boolean }) {
  const [harness, setHarness] = useState<Harness>(typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent) ? "mac" : "linux");
  return (
    <TutorialStep id="runner" n={1} title={t("Connect a Task Runner")} done={done} refs={[{ to: "/connect/setup", label: t("Setup guide") }, { to: "/help/start", label: t("Overview") }]}>
      <Bullets>
        <li>{t("Model work runs on your own machine, with your Claude or Codex subscription.")}</li>
      </Bullets>
      <Steps>
        <li>
          {t("Run the first command of the")} <A to="/connect/setup">{t("Setup guide")}</A>. {t("It installs the runner and logs it in.")}
        </li>
        <li>{t("Open the link it prints and approve the code.")}</li>
        <li>
          <div className="flex flex-col gap-1.5">
            <span>{t("If setup did not pick a model login, pick one:")}</span>
            <Segmented label={t("Model login")} value={harness} onChange={(v) => setHarness(v as Harness)} options={[{ value: "linux", label: t("Claude on Linux") }, { value: "mac", label: t("Claude on macOS") }, { value: "codex", label: "Codex" }]} />
            <CodeBlock compact title={t("Model login")} text={HARNESS[harness]} />
          </div>
        </li>
        <li>
          {t("Check it:")} <Code>autocraft doctor</Code>
        </li>
        <li>
          {t("Keep it running:")} <Code>autocraft service install</Code>, {t("or")} <Code>autocraft work</Code> {t("in a terminal.")}
        </li>
        <li>
          <div className="flex flex-col gap-1.5">
            <span>
              {t("Choose what it takes, under My settings on the")} <A to="/runner">{t("Runner page")}</A>:
            </span>
            <Bullets>
              <Term term={t("Manual only")}>{t("only what you start or pick")}</Term>
              <Term term={t("My repos, task kinds")}>{t("narrow the other work")}</Term>
              <Term term={t("Keep free")}>{t("plan usage it leaves unused, 5-hour and weekly")}</Term>
              <Term term={t("Max calls at once")}>{t("calls all your runners run together")}</Term>
            </Bullets>
          </div>
        </li>
        <li>
          {t("Rename it on its row on the")} <A to="/connect">{t("Connect page")}</A>.
        </li>
      </Steps>
      <Bullets>
        <li>{t("Done when one of your Task Runners is connected and ready.")}</li>
        <li>
          {t("Its calls:")} <A to="/agents">{t("Agents")}</A>
        </li>
      </Bullets>
    </TutorialStep>
  );
}

function DiscordStep({ check }: { check?: SetupCheck }) {
  const [linking, setLinking] = useState(false);
  return (
    <TutorialStep id="discord" n={2} title={t("Link Discord")} done={check?.done} refs={[{ to: "/help/start", label: t("Overview") }]}>
      <Steps>
        <li>
          <div className="flex flex-col gap-1.5">
            <span>
              {t("Press Link Discord, here or on the")} <A to="/runner">{t("Runner page")}</A>.
            </span>
            {check && !check.done && (
              <>
                <Button variant="primary" className="w-fit max-md:h-11" onClick={() => setLinking(true)}>{t("Link Discord")}</Button>
                <LinkDiscordDialog open={linking} linked={check.done} onClose={() => setLinking(false)} />
              </>
            )}
          </div>
        </li>
        <li>
          {t("In Discord, run the command it shows:")} <Code>/autocraft account action:link code:…</Code>
        </li>
      </Steps>
      <Bullets>
        <li>{t("The code works once, until the time the dialog shows.")}</li>
        <li>
          {t("After that,")} <Code>@AutoCraft</Code> {t("and")} <Code>/autocraft do</Code> {t("act as you.")}
        </li>
      </Bullets>
    </TutorialStep>
  );
}

function HowStep() {
  return (
    <TutorialStep id="how" n={3} title={t("How AutoCraft works")} refs={[{ to: "/help/workflows", label: t("Workflows") }, { to: "/help/after", label: t("After a command") }]}>
      <Bullets>
        <li>{t("Nothing runs on an item until someone sends a command.")}</li>
        <li>{t("Exception: small and medium bug fixes from contributors with a good merge history.")}</li>
        <li>
          <Code>merge</Code> {t("approves the merge once any outstanding fixes or implementation are done. Skips the full review.")}
        </li>
        <li>
          <Code>review and merge</Code> {t("approves the merge if the full review finds no blocker, once its recommended fixes or implementation are done.")}
        </li>
        <li>{t("Blockers come back to you: a scope question, author commits you did not approve, a step that failed twice.")}</li>
        <li>{t("Approved: AutoCraft reviews, fixes and merges in your name on green CI.")}</li>
        <li>{t("It comes back to you only when it cannot get there.")}</li>
        <li>{t("Not approved: it comes back with one recommendation.")}</li>
      </Bullets>
    </TutorialStep>
  );
}

function CommandsStep() {
  return (
    <TutorialStep id="commands" n={4} title={t("Commands")} refs={[{ to: "/help/commands", label: t("Commands") }]}>
      <Bullets>
        <li>{t("The same words on GitHub, Discord, your agent and here.")}</li>
        <li>
          {t("Combine them:")} <Code>review and merge</Code>, <Code>fix 1, drop 2, then merge</Code>
        </li>
      </Bullets>
      <ul aria-label={t("Commands")} className="flex flex-col divide-y divide-line rounded-md border border-line text-sm">
        {COMMANDS.map((c) => (
          <li key={c.word} className="grid gap-x-3 px-3 py-1.5 sm:grid-cols-[11rem_1fr]">
            <Link to={c.more ? "/help/commands" : `/help/commands#cmd-${c.word.split(" ")[0]}`} className="code w-fit rounded text-accent-ink hover:underline">
              {c.usage}
            </Link>
            <span>{t(c.short)}</span>
          </li>
        ))}
        {WEIGHT_HELP.filter((w) => w.word !== "(none)").map((w) => (
          <li key={w.word} className="grid gap-x-3 px-3 py-1.5 sm:grid-cols-[11rem_1fr]">
            <span className="code">{w.word}</span>
            <span>{t("Weight {weight}", { weight: t(w.weight) })}</span>
          </li>
        ))}
      </ul>
    </TutorialStep>
  );
}

function AnswerStep() {
  return (
    <TutorialStep id="answer" n={5} title={t("Answering AutoCraft")} refs={[{ to: "/help/after", label: t("After a command") }, { to: "/help/examples", label: t("Examples") }]}>
      <Bullets>
        <Term term={<><Code>yes</Code>, <Code>approve</Code>, <Code>lgtm</Code></>}>{t("run the recommendation")}</Term>
        <Term term={t("Anything else")}>{t("what to do instead, in your own words")}</Term>
        <Term term={<><Code>hold</Code>, <Code>stop</Code>, <Code>pause</Code></>}>{t("halt the item at once")}</Term>
        <li>{t("Unclear text runs nothing; AutoCraft says what it understood.")}</li>
        <li>{t("Every accepted command gets one confirmation line.")}</li>
      </Bullets>
    </TutorialStep>
  );
}

function WhereStep({ mention }: { mention: string }) {
  const one = confirmation(SAID);
  const status = statusLines();
  const many = ITEMS.map((i) => `${ref(i.number)}: ${confirmation(`${SAID} ${ref(i.number)}`)}`);
  const said: Extract<ChatEntry, { t: "said" }> = { t: "said", id: "s1", at: AT, login: WHO, via: "dashboard", body: SAID, url: null };
  const confirmed: Extract<ChatEntry, { t: "reply" }> = { t: "reply", id: "c1", at: AT, body: one, findings: [], ask: null };
  return (
    <TutorialStep id="where" n={6} title={t("Where to send them")} refs={[{ to: "/help/start", label: t("Overview") }]}>
      <Bullets>
        <Term term="GitHub">
          {t("a comment on the item:")} <Code>@{mention} {SAID}</Code>
        </Term>
        <Term term="Discord">
          <Code>/autocraft do</Code> {t("(private reply) or")} <Code>@AutoCraft</Code> {t("(reply in a thread)")}
        </Term>
        <Term term="AutoCraft">{t("tick items on Items, or write in an item's chat")}</Term>
      </Bullets>
      <div className="grid gap-4 lg:grid-cols-2">
        <CommentThreadMock
          label={t("On GitHub: your comment, the reply, the status comment")}
          title={
            <span className="flex items-start gap-2">
              <ItemIcon kind="pr" state="open" tip={false} />
              <span>
                {ITEMS[0]!.title} <span className="code font-normal text-ink/60">#{ITEMS[0]!.number}</span>
              </span>
            </span>
          }
          comments={[
            { author: WHO, when: "09:30", body: <p className="code">@{mention} {SAID}</p> },
            { author: mention, tag: t("bot"), when: "09:31", body: <p>@{WHO} {one}</p> },
            {
              author: mention, tag: t("bot"), when: t("09:48, edited"),
              body: (
                <>
                  <p className="font-semibold">{status.head}</p>
                  {status.rest.map((l) => <p key={l}>{l}</p>)}
                  <p>
                    {t("Details for maintainers:")} <span className="text-accent-ink underline underline-offset-2">{t("this item")}</span>
                  </p>
                </>
              ),
            },
          ]}
        />
        <ChannelMock
          label={t("On Discord: the slash command and its private reply")}
          channel={REPO}
          messages={[
            {
              author: WHO, when: "09:30",
              body: (
                <p>
                  <span className="code rounded bg-accent/15 px-1 py-0.5 text-accent-ink">/autocraft do</span> <span className="code">text: {SAID} {ref(ITEMS[0]!.number)}</span>
                </p>
              ),
            },
            { author: "AutoCraft", tag: t("bot"), when: "09:30", body: <p>{one}</p>, note: t("Only {login} sees it.", { login: WHO }) },
          ]}
        />
        <figure className="flex min-w-0 flex-col gap-2">
          <figcaption className="text-sm font-semibold">{t("On Items: tick rows, type only the words")}</figcaption>
          <div className="flex min-w-0 flex-col gap-2 rounded-md border border-line p-3">
            <div className="flex flex-col gap-2 rounded-lg border border-line-strong bg-raised p-3">
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-medium">{t("Command")}</span>
                <span className="num text-ink/70">{t("{n} items selected", { n: ITEMS.length })}</span>
              </p>
              <p className="code rounded border border-line bg-sunken px-2 py-1.5 text-sm">{SAID}</p>
              <span aria-hidden className="inline-flex h-8 w-fit items-center rounded border border-accent bg-accent px-3 text-sm font-medium text-white">{t("Run")}</span>
              {many.map((l) => <p key={l} className="text-sm text-ink/80">{l}</p>)}
            </div>
            <ul aria-label={t("Ticked items")} className="flex flex-col divide-y divide-line rounded border border-line">
              {ITEMS.map((i) => (
                <li key={i.number} className="flex items-start gap-2 px-2 py-1.5 text-sm">
                  <CheckSquareIcon role="img" aria-label={t("Ticked")} weight="fill" className="mt-0.5 shrink-0 text-accent-ink" />
                  <ItemIcon kind="pr" state="open" tip={false} />
                  <span className="min-w-0 break-words">
                    <span className="code text-ink/70">{ref(i.number)}</span> {i.title}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </figure>
        <figure className="flex min-w-0 flex-col gap-2">
          <figcaption className="text-sm font-semibold">{t("On an item's page: write in its chat")}</figcaption>
          <ol aria-label={t("Sample chat")} className="flex flex-col gap-4 rounded-md border border-line p-3">
            <ChatBubble e={said} />
            <AutoCraftTurn at={confirmed.at} text={confirmed.body}>
              <AutoCraftMessage e={confirmed} open={false} />
            </AutoCraftTurn>
          </ol>
        </figure>
      </div>
    </TutorialStep>
  );
}

function TalkStep() {
  const question: Extract<ChatEntry, { t: "said" }> = { t: "said", id: "q1", at: "2026-11-28T10:02:00.000Z", login: WHO, via: "dashboard", body: t("Why does the preview lose the alpha channel?"), url: null };
  const answer: Extract<ChatEntry, { t: "reply" }> = {
    t: "reply", id: "r1", at: "2026-11-28T10:03:00.000Z", findings: [], ask: null,
    body: t("The preview encoder converts to RGB before writing the PNG (`preview/encode.rs`, line 88). Writing RGBA there keeps the alpha channel; the full export already does that."),
  };
  return (
    <TutorialStep id="talk" n={7} title={t("Ask the model about an item")} refs={[{ to: "/help/roles", label: t("Who can do what") }]}>
      <Bullets>
        <li>{t("Write a question, with a question mark, in the item's chat.")}</li>
        <li>{t("Opus reads the item, the chat and the repository's code; it changes nothing.")}</li>
        <li>{t("It runs on your own Task Runner, which must be ready.")}</li>
        <li>{t("Everyone who can see the repository reads the answer.")}</li>
        <li>{t("It may recommend a command; nothing runs until someone sends it.")}</li>
        <li>{t("You can withdraw the question until Opus answers.")}</li>
        <li>{t("A message that is not a question is read as a command.")}</li>
      </Bullets>
      <figure className="flex min-w-0 flex-col gap-2">
        <figcaption className="text-sm font-semibold">{t("A question and Opus's answer")}</figcaption>
        <ol aria-label={t("Sample chat")} className="flex flex-col gap-4 rounded-md border border-line p-3">
          <ChatBubble e={question} />
          <AutoCraftTurn at={answer.at} text={answer.body}>
            <AutoCraftMessage e={answer} open={false} />
          </AutoCraftTurn>
        </ol>
      </figure>
    </TutorialStep>
  );
}

function FollowStep() {
  const q = (query: string) => (
    <Link to={`/items?q=${encodeURIComponent(query)}`} className="code rounded text-accent-ink underline underline-offset-2">
      {query}
    </Link>
  );
  return (
    <TutorialStep id="follow" n={8} title={t("Follow the work")} refs={[{ to: "/help/after", label: t("After a command") }]}>
      <Bullets>
        <Term term={<A to="/">{t("Home")}</A>}>{t("your items and their last message; questions for you are marked")}</Term>
        <Term term={<A to="/items">{t("Items")}</A>}>
          {q("is:draft")}, {q("is:ready")}, {q("is:asked")}, {q("autocraft:waiting")}, {q("is:mine step:merge")}
        </Term>
        <Term term={<A to="/queue">{t("Work queue")}</A>}>{t("what runs, what waits and why")}</Term>
        <Term term={<A to="/agents">{t("Agents")}</A>}>{t("model calls running, waiting and finished; why a call waits")}</Term>
        <Term term={t("An item's page")}>{t("the chat, with GitHub and Events tabs beside it")}</Term>
      </Bullets>
    </TutorialStep>
  );
}

function AgentStep() {
  return (
    <TutorialStep id="agent" n={9} title={t("Connect your own agent")} refs={[{ to: "/connect", label: t("Connect") }]}>
      <Steps>
        <li>
          {t("Make a token in the MCP Connector block of the")} <A to="/connect">{t("Connect page")}</A>.
        </li>
        <li>{t("Run the command it shows to add AutoCraft to Claude Code, or use its config in another client.")}</li>
      </Steps>
      <Bullets>
        <li>{t("Your agent reads your items and questions.")}</li>
        <li>{t("With a token that may send commands, it sends them as you.")}</li>
      </Bullets>
    </TutorialStep>
  );
}

const SECTIONS: { id: string; title: () => string; steps: [string, () => string][] }[] = [
  { id: "setup", title: () => t("Set up"), steps: [["runner", () => t("Connect a Task Runner")], ["discord", () => t("Link Discord")]] },
  {
    id: "work", title: () => t("Work with issues and pull requests"),
    steps: [["how", () => t("How AutoCraft works")], ["commands", () => t("Commands")], ["answer", () => t("Answering AutoCraft")], ["where", () => t("Where to send them")], ["talk", () => t("Ask the model about an item")], ["follow", () => t("Follow the work")]],
  },
  { id: "agent-section", title: () => t("Your own agent"), steps: [["agent", () => t("Connect your own agent")]] },
];

function Section({ id, children }: { id: string; children: ReactNode }) {
  const s = SECTIONS.find((x) => x.id === id)!;
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-4 flex-col gap-4 pt-4">
      <h2 id={`${id}-title`} className="text-lg font-semibold">{s.title()}</h2>
      {children}
    </section>
  );
}

export function TutorialView({ user }: ViewProps) {
  const { data } = useQuery("mention", (api) => api.mention());
  const mention = data?.mention ?? "app";
  const setup = useSetupProgress(user, { always: true });
  const check = (id: SetupCheck["id"]) => setup.checks?.find((c) => c.id === id);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 text-md leading-relaxed">
        <Link to="/help" className="inline-flex h-11 w-fit items-center gap-1.5 rounded text-sm text-ink/70 hover:text-ink">
          <ArrowLeftIcon aria-hidden /> {t("Help")}
        </Link>
        <h1 className="text-xl font-semibold">{t("Get started")}</h1>
        {setup.checks && <p className="text-sm text-ink/70">{t("Setup: {done} of {all} done", { done: setup.done, all: setup.checks.length })}</p>}
        <nav aria-label={t("Contents")}>
          <ul className="flex flex-col gap-2 text-sm">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="inline-flex min-h-7 items-center rounded font-semibold hover:underline max-md:min-h-11">{s.title()}</a>
                <ul className="flex flex-col pl-4">
                  {s.steps.map(([id, title]) => (
                    <li key={id}>
                      <a href={`#${id}`} className="inline-flex min-h-7 items-center rounded text-accent-ink hover:underline max-md:min-h-11">{title()}</a>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </nav>
        <Section id="setup">
          <RunnerStep done={check("runner")?.done} />
          <DiscordStep check={check("discord")} />
        </Section>
        <Section id="work">
          <HowStep />
          <CommandsStep />
          <AnswerStep />
          <WhereStep mention={mention} />
          <TalkStep />
          <FollowStep />
        </Section>
        <Section id="agent-section">
          <AgentStep />
        </Section>
        <Link to="/help/start" className="mt-2 flex min-h-12 items-center justify-between rounded-lg border border-line px-3 text-md hover:bg-ink/[0.04]">
          <span>
            <span className="text-sm text-ink/70">{t("Next:")} </span>
            {t("Overview")}
          </span>
          <CaretRightIcon aria-hidden className="text-ink/60" />
        </Link>
      </div>
    </div>
  );
}
