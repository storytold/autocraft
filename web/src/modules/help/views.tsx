// Help pages: Getting started, Commands, After a command, Workflows, Examples, Who can do what, Keyboard.
import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { t } from "../../../../src/i18n/index.ts";
import { COMMANDS, CONTROLS, ENTRY_LABEL, WEIGHT_HELP, type CommandDef } from "../../../../src/workflow/vocab.ts";
import { blockerLabel, stepLabel, stepsFor, type StepName } from "../../../../src/workflow/status.ts";
import type { Blocker } from "../../../../src/workflow/types.ts";
import type { ViewProps } from "../../registry/types";
import { modules } from "../../registry";
import { MessageSample } from "../../ui/molecules/MessageSample";
import { StepFlow, type FlowRow } from "../../ui/molecules/StepFlow";
import { useQuery } from "../../api/client";

/** What to type after the `@` in a GitHub comment: the app's mention name or slug; a placeholder until it is known or without an app. */
function useMention(): string {
  const { data } = useQuery("mention", (api) => api.mention());
  return data?.mention ?? "app";
}

const MAIN = COMMANDS.filter((c) => !c.more);
const MORE = COMMANDS.filter((c) => c.more);
const BLOCKERS: Blocker[] = ["failed-twice", "author-commits"];
const ITEM = "photocraft#803";

/** Phrasings the parser reads, with the command each one runs. */
const WORKS: [string, () => string][] = [
  ["looks good, can you merge it please", () => "merge"],
  ["yes except 3", () => t("yes, without finding 3")],
  ["drop the second one", () => "drop 2"],
  ["merge once CI is green", () => t("merge; it only merges on green CI anyway")],
  ["close, it's a dupe of #12", () => "close as duplicate of #12"],
  ["fix the UV seam normals, then merge", () => t("a fix-up that does what the words say, then the merge")],
];
/** Phrasings that run nothing, with why. */
const NOT_RUN: [string, () => string][] = [
  ["maybe merge it?", () => t("A question or maybe never runs.")],
  ["merge after Friday's release", () => t("A condition AutoCraft can't check. At most it suggests a command.")],
  ["don't fix 2", () => t("A negation never runs. Write drop 2.")],
];

const PAGES = [
  { id: "tutorial", title: () => t("Get started") },
  { id: "start", title: () => t("Overview") },
  { id: "commands", title: () => t("Commands") },
  { id: "after", title: () => t("After a command") },
  { id: "workflows", title: () => t("Workflows") },
  { id: "examples", title: () => t("Examples") },
  { id: "roles", title: () => t("Who can do what") },
  { id: "keyboard", title: () => t("Keyboard") },
];

const Code = ({ children }: { children: ReactNode }) => <code className="code rounded bg-ink/[0.07] px-1 py-0.5 text-[0.9em]">{children}</code>;

function Part({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} aria-label={title} className="flex flex-col gap-1.5 border-t border-line pt-4">
      <h2 className="text-md font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const arrow = (names: StepName[]) => names.map((n) => stepLabel({ name: n, state: "next" })).join(" → ");
const first = (word: string) => word.split(" ")[0]!;

function Page({ id, children }: { id: string; children: ReactNode }) {
  const i = PAGES.findIndex((p) => p.id === id);
  const next = PAGES[i + 1];
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 text-md leading-relaxed">
      <Link to="/help" className="inline-flex h-11 w-fit items-center gap-1.5 rounded text-sm text-ink/70 hover:text-ink">
        <ArrowLeftIcon aria-hidden /> {t("Help")}
      </Link>
      <h1 className="text-xl font-semibold">{PAGES[i]!.title()}</h1>
      {children}
      {next && (
        <Link to={`/help/${next.id}`} className="mt-2 flex min-h-12 items-center justify-between rounded-lg border border-line px-3 text-md hover:bg-ink/[0.04]">
          <span>
            <span className="text-sm text-ink/70">{t("Next:")} </span>
            {next.title()}
          </span>
          <CaretRightIcon aria-hidden className="text-ink/60" />
        </Link>
      )}
    </div>
  );
}

function Start() {
  const mention = useMention();
  return (
    <Page id="start">
      <p>{t("AutoCraft reviews, fixes, implements and merges issues and pull requests. It classifies everything new on its own. It does more only when a maintainer sends a command, except small and medium bug fixes, which it handles itself.")}</p>
      <Part title={t("Connect a Task Runner")}>
        <p>
          {t("Model work runs on Task Runners: maintainers' own machines, on their own subscription. Run")} <Code>autocraft login</Code> {t("on yours, then pick what it takes on the")}{" "}
          <Link to="/runner" className="rounded text-accent-ink underline underline-offset-2">
            {t("Runner page")}
          </Link>
          .
        </p>
        <p>{t("Without one, your work waits for another runner that takes it. Home shows how many there are.")}</p>
        <p>{t("When no Task Runner can take work you start or approve, AutoCraft's reply says why and links the setup page. Work that waits for one later says so once, in the item's chat and its Discord thread.")}</p>
      </Part>
      <Part title={t("Link Discord")}>
        <p>
          {t("Link your Discord account on the Runner page, so")} <Code>@AutoCraft</Code> {t("and")} <Code>/autocraft do</Code> {t("act as you.")}
        </p>
        <p>{t("Once linked, the Verify button in the server's contributor role channel gives you the contributor role when you have a merged pull request.")}</p>
      </Part>
      <Part title={t("Where to type commands")}>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          <li>
            {t("GitHub: a comment that starts with the app's name,")} <Code>{`@${mention} ${COMMANDS[1]!.example}`}</Code>
          </li>
          <li>
            {t("Discord: mention the bot in a watched channel:")} <Code>{`@AutoCraft ${COMMANDS[1]!.example} ${ITEM}`}</Code>.{" "}
            {t("Reply to a message that names items with")} <Code>@AutoCraft review</Code> {t("to act on all of them. AutoCraft answers in a thread, where a command that names no item acts on the thread's items.")}{" "}
            <Code>{`/autocraft do text:${COMMANDS[1]!.example}: ${ITEM}`}</Code> {t("does the same with a private answer.")}{" "}
            {t("Reply to a message with")} <Code>@AutoCraft status</Code> {t("for the status of the items it names, or name items after it; anyone may ask.")}
          </li>
          <li>{t("Your agent: the AutoCraft tools take the same words.")}</li>
          <li>{t("This app: the chat on an item's page, or the command bar on Items after ticking items.")}</li>
        </ul>
      </Part>
    </Page>
  );
}

function Surfaces({ c }: { c: CommandDef }) {
  const mention = useMention();
  const dt = "text-ink/70";
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className={dt}>GitHub</dt>
      <dd className="min-w-0 break-words">
        <Code>{`@${mention} ${c.example}`}</Code>
      </dd>
      <dt className={dt}>Discord</dt>
      <dd className="min-w-0 break-words">
        <Code>{`@AutoCraft ${c.example} ${ITEM}`}</Code>
      </dd>
      <dt className={dt}>{t("Agent")}</dt>
      <dd className="min-w-0 break-words">“{`${c.example}: ${ITEM}`}”</dd>
      <dt className={dt}>{t("App")}</dt>
      <dd className="min-w-0 break-words">{t("{word} in the item's chat", { word: c.example })}</dd>
    </dl>
  );
}

function Commands() {
  return (
    <Page id="commands">
      <p>{t("The same words work everywhere. Combine them in one message.")}</p>
      <nav aria-label={t("Commands")} className="flex flex-wrap gap-1.5">
        {MAIN.map((c) => (
          <a key={c.word} href={`#cmd-${first(c.word)}`} className="code inline-flex h-11 items-center rounded border border-line px-2.5 text-sm hover:bg-ink/[0.06]">
            {c.word}
          </a>
        ))}
      </nav>
      {MAIN.map((c) => (
        <Part key={c.word} id={`cmd-${first(c.word)}`} title={c.usage}>
          <p>{t(c.does)}</p>
          {c.entry && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {c.entry === "merge" ? (
                <>
                  <dt className="text-ink/70">{t("Unstarted PR")}</dt>
                  <dd>{arrow(stepsFor("merge", true))}</dd>
                </>
              ) : (
                <>
                  <dt className="text-ink/70">{t("Runs")}</dt>
                  <dd>{arrow(stepsFor(c.entry, false))}</dd>
                  <dt className="text-ink/70">{t("With merge")}</dt>
                  <dd>{arrow(stepsFor(c.entry, true))}</dd>
                </>
              )}
            </dl>
          )}
          <p className="text-sm">
            <span className="text-ink/70">{t("Comes back:")} </span>
            {t(c.back)}
          </p>
          <Surfaces c={c} />
        </Part>
      ))}
      <Part title={t("Weight")}>
        <p>{t("Add a weight anywhere in a command to order the queues. Heavier goes first.")}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {WEIGHT_HELP.map((w) => (
            <Fragment key={w.word}>
              <dt className="code">{t(w.word)}</dt>
              <dd>{t(w.weight)}</dd>
            </Fragment>
          ))}
        </dl>
        <p>
          <Code>fix-up and merge, urgent</Code>. {t("On a started item the word alone changes it:")} <Code>@&lt;app&gt; urgent</Code>.
        </p>
      </Part>
      <Part title={t("Combining")}>
        <p>
          <Code>fix-up and merge</Code>, <Code>implement and merge</Code>, <Code>fix 1, drop 2, then merge</Code>, <Code>fix the export normals, then merge</Code>.
        </p>
      </Part>
      <Part title={t("Writing normally")}>
        <p>{t("Ordinary phrasing works too. These run:")}</p>
        <ul className="flex flex-col gap-2">
          {WORKS.map(([said, does]) => (
            <li key={said}>
              <MessageSample tone="ok" note={`→ ${does()}`}>
                <Code>{said}</Code>
              </MessageSample>
            </li>
          ))}
        </ul>
        <p>
          <Code>land it</Code>, <Code>park it</Code>, <Code>carry on</Code>, <Code>ask the author</Code> {t("mean merge, backlog, resume and ask author.")}
        </p>
        <p>{t("These don't run:")}</p>
        <ul className="flex flex-col gap-2">
          {NOT_RUN.map(([said, why]) => (
            <li key={said}>
              <MessageSample tone="bad" note={why()}>
                <Code>{said}</Code>
              </MessageSample>
            </li>
          ))}
        </ul>
        <p>{t("A message with not, maybe or a question mark never runs as written. The phrases don't merge yet, not yet and not now still hold. When nothing runs, AutoCraft says what it understood.")}</p>
      </Part>
      <Part title={t("Several items")}>
        <p>
          {t("On Discord and in an agent, write them inline:")} <Code>merge photocraft#803 photocraft#19</Code>, {t("or as a list after a colon:")} <Code>merge, urgent: photocraft#803 #19</Code>. {t("A bare number takes the repo before it. Each item gets its own answer line. A GitHub comment acts only on the item it is written on.")}
        </p>
        <p>
          {t("In this app, tick the items on Items, or paste text with refs or links into its search box to list exactly those items and tick them with Select all shown, then write only the command's words in the command bar:")} <Code>review and merge</Code>.
        </p>
      </Part>
      <Part title={t("More commands")}>
        {MORE.map((c) => (
          <p key={c.word}>
            <Code>{c.usage}</Code>: {t(c.does)} <Code>{c.example}</Code>
          </p>
        ))}
      </Part>
      <Part title={t("Controls")}>
        <p>{t("Buttons for what a command word does not cover. The agent has them as commands too.")}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {CONTROLS.map((c) => (
            <Fragment key={c.control}>
              <dt className="font-semibold">{t(c.name)}</dt>
              <dd>{t(c.short)}</dd>
            </Fragment>
          ))}
        </dl>
      </Part>
    </Page>
  );
}

function After() {
  return (
    <Page id="after">
      <Part title={t("The confirmation")}>
        <p>{t("Every accepted command gets one line back, the same on every surface. It says what runs next, who sent it, and ends with how to halt it.")}</p>
        <p className="rounded border border-line bg-sunken px-3 py-2 text-sm">{t("Fixing 1 and 2, then merging when CI is green (approved by mira, 09:31 UTC). Reply hold to halt.")}</p>
      </Part>
      <Part title={t("On GitHub")}>
        <p>{t("One status comment per started item, edited in place: the steps, the state, the open recommendation, who it asks and who approved.")}</p>
      </Part>
      <Part title={t("Following progress")}>
        <p>{t("Each item page is a chat with AutoCraft: what people said on every surface, AutoCraft's replies and the work it did. GitHub and Discord activity shows as short lines between them. The status and next step are at the top, and the GitHub and Events tabs open beside the chat.")}</p>
        <p>{t("Home lists your items: the ones you started, approved, held, answered or wrote about, with the last message. An item with a question for you is marked, and the Home entry in the sidebar counts those questions.")}</p>
        <p>{t("The Work queue shows what runs, what waits and why.")}</p>
      </Part>
      <Part title={t("When AutoCraft asks you")}>
        <p>{t("AutoCraft asks one question with one recommendation, in the item's chat, with the findings numbered. It asks whoever started the item and whoever approved its merge; anyone with write access may answer.")}</p>
        <MessageSample tone="asks">{t("Recommendation: Fix 1 and 2, then merge. Reply to go ahead: fix 1 and 2, then merge (after the pre-merge check and green CI).")}</MessageSample>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          <li>
            <Code>yes</Code>, <Code>lgtm</Code>, <Code>proceed</Code>, <Code>go ahead</Code>: {t("runs the recommendation. If it ends in a merge, the answer also approves the merge.")}
          </li>
          <li>
            <Code>merge</Code>: {t("runs the recommendation, whatever it fixes first, then merges.")}
          </li>
          <li>
            {t("Or say what you want instead:")} <Code>fix 1, drop 2, then merge</Code>, <Code>fix the export normals, then merge</Code>, <Code>review</Code>, <Code>close</Code>, <Code>hold</Code>.
          </li>
          <li>{t("Anything unclear runs nothing as written. AutoCraft reads it as the part below says.")}</li>
        </ul>
        <p>{t("It comes back to you when:")}</p>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          <li>{t("the steps are done and the merge is not approved;")}</li>
          <li>{t("an implementation's plan has a question, approved or not;")}</li>
          <li>{t("only a person can go on: the base branch, missing CI, red CI AutoCraft can't repair, or an approver who lost write access;")}</li>
          <li>{t("an approved item reaches a blocker (below).")}</li>
        </ul>
      </Part>
      <Part title={t("Merge approval")}>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          <li>
            <Code>merge</Code> {t("approves, alone or with a start command, as the merge button on GitHub would. So does a yes to a recommendation that ends in a merge.")}
          </li>
          <li>{t("An approved item merges when its steps are done, the pre-merge check is clean and CI is green, in the approver's name.")}</li>
          <li>{t("AutoCraft makes every fix the merge needs: what the review finds, a hold or close of the review, the pre-merge check's defects, a failed verification, red CI and conflicts. Findings that don't block the merge go to a follow-up issue.")}</li>
          <li>{t("The approval stays through AutoCraft's own fixes and through a hold. It ends with backlog or close, and when the approver loses write access.")}</li>
          <li>{t("An approved item comes back only where AutoCraft cannot get to the merge:")}</li>
        </ul>
        <ol className="list-decimal pl-6 text-sm">
          {BLOCKERS.map((b) => (
            <li key={b}>{blockerLabel(b)}</li>
          ))}
        </ol>
        <p className="text-sm">{t("At a blocker the approval stays. A yes resumes the plan.")}</p>
        <p className="text-sm">{t("New commits from the author after the approval are reviewed first, and the approval stays. Fixes, answers to review or CI, a merge of the base branch and small adjustments go on to the merge; the item comes back only when the review finds the commits beyond what was approved. A merge of the base branch that leaves the pull request's own changes as they were keeps the earlier review.")}</p>
        <p className="text-sm">{t("After the merge, a model reviews the change if AutoCraft changed code after the approval, wrote the pull request after it, or merged it automatically.")}</p>
      </Part>
      <Part title={t("Messages AutoCraft can't read")}>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          <li>{t("AutoCraft reads a message it can't read as a command with a model, on your own Task Runner or another free one.")}</li>
          <li>{t("A clear reading runs. The confirmation line ends with the command it read from your words.")}</li>
          <li>{t("Otherwise AutoCraft replies with the command it thinks you meant. Send that command to run it.")}</li>
          <li>{t("A message that says not to, hedges, asks a question or sets a condition never runs this way, except a hold.")}</li>
          <li>{t("With no Task Runner free, AutoCraft says what it understood and waits.")}</li>
        </ul>
      </Part>
      <Part title={t("Holding and resuming")}>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          <li>
            <Code>hold</Code> {t("ends all work on the item at once, its place in a batch included. AutoCraft keeps off it and shows who holds it. It works on any open item, started or not.")}
          </li>
          <li>
            {t("On their own,")} <Code>stop</Code>, <Code>pause</Code>, <Code>wait</Code>, <Code>hold on</Code>, <Code>not yet</Code> {t("mean the same. In a longer message that asks for something else they run nothing.")}
          </li>
          <li>
            <Code>resume</Code>, <Code>continue</Code>, <Code>yes</Code> {t("on a held item go on with its plan, merge approval included, in the name of whoever wrote it. If the author pushed commits meanwhile, AutoCraft reviews them first.")}
          </li>
          <li>{t("Any other command starts the item again as usual.")}</li>
        </ul>
      </Part>
    </Page>
  );
}

/** One flow per starting point; the person's command first, the points where AutoCraft asks marked. */
function flows(): { title: string; note?: string; rows: FlowRow[] }[] {
  const ends = (approved: string): FlowRow => [
    { when: t("Merge approved"), text: approved, kind: "done" },
    { when: t("Not approved"), text: t("one recommendation"), kind: "asks" },
  ];
  return [
    {
      title: t(ENTRY_LABEL.review),
      note: t("A review that finds the pull request incomplete or wrong asks its author at once, with the findings, and waits for their push; one that asks whether the change is wanted at all comes to you first."),
      rows: [{ text: "review", kind: "you" }, { text: t("Model review of the pull request") }, ends(t("Fix the findings, review again, merge"))],
    },
    {
      title: t("Review (issues)"),
      note: t("The review reads the issue and the code, posts one comment, and recommends one next step."),
      rows: [
        { text: "review", kind: "you" }, { text: t("Model review of the issue against the code") },
        [
          { when: t("Recommends implement"), text: t("Implement: at once after review and implement, after your yes after review") },
          { when: t("Otherwise"), text: t("one recommendation: close, ask the reporter, or backlog"), kind: "asks" },
        ],
      ],
    },
    { title: t(ENTRY_LABEL.fixup), rows: [{ text: "fix-up", kind: "you" }, { text: t("Review") }, { text: t("Fix what the review found") }, { text: t("Review again") }, ends(t("Merge"))] },
    {
      title: t(ENTRY_LABEL.implement),
      rows: [{ text: "implement", kind: "you" }, { text: t("a plan question, if the plan has one, even when the merge is approved"), kind: "asks" }, { text: t("Write the change and its tests in a new pull request") }, { text: t("Review, fix, review again") }, ends(t("Merge"))],
    },
    {
      title: t(ENTRY_LABEL.merge),
      note: t("On a pull request nobody started. No model review; the approval is the command itself."),
      rows: [{ text: "merge", kind: "you" }, { text: t("Update from main") }, { text: t("Fix CI and conflicts") }, { text: t("Pre-merge check and green CI") }, { text: t("Merge in a batch, in your name"), kind: "done" }],
    },
    {
      title: t("Automatic, for everything new"),
      note: t("Only small and medium bug fixes and infra changes from contributors with a good merge history, in repos where automatic work is on. Everything else waits for a maintainer's command."),
      rows: [
        { text: t("Classify: kind, size, duplicates, priority") },
        { text: t("Review, and fix if needed") },
        { text: t("Pre-merge check and green CI") },
        [{ when: t("All clear"), text: t("Merge"), kind: "done" }, { when: t("Needs a person"), text: t("stops and asks nobody; a maintainer's command takes the item over"), kind: "asks" }],
      ],
    },
  ];
}

function Workflows() {
  return (
    <Page id="workflows">
      <p>{t("A command picks where the item enters. Every merge waits for the pre-merge check and green CI, and goes only into the default branch.")}</p>
      {flows().map((f) => (
        <Part key={f.title} title={f.title}>
          {f.note && <p className="text-sm">{f.note}</p>}
          <StepFlow label={t("Steps of {flow}", { flow: f.title })} rows={f.rows} />
        </Part>
      ))}
      <Part title={t("At any step")}>
        <p>{t("A blocker stops the item and asks, even when it is approved.")}</p>
      </Part>
    </Page>
  );
}

/** A worked example: numbered steps, each a sentence with an optional message under it. */
function Story({ title, steps }: { title: string; steps: { text: ReactNode; said?: string; tone?: "ok" | "asks" | "neutral" }[] }) {
  return (
    <Part title={title}>
      <ol className="flex list-decimal flex-col gap-3 pl-6">
        {steps.map((s, i) => (
          <li key={i} className="flex flex-col gap-1.5 pl-1">
            <span>{s.text}</span>
            {s.said && <MessageSample tone={s.tone ?? "ok"}>{s.said}</MessageSample>}
          </li>
        ))}
      </ol>
    </Part>
  );
}

function Examples() {
  const mention = useMention();
  const by = (who: string, typed: string) => (
    <>
      <span className="font-semibold">{who}:</span> <Code>{typed}</Code>
    </>
  );
  return (
    <Page id="examples">
      <Story
        title={t("A contributor's bug fix")}
        steps={[
          { text: t("A contributor with a good merge history opens a 40-line bug fix. Nobody types anything.") },
          { text: t("AutoCraft reviews it, finds two small problems and fixes them.") },
          { text: t("The pre-merge check is clean and CI is green. AutoCraft merges it, then reviews the merged change.") },
          { text: t("Another time the review is unsure. AutoCraft stops and asks nobody. The item's status says why and what it would do:"), said: t("Stopped: the review is unsure. AutoCraft would: review it again, then come back with the result."), tone: "neutral" },
          { text: <>{by("mira", `@${mention} fix-up and merge`)} {t("Mira now owns the item. Had the author pushed before anyone wrote, the automatic rule would have taken the pull request back.")}</> },
        ]}
      />
      <Story
        title={t("A review with findings")}
        steps={[
          { text: by("mira", `@${mention} review`), said: t("Reviewing, then coming back with a recommendation (started by mira, 09:31 UTC). Reply hold to halt.") },
          { text: t("The review finds three problems. Nothing is fixed yet: the merge is not approved.") },
          { text: t("AutoCraft asks:"), said: t("Recommendation: Fix 1 and 2, then merge."), tone: "asks" },
          { text: by("mira", "drop 2, merge"), said: t("Dropping 2, fixing 1, then merging when CI is green (approved by mira, 10:02 UTC). Reply hold to halt.") },
          { text: t("AutoCraft fixes 1, reviews again, waits for the pre-merge check and green CI, and merges in Mira's name. It changed code after the approval, so it reviews the merged change.") },
        ]}
      />
      <Story
        title={t("A normal reply read by the model")}
        steps={[
          { text: t("AutoCraft has asked: Fix 1 and 2, then merge.") },
          { text: by("mira", `@${mention} sure thing, just get the export bug sorted and land it`) },
          { text: t("That is not a command AutoCraft can read. A model on Mira's Task Runner reads it as fix 1, merge.") },
          { text: t("A second model check is sure, and the message has no but, if or question. So it runs:"), said: t("Fixing 1, then merging when CI is green (approved by mira, 10:02 UTC). Reply hold to halt. Read from your words as `fix 1, merge`.") },
          { text: t("Had she written land it once you've sorted the export bug, it would not run. AutoCraft would reply with the command to send instead.") },
        ]}
      />
    </Page>
  );
}

function Roles() {
  const rows: [string, string[]][] = [
    [t("Viewer"), [t("Reads items, Work queue, Stats, Prompts, Environments, Repos and Scans, without security findings."), t("Sends no commands.")]],
    [t("Maintainer (write access on the repo)"), [t("Starts, answers, approves the merge, holds, resumes and closes any item in that repo."), t("Turns the repo's automatic handling on or off, resumes paused steps and releases outside authors' items."), t("Starts security scans with a spend cap and sees their findings."), t("Connects a Task Runner.")]],
    [t("Operator"), [t("Everything a maintainer can, on every repo where they have write access."), t("Admin: users and access, accounts, inference, GitHub App, Discord, limits, health, sweeps, audit log.")]],
    [t("Outside contributor"), [t("Sees the status of their own issues and pull requests.")]],
  ];
  return (
    <Page id="roles">
      <p>{t("Every action is logged with who did it: “approved by mira”, “held by jonas”.")}</p>
      {rows.map(([who, can]) => (
        <Part key={who} title={who}>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            {can.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </Part>
      ))}
    </Page>
  );
}

function Keyboard() {
  const all = [
    { id: "search", keys: "/", label: t("Search"), group: t("Anywhere") },
    { id: "help", keys: "?", label: t("Keyboard shortcuts"), group: t("Anywhere") },
    { id: "rail", keys: "[", label: t("Toggle sidebar"), group: t("Anywhere") },
    ...modules.flatMap((m) => m.commands ?? []),
  ];
  const groups = [...new Set(all.map((c) => c.group))];
  return (
    <Page id="keyboard">
      <p>{t("Press ? anywhere for this list.")}</p>
      {groups.map((g) => (
        <Part key={g} title={g}>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
            {all
              .filter((c) => c.group === g)
              .map((c) => (
                <Fragment key={c.id}>
                  <dt>{c.label}</dt>
                  <dd>
                    <Code>{c.keys}</Code>
                  </dd>
                </Fragment>
              ))}
          </dl>
        </Part>
      ))}
    </Page>
  );
}

export function HelpView({ params }: ViewProps) {
  return (
    <div className="h-full overflow-y-auto">
      <HelpPage page={params.page} />
    </div>
  );
}

function HelpPage({ page }: { page?: string }) {
  if (page === "start") return <Start />;
  if (page === "commands") return <Commands />;
  if (page === "after") return <After />;
  if (page === "workflows") return <Workflows />;
  if (page === "examples") return <Examples />;
  if (page === "roles") return <Roles />;
  if (page === "keyboard") return <Keyboard />;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 text-md leading-relaxed">
      <h1 className="text-xl font-semibold">{t("How to use AutoCraft")}</h1>
      <p>{t("Tell AutoCraft what to do with an issue or pull request: on GitHub, in Discord, from your agent or here. The words are the same everywhere.")}</p>
      <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
        {PAGES.map((p) => (
          <li key={p.id}>
            <Link to={`/help/${p.id}`} className="flex min-h-12 items-center justify-between rounded px-3 hover:bg-ink/[0.04]">
              {p.title()}
              <CaretRightIcon aria-hidden className="text-ink/60" />
            </Link>
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border border-line bg-raised px-3 py-3 text-sm">
        {MAIN.map((c) => (
          <Fragment key={c.word}>
            <dt className="code font-semibold">{c.word}</dt>
            <dd>{t(c.short)}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}
