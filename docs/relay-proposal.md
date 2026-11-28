# Proposal: Relay

**Status: proposal for discussion. Nothing in this file is implemented.** Sentences about what AutoCraft does today say "today" or stand under [Today](#today). Everything else describes the proposal, in the present tense, as the docs would read if it landed. If it is wanted, the parts land in small pull requests, their description moves into [pipeline.md](pipeline.md) and [operations.md](operations.md), and this file is deleted.

Many people pay for a coding agent by subscription, with an allowance that resets whether they used it or not. Relay gives the unused part somewhere useful to go: a project they care about.

It works in a loop of three parts:

1. **AutoCraft makes the tasks.** A bugfix issue that Fix triage judged fixable becomes a relay task, with the files to edit, the test to add and the checks to pass.
2. **A contributor's agent does them.** The contributor sets their own agent up once, on their own machine and their own model usage. From then on it takes a relay task, works on it and sends back a patch without the contributor doing anything.
3. **AutoCraft judges the patch.** Build tasks first, then the Opus check. A patch that is not good enough sends the relay task back with the reasons, for the same or the next contributor's agent to rework. A patch that passes becomes a pull request through Fix's own PR step and is reviewed, verified and merged like any other.

## Today

Fix opens a PR for open bugfix issues in public Rust repos where the fix is clear. It runs on the operator's Claude accounts, by default 10 attempts a day. Sonnet triages the issue, a model writes the patch, the sandbox builds and tests it, and Opus checks it before anything is pushed. Three failed rounds end the attempt and the issue is held. An issue whose attempt failed is not a candidate again until an operator asks for "Try the fix again", which deletes the attempt. The pipeline releases its assignment of the issue when the attempt fails. What the attempt got right is handed to nobody: the next try, by a model or by a person, starts from the issue.

The Inbox MCP server lets a maintainer's or operator's own agent list open decisions and held fix-ups and work one through locally. What comes back is feedback. Viewers cannot make an agent token.

Three things are missing for someone outside the team who has agent capacity to spare:

- **Knowing what is wanted.** Which issue is in scope, clear enough to fix and not taken? The pipeline knows (scope decision, duplicate hold, open PRs that mention the issue, Fix triage). A newcomer does not.
- **Continuing someone else's work.** A person who gets halfway has two choices: open an unfinished PR, which costs a maintainer's attention, or keep the work to themselves.
- **A verdict before the PR.** A contributor's local test run proves nothing to the project. The build environments and the Opus check can judge a patch, but only one the pipeline wrote.

The pipeline is built around maintainers' judgement. Relay has to respect that: it may add hands, it must not add questions. A relay task that completes arrives as one PR that has passed what a Fix PR passes. One that does not complete costs the team nothing except build time and the model calls that judge it, and both have limits.

## Terms

The words are chosen to stay clear of build tasks, the runner's work leases and Fix attempts.

| Term | Meaning |
|---|---|
| Relay task | A bugfix issue that Fix triage judged fixable, frozen at a default-branch commit, with the files and crate the triage named |
| Claim | One contributor's time-limited hold on a relay task, like a decision's claim but longer. A relay task has at most one |
| Submission | One patch a contributor's agent sent for a relay task under a claim. Never changed after it is stored |
| Verdict | What AutoCraft says about a submission: its level from the build tasks and, for a complete one, the Opus check's approve or reject with reasons |
| Checkpoint | What has been verified so far and is handed to the next claim |

## The flow

1. **Offer.** The Relay setting of a repo is off, `first` or `after-fix`. With `first`, an issue becomes a relay task when Fix triage judges it fixable, and Fix writes no patch of its own for now. With `after-fix`, it becomes one when its Fix attempt is `failed` after the last round; other failures (a closed issue, a lost base commit, a build-environment error) offer nothing. The candidate rules are Fix's own (with `after-fix`, except "no earlier attempt"): no pending scope decision, no open PR that mentions the issue, not held as a duplicate. An item with the security flag never becomes a relay task. The base commit is the default-branch head at the offer.
2. **Claim.** A contributor's agent asks for the next relay task and gets it claimed in the same call. The claim has an end time (`relay_claim_minutes`, default 120) and a number that goes up with every claim of the relay task. An account holds one claim at a time. Nothing is written to GitHub (see open question 4).
3. **Work.** The agent gets the pack: repo, base commit, the checkpoint if there is one, the files it may edit, the path of the regression test, the limits, the steps the build runs, and the verdict on the checkpoint when the check rejected it. It works in the contributor's own clone with the contributor's own model. AutoCraft holds no model credential of a contributor and does not ask which model was used.
4. **Submit.** The agent sends one unified diff against the base commit: the whole patch, not a change to the checkpoint. Submitting ends the claim. A submit under a claim that has expired or been replaced is refused by the claim number, so a slow agent cannot overwrite newer work.
5. **Validate.** Our code validates the diff with the validator Fix patches go through today: the regression test as a plain new file at its fixed path, edits only to the listed files, the same limit on changed lines, no binary, symlink or mode change, no trust path. One rule changes: today a diff that changes no source file is refused, and Relay accepts one that adds only the test. The diff also gets the fixed-shape credential check that a model's code reply gets today.
6. **Sandbox.** The submission runs as the two build tasks Fix runs today: the base commit plus the whole patch, and the base commit plus the test file alone. Pass or fail comes from exit codes and lint findings from the clippy output, as in Fix. Nothing a contributor reports counts.
7. **Checkpoint.** The results give the submission a level (below). A submission replaces the checkpoint when its level is higher, or when both are at level 2: a level-2 checkpoint is a patch the check rejected, and the new one is the rework of it. Any other submission is stored, shown on the item page and never part of a later pack.
8. **Check.** A level-2 submission gets the check a passed Fix patch gets today: Opus reads the issue, the triage reasoning and the whole patch with its test, and approves or rejects with reasons.
9. **Rework.** A submission that did not reach level 2, or that the check rejected, opens the relay task again. Its submitter reads the verdict: the failing step and the failure summary, or the check's reasons and problems. For `relay_rework_minutes` (default 30) only the submitter's account can claim the relay task, so an agent with allowance left reworks its own patch. After that anyone can. A pack never holds a verdict on a patch it does not contain. A rejected level-2 patch is the checkpoint and comes with its reasons, so the next agent changes it and does not start over. What a submission that did not become the checkpoint got wrong is told to its submitter only. After `relay_checks_per_task` (default 3) rejects the relay task is held with the last reasons, as a Fix attempt is after its rounds today, and an operator can offer it again.
10. **PR.** An approved submission goes to Fix's PR step. This needs the repo's fix approval and counts against Fix's daily limit. The PR then goes through Review, Verify and the merge queue like any other, and fixes a review asks for are handled as for any PR today. Relay adds no merge path.
11. **Expiry.** A claim that ends without a submit frees the relay task. The checkpoint stays. Nothing is lost and nobody has to clean up.
12. **Fallback.** With `first`, a relay task that has no approved submission after `relay_first_days` (default 7) gets no new claim. An open claim and a submission that is being judged finish first. If that ends without an approval, one transaction withdraws the relay task and hands the issue to Fix's own rounds as today.
13. **Withdrawn is final.** A withdrawn relay task takes no claim and no submit, and Fix's PR step takes a patch only from a relay task that is not withdrawn. A submission that was still being judged is stored with its verdict and goes no further. This holds for the fallback, for "Try the fix again" and for an issue that was closed.

### Levels

| Level | Shown as | What the build tasks say | The checkpoint carries |
|---|---|---|---|
| 1 | reproduced | With the test file alone, the base commit builds and the regression test fails | The test file alone |
| 2 | complete | Level 1, and with the whole patch every step passes and clippy has no finding on the changed lines | The whole patch |

Level 2 says that the patch works, not that it is good. The check decides that (step 8).

A level-1 checkpoint is a real handover: one person's agent wrote the test that shows the bug, the next one writes the fix against it. Source changes of a submission that only reached level 1 are not carried, because nothing verified them.

There is no level for "the regression test passes and other tests fail". Today the worker stops a build task at its first failed step and the crate's tests run before the regression step, so the results cannot show it. It would need the plan's order changed.

## Running unattended

A contributor decides once and then does nothing per relay task.

- **Set up once.** The contributor makes a relay token, adds the server to their agent and chooses on their side which repos, up to which size and how many relay tasks a day.
- **One call for the next job.** `next_relay_task` returns the most wanted open relay task that fits the caller's filters, by work rank, and claims it in the same transaction. Rework of the caller's own submission comes first. No person has to pick.
- **The pack is the whole brief.** It holds everything the agent needs without asking anyone. The working instructions are fixed text from AutoCraft, the same for every relay task. Issue text, the checkpoint and the verdict come as data.
- **A scheduled run.** A timer on the contributor's machine starts their agent in its non-interactive mode with a fixed prompt: take the next relay task, work on it, submit, wait for the verdict, rework if asked, stop. The docs ship that prompt and one example per common agent.
- **AutoCraft starts nothing.** It never calls out to a contributor's machine. The agent asks, and an agent that does not ask costs nothing.
- **When the allowance runs out.** The agent stops and the claim expires. If it got as far as a test that shows the bug, it submits that first.

**On the contributor's machine.** An unattended agent reads issue text and builds the project's code. Both are untrusted, and AutoCraft cannot enforce anything there. Two secrets are in that environment whatever the setup: the agent's own model login and the relay token. Issue text or project code can get an agent to send them somewhere, and the narrow scope of the relay token does not prevent that. It limits what a stolen token is good for: claiming and submitting under the contributor's account until it is ended. The setup page says this and recommends three things. A container or a separate OS user limits what else the agent can read, and only as far as it is set up to: no host directory or credential store mounted, no host file readable by that user. It does not protect those two secrets. Network access limited to the model provider, the AutoCraft server, the source host and the dependency registry, with the build itself offline as on AutoCraft's own workers today, leaves fewer places a secret can be sent, not none: a request to an allowed host can still carry it. And after a suspected leak the contributor revokes the relay token, which its owner can do today for an Inbox token, and renews the model login with the provider; an operator can end the account's tokens and claims with `deny`. None of this removes the risk. What remains is the contributor's, and the page says so.

## Spare allowance

- **Nothing is transferred.** The allowance stays in the contributor's account. Their agent runs on their machine under their own login, and AutoCraft sees only the patch. Whether a subscription may be used this way is between the contributor and their provider.
- **Any agent.** The tools are plain MCP over HTTP, and Relay does not ask which agent or model did the work. A subscription with another provider takes part the same way.
- **Picking by size.** A relay task carries the triage's size estimate (S, M, L or XL) and the checkpoint's level, so an agent takes what fits what its owner has left. A relay task at level 1 is the smaller job: the test exists.
- **What is not handed on.** Unfinished source changes are not carried (see Levels). An allowance that runs out in the middle of a fix leaves the test at most (open question 9).
- **How much there is to do.** With `first`, every fixable issue of the repo is on offer. With `after-fix`, only those where Fix failed (open question 2).

## Who can take part

Relay lands in two phases, because the second one opens a new door.

- **Phase 1: the access list.** Operators, maintainers and, new, viewers can make a relay token, which can call only the relay tools. Today viewers get 403 on any agent token. Nobody new reaches the dashboard. This is enough to try the mechanic.
- **Phase 2: anyone with a GitHub account**, where an operator switched that on for the repo. Such a person signs in with GitHub and gets a `contributor` scope: relay tasks of public repos, their own submissions and their own tokens, and nothing else of the dashboard. A relay task is made of public data (a public issue, public code at a public commit) plus other contributors' verified checkpoint.

Phase 2 gets protections modelled on today's outside-author protections, with their own settings on the Pipeline page:

| Protection | Setting and default |
|---|---|
| Submissions per account per day | `relay_submissions_per_day`, 5 (as `outside_prs_per_day`) |
| Claims per account at a time | 1, fixed |
| Checked submissions per day | daily limit of the `relay-check` step, 30 (as Verify) |
| Opus checks per relay task | `relay_checks_per_task`, 3 |
| Surge breaker | more than `relay_surge_per_hour` (30) new contributor accounts in an hour trips `relay-surge`; an operator resumes it |
| Contributors page | `deny` ends every claim and token under the login; a whitelisted tier or an `allow` gets `relay_submissions_per_day_trusted` |

As on the Contributors page today, a tier and an allow belong to the GitHub account, not the login string, and a deny holds for every account under the login.

## Agent tools

Relay extends the Inbox MCP server (`src/dash/mcp/`) with the same transport, token storage and rate limits. Listing starts nothing.

| Tool | Does |
|---|---|
| `next_relay_task` | `{ repos?, max_size? }`; claims the most wanted open relay task that fits and returns its pack, or says that there is none |
| `list_relay_tasks` | Open relay tasks the caller may take: repo, issue number and title, level of the checkpoint, size estimate |
| `get_relay_task` | The pack (see step 3) |
| `claim_relay_task` | Starts a claim on a named relay task, or says that it is claimed and until when |
| `submit_relay_patch` | `{ claim, patch, note? }`; ends the claim and queues the build tasks |
| `release_relay_task` | Ends the caller's own claim early |
| `get_relay_submission` | The verdict on one of the caller's submissions, or that it is still being judged |

Tool descriptions and server instructions are fixed text. Issue text, patches and verdicts are returned as data in fields the description names as untrusted, never as instructions. A patch has to fit the server's request cap (64 KiB today) and the Opus check's patch cap.

## Trust boundary

- **A contributor's patch is untrusted code.** It is treated as a PR's code is today: it runs only as a build task on a build environment, never where a GitHub token or a Claude login is. The build tasks carry the issue number, so a confidential environment does not take them.
- **A contributor's note reaches no model.** The optional note of a submission (at most 500 characters) is shown on the item page. It is not put in a prompt and not given to the next contributor's agent. The patch and the build log do reach a model, as untrusted data: the patch in the Opus check and the log in the failure summary, as with a Fix round today.
- **A verdict is data.** The check's reasons and problems come from a model that read a stranger's patch. They keep today's caps (60 words of reasons, 10 problems of 200 characters) and go to the next agent in fields named as untrusted.
- **No new kind of write to GitHub.** Offering, claiming, submitting, judging and checkpointing write nothing to GitHub. The only writes are those of Fix's PR step: the push (and the fork, where the pipeline's account has none), the PR and its one issue comment. `src/github/write.ts` stays the only module that writes, with its audit rows and the repo's fix approval.
- **Model spend stays the operator's to limit.** A contributor's patch costs the operator a Haiku failure summary when it fails its build tasks, and one Opus check when it passes every step. The submissions per account, the checks per relay task and the step's daily limit bound both.
- **Nobody's quota is read or pooled.** AutoCraft holds no credential of a contributor, on the server or in a sandbox.
- **A relay token has no GitHub token of its own**, as with Inbox tokens today. Its role is read on every call. Removing a login or setting it to `deny` ends its tokens and claims.
- **Stale work cannot win.** The claim number refuses a late submit. A checkpoint counts only for the base commit it was checked on: when the default branch moved, an approved submission is built again on the new head before the PR. If it no longer applies or no longer passes there, the relay task moves to the new head before it opens again: the base commit changes, the checkpoint is run again on it and kept at the level it reaches there, or dropped, and the next pack names the new base. If a listed file is gone, the relay task is withdrawn and the issue goes back to Fix triage.
- **Checks before the PR.** As in Fix today, the issue is read from GitHub right before the PR, and a closed issue ends the relay task. An open PR that mentions the issue is read from the mirror, as Fix reads it, and ends the relay task too.
- **Private repos are never offered**, and neither are items with the security flag.

Audit actions: `relay-offer`, `relay-claim`, `relay-submit`, `relay-release`, `relay-checkpoint`, `relay-verdict`, `relay-withdraw`.

## What changes in Fix

Relay reuses Fix's parts, and six of them do not fit as they are today.

- **Triage without rounds.** Today triage, patch rounds and the PR are one flow of the Fix step, and the pipeline's account is assigned to the issue as soon as triage says fixable. With `first`, the step stops after triage and offers the issue.
- **One row per issue.** `fix_attempts` holds one row per issue, and Fix's PR step opens the PR for a row in `passed`. Relay keeps its own tables and puts an approved patch and its test into that row as `passed`, so one code path opens every fix PR.
- **A reject is a verdict.** Today an Opus reject is a failed round of the pipeline's own attempt and its reasons go into the next round's prompt. For a relay patch the reasons go into the verdict.
- **"Try the fix again".** Today it deletes the row. With a relay task on the issue it also withdraws the relay task (step 13): Fix has the issue back. The checkpoint is kept for the record and not used.
- **The triage reason.** The Opus check reads why the issue was judged fixable. Today a failed attempt overwrites that text with the failure. With `after-fix` it has to be kept.
- **The check prompt.** Today `fixissue.check` introduces the diff as the fix we wrote. A relay patch needs a variant that frames it as a contributor's untrusted code.

## Credit

The PR's commit carries one `Co-authored-by:` line for each contributor whose submission was a checkpoint of the relay task, when that contributor chose to be named. A submission that never was a checkpoint earns no line. The Contributors page gets three private columns (submissions, checkpoints, completed relay tasks). There is no public ranking.

The note line of the PR needs a new wording, because no model the pipeline called wrote the patch. For example: `_Pull request from AutoCraft Relay. Patch by contributors' own agents, checked by <Model>. Not a maintainer decision._`

## Data

A sketch, to show the size of it. New tables are created in `src/schema.sql`; later changes go through the migrations in `src/db.ts`.

| Table | Holds |
|---|---|
| `relay_tasks` | repo, number, base commit, editable files, crate, size, triage reason, state, current claim number, checkpoint submission and its level, number of rejects |
| `relay_claims` | relay task, claim number, account id and login, start, end, how it ended (submitted, released, expired, revoked) |
| `relay_submissions` | relay task, claim number, account id, patch and patch hash, test patch, the two build task ids, level, state, summary, the check's verdict, note |

Claim, submit and checkpoint are each one `BEGIN IMMEDIATE` transaction that checks the claim number. A submission row gets its level, state and verdict once, when its build tasks and its check end, and is not updated after that.

## Dashboard

- **Item page.** A Relay panel on the issue's item page: state, whether it is claimed and until when, the submissions with their verdicts, the checkpoint.
- **Home flowchart.** Relay as a branch of the Fix column: offered, claimed, being judged, rework, approved.
- **Repos page.** The Relay setting per repo (off by default, `first` or `after-fix`), and in phase 2 a switch for contributors outside the access list.
- **Pipeline page.** The settings above and the `relay-check` step with its daily limit.
- **Connect agent page.** The relay token, the fixed prompt for an unattended run and the note about the contributor's own machine.

## What Relay does not do

- It does not merge, approve, label or close anything, and it posts nothing beyond the one issue comment of Fix's PR step.
- It does not start anything on a contributor's machine and holds none of their credentials.
- It does not run two contributors on one relay task at once, and it keeps one line of checkpoints per relay task, not a tree.
- It does not rank people in public or count tokens, lines or submissions as merit.
- It does not offer security items, private repos or anything outside the public Rust repos Fix works on today.
- It does not let a contributor's text choose a check, a file list or a build step. Those come from Fix triage and the repo's default branch.

## Landing it

Each step is a small PR behind the per-repo setting.

1. Schema and the state machine in `src/relay/` as pure functions, with tests: one claim per relay task, the claim number refuses a late submit, a submission is never changed, the checkpoint moves up or is replaced by its rework, rework goes to the submitter first, a withdrawn relay task takes nothing. No step, no tool, no page.
2. The `relay-check` step: validation with the test-only rule, the two build tasks, levels from the results.
3. The agent tools for access-list roles with `after-fix`, the item page panel and the fixed prompt for an unattended run.
4. The verdict and completion: the Opus check with its relay prompt, rework, the changes in Fix above, the note line and the co-author lines.
5. `first`: triage without rounds, and the fallback to Fix.
6. Phase 2: the `contributor` scope, the settings, the surge breaker and the Contributors columns.

## Open questions

1. **Is outside capacity useful here at all?** If maintainers' judgement is the limit and model spend is not, Relay helps where Fix is limited by the day or failed. Is that enough of the backlog to be worth a new surface?
2. **`first` or `after-fix`?** With `first`, contributors' allowance does the patch rounds and the operator's accounts do triage, the check and Review. That is where spare allowance helps most, and it puts strangers' patches in front of the Opus check far more often. With `after-fix`, Relay only gets what Fix could not do: few issues, and the hard ones.
3. **Checkpoint by rule or by a person?** The proposal sets a checkpoint from the build results alone, because a checkpoint is internal and the PR still passes everything. A stricter design asks a maintainer for every checkpoint. That is safer, and it spends exactly the resource the pipeline protects.
4. **Assign the issue while it is a relay task?** Today Fix assigns the issue to the pipeline's account while it works and releases it when the attempt fails. A relay task then looks free on GitHub, and a person may start on it in parallel. Assigning would prevent that with a write Fix already makes.
5. **Whose PR is it?** The proposal has the pipeline's account open it with co-author lines. The alternative is that the contributor of the approved submission opens it from their own fork and Relay only attaches the verdict.
6. **Where does phase 2 listen?** On the dashboard's origin with a narrow scope, or on its own listener as the worker API has.
7. **Licence and sign-off.** A contributor would confirm once per token that their patches are theirs to give under the repo's licence. Repos with a DCO or CLA need more than that, since the commit's author is the pipeline's account.
8. **Beyond Rust.** The checks reuse Fix's cargo plan and its regression test rule. Another language needs its own plan and its own rule.
9. **Hand on unfinished work?** A contributor whose allowance runs out in the middle of a fix can hand on only the test. Carrying their unverified source changes to the next agent would waste less, and would put a stranger's unchecked code in front of that agent.
10. **A runner for contributors?** The proposal ships a fixed prompt and examples for an unattended run. A small command that does the loop itself (next, work, submit, wait, rework) would be easier to set up and one more thing to maintain.
