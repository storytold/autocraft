# Operations reference

Local mirror of every storytold issue and PR, the triage pipeline's state, and the backlog dashboard.

- `autocraft-server sync` fills a SQLite mirror (`~/.local/share/autocraft/mirror.db`, or `$AUTOCRAFT_DB`) from GitHub GraphQL. Agents and scripts query the mirror instead of calling `gh`.
- `autocraft-server whitelist` shows and edits which contributors' PRs may merge on green CI without a decision.
- `autocraft-server decide` turns items that need a maintainer's scope call into dashboard decisions, each with an AI summary (`docs/pipeline.md`, Decide).
- `autocraft-server labels ensure|plan|apply --repo R` is the pipeline's Label stage: puts each item's settled type label and flags on GitHub. `plan` and dry runs only read; `apply --apply` writes, and only for repos an operator approved on the dashboard Repos page. See docs/pipeline.md.
- `autocraft-server dash serve` serves the dashboard.
- `autocraft-server runner serve` runs the pipeline: while the pipeline is On (switch on the dashboard's Pipeline page, or `autocraft-server pipeline on`), it queues and runs the steps that have work, within each stage's daily limit. Turning it Off cancels queued automatic jobs; running ones end at their next model call (queued calls are withdrawn) and their GitHub writes are refused. `autocraft-server pipeline drain` also cancels queued automatic jobs and starts and plans nothing new, while jobs already running finish and keep their writes and their queued and leased model and helper calls (the dashboard shows Draining; `pipeline on` ends it). `pipeline drain` is refused while the pipeline is Off; `pipeline on --if-draining` switches on only a pipeline that is still draining, so an operator's Off stays Off. A deploy does not drain: it restarts the runner, and the jobs the restart interrupts resume (see [Restarts and resumed jobs](#restarts-and-resumed-jobs)).
- `autocraft-server opus-review --repo R [--limit N] [--dry-run]` runs the Review stage on one repo; `autocraft-server checks --repo R` refreshes CI and merge state of its open PRs. See docs/pipeline.md, Review.
- `autocraft-server merge --repo R [--limit N] [--apply]` merges the repo's queued PRs that may merge, through the built-in `autocraft-server safe-merge` (`$AUTOCRAFT_MERGE_CMD` overrides it with another command that takes `OWNER/REPO PR --squash|--merge --head <sha>` and refuses when the head differs), and asks a Merge? decision for the other taken PRs; without `--apply` it is a dry run. `autocraft-server queue [--repo R]` prints the merge queue. The runner's `merge` step and the autopilot merge only in repos an operator approved for merging on the Repos page. See docs/pipeline.md, Merge queue.
- Runner steps (`autocraft-server runner steps`): `classify-new`, `classify-all`, `embed`, `labels-ensure`, `labels-apply`, `decide`, `opus-review`, `checks` and `merge` (operator only, params `repo` and `limit`; it runs the merge command with `--apply`, so it merges for real).

### Sync

`autocraft-server sync` (every minute) runs one org-wide GitHub search for items updated since the newest `updatedAt` stored (`org_high_water`) minus 10 minutes, up to the run's start. The search returns at most 1,000 results, so a window with more matches is cut into `updated:A..B` slices, halving until each fits. A one-second slice with more than 1,000 matches is read by listing every tracked repo down to that second (with a logged warning); until the run finishes, neither `org_high_water` nor a repo's `high_water` moves. GitHub's search index can lag, so once an hour (`search_catchup_at`) the same search also re-reads the 6 hours before `org_high_water`, sliced the same way. `org_high_water` moves to the newest `updatedAt` seen, not to the start time. An item whose stored row equals what GitHub returned is not written again. Items of untracked repos are dropped before anything else is done with them. Per-repo passes run only for the first sync, for a repo that was just tracked (tracking clears its `high_water` and `synced_at`) and for `--per-repo`, `--all` and `--repo`.

Once a day per tracked repo the runner lists the repo's open issues and PRs (`reconcileTick` in `src/runner/runner.ts`). Mirror rows still `OPEN` that GitHub does not list as open are read one by one: closed or merged ones are updated, and ones GitHub no longer finds (deleted) or reports in another repo (transferred) are set to `CLOSED` and written to the audit log as `item-gone`. Every 5 minutes the runner takes the repo with the oldest `repos.reconciled_at`, if that is over 24 hours old, of the repos the sync has read in full. It reconciles one repo at a time, with the pipeline off too, and gives way to the minute sync: before each request it waits while the minute sync or a full re-sync holds its lock, and below 1,000 rate-limit points it waits for the reset. A failed reconcile is recorded like a failed sync and still moves `reconciled_at`, so the repo does not stay first.

`autocraft-server sync --full` re-reads every item of every tracked repo. It has its own lock (`sync-full-<db>.lock`), so the minute sync keeps running; before each request it waits while a minute sync runs, and it sleeps until the rate limit resets when fewer than 2,500 points are left (`--keep N`). It records the last finished repo (`full_sync_cursor` in `settings`) and a stopped run continues after it; `--restart` starts over.

Each run stores `sync_points_last_run` (a full run: `sync_full_points_last_run`) and `sync_rate_remaining` in `settings`.

#### Tracked repos

`autocraft-server repos track <name>` tracks a storytold repo; `autocraft-server repos track <owner/name>` tracks one of another owner. The name keeps the casing given, and sync compares names case-sensitively, so use the casing GitHub shows.

- Repo names are unique across owners. Tracking `owner/name` is refused when the name is known under another owner, or when it is new and storytold has a repo of that name. A known bare name means its recorded owner.
- The repo must exist and be readable. With the GitHub App identity, the app's installation must cover it.
- Sync refreshes the repo list from storytold first, so the GitHub App must be installed on storytold too. An app installed only on the other owner lets tracking succeed and sync fail.

#### Filing-only repos

A filing-only repo is a public repo of any owner that the Discord issue bot offers and files into with "Submit for me", without tracking it: no sync, no embeddings, no pipeline and no Discord search. Operators manage the list with `autocraft-server discord filing list | add <owner/name> | remove <owner/name>` or on the Discord page (Filing-only repos); each add and remove is audited (`discord-filing-add`, `discord-filing-remove`).

- Adding reads the repo through the read path (as the app under the app identity) and refuses it unless it is public, not archived and has issues turned on, and the GitHub App's installation covers it.
- Names stay unique across owners: a name that is tracked, known in `repos` under another owner, or already on the list is refused. GitHub's spelling of the name is stored.
- The one write such a repo gets is the bot's issue and its label (`guardBotFiling` in `src/core/guard.ts`), under the same limits and junk check as for tracked repos. When the app has lost access, the reporter is told so and gets the GitHub link.
- The bot's app select holds at most 25 repos: the preselected one, then the filing-only repos, then the tracked ones with the most open issues.
- While the GitHub App has allowed owners (below), the repo's owner must be one of them.

#### GitHub App installations

A private GitHub App can be installed only on the account that owns it. To let another account (a partner organization) install it, an app manager makes it public: the app's GitHub settings, Advanced, Make public. GitHub then lets any account install it, so AutoCraft keeps its own list of allowed owners.

- Operators manage the list on the GitHub App page (Allowed owners) or with `autocraft-server app owners list | allow <login> | remove <login>`; `autocraft-server app installations` lists the app's installations. Each change is audited (`app-owner-allow`, `app-owner-remove`). The list keeps each account's GitHub id and matches installations by it, so a renamed account stays allowed and its row takes the new login.
- An empty list enforces nothing: any account may install the app and nothing is removed. The first account allowed also lists every account the app is installed on at that moment and every account that owns a tracked or filing-only repo or the app, so turning enforcement on removes nothing that exists; their audit rows give the reason.
- To let a new organization install the app, allow it first: an installation on an account not yet listed is removed within seconds.
- While enforcement is on, tracking a repo or adding a filing-only repo needs its owner on the list; a repo tracked by a path that skips that check puts its owner on the list. Owners of tracked or filing-only repos and of the app show as Protected and cannot be taken off the list, and neither can an account whose installation covers such a repo (repos match by name, since names are unique across owners and survive an owner's rename); untracking does not remove them.
- With accounts listed, an installation on any other account is uninstalled: right after its `installation` (created, new permissions accepted) or `installation_repositories` (added) webhook is answered, and otherwise by a sweep of the app's installations that the sync run makes every 10 minutes. Before removing, AutoCraft reads the installation's repos; one that is tracked or filing-only keeps the installation, recorded as a failed `app-install-removed` row. Each removal is audited as `app-install-removed` (the account's login and id, the installation id and what found it); an installation GitHub no longer has is recorded with `already`. Removals and kept installations raise the `app-foreign-install` warning in the header for 24 hours, or until an operator acknowledges it.
- Filing-only repos of an owner that is not on the list are refused.

#### Hiding tracked repos from the Discord bot

The bot's repo select offers every public tracked repo. An operator hides one with `autocraft-server discord offer list | hide <name> | show <name>` or with its switch under "Offered in Discord" on the Discord page (audited as `discord-offer-hide` and `discord-offer-show`; table `discord_hidden_repos`). A hidden repo stays tracked: Discord search, ping replies and channel default repos still use it, but the bot no longer offers it for a new issue and refuses "Submit for me" there. Filing-only repos are removed, not hidden. The page shows how many of the select's 25 places the offered and filing-only repos fill.

#### Webhooks

The poll stays the backup and serves repos without the GitHub App. With webhooks on, a change reaches the dashboard in seconds instead of up to a minute. Setup, in the app's GitHub settings under General (an app manager does this):

- Webhook: Active. Webhook URL `<AUTOCRAFT_BASE_URL>/webhooks/github`, content type `application/json`, secret: the one GitHub returned when the app was registered from the dashboard (stored with the app's keys in the database). If there is none, set a secret in the app's settings and put the same value as `github_app_webhook_secret` in the secrets file; the dashboard stores it for the registered app at its next start.
- Permissions (Permissions & events): read access to Issues, Pull requests and Checks. The answer to a command in a comment (below) is a comment by the app under the app identity, which needs write access to Issues and Pull requests; an app registered from the dashboard has both (`appManifest` in `src/github/app.ts`). After raising a permission in the app's settings, the owner of each installation approves it there before it takes effect.
- Subscribe to events: Issues, Issue comment, Pull request, Pull request review, Pull request review comment, Check suite. A check suite counts when its action is `completed`; a fork's pull request, which GitHub lists no pull requests for, is found through the event's head commit.
- Check Recent Deliveries after saving: the `ping` delivery answers 200.

`POST /webhooks/github` needs no session. It checks `X-Hub-Signature-256` (HMAC-SHA256 of the raw body, constant-time compare) before parsing and answers 401 for a wrong signature or when no secret is set, 413 over 1 MB. From a verified delivery it takes only the repository's full name and the item number (for completed check suites, the pull requests the event lists whose base repository is this one, or the open ones at its head commit), and only for tracked repos. It writes one row per item to `sync_requests`, so a burst of events collapses, and answers 202. Payload text is neither stored nor logged and never reaches a prompt.

The runner drains `sync_requests` every 5 seconds while rows exist (`webhookTick` in `src/runner/runner.ts`). It skips a pass while a sync run holds its lock and stops when fewer than 1,000 rate-limit points are left. Each item is read with the sync's single-item document and written by the sync's writer, so the live topics update open pages. A failed read stays queued until it is 6 hours old; the next poll reads the item anyway. Both the poll and the re-read write `item_reads.synced_at` (one statement per page): the time the read started, before its first GitHub request (the start of the whole run for a paged read), so a read that began before a change never counts as made after it. A read that started before the one already stored for an item writes nothing for that item (not its row, its comments or its read time), so the mirror never goes back to an older snapshot. A re-read rewrites the item's comments even when the item row is unchanged. The runner uses one GitHub client seeded from the last sync's rate-limit reading and also skips a pass while the full-sync lock is held. A read that fails for a reason other than a transient one is dropped from the queue and logged. The item page shows it as "updated hh:mm" beside "On GitHub".

**Commands in comments** (`src/github/commands.ts`). Anyone who may use Queue items on the repo adds a pull request or an issue to the merge queue from GitHub with a comment that has, on a line of its own, `@<app-slug> merge queue` (`merge-queue` and `mergequeue` work as well, in any case). An optional weight from 1 to 10 follows the words `merge queue`, as `@<app-slug> merge queue 8` or `@<app-slug> merge queue weight 8`; a weight on its own (`@<app-slug> weight 8`) is no command. Quoted lines, fenced and indented code (four spaces or a tab) and HTML comments (`<!-- -->`, also across lines) do not count. Only a new comment (`issue_comment`, action `created`) by a user account in a tracked repo counts; edits and comments by bots or apps do not, and neither does a comment created more than 5 minutes before its delivery arrives (a redelivery of an old comment). The webhook stores the comment's id and creation time, the repo, the number, whether it is a pull request, the weight and the commenter's login and numeric GitHub id in `github_commands`, never the comment's text; a redelivery of the same comment adds nothing. The runner carries the command out in the same pass that drains `sync_requests`, after the item's own re-read (see the last point):

- A commenter without an AutoCraft login, with a login whose GitHub id was never bound (no dashboard sign-in yet), or whose GitHub id is not the one bound to that login, gets no answer (audited as `github-command` `ignored`), so nobody outside the access list can make the app write. A viewer's command is refused without an answer.
- The comment is read again by its id (REST, through the app installation). A deleted comment, another author, or a body that no longer holds the same command (with the same weight) runs nothing and gets no answer (`ignored`).
- A pull request is pinned to the head it had when the comment was written. GitHub keeps no push time for a commit, so the PR counts as changed after the comment when any of three signals is later than the comment's creation time: a force push (`HeadRefForcePushedEvent`, stamped by GitHub), a commit's committer date (set by the pusher, so a back-dated commit passes this one) or the head's first check suite (stamped by GitHub when a push starts CI; a merge needs green CI at the head). While the head has no check suite yet and neither other signal shows a change, its push time is unknown: the command is tried again (see the last point) until CI registers the head. A changed PR is refused with "the PR changed after your comment; comment again"; otherwise exactly that head is pre-approved, and a mirror head that differs from it is refused the same way. On an issue, its one open closing PR is queued only when it was opened before the comment and has not changed since; otherwise the issue is still fast-tracked and the answer names the PR to comment on.
- Then the commenter's write permission on the repo is read from GitHub through the app installation (`appPermission`, the collaborator permission, which writes `repo_permissions`, so a maintainer's pre-approval keeps the fresh row `refreshSettlers` then keeps alive) and the item is added exactly as a line of **Queue items** on the Queue page (`queueAdd`, see docs/pipeline.md, Merge queue), as that login with its current role. The role and the login's binding are read again once GitHub has answered, with the same outcomes as above, so a login demoted or rebound meanwhile queues nothing. Who may is queueAdd's rule, the one every person-started write uses (`settleRefusal` in `src/settlers.ts`): an operator with write access on the repo, or a maintainer with `maintainer_writes` on, the app identity and write access; anyone else is refused with its reason. A role or setting that refuses whatever GitHub says is answered before the head and permission reads. A PR is fast-tracked with the weight (default 5); an issue is fast-tracked and its one open closing PR queued. Its refusals (outside the scope, a draft, the backlog, a duplicate hold, an open scope question, no merge approval for the repo, a pre-approved merge already in progress, …) are the answer; the PR's type label is never one, since the pre-approval lifts the label gate and the PR gets its review, pre-merge review and CI whatever its label; any other error is logged and answered "it could not be queued". Audit rows are queueAdd's own under the commenter's login with `via: "github"`, plus one `github-command` row.
- On a quiet pull request (a security fix not yet published), or an issue whose closing PR is one, only an operator's command is carried out, and nothing is answered.
- The app answers in the same thread, naming the commenter: what was done and the item's fast-track place, or why not. The answer goes through `src/github/write.ts` (`ghComment`, audit action `github-command-reply`, note line "Automated reply") under a grant in the commenter's name. An answer to a person the queue rule lets queue on the repo needs no Comments approval; any other answer (a refusal by the rule, an expiry) needs it. A paced write is retried on the next pass; another failed answer is logged and not retried. `reply` is `none` for a command that gets no answer.
- A command waits until the item, and for an issue every open PR that closes it (the one Queue items would queue), was read from GitHub after the delivery, by the webhook's re-read or by the poll when that re-read failed. `item_reads.synced_at` must be strictly after the command's arrival: a read stamped at the same instant may have started before it. This is checked again after the GitHub reads, right before `queueAdd`, with nothing waiting on I/O between that check and the pre-approval, because a read that started earlier (a reconcile) may have written an older snapshot meanwhile, which also sets the item's read time back. While no such read exists and none is queued (the re-read failed, or started within the delivery's second, which the second-precision `synced_at` counts as before it), the command queues a re-read itself, at most once a minute (`tried_at`). A command whose comment, head or permission read GitHub cannot settle (an error, no app answer, or a head without a check suite) is tried again after a minute (`tried_at`, `retries`). Waiting commands cost no GitHub call and never keep newer ones out: a pass carries out at most 10 commands that call GitHub, oldest first among those that are due. One not carried out within an hour of its arrival is dropped (`expired`): unanswered when it only waited, answered once with "could not check your access; comment again" when GitHub's reads kept failing. Settled commands are deleted after 30 days by the runner's hourly pruning.

**Autorepin** (`src/repin`). A pull request that needs an unmerged change in another tracked repository (a craft-libs pull request, say) pins that repository's crates to a commit of its branch, and has to be repinned to the merge commit once the change is merged. A comment on the pull request with, on a line of its own, `@<app-slug> autorepin <pull request>` (`auto-repin` works as well) has AutoCraft do that. The pull request is named as `owner/name#12`, `name#12` or its GitHub URL; `@<app-slug> autorepin off` drops every autorepin still waiting on the pull request. `@<app-slug> autorepin <pull request> via <branch>` pins to a branch of that repository other than its default one (a `next` that the default branch is merged into, say): see below. The branch name must be one git accepts, made of letters, digits, `.`, `_`, `-` and `/`; any other makes the line no command. It is a command like the one above (same commenters, same storage plus the named repository and number, same answer in the thread), with these differences:

- Who may is the same rule (`settleRefusal`), for the pull request's repo. The command is refused on an issue, for a repository AutoCraft does not track, for a pull request the mirror has not read or that was closed without merging, for one in the pull request's own repo, where **Pushes** are not approved for the repo, and where no build worker would take its lockfile task (the repo is outside the pipeline's scope and the PR is not fast-tracked). A repo that leaves that scope before the task is queued fails the autorepin with the same reason. It does not wait for a re-read: nothing is written at a head when it is set. The comment read again must still name the same pull request and branch (or still say `off`).
- One row per pull request and dependency repository is kept in `autorepins`; a second command for the same repository replaces the first, so a pull request can wait on one pull request in each of several repositories. Commands count in the order of their comments: one carried out late (a retried permission read) never sets again what a later `off` dropped, nor replaces a later command's pull request. The latest `off` of each pull request is kept in `autorepin_offs`, also when nothing was waiting, so a command written before it sets nothing. An `off`, a try that starts over, or any end cancels a lockfile task still running.
- Nothing happens while the named pull request is open. The runner looks at the rows on every pass of `webhookTick` from the database alone (`src/repin/due.ts`): a row is due when the mirror shows the named pull request merged or closed (the webhook's re-read of that repository brings that in within seconds, the poll otherwise), when its lockfile task ended or has run for 3 hours (no build worker took it, say: the autorepin then fails), or when its outcome is still to post. A pass takes at most 5 due rows. The drain starts after the pass's comment commands and runs on its own, so its git work never holds up the next pass's re-reads and commands.
- Once it is merged, the merge commit is read from GitHub. It must be on that repository's default branch: a merge into another branch fails the autorepin, and so does a merge commit that is no longer an ancestor of the branch as fetched now (a branch rewritten since).
- With `via <branch>`, a merge into the default branch or straight into that branch is accepted. The branch is fetched too, and the pin is not the merge commit but the oldest commit of the branch's first-parent history that holds it: the merge that brought it into the branch, or the merge commit itself when that history passes through it (a merge, squash or fast-forward into the branch). So nothing else of the branch comes along. The branch must exist when the command is accepted (one GitHub read; a missing branch is refused, and a failed read accepts the command). While the branch does not hold the commit yet, the autorepin waits, which clears the count of tries, so only consecutive failures reach the limit, looking again every 15 minutes, and fails 7 days after the merge. If the commit to pin to changes while the lockfile is written (the branch was rewritten), the try starts over. Then the access of the person who asked is read again (their AutoCraft login, still bound to the GitHub account that asked, their live write permission through the app, `settleRefusal`, and on a quiet pull request only an operator), the Pushes approval is checked again, and the pull request is read live: it must be open and its branch one AutoCraft may push to (the rule of fix-ups, `src/fixup/pushable.ts`).
- No model is involved. In every `Cargo.toml` of the pull request's head, the `rev` of each git source on the repository (dependencies of every kind, `[workspace.dependencies]`, `[patch]`) is set to the full id of the commit pinned to (the merge commit, or with `via` the branch's commit) by a text edit that is accepted only if the manifest then parses to the same data with exactly those values replaced (`src/repin/manifest.ts`). Only dependency tables count; a `git` and `rev` elsewhere (`[package.metadata]`) are not touched. A `Cargo.toml` that cannot be read (a failed read, a link, over the size limit) ends the try, so a repin never covers only some manifests; one that names the repository but does not parse fails the autorepin, naming the file. Sources on the repository without a `rev` (a branch, a tag) are left alone; a pull request with no `rev` on it fails the autorepin.
- A `Cargo.lock` below the repository root fails the autorepin: the task updates only the root one. With a `Cargo.lock` at the repository root, a build task (step `autorepin`, one step with network, the fetch step's environment: no repository cargo config or toolchain file, nothing of the repository runs) gets the manifest edit as its patch, runs `cargo update --workspace` and returns `Cargo.lock`. The lockfile is read as TOML, before and after, and accepted only if every package of the repository is at the commit pinned to, by rev (one on a branch or tag is refused with that reason), every other package is in the old lockfile with the same name, source, version and checksum, and the only packages added are crates.io packages whose name the old lockfile has from no source (crates.io under either index spelling, git or another registry). Packages may be dropped. Without a lockfile there is no task.
- The commit ("Repin <repo> to <commit>", authored like the pipeline's other commits) changes only those manifests and the lockfile, and is pushed with a lease on the head it was made on (`pushRepin` in `src/github/write.ts`, audit action `autorepin-push`). A head that moved meanwhile, a failed lockfile task or a GitHub read that fails starts the autorepin over after a minute, at most 5 times; then it fails with the last reason. A reason AutoCraft did not word itself (git or database errors) is only logged; the comment then gives a fixed reason.
- The outcome is one comment on the pull request naming the person who asked (audit action `autorepin-comment`): the commit and the files it changed, why it failed, or that the named pull request was closed without merging. A quiet pull request gets no comment. A pull request that itself closed or merged first drops its autorepins without a comment. The new head goes through Review and Verify like any new head. A merge pre-approved at the old head (`@<app-slug> merge queue`, Queue items) carries on to the repinned head as it does across the pipeline's own base merge (`ownPush` in `src/preapproval/index.ts`): the row goes back to `review`, and the review, the pre-merge review and CI must be clean at the new head before the PR reaches the merge queue. As for a base merge, this holds until the row is `queued`: a pre-approval whose Merge answer is already written for the old head is cancelled by the repin, with the reason in the PR's thread, and a person queues the PR again. So a pull request that has both commands needs nobody between the dependency's merge and its own.

The app's slug is shown on the GitHub App page; without the app there are no commands. The **Issue comment** event must be subscribed (it is in the list above).

Sync also stores the hashes the planner compares, on the item row: `embed_hash` (the embedded text, `src/embed/text.ts`) and `class_hash` with `class_scheme` (the classifier's input hash, `src/itemhash.ts`). `classify-new` and `embed` select changed items from these columns on covering indexes instead of hashing every body. The first `connect()` after an upgrade fills them for existing rows (about 6 s for 56,000 items). An edit of title, body or size outside sync clears the row's hashes, and the readers fill them again.

Schema: `src/schema.sql`. Full-text search uses the FTS5 tables `items_fts` and `comments_fts`, kept current by triggers; the first `connect()` after an upgrade builds them (about 16 s for 56k items and 65k comments). Mirror tables are overwritten by sync; work tables (classifications, stages, whitelist overrides, token use) are ours.

TypeScript on Node 24, run directly (type stripping, no build step): `node src/cli.ts <command>`. SQLite through the built-in `node:sqlite`. `pnpm check` type-checks; `pnpm test` runs the tests.

## Dashboard server

`autocraft-server dash serve` serves the dashboard over plain HTTP; a proxy in front provides HTTPS. Every page needs GitHub sign-in, and only logins on the access list get a session. Roles are `operator` (answers decisions, manages the whitelist, repos and access), `maintainer` (reads everything except accounts and access, and gives opinions and comments) and `viewer` (read-only, without prompts, logs or notes). Add the first operator from a shell: `autocraft-server access add <login> --operator`. Then manage the list on the Access page or with `autocraft-server access list|add|remove|role`.

The frontend is the React app in `web/`. Build it before serving: `pnpm -C web install && pnpm -C web build` (writes `web/dist`). Without a build the server answers app pages with a 503 that says so. `VITE_MOCK=1 pnpm -C web build` builds a mockup on fake data that runs without the server.

| Variable | Meaning |
|---|---|
| `AUTOCRAFT_BASE_URL` | Public origin of the dashboard, such as `https://dashboard.example.org` (no path). The OAuth App's callback URL must be exactly `<AUTOCRAFT_BASE_URL>/auth/callback`. Required unless dev auth is on. |
| `AUTOCRAFT_LISTEN` | `host:port` to listen on. Default `127.0.0.1:8993`; with dev auth, `127.0.0.1:8994`. |
| `AUTOCRAFT_DB` | SQLite database path (the mirror database). |
| `AUTOCRAFT_DB_URL` | A `postgres://` URL: the database is Postgres instead of SQLite. Set it or `AUTOCRAFT_DB`, not both. The runner hands it to its worker threads and job processes. |
| `AUTOCRAFT_REVIEW_BOTS` | Comma-separated logins of review bots whose comments never make a review stale, besides accounts of type Bot or ending in `[bot]`. Default `coderabbitai,dependabot,renovate`. Read by `sync` (when it stores a comment), the database backfill and the runner, so set it for all three alike. |
| `AUTOCRAFT_WEB_DIST` | Directory of the built frontend. Default `web/dist` in the repo. |
| `AUTOCRAFT_SECRETS_FILE` | JSON file with `github_client_id`, `github_client_secret` and `session_key` (at least 32 characters, random). Must be mode 0600; the server refuses to start if it is missing, incomplete, or readable by group or others. The file is only read, so it can be a read-only mount. Registering the GitHub App from the dashboard (GitHub App page, operators only) stores the app's keys in the database, sealed with a key derived from `session_key`. The GitHub App page's Remove button clears them (refused while the GitHub identity is the GitHub App) and links to the app's GitHub settings page, where the operator deletes the app. A secrets file from before that holds `github_app_id`, `github_app_slug`, `github_app_private_key`, `github_app_client_id`, `github_app_client_secret`, `github_app_webhook_secret` and `github_app_owner` is imported into the database once, at the first start that finds no stored app; after that those keys in the file are ignored, except `github_app_webhook_secret` (Webhooks above). Every process reads the stored keys again at most every 10 seconds, so registering or removing the app needs no restart. Stored keys that the current `session_key` cannot open count as no app: the processes log it once and the GitHub App page says so; registering a new app is refused while they are stored, with an error saying they are sealed with a different `session_key`, unless the operator ticks the confirmation to replace them (the `replace_unreadable` field of the registration form). Whether GitHub reads, writes and dashboard sign-in use the box account or the GitHub App is one instance-wide setting (GitHub App page, or `autocraft-server identity [box|app]`); switching ends every dashboard session and takes effect in the runner and the dashboard at their next GitHub call, without a restart. Under `box`, every `gh` and `git` call uses the server user's own `gh` login. Under `app`, every read (GraphQL, REST, git fetch over HTTPS, the image proxy, repository checks when tracking) runs with an installation token of the owner it concerns (the first tracked repo's owner when a read names none) and never sees the box account's credentials; the `gh` login of the server user is not needed. A read for which no installation token can be minted fails with an error naming the owner. The GitHub rate figures shown on the Pipeline page and used by the sync's reserve are those of the token in use. Permission checks of a signed-in person use that person's own token in both modes. |
| `AUTOCRAFT_GITHUB_APP_NAME` | Name suggested on the registration form. Default `AutoCraft`; at most 34 letters, digits, spaces, dashes or underscores. |
| `AUTOCRAFT_TRUST_PROXY` | The number of trusted proxies in front of the server (0 to 9, default 0), for the client address of the rate limits. Each proxy is assumed to append the address it was reached from to `X-Forwarded-For`, so the client is that many entries from the end; with 0 the socket address counts. A proxy that replaces the header with a CDN's client-address header counts as one, and must then refuse connections that do not come from the CDN. |
| `AUTOCRAFT_IMG_CACHE` | Disk cache of the image proxy. Default `$XDG_CACHE_HOME/autocraft/img` (`~/.cache/...`); empty for no disk cache. It is only a cache, so each replica can have its own scratch directory (a Kubernetes `emptyDir`). |
| `AUTOCRAFT_RUNNER_URL` | Base URL of the runner's worker API (`AUTOCRAFT_WORKER_LISTEN`), for a dashboard that does not share the runner's disk. The item and reference tools and the tarball mounts of Task Runner calls read the runner's files (the item snapshot, the diff cache, the reference index, the git clones); with this set, the dashboard asks the runner for them under `/remote/`, passing the call's lease secret, which the runner checks again. Build artifact downloads and everything on the Accounts page (the account list, adding and editing accounts, sign-in and token requests, sign-out, refresh) also go to the runner, under `/internal/`, which holds the account directories and runs the `claude` sign-in; the account list is reused for 2 seconds. The dashboard checks the user as before and signs each `/internal/` request with a key derived from `session_key` (method, path, body hash and login, valid for a minute), so the runner needs the same secrets file. Unset: the dashboard reads the files and runs the sign-in itself. |
| `AUTOCRAFT_DASH_REPLICAS` | Number of dashboard processes serving the same instance (1 to 100, default 1). The rate limits are kept in each process's memory, so each process allows its share of every limit (the limit divided by this number, rounded down, at least 1) and together they allow about what one dashboard allows. That holds when requests are spread over the replicas per request, as an ingress or load balancer in front does; a client whose requests all reach one replica (one kept-alive connection through a per-connection balancer) gets that replica's share only. |

The GitHub OAuth App needs no scopes, and expiring user tokens are supported: the server refreshes them as needed and ends the session when a refresh fails. Tokens are stored encrypted with a key derived from `session_key`; changing `session_key` makes the stored GitHub tokens unreadable until each user signs in again.

### Images

`GET /img?u=<url>` (signed in only) fetches GitHub-hosted images from issue and PR bodies and comments so the app can show them inline under its CSP. It serves only `https` URLs on `github.com/user-attachments/assets/<uuid>`, `private-user-images.githubusercontent.com`, `user-images.githubusercontent.com`, `raw.githubusercontent.com/storytold/` and `avatars.githubusercontent.com`, and only when the exact URL occurs in a mirrored body or comment of a tracked repo; everything else is a 404 with no upstream request. The set of such URLs is rebuilt from the mirror when it has changed (at most every 30 seconds), and a cached image is served only while its URL is still in it. `imageRepo(url)` in `src/dash/server/images.ts` returns the repo an allowed URL belongs to.

The proxy follows at most three redirects, each to one of those hosts or GitHub's attachment bucket (`github-production-user-asset-6210df.s3.amazonaws.com`); IP addresses and `localhost` are never fetched. It serves PNG, JPEG, GIF, WebP and AVIF, checked by their magic bytes, up to 5 MB (the stream is aborted past that), within 15 seconds; never SVG. At most 4 upstream fetches run at once; further ones wait up to 5 seconds, then get 429. Each session may make 120 upstream fetches a minute and each client address 240. Responses are `private, max-age=86400` with `default-src 'none'` and `nosniff`; images are cached on disk for 7 days (at most 512 MB).

Requests to `github.com` attachment URLs carry a GitHub token; no other host gets it. The token comes from `AUTOCRAFT_IMAGE_TOKEN_FILE` when it is set: a file holding a token that can read the tracked repos and nothing more (a fine-grained read-only token). The file is read at start and again when it changes. When the variable is unset, the server runs `gh auth token` in the repo's directory instead. Under the GitHub App identity the proxy uses an installation token and ignores both. The server logs which source it uses at start, never the value.

| Variable | Meaning |
|---|---|
| `AUTOCRAFT_IMAGE_TOKEN_FILE` | File with the image proxy's token. Default: unset, use `gh auth token`. |

### Request limits

The GET endpoints that do real work (`/api/queue`, `/api/contributors`, `/api/search?mode=semantic`) share a per-session token bucket of 20 requests refilling at one every two seconds; beyond it the answer is 429 with `Retry-After`. At most two embeddings run at once; others wait up to 3 seconds, then get 429. The contributors table is computed at most once a minute, and after that until the next sync moves the high-water mark.

### Development sign-in

With `AUTOCRAFT_DEV_AUTH=1` the server uses a fake GitHub: `/auth/signin` shows a form that signs in as any login typed into it (the login must still be on the access list). It needs no secrets file and starts only on a loopback listen address (default port 8994). With `AUTOCRAFT_SECRETS_FILE` set to a file holding `session_key`, that key seals the GitHub App's keys, so a registered app stays readable after a restart; without one, a random key per process is used. If `AUTOCRAFT_BASE_URL` is set it must be an `http://localhost` or `http://127.0.0.1` URL. The server answers 403 to any request that carries `X-Forwarded-For` or a `Host` that is not a loopback name. Repo permissions come from the JSON file named by `AUTOCRAFT_DEV_PERMS`, read on every check: `{"<login>": {"<repo>": "write"}}` (values `admin`, `maintain`, `write`, `triage`, `read`). `AUTOCRAFT_DEV_TOKEN_TTL` sets the fake access tokens' lifetime in seconds (default 8 hours). Open the dashboard as `http://localhost:<port>` so the browser accepts its `Secure` cookies.

### JSON API

The frontend in `web/` talks to `/api/`; the wire types are `web/src/api/types.ts`. Every endpoint needs a session (401 JSON without one) and returns errors as `{"error": "..."}` with a status code. Every `/api/` response carries the session's CSRF token in `X-CSRF-Token`; every POST must send it back in the same header, with a JSON body (at most 64 KB). A POST whose `Origin` or `Sec-Fetch-Site` names another site is refused.

| Method and path | Who |
|---|---|
| `GET /api/me`, `/api/repos`, `/api/progress`, `/api/search?q=`, `/api/items/<repo>/<n>` | anyone signed in |
| `GET /api/items?q=&mode=text&repo=&kind=&state=&label=&status=&flag=&author=&since=&flow=&sort=&desc=&limit=&offset=&run=` (Items browser: full-text search over titles, bodies and comments, settled type labels, counts per settled status; `flow=<node>.<branch>` lists exactly the items a flowchart branch counts) | anyone signed in |
| `GET /api/classifiers?run=&a=&b=` (agreement, confusion, confidence bands and flags for a run and classifier pair; defaults to the latest run), `/api/classifiers/disagreements?run=&a=&b=&label=&band=&limit=&offset=` | anyone signed in |
| `GET /api/cost?run=` (token use, USD where recorded, and wall time per stage and model and per repo, plus spend over time; all runs when `run` is empty) | anyone signed in |
| `GET /api/flow?repo=` (the home page flowchart: stages with branch counts, edges, the last 24 hours, runner steps and prompts per stage, from the per-repo `flow_summary` rows) | anyone signed in |
| `GET /api/queue?repo=&state=` (the merge queue: taken PRs, their state, counts per state) | anyone signed in |
| `GET /api/prompts` (every registered model prompt: template, model, call settings, output checks and a rendered example on made-up items, plus the commit the server runs) | anyone signed in |
| `GET /api/decisions?status=open\|opinions\|answered&repo=&kind=&minAge=&mine=1&limit=&offset=`, `/api/decisions/<id>`, `/api/decisions/<id>/thread` | anyone signed in; answer notes only for operators |
| `POST /api/decisions/<id>/answer` `{answer, note?, exceptions?}`, `/undo`, `/adopt` `{opinionId}` | operator with write, maintain or admin on every repo the decision covers |
| `POST /api/decisions/<id>/feedback` `{option?, text?}` (at least one; a pick replaces the login's live pick, text alone joins the thread), `/retract` (withdraws the pick) | maintainers and operators; audited; maintainers get 60 an hour per login; viewers get 403 |
| `POST /api/decisions/<id>/claim` | maintainers and operators: marks the decision as being looked at for 10 minutes |
| `GET /api/contributors?q=&tier=&repo=&sort=&desc=&limit=&offset=` | anyone signed in; override notes only for operators |
| `GET /api/contributors/rule-preview?minMerged=&minRate=`; `POST /api/contributors/rule` `{minMerged, minRate}`, `/api/contributors/<login>/override` `{status: "allow"\|"deny"\|null, note?}` | operator |
| `GET /api/repos/all` (operator or maintainer); `POST /api/repos/track` `{name}`, `/api/repos/untrack` `{name}`, `/api/repos/pipeline-on` `{name}`, `/api/repos/pipeline-off` `{name}` | operator |
| `POST /api/repos/build-feature` `{name, feature, on}` (one repo's build feature switch; returns the repo), `POST /api/build/features` `{feature, on, repo}` (the same switch; `repo` is required except for the instance-wide `scan-tests`), `GET /api/build/features` (each feature's repos that have it on, and whether the dashboard shows its switch) | an operator, or a maintainer with write permission on the repo, for the shown features (`push-tests`, `batch-build`, `implement`; `screenshots` while an enabled environment reports a display; `nightly` while one reports a nightly toolchain); operator for the others and for pr-builds' `scope` and `perDay`; audited as `build-feature` |
| `GET /api/audit?login=&action=&limit=&offset=` (operator or maintainer; maintainers get no access-management rows and a 400 for those actions); `GET /api/access`; `POST /api/access/add` `{login, role, note?}`, `/api/access/remove` `{login}`, `/api/access/role` `{login, role}`, `/api/access/sessions/revoke` `{id}` | operator; the last operator can't be removed or demoted |
| `GET /api/pipeline` (stages, steps with their params schema and last job, runner heartbeat, recent syncs), `/api/pipeline/state` (switch, who and when, per-stage daily limits with use today), `/api/pipeline/jobs?step=&state=&limit=&offset=`, `/api/pipeline/jobs/<id>` (with the scrubbed end of its log) | anyone signed in |
| `POST /api/pipeline/jobs` `{step, params}`, `/api/pipeline/jobs/<id>/cancel`, `PUT /api/pipeline/state` `{enabled}`, `/api/pipeline/limits/<step>` `{perDay: number\|null}` | operator; audited |
| `GET /api/accounts` (Claude accounts with label, slots in use and usage; maintainers and viewers see enabled ones only), `/api/agents?state=&step=&account=&repo=&cursor=&limit=` (agent runs, newest first, keyset cursor; `state=running` lists every active run), `/api/agents/<id>` (with prompt, output, cost and tool uses; texts for ten years), `/api/rates?window=24h\|7d` (items moved and agent runs per stage, account usage over time) | anyone signed in |
| `PUT /api/accounts/<id>` `{label?, enabled?, maxConcurrent?}` | operator; audited as `account-change` |
| `POST /api/accounts/<id>/token`, `/token/code` `{code}`, `/token/cancel`, `/token/remove` (long-lived token of an account; the value is never returned) | operator; audited as `account-token-start`, `-code`, `-cancel`, `-set`, `-remove` |
| `GET /api/mcp/tokens` (the caller's own MCP Connector tokens, never their values); `POST /api/mcp/tokens/revoke` `{id}` | anyone signed in, own tokens only; revoke audited as `mcp-token-revoke` |
| `POST /api/mcp/tokens` `{label?, answer?}` (a new MCP Connector token, its value returned this once; at most 5 per login; `answer: true` makes an answering token that lasts 7 days, operators only; `run: true` is refused with 400, since a Task Runner makes its own credential, see [Task Runner credentials](#task-runner-credentials)) | maintainers and operators; audited as `mcp-token-create`; viewers get 403 |
| `GET /api/runners` (the caller's own Task Runners with machine, version, readiness, slots, usage, last error and scopes `agent`, `answer`; `answering`: whether the caller may let a runner answer); `GET /api/runners/pending?code=` (the login waiting for approval, with the scopes it asks for); `POST /api/runners/approve` `{code, label?, agent, answer}`, `/deny` `{code}`; `POST /api/runners/scopes` `{id, agent, answer}`; `POST /api/runners/revoke` `{id}` | maintainers and operators approve and deny (viewers get 403); anyone sets the scopes of and removes their own; `answer: true` needs answering to be available and an operator, or a maintainer while maintainers settle decisions (keeping a runner's existing answering needs neither); audited as `runner-approve`, `runner-deny`, `runner-scopes`, `runner-revoke` (operator-only audit rows) |
| `GET /api/model-queue` (queued model calls, the Task Runner counts and the caller's picks); `POST /api/model-queue/<id>/pick`, `/unpick` | anyone signed in reads, with fewer fields for viewers; maintainers and operators pick; audited as `remote-pick`, `remote-unpick` |
| `PUT /api/me/settings` `{reserve?, repos?, maxCalls?, manualOnly?, runnerPrivate?}` | maintainers and operators; audited as `usage-reserve`, `my-repos`, `max-calls`, `interactive-slots`, `manual-only`, `runner-private`; the `settings` and `settings set` commands do the same through MCP |
| `POST /api/signout` | anyone signed in |
| `GET /api/similar/<repo>/<n>?limit=` (nearest items across the tracked repos, with score; default 10, at most 50), `/api/search?q=&mode=semantic` (search by meaning, same hits plus a score) | anyone signed in; 503 until `autocraft-server embed` has run |

Feedback (picks and text) is display-only. The pipeline reads answers with `autocraft-server decisions list --actionable` (one JSON object per line: option keys of unapplied answers by a current operator), which never includes them.

### MCP Connector

`POST /mcp` on the dashboard's origin is an [MCP](https://modelcontextprotocol.io) server named `autocraft` (title AutoCraft) for contributors' own agents (Claude Code or any client that speaks Streamable HTTP). It lists what the pipeline could not settle on its own and takes feedback back, so a contributor can work the Inbox from the agent they already use, on their own machine and their own model usage. The code is `src/dash/mcp/`.

- **Tokens.** A maintainer or operator makes a Connector token in the MCP Connector block of the Connect page (`/connect`, opened from the user menu), which shows it once with the `claude mcp add --transport http ... --header "Authorization: Bearer <token>"` command and a JSON config for other clients. Connector tokens are `acmcp_` plus 32 random bytes, stored as a SHA-256 hash in `mcp_tokens` (`kind` `connector`), valid for 90 days, at most 5 per login, and revocable by their owner. A Task Runner credential (`acrun_`) works on `/mcp` only with Agent access (see [Task Runner credentials](#task-runner-credentials)); without it, `/mcp` answers 403. Client configs that call the server `autocraft-inbox` keep working: the name exists only in the client, and their tools keep the prefix `mcp__autocraft-inbox__`. An operator can tick **Can answer decisions** to make an answering token (`can_answer`), which lasts 7 days, the longest an operator's dashboard session lasts. A token counts only while its login is on the access list, and its role is read from the list on every call; removing a login deletes its tokens, ending a session of a login (Access page) deletes that login's tokens, and a lowered role deletes its answering tokens and takes answering from its Task Runners. Operators list and revoke any login's tokens on the Access page (`POST /api/access/tokens/revoke` `{id}`, audited as `mcp-token-revoke`; token audit rows are operator-only). A token has no GitHub token of its own: without a live dashboard session of its login, only recently cached permissions count.
- **Transport.** One JSON-RPC message per POST (at most 4 MiB, room for a 1 MiB patch), answered with one JSON body (no event stream: `GET` is 405; notifications get 202; batches get 400). The token goes in `Authorization: Bearer`; the session cookie is never accepted here, and a request whose `Origin` or `Sec-Fetch-Site` names another site is refused. Limits: 120 calls a minute per login, and 300 failed authentications a minute per client address.
- **Tools.** `list_repos` (visible tracked repos with open decisions by kind and fix-ups waiting), `list_inbox` (open decisions, oldest first; `repo`, `kind`, `limit` up to 25, `cursor`), `get_inbox_item` (one decision: question, option keys, summary and recommendation, item text, facts, risks, related items, picks and comments), `send_feedback` (`id`, `option?`, `text?`), `list_merge_queue` (the Queue page's Merge tab: each PR's state, merge path, CI, verify, fast-track weight and place, hold, how it came in and who added it (logins for maintainers and operators only), why it does not merge yet, the next merges with what each waits for, the batches in flight, and pre-approved merges whose PR is no queue row on any page yet, from every visible repo or the one asked for; `repo`, `limit` up to 25 for each list, `cursor` `<queue offset>:<last pre-approval id>` with `x` for a list that is done), and `list_fixups` (open PRs at their current head that the planner holds in the fix-up `hold` bucket with no push of ours under way, with the review's fix list and why the step stopped; viewers get the state only, as on the item page). While answering is available (`answering.enabled`), an answering token of a login that is an operator at the time of the call is also offered `answer_decision` (`id`, `option`, `note?`, `textsHash?` for a duplicate group, `exceptions?` for a batch) and `undo_answer` (`id`); for it, `get_inbox_item` adds `undoable`, the comment the answer would post, and each option's duplicate-group texts with their `textsHash`. Answering is the user's own action and has to execute as that GitHub user, which needs GitHub App user tokens that AutoCraft does not have yet. Until then no token can be made with `answer: true`, the Connect page hides the switch, the answer tools are not listed and the instructions do not mention them; a call to either refuses with a message that the user must sign in again with GitHub App sign-in. The switch is `answering.enabled` in `src/dash/mcp/index.ts`, and the checks below stay ready. Any other token is not offered them and gets an error if it calls them. `list_repos`, `list_fixups` and `list_merge_queue` share a per-login budget of a burst of 20 then 30 a minute. Every result frames GitHub text, and the pipeline's text about it (option labels and what an answer writes included), as untrusted, as the item tools do.
- **Merge queue.** A token whose login is an operator at the time of the call is also offered `set_weight` and the instructions describe it. `queue_pr` and `cancel_queued` are offered and allowed only to an answering token (`McpEnv.canAnswer`, with `answering.enabled`), because a pre-approved merge is a Merge answer given ahead; a call also refuses unless the user has live write permission on the repo (`queue_pr`). A maintainer's answering token (answering needs `maintainer_writes` on) is offered `queue_pr` as well, without its `weight`, and not `set_weight` or `cancel_queued`; the call takes the dashboard's rule for Queue items, so it is refused (403) on a repo without the app identity or the maintainer's write access. Weights are set by operators: a maintainer's `queue_pr` fast-tracks an item not on the list yet with the default weight, leaves an existing weight as it is, and ignores a weight it is sent (the reply says so). `queue_pr` (`item`, `weight?`) is "Queue items" (`POST /api/queue/add`): a PR is pre-approved at its current head and fast-tracked with the weight (default 5), keeping a heavier weight it has; an issue is fast-tracked and its one open closing PR is queued. `set_weight` (`item`, `weight?` or `remove: true`) changes a fast-tracked item's weight, fast-tracks an item not on the list with that weight without approving its merge, or takes it off; it calls `setFastTrackWeight`, `addFastTrack` and `removeFastTrack` directly (the dashboard's `/api/fast-track` routes call the same functions); it checks the repo is visible first and then decides between adding and changing in the same write, so a `queue_pr` of the same item meanwhile cannot leave its weight in place of the one asked for. `cancel_queued` (`item`) is the item page's cancel of a pre-approved merge (`POST /api/items/<repo>/<n>/preapproval/cancel`); the weight stays. `item` is a GitHub URL, `repo#number` or `owner/repo#number`. The role is read on every call, so a login that stopped being an operator is refused (403) even if its agent still lists the tools (a demoted operator keeps `queue_pr` only where a maintainer may queue). Audit rows are the handlers' own (`preapproval`, `fasttrack-add`, `fasttrack-weight`, `fasttrack-remove`), under the operator's login, with `via: "mcp"` in their details. Batch summaries, which can hold raw push and GitHub errors, go to operators and maintainers only, on the dashboard and in `list_merge_queue`.
- **Model calls.** In the `user-local` mode every token is offered `list_model_calls` (the Queue page's Model calls view through the same handler, `GET /api/model-queue`: each waiting call's id, items, step, tier, model, estimated cost, minutes waited, why it waits, its pick and whether the user may pick it, with the ready Task Runner counts and the user's picks; viewers get no picker logins, errors or repo-less calls). A login that is a maintainer or operator when the tools are listed is also offered `pick_model_call` and `unpick_model_call` (`id`), the dashboard's pick and unpick with the same refusals (403 for viewers and for ending another user's pick unless an operator, 409 with the reason a call cannot be picked); audited as `remote-pick` and `remote-unpick` with `via: "mcp"`.
- **Builds.** A login that is an operator or a maintainer when the tools are listed is offered `build_base` (`repo`: the current default-branch head, as the Main CI page shows it), `start_build` (`repo`, `base`, `patch?`, `steps`, `step_minutes?`, `display?`, `artifacts?`), `list_builds` (`repo?`, `all?`, `mine?`, `limit?`), `build_status` (`id`, `log_lines?`), `build_artifact` (`id`, `name`) and `cancel_build` (`id`); each call checks the role again, and a maintainer's call needs live write access to the repo (checked as for the queue tools; a status or cancel checks the build's repo). They let an operator's or maintainer's own tooling build on the registered build environments instead of on their machine (code: `src/build/mcp-builds.ts`). `base` must be a default-branch commit recorded in `main_ci`, and the task reads its CI gate there, so the caller's tree never chooses packages or env; `patch` (a unified diff, at most 1 MiB) turns the base into the caller's tree; a patch the worker would refuse (binary content, symlinks, paths outside the tree) is refused at once. The plan is the dependency fetch (the only step with network), then one offline step per command line (1 to 19, each run with `sh -c` in the repo root with `CARGO_NET_OFFLINE=true` after a `### line N` marker, so even a line that prints nothing shows in the log as running, 1 to 120 minutes each, default 60) that records its exit code as an artifact (`step-N.exit`) and always succeeds, so every line runs; a line that runs out of time ends the task. The task (step `mcp-build`, toolchain `rust-stable`, Linux) counts as PR code: no confidential environment and no warm-snapshot signer takes it, and it only reads the repo's warm build cache. It runs for any tracked repo, in the pipeline's scope or not. At most 8 are queued or running at once (the count and the insert are one write). The task records who started it (`build_tasks.started_by`). `build_status` gives the state, the environment, the queue position, the phase (`queued`, `starting`, `source`, `fetch deps`, `line N`, `finishing`), the elapsed time, each line's state (`ok`, `failed`, `timed out`, `running`, `ended`, `waiting`, `not run`), exit code and time, and the end of the log (`log_lines`, default 120, 0 for none), framed as untrusted. While a build runs, a line's exit code comes from its `step-N.exit` artifact, which a worker uploads after each step; the line the newest log output belongs to is `running`, earlier lines without an exit code yet are `ended` (a build pod uploads artifacts at the end), and later ones `waiting`. `list_builds` gives the same view of the builds in the repos the user may build, newest first: open ones by default, `all` adds ended ones, `mine` keeps the user's own, `limit` up to 50 (default 20). Screenshots: `display: true` adds `requires.display`, so only a worker that offers a display takes the build, and it gets the software Vulkan and GL drivers (lavapipe, llvmpipe) as screenshot tasks do; there is no window system, so the app renders to a file itself. `artifacts` (up to 19 globs relative to `/out`) is collected after the last line only, since a worker collects a step's artifacts after each step and the same glob on every line would return a file once per line; the worker's caps apply (PNG, JSON, JUnit XML or text, 50 MB each, 100 and 200 MB per task). `build_status` lists the returned files without the `step-N.exit` codes, and `build_artifact` returns one: a PNG as an MCP image (at most 3.75 MB), text and JSON as text framed as untrusted (cut at 60,000 characters). `format: "json"` makes `build_base`, `start_build`, `list_builds`, `build_status` and `build_artifact` answer with one JSON object (`build_status` adds `log` and `logTruncated`; `build_artifact` gives `{name, contentType, bytes, data}` with the bytes in base64, at most 15 MB), for scripts. The status and cancel tools reach only `mcp-build` tasks. `start_build` is audited as `mcp-build` with `via: "mcp"`, in the write that queues the task; a cancel is recorded on the task as any cancel is.
- **Workspaces.** While a kubernetes environment takes workspaces (enabled, not a warm writer, `workspaceSlots` above 0), a login that is an operator or a maintainer when the tools are listed is offered `workspace_open` (`repo`, `base?`, `patch?`, `env?`, `hours?` 1 to 24, default 8), `list_workspaces` (`repo?`, `all?`, `mine?`, `limit?`), `workspace_status`, `workspace_result` (`workspace`, `call`, `wait_sec?`), `workspace_diff`, `workspace_close`, and one `workspace_<tool>` per workspace tool (`shell`, `shell_status`, `shell_kill`, `read`, `write`, `edit`, `glob`, `grep`, `app_start`, `app_stop`, `screenshot`, `fetch_dependencies`; see [Workspace tools](#workspace-tools)) with the tool's own arguments plus `workspace` and `wait_sec`. The code is `src/build/agent-workspaces.ts`.
  - Who: the build tools' rule (operators, and maintainers with live write access to the repo), and only the workspace's owner or an operator; a maintainer's `list_workspaces` shows their own. At most 3 live workspaces per login.
  - Open: `base` (default the current head) must be a default-branch commit recorded in `main_ci`, so the CI gate the workspace reads is upstream's. The workspace row is `requested` with owner `agent:<login>` and the deadline `hours`; the launcher starts it when a slot is free and parks, resumes and ends it as any workspace (parked after 30 minutes without a call; the next call resumes it). `patch` (text, at most 1 MiB, refused at once when the worker's patch rules would refuse it) is queued as an `agent-setup` row, run as `git apply --whitespace=nowarn -` with the patch on stdin before any other call of the workspace; `workspace_status` gives `patch: none | queued | applied | failed: <git's output>`; while it failed, the workspace's other calls (all but `workspace_diff`) are refused, so nothing runs on a tree that is not the caller's: close it and open a new one.
  - Calls: each tool call is a `workspace_calls` row with `agent_login` set. The runner's agent server (`startAgentWorkspaces`, next to the pod launcher, with its leader fence) claims those rows and runs them on a `WorkspaceSession`, the code and per-workspace limits a model session's calls use (2,000 calls, 3 h of shell time, 300 images over the workspace's life). Rows without `agent_login` (a model session's, the CLI's) are never touched. The dashboard waits for the row's result up to `wait_sec` (default 660, at most 900; the HTTP reply sends a space every 15 s, so proxies keep it open); past it the answer names the call and `workspace_result` reads it. Images (`screenshot`, `read` of a picture) come back as MCP images. A runner that restarts hands a shell command the session started back to it and fails other running calls, whose outcome is unknown.
  - Diff and close: `workspace_diff` is an `agent-diff` row: the runner reads the workspace's diff against its base as an implementation does (untracked files included, `--binary`, at most 5 MiB), framed as untrusted for reading; the frame spaces out runs of three or more `<` or `>`, so the exact patch to apply is `format: "json"` (`{workspace, base, diff}`). `workspace_close` ends the workspace and refuses its queued calls. Opening and closing are audited as `mcp-workspace-open` (in the write that requests the workspace) and `mcp-workspace-close` with `via: "mcp"`.
- **Same rules as the dashboard.** The tools call the dashboard's own handlers as the token's user: repo visibility, the decision checks and audit rows are the same. `send_feedback` is the Feedback box (audit `via: "mcp"`; the stored pick or comment carries `via` too, and the item thread marks it "via agent"), so it is display-only until an operator answers or uses the pick; viewers get an error, and maintainers get 60 posts an hour per login, counted together with the dashboard's own feedback. A token has no GitHub token of its own: permission checks use the login's newest live dashboard session, and without one only a recent cached permission counts (a private repo is then hidden and a pick shows as `none`). An answer through `answer_decision` is the operator's answer, made through the same handler as the dashboard's: it needs write, maintain or admin on every repo the decision covers (checked live with the operator's dashboard session, so without a live session it is refused), the duplicate-group texts check and batch exceptions apply, it is audited as `answer` with `source: "dashboard"` and `via: "mcp"`, and the pipeline acts on it like any operator answer. `undo_answer` is the dashboard's Undo (audit `undo` with `via: "mcp"`). Nothing here approves a repo or changes settings, and only `cancel_queued` writes to GitHub itself (it closes the batch PR of a PR it takes out of a batch, as the dashboard's cancel does). A fix-up's result lands on GitHub as the contributor's own commit or suggestion, and the pipeline reviews the new head as usual.

## User-local inference

In the `user-local` inference mode, model calls do not run on this host. Each call is queued, and a maintainer's or operator's Task Runner (the `autocraft` command) claims it, runs the harness on that person's machine under their own Claude Code or Codex subscription, and submits the reply. The planner, gates, Jev calls, embeddings, GitHub writes and builds stay on the server. The code is `src/remote/` (wire format in `protocol.ts`) and `worker/autocraft.mjs` (the Task Runner, served by the dashboard at `/worker/autocraft.mjs`). The server admin CLI is `autocraft-server`; the MCP server name and the Task Runner command are both `autocraft`.

### Switching the mode

| How | What |
|---|---|
| Dashboard | **Inference** page (Settings): the mode, the accepted model families per tier and the lowest effort per tier |
| CLI | `autocraft-server inference` shows the mode; `autocraft-server inference user-local` or `autocraft-server inference server` sets it (audit `inference`) |
| API | `GET`/`PUT /api/settings/inference`, body `{mode?, models?, minEffort?}`; operators only |

- **Mode.** In `server` mode a claim returns no lease and asks the Task Runner to retry in 300 seconds. The Accounts page is hidden while the mode is `user-local`.
- **Accepted models.** `models` maps a tier (`top`, `mid`, `small`) to 1 to 10 lowercase model families. Defaults: `top` accepts `opus` and `astra` (Codex's top family; change it if your Codex catalogue differs), `mid` accepts `sonnet`, `small` accepts `haiku`. A Task Runner declares a model per tier; the server accepts the tier only when the model belongs to an accepted family, and refuses a reply from a model of another family (the call goes back to the queue). Changes are audited as `remote-models`.
- **Effort floor.** `minEffort` maps a tier to `low`, `medium`, `high`, `xhigh` or `max`, or to `null` to remove it. A Task Runner declares the highest effort it passes to its harness for each tier and gets a tier's calls only when that meets the floor. Codex stops at `xhigh`, so there `xhigh` meets a `max` floor. A Task Runner that declares no effort (an older one) meets no floor.

### Task Runner credentials

A Task Runner has its own credential, separate from MCP Connector tokens. It always runs model calls, and has two scopes that its owner sets on the Connect page:

- **Agent access** (`can_agent`): the credential also works on `/mcp`, with the tools a Connector token of the same login gets (inbox, decisions, feedback, the merge queue per role, and the task tools while one of the login's Task Runners reports in). The `autocraft` command uses it to call the tools from a shell.
- **Can answer decisions and approve merges** (`can_answer`): with Agent access, the answer tools (`answer_decision`, `undo_answer`, `queue_pr`, `cancel_queued`) are offered too. They still need answering to be available, the login to be an operator or a maintainer while maintainers settle decisions, and write permission on the repo at the time of the call.

| | MCP Connector token | Task Runner credential |
|---|---|---|
| Prefix | `acmcp_` | `acrun_` |
| Made by | The Connect page's MCP Connector block (the value is shown once) | The Task Runner itself, with `autocraft login` and an approval on the Connect page; no secret travels from the server |
| Valid for | 90 days (7 for an answering token) | 90 days, extended on every use, whatever its scopes |
| Limit | 5 per login | 5 per login |
| `/mcp` | Yes | With Agent access; otherwise 403 "this Task Runner has no agent access" |
| `/api/remote/*` (claims, status, leases) | 403 "MCP Connector tokens cannot run tasks" | Yes |
| Dashboard `/api/*` | Never (session cookie only) | Never |

Removing a login, or ending its sessions on the Access page, ends both kinds. Revoking a Task Runner (Connect page, or an operator on the Access page) deletes its credential: a lease it holds goes back to the queue without using an attempt, its next heartbeat gets 410, and its claims get 401. The Task Runner then logs that the credential was revoked or expired, asks for `autocraft login` and checks again every 10 minutes.

Device-style login:

1. `autocraft login <dashboard URL>` makes the credential on the machine and sends only its hash to the server, with the scopes it asks for: Agent access unless `--no-agent` is given, answering only with `--answer`. The server answers with a code (`BCDF-GHJK`, valid 10 minutes, single use) and a link (`<dashboard URL>/connect?runner=<code>`).
2. The Task Runner prints both and polls until the login is approved, denied or expired.
3. A maintainer or operator opens the link, or types the code on the Connect page. The card names the label, machine, platform, version and start time, and shows the requesting address next to the browser's address. When they differ, Approve stays disabled until "I started this on another machine" is ticked; the server refuses the approval without it (an IPv6 address counts by its /64). The ticks **Agent access** and **Can answer decisions and approve merges** start as the Task Runner asked; the second shows only while answering is available and the approver may answer. Approval stores the ticks as they are, adds the Task Runner to the list, marked new, and is audited.
4. The credential then works as it is. Each Task Runner in the list has the same two switches; changing them takes effect on the credential's next call, without a new login.

`autocraft login <dashboard URL> --no-wait` prints the code and link and exits; an agent shows the link to the user, then runs `autocraft login --wait` (at most 9 minutes, exit code 3 while pending). `autocraft login <dashboard URL> --stdin` stores a credential read from stdin, for example one from `autocraft-server remote token <login>`.

Rate limits: 10 logins started per 10 minutes and 5 pending per client address (an IPv6 address counts by its /64), 1000 pending overall; 30 polls a minute per credential; 10 failed code lookups per 10 minutes per login. The credential is stored in `credentials.json` (mode 0600) beside `config.json` in a 0700 directory, so a pasted config leaks nothing.

### Setting up a Task Runner

A Task Runner needs a maintainer or operator login on the dashboard. The Connect page lists the same steps with the server's address filled in. The page, "Connect your Agents", has two views for a user who has a Task Runner: Overview (My settings, the Task Runners, then the MCP Connector) and Setup guide (`/connect/setup`). A user with no Task Runner yet sees the setup guide above the MCP Connector.

Requirements: Node 22 or later, `git` and `tar`, a signed-in harness (`claude` or `codex`), and a sandbox tool: bubblewrap (`/usr/bin/bwrap`) on Linux and WSL, `sandbox-exec` on macOS. Other systems are refused.

1. Install the Task Runner and set up the machine:
   ```sh
   mkdir -p ~/.local/bin && curl -fsSL <dashboard URL>/worker/autocraft.mjs -o ~/.local/bin/autocraft && chmod +x ~/.local/bin/autocraft && ~/.local/bin/autocraft setup <dashboard URL>
   ```
   `setup` looks at what the machine lacks and, one item at a time, prints the problem and the command that fixes it, and runs the command only when you answer yes (see [setup](#setup)). It ends with `doctor`.
2. Log in: `setup` runs `autocraft login <dashboard URL>`; approve the code on the Connect page. The URL must be `https` (`http` only for localhost).
3. Choose how the harness signs in:

   | Command | Harness login |
   |---|---|
   | `autocraft harness claude --config-dir [<dir>]` | The login of a Claude config directory (default `$CLAUDE_CONFIG_DIR` or `~/.claude`), read before each call. Linux only. |
   | `autocraft harness claude --keychain` | Claude Code's own login from the macOS Keychain, read before each call and never refreshed by the Task Runner: use Claude Code now and then, or store a setup-token. macOS only. |
   | `claude setup-token`, then `autocraft harness claude` (token on stdin) | A long-lived token. It may not be allowed to read plan usage; the Task Runner then holds (see [Usage reserve](#usage-reserve-and-readiness)). |
   | `autocraft harness codex [--device-auth]` | Logs Codex in to the Task Runner's own `CODEX_HOME`, a login separate from `~/.codex`, so refreshes never invalidate your own session. `--device-auth` is for a machine without a browser. |

4. Models. Claude defaults to `opus`, `sonnet` and `haiku` for the three tiers. Codex has no defaults: add `"tiers": {"top": "...", "mid": "...", "small": "..."}` to `$XDG_CONFIG_HOME/autocraft-runner/config.json` (mode 0600; default `~/.config/autocraft-runner/config.json`). The config also takes `repos` (claim only calls on these repos), `claudeBin`, `codexBin` and `treeCacheGb` (the tree cache cap, default 20). `AUTOCRAFT_RUNNER_CLAUDE_BIN` and `AUTOCRAFT_RUNNER_CODEX_BIN` override the binaries.
5. Run `autocraft doctor`, then `autocraft work` in a terminal (Ctrl-C stops it), `autocraft run` for one call, or `autocraft service install [--parallel N]` to keep it running.

### setup

`autocraft setup [<dashboard URL>]` checks the machine and offers one fix at a time, in this order. Each offer prints the problem, what the fix does and the exact command, and asks `Run it now?`. A command that runs `sudo` or downloads and runs an installer asks `[y/N]`: only a typed `y` runs it, and an empty line is no. The others ask `[Y/n]`. Input typed before a question appears is discarded, so an answer typed ahead, or a line left over from the step before, never answers it. After each offer setup looks at the machine again, so a fix that made the next one unnecessary is not offered. Each item is offered once per run.

| Missing | Command offered |
|---|---|
| Windows or another system | None: install and run `autocraft` inside WSL |
| bubblewrap (Linux), `git`, `tar`, and `curl` and `bash` when Claude Code must be installed | The package manager's install, run with `sudo sh -c '…'` unless run as root: `apt-get update && apt-get install -y`, `dnf install -y`, `pacman -Sy --needed --noconfirm`, `zypper --non-interactive install` or `apk add`; `xcode-select --install` on macOS, also when the `git` found on `PATH` is, after following symlinks, the stub `/usr/bin/git` that macOS has without the developer tools (`xcode-select -p` fails) |
| A sandbox that does not start because AppArmor restricts unprivileged user namespaces (`/proc/sys/kernel/apparmor_restrict_unprivileged_userns` is 1, Ubuntu 23.10 and later) | Installs Ubuntu's `bwrap-userns-restrict` AppArmor profile as `/etc/apparmor.d/bwrap-userns-restrict` and loads it with `apparmor_parser -r`. It copies `/usr/share/apparmor/extra-profiles/bwrap-userns-restrict` when that exists (apparmor 4.x, package `apparmor-profiles`), else writes the same rules. The profile lets any program on the machine run `/usr/bin/bwrap` to create user namespaces; everything bwrap starts runs under the `unpriv_bwrap` profile, which denies every capability, so bwrap gives a sandbox but never a privileged namespace. Programs inside a call therefore cannot start a sandbox of their own. Setup writes a temporary file and hard-links it into place, so a profile that exists by then is never overwritten and a failed write leaves none; when loading fails, it removes only the profile it linked, so the next `setup` offers it again. When the file already exists, it offers `sudo apparmor_parser -r` on it; for another cause it only shows bubblewrap's error |
| `claude` on `PATH` | Claude Code's native installer (`bash -c "$(curl -fsSL https://claude.ai/install.sh)"`, into `~/.local/bin`, no sudo): the script is downloaded whole before bash runs it. It says so when it sees the snap `claude-code` or VS Code's own copy of Claude Code (`~/.vscode-server/extensions`): neither is a standalone binary at a fixed path, so neither can be mounted into the sandbox. For Codex it names the audited versions and installs nothing |
| A Claude login (none yet, or the chosen one no longer gives a token) | `claude` (the binary setup found, also outside `PATH`; with `CLAUDE_CONFIG_DIR` set when the runner reads another config directory), to sign in and `/exit`. When the runner has a stored setup-token, or a config directory on macOS (where Claude Code keeps its login in the Keychain), it offers `autocraft harness claude` instead, to paste a new token from `claude setup-token` |
| A harness login for the runner | `autocraft harness claude --config-dir` (Linux) or `--keychain` (macOS) when that login exists (on macOS setup checks that the Keychain item exists without reading it); `autocraft harness codex` for Codex. A setup-token is not offered: choose it yourself |
| A dashboard login, or a login to another dashboard than the URL setup was given | `autocraft login <dashboard URL>`, when setup was given the URL; it replaces the other login, and the offer says so |

To remove the AppArmor profile setup installed, unload it, then delete the file (newer Ubuntu releases ship this file in the `apparmor` package; leave theirs in place):

```sh
sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict
sudo rm /etc/apparmor.d/bwrap-userns-restrict
```

`--yes` runs every command without asking, the `sudo` and installer ones included. Without a terminal and without `--yes`, `setup` only lists the commands. When `~/.local/bin` is not on `PATH`, setup looks there too and, at the end, says how to add it to the shell profile (`export PATH="$HOME/.local/bin:$PATH"`).

### Moving a 1.2.0 runner

A 1.2.0 runner is installed as `autocraft-task`. Move it with:

```sh
autocraft-task update && autocraft-task migrate
```

With only `autocraft-task update`, the move happens at the next restart of the running `work` process or service; 1.2.0 keeps working meanwhile, because the server still accepts protocol 3. From 1.3.0 on, `update` runs the move itself.

The move (`autocraft migrate`, also run at the first start of 1.3.0, before the first claim, under a lock file) does this, and on a failure logs it, keeps the old setup running and retries at most daily:

| Step | Result |
|---|---|
| Directories | The files of `~/.config/autocraft-task` and `~/.cache/autocraft-task` move to `$XDG_CONFIG_HOME/autocraft-runner` and `$XDG_CACHE_HOME/autocraft-runner` (the directory itself is renamed when the target does not exist), with a symlink at the old path. It waits while another `work` process holds a slot. The old `agentToken` moves into `credentials.json`. |
| Binary | An installed `autocraft-task` becomes `autocraft`, with `autocraft-task` left as a symlink to it. A checkout (a `worker/autocraft-task.mjs` that is a shim) stays as it is. |
| Linux service | `autocraft-task.service` gets an `autocraft.service` with the same `work` arguments and environment. When the move runs inside the old unit, the old unit is disabled and removed and the new one starts; run by hand, the units switch only while the old service is idle, else at its next restart. |
| macOS service | The `autocraft` launchd agent is bootstrapped, then `autocraft-task` is booted out. |

`autocraft-task` stays as an alias for one release, and the server serves the same file at `/worker/autocraft-task.mjs` so that 1.2.0's `update` works. If the server has not been updated yet, the move waits and retries.

### Commands

`autocraft help` prints the commands in the groups below; `autocraft help --all` adds the task commands; `autocraft <group> --help` prints one group.

**Setup**

| Command | What it does |
|---|---|
| `login <dashboard URL> [--label X] [--no-wait] [--answer] [--no-agent]`, `login --wait`, `login <dashboard URL> --stdin` | Makes a credential and waits for its approval on the Connect page, or stores one read from stdin (see [Task Runner credentials](#task-runner-credentials)). `--answer` also asks to answer decisions and approve merges; `--no-agent` asks for no Agent access. |
| `harness claude\|codex ...` | Chooses the harness login (see [Setting up a Task Runner](#setting-up-a-task-runner)). |
| `setup [<dashboard URL>] [--yes]` | Installs what the machine lacks, asking first (see [setup](#setup)), then runs `doctor` and returns its exit code. |
| `doctor` | Checks Node, platform, sandbox (on macOS with the canary), `git` and `tar`, the harness binary, version and login, a harness start inside the sandbox, the server and the tiers. Exit code 1 when a check fails; it then names `autocraft setup`. |
| `update` | Downloads the server's current Task Runner over this file (checked with `node --check` first); restart `work` or the service afterwards. A version refusal names this command. `work` runs it by itself (see [Self-update](#self-update)). |
| `service install [--parallel N]` | Writes and starts a systemd user unit (Linux, `~/.config/systemd/user/autocraft.service`) or a launchd agent (macOS, `~/Library/LaunchAgents/autocraft.plist`) that runs `work` with these arguments and restarts it whenever it ends (systemd `Restart=always`, launchd `KeepAlive`). It keeps `PATH`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `CLAUDE_CONFIG_DIR` from the shell it ran in. The log: `journalctl --user -u autocraft -f` (Linux), `$XDG_CACHE_HOME/autocraft-runner/service.log` (macOS). On Linux, when lingering is off, the command prints a line that the service stops at logout and names `loginctl enable-linger`; `doctor` warns the same while a unit is installed. No root. |
| `service uninstall` / `service status` | Stops and removes the service; prints its state and where its log is. |

**Self-update**

`work` replaces its own file when the server serves a newer Task Runner. Every claim reply carries the served version (`currentHelper`); a refused claim (HTTP 409) or a lease whose `requiredHelper` is newer than the running version has the same effect. `work` then downloads the runner, checks it with `node --check`, stops claiming, lets running calls finish, renames the file into place, runs `migrate` and exits with code 0, logging `autocraft updated from X to Y; restarting`. The systemd unit (`Restart=always`) and the launchd agent (`KeepAlive`) start the new version about 30 seconds later. A `work` started in a terminal exits the same way and prints that it must be started again.

- A version that is not newer than the running one is never installed; the server is asked again after an hour. A failed download or check keeps the current file and retries after 5 minutes, doubling up to an hour.
- A file inside a git checkout (a `.git` directory in any parent) never updates itself. `work` logs once that an update is available, and the readiness stays `version-refused` while the server refuses the version; update such an install with git.
- Opt out with `"autoUpdate": false` in the runner's `config.json` or `autocraft work --no-auto-update` (add it to the service's arguments by reinstalling it with the flag in the unit). `autocraft update` still works by hand.
- `runner status` prints the last update (versions and time) and an update that is pending or was not applied.

**Runner**

| Command | What it does |
|---|---|
| `runner status` | Prints whether the Task Runner claims now, with plan usage, reserve, pause and hold. Exit code 0 only when `ready`. |
| `runner logs [-n N] [-f]` | Prints the last `N` lines (default 50) of the service's log, and follows it with `-f`: `journalctl --user -u autocraft` on Linux, `$XDG_CACHE_HOME/autocraft-runner/service.log` on macOS. |
| `runner pause` | Claims nothing until the plan window resets, whatever the usage. `runner resume` ends it. |
| `runner resume` | Ends a pause, a hold after a provider refusal, and a hold of `work` (a stopped run, failed calls). The usage reading still decides. |
| `runner reserve <5h> <weekly>` | Keeps more of each window free than the server's reserve (percent, 0 to 100). `runner reserve off` drops it. The server's reserve, which every Task Runner of the user follows, is set with `settings set --reserve`. |

**Server commands** call the server's MCP tools (`/mcp`) with the Task Runner's credential, so they need Agent access. Each command maps to one tool (`CLI_COMMANDS` in `worker/autocraft.mjs`): its positional words fill the tool's arguments in order, and options of the tool that the command does not name pass through as `--<argument>` (`--key value`, `--flag` / `--no-flag`, repeated or comma-separated lists, JSON for objects), typed by the tool's input schema. When the credential is not offered a command's tool, the command says why in one line. `--json` prints the raw result. Exit code 0 done, 1 the tool refused or failed, 2 a wrong command line.

| Command | Tool | What it does |
|---|---|---|
| `inbox [--repo R] [--kind K] [--limit N] [--cursor C]` | `list_inbox` | Open decisions, oldest first. |
| `inbox show <id>` | `get_inbox_item` | One decision in full. |
| `inbox feedback <id> --pick <key> --note "..."` | `send_feedback` | Your pick of one option (`option`) and/or a note (`text`); an operator answers. |
| `queue [--repo R] [--limit N] [--cursor C]` | `list_merge_queue` | The merge queue as on the Queue page. |
| `queue add <pr> [--weight N]` | `queue_pr` | Pre-approves a PR's merge and fast-tracks it (operators, and maintainers who answer decisions, with answering; only an operator's `--weight` counts). |
| `queue weight <item> <N>`, `queue weight <item> --remove` | `set_weight` | Sets an item's fast-track weight, or takes it off the list (operators). |
| `queue remove <pr>` | `cancel_queued` | Withdraws a PR's pre-approved merge (operators with answering). |
| `calls` | `list_model_calls` | The waiting model calls as on the Queue page's Model calls view (`user-local` mode). |
| `calls pick <id>`, `calls unpick <id>` | `pick_model_call`, `unpick_model_call` | "Run on my Task Runner" and its undo (maintainers and operators). |
| `calls mine` | `my_work` | Today's calls on your machine and your Task Runners. |
| `settings` | `my_settings` | Your reserve, repos, calls at once and interactive slots (maintainers and operators). |
| `settings set [--reserve <5h> <weekly>] [--max-calls N \| --no-max-calls] [--repos <a,b>\|all] [--interactive-slots N]` | `set_my_settings` | Changes them with the checks and audit rows of `PUT /api/me/settings`; `--reserve` takes whole percents from 0 to 90 for both windows. |
| `build [--repo R] [--all] [--mine] [--limit N]` | `list_builds` | Queued and running builds; `--all` adds ended ones (operators, and maintainers with write access). |
| `build base <repo>` | `build_base` | The default-branch commit a build starts from (operators, and maintainers with write access). |
| `build status <id> [--log-lines N]` | `build_status` | A build's state, each line's exit code and time, and the end of its log (operators, and maintainers with write access). |
| `build cancel <id>` | `cancel_build` | Stops a queued or running build (operators, and maintainers with write access). |
| `workspace [--repo R] [--all] [--mine] [--limit N]` | `list_workspaces` | Live agent workspaces (operators, and maintainers with write access, where a kubernetes environment takes workspaces). |
| `workspace open <repo> [--base SHA] [--hours N] [--env ID]` | `workspace_open` | Opens one without a patch. |
| `workspace status <id>`, `workspace diff <id>`, `workspace close <id>` | `workspace_status`, `workspace_diff`, `workspace_close` | Its state, its changes against the base, and its end. |
| `repos` | `list_repos` | Tracked repos with open decisions and fix-ups waiting. |
| `fixups [--repo R] [--limit N]` | `list_fixups` | PRs whose review fixes the pipeline could not apply. |
| `call [<tool> [args]]` | any | Raw access: alone it lists the tools the credential is offered; `call <tool> --help` prints a tool's description and arguments; a tool with one required text argument takes it bare. `call --guide` prints the server's instructions for an agent. |

`next_task`, `task_status`, `answer_decision`, `undo_answer`, `start_build`, `build_artifact`, `workspace_result` and the `workspace_<tool>` tools have no command (`MCP_ONLY`): the task tools tell an MCP agent to run the Task Runner's own commands, answering stays on the dashboard until it opens to agents, `start_build` takes a patch and a list of command lines, which an agent or a script sends better than a command line, `build_artifact` returns images, which a terminal does not show, and the workspace tools are an agent's working tools. `call` reaches them. A test (`test/autocraft-cli-layout.test.ts`) fails when a server tool has neither a command nor a place in `MCP_ONLY`.

**Task commands** are what the service and agents run; `help --all` lists them.

| Command | What it does |
|---|---|
| `work [--parallel N]` | Claims, runs and submits in a loop. `N` is 1 to 16, plus the fast lane for short calls and follow-ups (see [Who gets which call](#who-gets-which-call)); Codex runs one call at a time because its login refreshes in place. Ctrl-C, SIGTERM and SIGHUP stop running calls and give them back; a second signal quits at once. See [Task Runner process](#Task Runner-process). |
| `claim` | Claims one call and prints its lease id. |
| `run [--detach] [<lease>]` | Runs a claimed lease, or claims one and runs it. `--detach` starts the run in the background and prints the lease id. |
| `wait <lease>` | Waits for a detached run and prints its result. Returns after at most 9 minutes with exit code 3 while the run still goes; run it again. |
| `try <bundle.json> [--slot N]` | Runs a bundle from a file without a server and prints the reply (testing). |
| `mcp <server> <lease>` | Stdio-to-HTTP proxy for one of the lease's MCP servers. |
| `tool <server> <tool> [<json>] [<lease>]` | One tool call of a lease's server without MCP; prints the result, exit code 1 for an error result. |
| `migrate` | Moves a 1.2.0 install: directories, credential, binary and service (see [Moving a 1.2.0 runner](#moving-a-120-runner)). |
| `status`, `pause-until-reset`, `resume`, `config reserve ...` | The same as `runner status`, `runner pause`, `runner resume` and `runner reserve`. |

Task Runner state lives in `$XDG_CONFIG_HOME/autocraft-runner` (config, credential and lease secrets, 0600) and `$XDG_CACHE_HOME/autocraft-runner` (task directories, run logs, status file). The server's own `~/.config/autocraft` and `~/.cache/autocraft` are separate.

### Task Runner process

- **Retries.** The claim and every lease request (bundle, tarball, heartbeat, release, submit) are retried after a 408, 429 or 5xx, a network error, a request timeout or a cut-off reply, with exponential backoff from 1 to 30 seconds, jitter, and at least the server's `Retry-After`. A 410 or another 4xx is final. A claim is tried up to 5 times within 60 seconds with the same `requestId`, and after a failure in transit the next claim a minute later sends that `requestId` again, so a claim whose reply was lost gets its lease back. Lease requests are retried until 90 seconds before the lease's deadline on the server. A finished reply's submit is retried until the server answers it, up to 30 minutes past that deadline, since the server moves its deadlines past a dashboard outage; a reply whose submit failed is never sent as a failure. A tool call from inside the sandbox is retried for 3 minutes.
- **Heartbeats.** One every 30 seconds from the claim on, each retried until the next is due. The phase is `preparing` while the Task Runner fetches the bundle and sets up the files, and `running` from the harness's spawn, sent at once; the harness's timer starts there too. A 410 stops the run (`lost`).
- **Preparation.** Anything that fails before the harness spawns (bundle, files, git, tarball, disk, login) gives the call back without using an attempt. Preparation stops 12 minutes after the claim, so its release still reaches the server before the 15-minute cap.
- **Start.** `work` gives back, with a reason, every lease on the machine whose run process is dead (a crash, a kill, a reboot), and a lease claimed and never started once it is 5 minutes old.
- **Stop from a run.** A run that finds the Task Runner cannot take calls (Task Runner older than the server requires, sandbox missing, harness binary or login missing, harness version not audited) gives its call back and holds the Task Runner's claims; calls running in other slots finish. The hold shows as the readiness with the run's reason. A Task Runner that is too old holds until it is restarted; the others are checked again after 10 minutes. A login that cannot be read is read again after 2 seconds, and if still missing holds for 30 seconds only: Claude Code rewrites its credentials file in place, and a Keychain read can fail once.
- **Failed calls.** After a call fails or is given back, `work` waits 1, 2, 5 and then 10 minutes before its next claim, by the number of such calls in a row. After 5 in a row it reports `failing` with the last error until the wait ends; then it claims again if its usage and harness checks pass. A submitted call resets the count.
- **Disk.** One git fetch per bare repo at a time across the user's Task Runner processes (a lock file beside the repo). `git gc --auto` runs after a fetch at most once a day per repo. Bare repos unused for 7 days are removed. Cached trees unused for 3 days are removed, then the least recently used ones while the cache is over `treeCacheGb` (default 20 GB); a tree used in the last 6 hours stays, since a running call may have it mounted. Pruning runs before a call, at most every 10 minutes.
- **Memory.** Of the harness's output the Task Runner keeps only what it reads (the result, usage, session, and each tool use's stored arguments and result size) and the last 4,000 bytes of plain-text lines, which go into the error line with stderr.
- **macOS orphans.** The harness runs in its own process group, recorded beside its slot. A Task Runner that crashed leaves that file; the next process to take the slot stops the group first (only while its leader is gone or has the recorded start time).

### Sandbox

The harness never runs outside a sandbox that shows it only the call's own files.

- **Linux and WSL.** bubblewrap with every namespace unshared and the network shared, an empty home, the harness binary and every mount read-only, and a temporary work directory. The credential reaches the harness through its environment only, never through arguments.
- **macOS.** `sandbox-exec` with a per-slot profile: the harness reads its slot and the files of its install, writes its temporary directory and nothing else. `sandbox-exec` cannot remap paths, so each slot (up to 16, one per parallel call) has its own root, which the claim reports to the server.
- **Canary (macOS).** Before the first claim, and in `doctor`, the Task Runner runs a Node probe inside the profile, in a scratch slot of its own process. It must read its slot and write its temporary directory, and must fail to read a file planted in the home, list the home, `~/.ssh` and the Keychains, and write the home or the slot. A failed canary makes the Task Runner `sandbox-failed`, and it claims nothing; the canary runs again 10 minutes later.
- **Instruction files.** `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` and `.claude` directories are removed from every checkout before a run.

### Who gets which call

A call goes to a maintainer or operator whose cached GitHub permission is `write` or better on every repo the call names. The permission is read through the GitHub App's installation (the collaborator permission endpoint, cached 60 s per login and repo), so it needs no dashboard session; without an installed app for the repo's owner it comes from the login's live session. That also covers reading a private repo. In addition:

- Calls that name no repo, and `discord.*` calls, go to operators only.
- My repos. Each user may pick repos on the Connect page (`PUT /api/me/settings` with `{repos: [...]}`, tracked repo names, audit `my-repos`; empty means every repo). The picker lists the repos with the pipeline on where the user has write permission. Their Task Runners then take only calls whose repos are all picked, and a Task Runner's own `repos` list can narrow the picks but not widen them; calls that name no repo are not filtered. The per-repo Pipeline switch stays the operators' control: a picked repo with the pipeline off has no calls.
- My tasks. Each user may untick kinds of work on the Connect page (`PUT /api/me/settings` with `{tasks: [...]}`, the ticked ids of `taskChoices`, audit `my-tasks`). The tasks are the pipeline stages that make model calls (Duplicates, Classify, Priority, Decide, Review, Fix, Fix-up, Verify, Merge queue, Post-merge review) and Other, for every other step (the security scan and fixes, Discord, and a call whose step is not known). A call's task is the stage of its step: inside a job the job's step (so Merge queue covers the pre-merge Opus review), outside a job the step its prompt belongs to. Every task is ticked by default; the unticked ones are stored (`skip_tasks`), so a task added later starts ticked. Their Task Runners then take no call of an unticked task from the queue; a call the user picked and follow-ups of their runners' sessions run either way. The room, the taker test, the runner's job starts, the pools and the planner all ask about the step's task, so a repo whose takers have all unticked a task gets no job of that task's steps ("No Task Runner takes <task> tasks on <repo>"). With no task ticked, the runners take only picks and, as with Manual only, are no room.
- My tasks items. Next to the tasks each user picks which items their Task Runners take work on (`PUT /api/me/settings` with `{taskItems: "all" | "fast" | "mine"}`, audit `task-items`): All items (the default; nothing is stored), Fast-tracked (open items on the fast-track list: added with Queue items, the `@<app> queue` command or the list itself) or Fast-tracked by me (fast-tracked items the user added to the list, or queued with a pre-approved merge still live, which counts when another user fast-tracked the PR first). A call fits when any item it names fits, so a call about no item never fits a filtered user and a duplicate check of a chosen item against an older one does; a call the user picked and follow-ups of their runners' sessions run either way. Batched calls hold only items the same filtered users take, so a filtered runner is never handed an item it does not take in a batch, and a chosen item never waits in a batch only others take. The pools, the room and the taker test ask about each unit's items: a filtered user's runners count only for units on items that fit, the calls ahead that only other runners take use none of their slots, and a limited selection, in every job that cuts one, puts units that a ready filtered taker takes first. A duplicate set too large for one comparison call is compared in rounds whose calls name only some members, so only runners that take every item count for it. The runner's job starts and the planner ask before a job's items are known, so they count a filtered user's runners on the repos with an open item that fits, and the planner runs again when those repos change. With every Task Runner filtered, a pipeline-on repo with no item that fits has no taker, so the health check lists it under No taker. A call left waiting for its items shows "No ready Task Runner's user takes its items" in the model queue, and one withdrawn for them names the takers' choice: "no Task Runner can take calls on its items (My tasks: fast-tracked items only)", or "… only the items they fast-tracked".
- Security calls (`security.verify`, `security.fixcheck`) follow the same rules as other calls: write permission on the repo, and the author preference below.
- Author preference. For prompts that judge an item (reviews, the pre- and post-merge reviews, fix-up and fix-issue checks, decision prepares, conversation turns, verify compare, classify, duplicate compares and the two security prompts), an author or co-author of an item of the call (a `Co-authored-by` trailer counts) is passed over while another eligible Task Runner has asked for work in the last 45 seconds and could take it (tier, repos, role, write permission and not an author). With no such Task Runner, the author takes the call.
- A call bound to a login goes to that login's Task Runners alone: a maintainer's message to Opus in a conversation and its reference check (an operator's use the shared queue). Like a pick it goes by the role rules and write permission, not by My repos, My tasks or Manual only; the author preference does not apply; nobody may pick it; and its follow-up turns keep the binding. A Task Runner from 1.3.8 runs an own lane beside its slots (`Claim.ownLane`; not for a harness that runs one call at a time, nor past the macOS slots) that claims only such calls and their follow-ups, and its slots then leave them to that lane (their claims carry `withOwnLane`). An own-lane lease counts toward no slot and no Max calls at once, and the own lane takes calls at the limit too. A Task Runner without an own lane takes them in a slot, where they count like any call. The server says in its reply that it honoured `ownLane` (`ownLane: true`); a server without the lane ignores the field, and the Task Runner then stops that lane after the one call it may have got. It has a taker only while one of that login's Task Runners is ready and offers its tier, so it is withdrawn like any call without one, and the model queue shows it waiting for that login's Task Runner (busy, or not ready).
- A follow-up turn of a session is offered only to the login that holds the session, first to the Task Runner that names the session in its claim. It waits while the Task Runner that ran the parent call (its credential) runs a lease with a heartbeat in the last 90 seconds, up to 15 minutes; with no such lease it waits 2 minutes. Then the call is withdrawn and the caller starts a fresh one (or skips the turn).
- Max calls at once. Each user may set the most calls all their Task Runners hold leases on together (Connect page, My settings; `PUT /api/me/settings` with `{maxCalls: 1-64}` or `{maxCalls: null}` for no limit, audit `max-calls`). At the limit a claim returns no lease and the reason. A follow-up of the user's own sessions still gets a lease one past the limit, so a session can finish.
- Interactive slots. Each user sets how many interactive calls their Task Runners may hold together (Connect page, My settings; `PUT /api/me/settings` with `{interactiveSlots: 0-4}`, audit `interactive-slots`; default 1 for an operator, 0 otherwise). Interactive calls are the prompts in `INTERACTIVE_PROMPTS` (`src/remote/interactive-slots.ts`; today `discord.*`), which a person waits for and which are withdrawn after 8 seconds without a taker. A Task Runner from 1.4.0 runs interactive lanes (`Claim.interactiveLane`, excluding the other lanes): one claim loop at the start, and the reply to a lane claim carries the user's `interactiveSlots`, which starts the others. A claim from a slot or the fast lane is offered none, and an interactive-lane claim is offered only them. An older Task Runner has no lane and is offered interactive calls in its ordinary claims, counted as any call; a server without the lane leaves `interactiveSlots` out of the reply, and the lane stops after the one call it may have got. Their leases count toward no slot and no Max calls at once, and a user at their Interactive slots (or with 0) gets no lease and the reason, so the Discord bot falls back. Quota holds and cool-offs apply as to any claim.
- A call the login released is not offered to it again for 10 minutes.
- A claim from a Task Runner older than 1.2.0, or of a protocol version other than 3 or 4, is refused with 409. Version 3 has no `wait` and is answered at once.

**Claim order.** A claim takes the first call it may take in this order:

1. Follow-up turns of the sessions the Task Runner names in its claim, oldest first.
2. Calls bound to the user, oldest first, then the user's own picks that are live (see [Model call queue](#model-call-queue)), oldest pick first; the fast lane takes only those that fit it.
3. Gating calls: lint checks (`lint.*` prompts) and, for their own Task Runner, the fix turns, check reminders and resumes above.
4. The rest, without the live picks of other users, by step class (security, then fix-up, review and decide steps, then the others), fewest running calls of the repo, the item's priority raised by time waited, fewest running calls of the step, oldest. A small-tier call ranks one class higher for every 2 minutes it has waited, up to the top step class, so a long Opus backlog cannot hold it.

**Fast lane.** Beside its `--parallel N` slots the Task Runner runs one more slot, whose claims say `fastLane: true`. A fast-lane claim gets only follow-ups of the Task Runner's sessions, gating calls and small-tier calls, so these never wait for a long run to end. The Task Runner reports `slots` as N + 1. Codex, which runs one call at a time, has no fast lane; on macOS the fast lane holds a slot of its own, so `--parallel 16` has none.

### Leases

| Event | Rule |
|---|---|
| Claim | The caller's call is leased to the Task Runner; the agent run records the user, harness and the model the Task Runner declared for the tier. The reply carries a lease id and a lease secret. A claim repeated with the same `requestId` within 5 minutes gets the same reply, the same lease and secret included; the replies are kept in the dashboard process's memory only. After a dashboard restart a repeated claim returns the lease it took to the queue without using an attempt, and is answered afresh. |
| Heartbeat | The Task Runner sends one every 30 seconds from the claim on, with its phase (`preparing` or `running`) and latest progress line. The first `running` heartbeat starts the call's time limit. |
| Expiry | A lease ends when it has had no heartbeat for 2 minutes, is still preparing 15 minutes after the claim, or is still running 2 minutes after the call's time limit. The call goes back to the queue with its next attempt, or fails when the prompt's attempts are used up. |
| Dashboard outage | Task Runners reach the server only through the dashboard, which stamps every 5 seconds that it serves. A lease ends only while the stamp is fresh (at most 15 seconds old), and for lack of heartbeats only when the dashboard served for the whole 2 minutes. When the dashboard comes back after a gap, every lease's heartbeat, claim and run start move forward by the gap. |
| Release | A Task Runner that cannot prepare or start a call (version, platform, missing login, bundle or checkout errors, quota refusal) gives the lease back with a reason. The call returns to the queue without using an attempt and is not offered to that login for 10 minutes. |
| Submit | A failed reply (`ok: false`, error `helper: <error>`) or a reply from another model family than claimed sends the call back to the queue with its next attempt, not offered to that login for 10 minutes; it fails when the prompt's attempts are used up. A submit repeated after an accepted one is accepted again. |
| Refusal | A failed reply whose model's safety filter declined the request (`refused: true`, or the harness's own refusal text from an older Task Runner) uses no attempt and adds nothing to the login's cool-off. The call goes back to the queue once: for another Task Runner (another runner token) that offers its tier, else one tier lower (top to mid, the instance's first accepted family for it) on any Task Runner, and its agent run reads `refused by <model> on <login>'s Task Runner; retried on …`. A follow-up turn is not retried. A second refusal, or one with nowhere to retry, fails the call with `refused by the model's safety filter …`; the step stops its attempts with that error, and a pre-merge review records it as its try's error. |
| Ended lease | Every lease route answers 410 for a secret whose lease was submitted, failed, expired, released or sent back to the queue (the secret hashes are kept 24 hours), and 401 only for a secret never issued; a 410 does not count toward the failed-authentication limit. |
| Caller gone | A queued or leased call whose job stopped polling for 5 minutes fails. |
| No taker | A taker of a call is a Task Runner that reported `ready` in the last 6 minutes, whose user is not cooling off, and that may take the call: the role rules, write permission (only a non-write permission confirmed within 10 minutes leaves a user out) and My repos narrowed by the Task Runner's own list, and My tasks. Busy Task Runners count, and so do Manual only ones (their user may pick the call), though they are no room. Once a minute the dashboard marks each queued call with a live caller that has no taker; a call marked for 10 minutes is withdrawn ("no Task Runner can take calls on <repos>", or "… of the <task> task (My tasks)" when a taker of its repos has unticked its task, or "… on its items (My tasks: <the takers' item choice>)" when the takers of its repos and task take only other items). A taker that comes back clears the mark. Follow-up turns and calls with a pick that counts keep their own rules. The pool unit that made the call is skipped: no failure, no failure backoff and no attempt against its item; the job counts it as a skipped item, so the planner runs the step again. A job that the withdrawal ends finishes as done ("skipped: …"). Pools never start a unit with no taker, and the runner leaves a queued job of a step that calls Claude queued while its repo has no taker that takes the step's task; the room the runner and pools count is that of such takers too. The planner proposes no such job (the stage's status and the repo's items on the Next page read "No Task Runner takes <repo>", or "No Task Runner takes <task> tasks on <repo>" when the takers of the repo have unticked its task); one already queued, for example an operator's, stays queued with that reason in the Jobs list and on the job page, and holds neither a repo of `step_parallel` nor part of the daily limit. The planner runs again when the set of Task Runners or their repos changes. |
| Waiting | The runner leaves at most 12 hours of queue time out of a job's deadline and no-progress stop; a call still queued after that is withdrawn ("no Task Runner took the call in time") and the job stops. |

Ended calls are kept 24 hours for task status and follow-ups; the dashboard deletes older ones once a minute.

**Limits.** Per Task Runner token: 600 claims and 120 status reports a minute. Per lease: 120 bundle, heartbeat, release and submit requests a minute, and 300 tool calls. Failed authentications count against the client address (300 a minute, shared with `/mcp`). Beyond a limit the answer is 429 with `Retry-After`. When the database stays locked for 2 seconds, a Task Runner route answers 503 with `Retry-After: 5`.

**Cool-off.** Cool-off applies to a login, across all its Task Runners and tokens:

| Cause | Cool-off |
|---|---|
| Leases of the login end by expiry 3 times within 2 hours (each token counts at most once in 10 minutes and each call once in 2 hours; a lease that never had a heartbeat does not count, since its claim's reply was likely lost) | 6 hours |
| The login's Task Runners send 5 failed replies in a row within 30 minutes (an accepted reply ends the run) | 1 hour |

While it lasts, the login's claims return no lease, a reason and the end time, and its Task Runners report `cooled-off` (audit `remote-cooloff`). Revoking or replacing a token does not end it. An operator clears it with `autocraft-server remote cooloff clear <login>` (audit `remote-cooloff-clear`).

### Long polling

A claim that finds no call it may take is held open instead of answered empty. The Task Runner sends `wait: 25` (protocol 4); the server holds the request for up to 25 seconds, never past the end of a cool-off, and answers as soon as a call the Task Runner may take is queued. An empty reply after a hold has `retryAfter: 1`; other empty replies keep the usual retry interval. Task Runners on protocol 3 are answered at once.

- A held claim runs the same checks as any claim each time it is tried: cool-off, Max calls at once, tiers, repos, picks and Manual only. At a limit, the usual reason reply goes out at once.
- The server wakes held claims when a call is queued or changes state, one claim at a time in arrival order, and tries each claim again every 5 seconds and at its deadline. The deadline try records that the Task Runner is idle, so it still counts as idle for the planner's room and the author preference.
- A Task Runner that disconnects drops its held claim. A claim repeated with the same `requestId` while held joins the same wait. When the dashboard stops, held claims are answered empty with a short `retryAfter`.
- A reverse proxy in front of the dashboard must allow responses that take 30 seconds: set no response timeout under 35 seconds.

### CDN or web application firewall

A CDN or web application firewall in front of the dashboard should skip its content rules (managed rule sets, bot checks, challenges) for `/api/remote/*` and `/mcp`. Both carry authenticated machine traffic: model replies, progress lines and tool arguments, which content rules may take for an attack. Keep its rate limits above the request limits under Leases.

- **Encoded bodies.** Claim and status replies list `encodings: ["gzip+base64"]`. Task Runners from 1.3.1 on then send every POST body as `{"encoding": "gzip+base64", "body": "<base64 of the gzipped JSON>"}`, so content rules never see model text. The server accepts plain JSON too (1.2.0 and 1.3.0). The uncompressed body has the route's size limit (413 above it). Tool calls stay plain JSON: the harness's from inside the sandbox (`/mcp/task/*`, `autocraft tool`) and the agent commands' (`/mcp`).
- **Proxy blocks.** An HTML reply with a 4xx status other than 404 comes from the proxy, not the server. The Task Runner retries it like an outage (a reply until 30 minutes past the lease's deadline) and logs `blocked by a proxy in front of the server (HTTP 403, HTML reply)`; it never takes it for a revoked credential. If the block persists, the lease ends as lost, the call goes back to the queue, and it fails at its attempt limit; the same call lost again does not add to the login's cool-off.

### Model call queue

The Queue view (Model calls page, `/model-queue`; Reports hub) lists the queued model calls in `user-local` mode: the items a call names, the step, tier, model, estimated cost (median of the prompt's last 60 finished runs), the time waited and why it waits. The reasons are: picked by a user, waiting for the Task Runner that holds its session, no Task Runner ready for the tier, every ready Task Runner Manual only, every Task Runner that may take it busy, no ready Task Runner whose user may take calls on the repo, no ready Task Runner whose user takes the call's task, or the number of calls ahead (calls passed over for their repo or task do not count).

| Role | Sees |
|---|---|
| Viewer | Item, step, tier, estimated cost, wait and reason, whether a call is picked (not by whom), and the number of Manual only Task Runners. Hidden repos and calls that name no repo are left out. Never prompts, output, progress or errors. |
| Maintainer | Also who picked a call, which logins are Manual only, and the last attempt's error. |
| Operator | Also clears anyone's pick. |

**Run on my Task Runner.** A maintainer or operator can reserve a queued call for their own Task Runners.

| Rule | Detail |
|---|---|
| Who | `user-local` mode, not in a cool-off, at least one fresh Task Runner whose models cover the tier, a role that fits the call, and write permission on every repo of the call. My repos and My tasks do not limit picks. |
| What | Queued calls with a live caller. Not follow-up turns, not calls that judge the user's own items, not calls another user has picked. |
| How many | At most the user's Task Runner slots without the fast lane, and 8. |
| Expiry | A pick lasts `remote_pick_minutes` (default 15; 0 means no cap). It also stops counting when none of the user's Task Runners is fresh. The user can unpick; operators clear any pick. A call released by the user, or no longer open to them, loses its pick at the next claim. |
| Claim order | Follow-ups of the Task Runner's own sessions, then the user's live picks, oldest first, then the normal order without other users' live picks. |
| Limits | Picks count toward Max calls at once, cool-offs, the release skip and attempts. Draining the pipeline leaves picks alone. A withdrawn call loses its pick. |

Operators set the cap with `autocraft-server pipeline pick-minutes [<minutes>]`, which shows it without an argument (audit `remote-pick-minutes`). A pick is a wait on a person, registered in the pipeline's waits.

**Manual only.** The Manual only switch (Connect page, My settings; `PUT /api/me/settings` with `{manualOnly}`, audit `manual-only`) makes the user's Task Runners take only their own picks and follow-ups of their own sessions. Their slots do not count in the planner's room, and `remote-starved` does not count them as ready. When every ready Task Runner is Manual only, unpicked calls wait with no fallback; the 12-hour queue cap still withdraws them, and the `remote-manual` health check warns after 10 minutes. Manual only Task Runners count as takers (No taker above), so such calls are not withdrawn for lack of one.

**Private on the Live board.** The switch (Connect page, My settings; `PUT /api/me/settings` with `{runnerPrivate}`, audit `runner-private`) keeps the user's Task Runners off the Live board's worker view for everyone else: their calls show on one "Private Task Runner" row, with no login, label, slots or models. It changes nothing about which calls the runners take.

### Test time scale

`AUTOCRAFT_REMOTE_TIME_SCALE` (a number from 0.01 to 1; unset means 1) is for the load rig (`scripts/loadtest`) only. When set below 1, the dashboard, the job processes and the Task Runners multiply every user-local time window by it: lease and heartbeat windows, the sticky follow-up wait, caller and status freshness, the liveness stamp, cool-off and drop windows, claim retry intervals, the Task Runner's heartbeat, retry, outage and failure-backoff times. Protocol constants keep their production values; the scale applies where they are used. Every process of one instance (dashboard, job processes, Task Runners) must run with the same value. The dashboard logs a warning at start when the variable is set and refuses to start when it is outside 0.01 to 1. Never set it in production.

### Usage reserve and readiness

Each maintainer and operator sets their own reserve on the Connect page: `GET`/`PUT /api/me/settings` with `{reserve: {fiveHour, weekly}}` (any of `reserve`, `repos` and `maxCalls`; the reply adds `repoChoices`), whole percents from 0 to 90, default 20. A viewer gets 403; a change is audited as `usage-reserve`. Every claim and status reply carries it.

- Before each claim the Task Runner reads its harness's plan usage and claims only while every 5-hour and weekly window keeps more than the reserve free. Claude: Claude Code's `GET /api/oauth/usage` with the Task Runner's Claude login, no model call. Codex: `account/rateLimits/read` from `codex app-server` with the Task Runner's own `CODEX_HOME`.
- A local `runner reserve` can only raise the server's reserve.
- One usage read runs at a time per machine: the slots of a process share one request, and processes share a lock file and the cached reading in the Task Runner's cache directory. A reading under a minute old is reused. A failed or refused read is shared for 30 seconds at most, or for the provider's `Retry-After` (up to an hour), before the provider is asked again.
- When a read fails or is refused, the last good reading keeps counting for up to 15 minutes, marked as an earlier reading, while every window has at least 10 points more free than the reserve. Otherwise, and for a missing, unparseable or stale (over 5 minutes) reading or a window kind the Task Runner does not know, the Task Runner holds. A held Task Runner reads again about every 45 seconds, 20% more or less at random so slots do not wake together.
- A call runs only when it ends, by its own timeout plus a minute, before the Claude login's refresh point 4 minutes before the login ends: no call holds the old token while the login is refreshed. Claims name the longest timeout that still fits (`maxTimeoutSeconds`, after a minute kept for preparation), counted from the claim's arrival, so the Task Runner stays `ready` and takes shorter calls up to the refresh point. A claim that passed over a longer call does not count as an idle helper's (other runners do not give way to it), and its empty reply says why. A call whose login no longer fits once its files are ready goes back without a hold and does not count toward `failing`. When not even the shortest call (2 minutes) fits, it reports `login-refresh` until the refresh point. Claude Code refreshes a login only in its last 5 minutes, so 4 minutes before the end the Task Runner runs the user's own `claude` once outside the sandbox (a one-word Haiku request with no tools, settings, hooks, MCP servers or session file, in an empty folder) with the login's config directory, or the default Keychain item on macOS, and Claude Code refreshes it under its own lock. The Task Runner never refreshes the login itself. A failed try is repeated every 90 seconds and reports `harness-missing`. A setup-token, or a Keychain item of another config directory, gets `harness-missing` with "run claude to refresh it" instead.
- A run the provider refuses for its limit goes back to the queue without using an attempt. The Task Runner holds until the reset the provider named (at most 7 days). A clock time without a time zone holds until a later reading shows headroom.

The Task Runner reports its readiness to `POST /api/remote/status` on every change and at least every 5 minutes, and keeps it in a 0600 status file in its cache directory. Each report also carries its `slots` (the `--parallel` slots and the fast lane), how many are `busy`, and its last error (a server request that failed after its retries, or a failed call's reason; a later success of the same kind clears it); the Connect page shows them per Task Runner. A report is retried up to 4 times within a minute. The Task Runner logs the first server failure and the recovery, one line each.

| Readiness | Meaning |
|---|---|
| `ready` | The Task Runner claims. |
| `quota-held` | A window is at or below the reserve, its usage could not be read, or the provider refused a run. |
| `paused` | The user ran `runner pause`. |
| `cooled-off` | The server gives the login no calls after repeated lost leases or failed replies. |
| `sandbox-failed` | The sandbox check or canary failed. |
| `version-refused` | The server refused the Task Runner's version. `work` updates itself unless that is off (see [Self-update](#self-update)). |
| `harness-missing` | The harness or its login is missing, no model is set for any tier, the harness version is not audited (Codex), or the Claude login expires soon and the Task Runner cannot have it refreshed. |
| `failing` | The Task Runner's last 5 calls failed or were given back in a row; it claims again at the time shown if its checks pass. |
| `login-refresh` | No call fits before the Claude login's refresh point, the time shown; the Task Runner claims again once claude has refreshed the login. A server that does not know it gets `harness-missing` with the same reason. |

The planner's room is the free slots of the Task Runners whose last status is `ready` and at most 6 minutes old and that are active (their last claim found nothing within 45 seconds, or a lease of theirs heartbeat within 90 seconds): each such Task Runner's reported slots less the leases its token holds, without the fast lane (taken to be present when a Task Runner reports 2 or more slots), since the planner does not know whether its next calls are small-tier or gating, for each user at most what their Max calls at once leaves. Room is counted for the repos the caller's next call names (a job's repo, or the repos of the next item or batch of a job that spans repos): only Task Runners that may take such a call count, by the same rules as claims apart from authorship and picks. Their user fits the role rules (a call that names no repo needs an operator), takes calls on every repo the call names (My repos, narrowed by the Task Runner's own list as of its last idle claim), and may write to it: only a non-write permission confirmed within the last 10 minutes leaves a user out, so a repo no claim has looked at lately still gets calls (the claim checks the permission itself). The queued calls that rank at or above the caller's class in the claim order and that one of those Task Runners may take come first. A queued call nobody's Task Runner may take therefore holds no room from other repos, and one user's slots do not start jobs on repos only another user serves. The runner asks the same room before it starts a job, for the job's repo (a job without a repo param counts every Task Runner); a job whose repo has no taker (see No taker below: a ready Task Runner outside a cool-off that may take it, busy or Manual only included) stays queued. Inside a job, the next item or batch to start is the first in order whose repos have room, so an item without room does not hold back later ones. When none has room and none of the job's calls runs, the first item that a connected, ready Task Runner may take starts anyway; an item no Task Runner may take never starts, and once only such items are left the job ends without them, to be picked again on a later pass. `GET /api/runners` and `my_work` list the user's own Task Runners with their last status. The `remote-Task Runners` live topic follows statuses and leases.

### Per-call tools

A call's bundle lists the servers it may use: `items` (search and read the synced items), `reference` (the repo's reference documentation, where one exists), `build` (the `check` build tool) and `work` (the tools of a session's workspace pod; Claude Code reserves the name `workspace`). Each is served only while the call's lease is live and only to a call whose bundle lists it.

- **HTTP routes.** `POST /api/remote/tool/<server>/<tool>` with the lease secret as bearer token and the tool's arguments as JSON body. The reply is an MCP `tools/call` result: a text entry, then any images (`{"type": "image", "data": <base64>, "mimeType": ...}`, protocol 5). A long call (`check`, workspace tools) sends whitespace before the JSON while it runs. `autocraft tool` prints the text and a line counting the images it cannot show.
- **MCP.** `POST /mcp/task/<server>` is a Streamable HTTP MCP server with only that server's tools. Claude gets it through the bundle's MCP config. Codex gets it through its configuration. An agent can use `autocraft mcp` or `autocraft tool` instead.
- **Reference cap.** One lease may read 60 reference passages in all (`reference_search` and `reference_around` together); past that, results are cut with a note.
- **Reference index.** `reference_search` reads the repo's search index as built; a repo without one returns no passages. `autocraft-server reference import` builds it, and `autocraft-server reference index <repo>` builds or refreshes it (the dashboard never builds one: embedding a manual takes minutes of CPU). Searches keep the vectors of up to 4 repos in memory, score them in a worker thread (reloaded when the index file changes) and run at most 4 at a time.
- **Check relay.** `check` runs in the job process that waits for the call, which keeps the call's count, time limit and run set. The dashboard queues the request and polls for the result; a request still waiting when the lease ends is refused.
- **Workspace relay.** A workspace session's call is bound to its workspace (`workspaces.remote_call_id`). Each tool call is a `workspace_calls` row: the dashboard queues it under the lease's run with its arguments whole, and the job process waiting for the call claims it and runs it on its session (several at once), which stores the result on the row. The row keeps the arguments cut to their record size once the job has claimed it, and a delivered result's images as type, size and SHA-256 only. After a runner restart the resumed job hands the rows still running that have a call number (shell, app_start, screenshot, fetch_dependencies) back to the session, which picks up the command or app it started instead of running it again; other rows left running are failed, since their outcome is unknown. On Postgres each side wakes the other with `NOTIFY` (channels `workspace_call` and `workspace_reply`) on a listening connection of its own, with a 10-second poll behind it; until that connection listens (it opens in the background, 5-second connect limit) and while it is down, and on SQLite, both poll every 3 seconds. The listening connection needs a direct or session-mode connection string: a transaction-mode pooler port drops `LISTEN` between statements, and the relay then waits for its polls. A workspace call is leased only to the claude harness, and the Task Runner never sends a workspace tool call again once the request may have reached the server (`autocraft tool` and `autocraft mcp` report the cut-off; the model looks with `shell_status`). A call still queued when the lease ends, or when the job's remote call ends, is refused; one already running finishes in the workspace and keeps its result on the row; the error names the call id for `shell_status`. A workspace call's body may be up to 12 MiB (other tools: 2 MiB).
- **Checkouts.** Public repos are fetched by the Task Runner from GitHub at the call's commit. Private repos and workspace entries come from `GET /api/remote/tarball?repo=&sha=` with the lease secret: 20 requests a minute per lease, at most 4 `git archive` at once, and each archive is cached on disk per repo and commit (2 GB in all, least recently used removed first) in `archives/` beside the diff cache.

### Task tools for an agent

A Connector token is also offered `next_task`, `task_status` and `my_work` on the MCP server (`POST /mcp`) while the mode is `user-local` and its login has a fresh Task Runner; in `server` mode they are not listed. `next_task` (`harness?`, `tiers?`) counts the queued calls the login's Task Runners may claim, with the same filters as a claim (accepted tiers, write permission on every repo, no judging of the login's own items), without leasing any. It returns the loop for the agent to run (`autocraft run --detach`, then `autocraft wait <lease>`, repeat) and never a lease secret. `task_status` (`lease`: the id the Task Runner printed) gives the state and error of a call the login holds or held; another login's call answers 404. `my_work` lists today's (UTC) model calls that ran for the login with prompt, items, state, tokens and cost. The instructions tell the agent never to read or change the Task Runner's bundle or reply files. `next_task` says when the user's Task Runner is held.

### What is recorded

Each call is one agent run, shown on the Agents page and the item timeline. A user-local run records the user, the harness, the model the Task Runner reported (a full id, which may differ from the alias claimed), tokens (input, output, cache read and write, per model when subagents ran), the harness's cost at list price when it reports one, turns, and every tool use (name, arguments, result size, timing). No Claude account is recorded. Progress lines from the Task Runner show on running calls.

### Health check

The `remote-calls` check (see [Health checks](#health-checks)) warns when a model call has waited over 10 minutes and no Task Runner has claimed any call in that time. The `remote-manual` check warns when a model call has waited over 10 minutes and every ready Task Runner is Manual only (it links to the model call queue). The `remote-starved-<tier>` checks warn when a Task Runner is ready but the oldest queued call of a tier has waited longer than 30 (top), 20 (mid) or 5 (small) minutes. The `remote-no-taker` check warns when a repo with the pipeline on has had no taker (see No taker above) for over 10 minutes, whether or not a call of it is queued; it names the repos and links to the model call queue.

### Codex versions and guards

Codex's own sandbox does not keep its shell tool away from its login on Linux, so the Task Runner turns the shell off, with browser, computer use, apps, plugins, hooks, image generation, subagents and web search, and gives the model the Task Runner's read-only file tools instead. It binds a separate `CODEX_HOME`, runs one call at a time, removes `AGENTS.md`, `AGENTS.override.md`, `.env` and `config.toml` from that home before each run, and passes no user config.

- **Version allowlist.** Only Codex versions listed in `CODEX_AUDITED` in the Task Runner (now `0.170.x`) run calls. Any other version is refused: `doctor` fails, the Task Runner reports `version-refused` and releases calls it claimed.
- **Stream guard.** The run stops at the first tool item in Codex's JSON stream that is not an MCP call to the call's own servers or the Task Runner's file tools.
- **Rollout check.** After the run, the thread's rollout file must hold no tool call except those MCP tools and `view_image`. A missing rollout fails the call. When either guard trips, the reply is not submitted.

## Pipeline runner

`autocraft-server runner serve` is the only process that runs pipeline steps (how the parts fit together: [docs/pipeline.md](docs/pipeline.md#architecture)). It polls the `jobs` table every 2 seconds, runs each job in a child process (`autocraft-server runner exec <id>`) with its output in a log file, stops jobs whose cancel was requested, and, while the pipeline is On, queues the jobs the stages need (see [docs/pipeline.md](docs/pipeline.md#on-and-off)). Every 20 seconds it also refreshes the flowchart counts (`flow_summary`) of repos whose data changed. On start it puts jobs that an earlier runner left running back in the queue to resume (see [Restarts and resumed jobs](#restarts-and-resumed-jobs)). A lock file keeps a second runner on the same host from starting; on Postgres, a second copy elsewhere waits as a standby (see [Two replicas](#two-replicas)).

It reads the same variables as the CLI (`AUTOCRAFT_DB` and the rest), plus:

| Variable | Meaning |
|---|---|
| `AUTOCRAFT_RUNNER_LOGS` | Directory of the per-job log files. Default `~/.cache/autocraft-logs/jobs`. The runner also copies the last 256 KiB of each job's log into the database (`job_log_chunks`, scrubbed, every 5 seconds while the job runs and once at its end) and keeps those copies 90 days. The dashboard reads a job's log from the path recorded in its row when it can, and otherwise from the database, so a dashboard on another disk shows logs up to 5 seconds behind. |
| `AUTOCRAFT_RUNNER_JOBS` | Most jobs running at once. Default 32. A job whose step calls Claude also waits for a free account slot before it starts. Jobs of one step run together only for different repos, within the `step_parallel` setting (`autocraft-server pipeline parallel [N|none]`, default 1). |
| `AUTOCRAFT_RUNNER_POLL_MS` | Poll interval. Default 2000. |
| `AUTOCRAFT_CALL_IDLE_MIN` | Minutes a Claude call may produce no output (no assistant text, tool use, tool result or progress line) before its process group is stopped (SIGTERM, then SIGKILL after 10 s) and the call fails with `no output for <n> min; stopped`. Default 15. Time spent inside a pending build-tool call (it waits on a worker, up to 45 minutes in all) does not count. |
| `AUTOCRAFT_LOCK_DIR` | Directory of the lock file, shared with `sync`. Default `~/.cache/autocraft-logs`. |
| `AUTOCRAFT_EXTRA_STEPS` | A module exporting `steps: StepDef[]` that is added to the step list, for tests and development (`test/runner-steps.ts` has fake steps). Set it for the dashboard and the runner alike, or not at all. |

The classify steps call `jev` and `claude`, so the runner's `PATH` must reach them. Where `jev` is not installed (containers), set `AUTOCRAFT_JEV_CLOUDFLARE_ACCOUNT` and `AUTOCRAFT_JEV_CLOUDFLARE_TOKEN_FILE` (a mode 0600 file holding a Cloudflare API token) to send every Jev call to Cloudflare Workers AI instead; `AUTOCRAFT_JEV_CLOUDFLARE_MODEL` overrides the model (default `typesafe/jev-1.14.0`). A 401 or 403 from Cloudflare, or an unreadable token file, records the same account outage as a rejected key, and a 402 (Cloudflare balance ran out) records it with the reason "out of credit", so calls fall back to Haiku until a Jev call succeeds again; 429, 5xx and network errors fail only that call.

To run it as a systemd user service, fill in the placeholders of `deploy/craft-runner.service`, copy it to `~/.config/systemd/user/`, and run `systemctl --user daemon-reload && systemctl --user enable --now craft-runner`. Stopping the service stops running jobs; they resume when the runner starts again.

From a shell: `autocraft-server pipeline on [--if-draining]|off|drain|status` flips the switch and `pipeline limit <step> --per-day N|none` sets a stage's daily limit (both recorded as `cli`). `autocraft-server runner steps` lists steps and their params, `runner enqueue <step> [--<param> <value> ...]` queues a job by hand for debugging (recorded as `cli`), `runner jobs [--state S]` lists jobs, `runner cancel <id>` cancels one.

### Build environments and the worker API

The runner also serves the worker API on its own listener, for workers that run untrusted code (concept and trust rules: [docs/pipeline.md](docs/pipeline.md#build-environments-and-tasks)). It is separate from the dashboard; expose it to remote workers only behind TLS (for example a tailnet-only proxy).

| Variable | Meaning |
|---|---|
| `AUTOCRAFT_WORKER_LISTEN` | `host:port` of the worker API. Default `127.0.0.1:8981`. If it cannot listen, the runner logs the error and carries on. |
| `AUTOCRAFT_ARTIFACT_DIR` | Where task artifacts are stored. Default `artifacts` beside the database. The runner writes it; the dashboard reads it directly, or through the runner with `AUTOCRAFT_RUNNER_URL`. |

Every call carries `Authorization: Bearer <worker key>`, which identifies the environment and refreshes its heartbeat. JSON bodies are sent as `application/json`.

| Call | Body | Answer |
|---|---|---|
| `POST /worker/hello` | `{ version, capabilities, slots }` | `{ envId, label, slots }` (slots capped by the operator's setting) |
| `POST /worker/claim` | `{ free, pausedReason }` | `{ tasks: [{ id, repo, headSha, baseSha, requires, plan, sourceUrl }], cancel: [ids] }` |
| `POST /worker/tasks/:id/start` | none | `{ cancel }` |
| `POST /worker/tasks/:id/log` | `{ step, chunk }`, chunk at most 64 KB | `{ truncated }` |
| `PUT /worker/tasks/:id/artifacts/:name` | raw bytes, at most 50 MB; the name is 1 to 100 of letters, digits, `.`, `_`, `-` | `{ bytes, contentType }` |
| `POST /worker/tasks/:id/finish` | `{ results: [{ step, exitCode, durationMs, timedOut, peakMemBytes?, oomKilled? }], summary }` | `{ state }`; retries return the same answer |
| `POST /worker/tasks/:id/heartbeat` | none (every 15 s while running) | `{ cancel }` |
| `GET /worker/pod/task` | none; build pod keys only | `{ id, repo, headSha, baseSha, sourceUrl, patch?, steps: [{ name, artifacts }] }` |

A build pod key (`cwp_<task>_…`, see [Build pods](#build-pods)) may call only `GET /worker/pod/task` and the artifact upload of its own task; anything else is 403. `claim` with `free: 0` is allowed and refreshes the heartbeat and the paused reason. The task is `done` when every step exited 0 without a timeout, otherwise `failed` (empty results too). Errors are `{ "error": text }` with status 400 (bad body), 401 (key), 409 (the task is not running on this environment), 413 (size cap), 415 (artifact type), 429 (rate limit; `Retry-After`).

Operators manage environments on the Build environments page (`/envs`) or from a shell (recorded as `cli`). A worker key is written to a file with mode 0600 and printed only with `--print`:

```
autocraft-server envs list
autocraft-server envs add <id> --label TEXT --kind local-sandbox|remote --slots N [--confidential yes|no] (--out FILE | --print)
autocraft-server envs set <id> [--label TEXT] [--enabled yes|no] [--slots N] [--confidential yes|no]
autocraft-server envs rotate-key <id> (--out FILE | --print)
autocraft-server tasks list [--state S] [--env ID] [--repo NAME] [--limit N]
autocraft-server tasks show <id>
autocraft-server tasks cancel <id>
autocraft-server tasks mem [--days N]
autocraft-server tasks enqueue-test --env-requires linux --repo NAME --sha SHA
```

**Confidential environments.** The build tasks of a security fix (its rounds and its model's checks) and of a scan test hold an undisclosed fix or test. Only an environment an operator marked confidential (the Confidential box on the Build environments page, or `--confidential yes`) takes them; the worker cannot report itself as one. A confidential environment takes no task that builds PR code (PR builds, integration batches, and every task for a PR or issue). A confidential environment is ready from its worker's first call after the flag, or the environment, was turned on; label, slot and key changes do not affect it. Until one is ready, a security fix waits before its model call (the finding's note reads "Waiting for a confidential build environment."; it continues on its own once one is ready), private tasks stay queued with the same text, the `confidential-env` health check warns, and the 4-hour build limit of a round or scan test starts only once one is ready. Run a confidential environment on its own host and user, apart from the workers that build PRs.

`tasks mem` prints, per repo and step name, the number of steps with a memory measurement, their median and maximum peak memory in GB and the number killed for running out of memory (default: tasks that ended in the last 30 days). Use it to size build nodes.

`tasks enqueue-test` queues a harmless smoke test for a tracked public repo (`uname -a; nproc; free -g` with no network, then `cargo --version`).

### Claude accounts

Claude calls run under accounts that an operator enabled. Which accounts exist on a machine comes from files outside the repository, named by environment variables that the runner, the dashboard and the CLI all read:

| Variable | Meaning |
|---|---|
| `AUTOCRAFT_ACCOUNTS` | A JSON file `[{ "id": "b", "configDir": "/path/to/claude-config-b" }]`. `id` is a short key (lowercase letters, digits, `_`, `-`); `configDir` becomes `CLAUDE_CONFIG_DIR` of the `claude` child process of calls made on that account. Directories never appear in the API, the logs or the UI. |
| `AUTOCRAFT_USAGE_DIR` | A directory with one file per account id, `<id>.json`: `{ "written_at": <unix s>, "rate_limits": { "five_hour": { "used_percentage": n, "resets_at": <unix s> }, "seven_day": { ... } } }`. Only that file is read. |
| `AUTOCRAFT_ACCOUNTS_ROOT` | Directory for the config directories of accounts added on the Accounts page (`<root>/<id>`, mode 0700). Without it, accounts can only come from the file. |
| `AUTOCRAFT_CLAUDE_BIN` | The `claude` command used for sign-in, status and usage (default: `claude` on the PATH). |

Example: `AUTOCRAFT_ACCOUNTS=/path/to/accounts.json`, `AUTOCRAFT_USAGE_DIR=/path/to/usage`, `AUTOCRAFT_ACCOUNTS_ROOT=/path/to/accounts`. With `AUTOCRAFT_RUNNER_URL` set on the dashboard, only the runner needs these.

Each account in the file gets a row (disabled, labelled with its id) the first time anything lists accounts. Operators set the label, the switch and the number of calls at once on the Accounts page or with `autocraft-server accounts list` and `autocraft-server accounts set <id> [--label X] [--enabled yes|no] [--max-concurrent N]` (1 to 100; recorded as `cli`). Jev has no accounts; its calls at once are the `jev_parallel` setting (default 4), changed with `autocraft-server accounts jev [N]`. Claude calls in flight are limited only by the accounts' free slots; waiting calls take freed slots by priority class (security, then the path to merge, then the rest). An operator can also give an account a long-lived token (*Long-lived token* on the Accounts page, stored as `oauth-token` in the account's config directory, mode 0600): calls on that account use it instead of the login's short-lived token, so sandboxed calls never wait for a token refresh. Allocation and pauses are described in [docs/pipeline.md](docs/pipeline.md#claude-accounts-and-agent-runs).

### Adding a step

A step is one entry in `STEPS` in `src/runner/steps.ts`:

```ts
{
  name: "opus-review",
  title: "Review pull requests",
  description: "Opus reviews, one pull request per call, the wanted pull requests of one repo that have no review at their current head. After a new push it reads only the changes since the head it reviewed before.",
  stage: 5,                      // docs/pipeline.md stage
  requires: "operator",
  // exclusive: "name",         // optional mutex for steps on shared run tables; otherwise one job per step and repo
  models: ["opus"],
  params: [
    { name: "repo", label: "Repo", kind: "repo", required: true },
    { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 5 },
  ],
  run: async (ctx) => {
    const { runOpusReview } = await import("../review/opus.ts");
    const r = await runOpusReview(ctx.db, { repo: String(ctx.params.repo), limit: Number(ctx.params.limit), onHandled: ctx.handled }, ctx.log);
    return `${r.repo}: reviewed ${r.reviewed} of ${r.candidates} candidates`;
  },
}
```

A step lists the models it calls in `models` (a list, or a function of the params, as `decide` does), so the Pipeline page shows them before any call is made. Model calls go through `askClaude` and `askJev` in `src/classify/run.ts`, which allocate the account and record the agent run; a step does neither itself.

Param kinds are `enum`, `repo` (a tracked repo), `int` and `run-id`; there is no free-text kind, so nothing typed on the dashboard reaches a prompt. `run` gets the database, the validated params, `progress(text)`, `log(line)`, `handled(n)` (the running total of units the job has attempted, saved at once and counted against the stage's daily limit), `usageRun(runId)` (token use recorded under that run from the job's start counts as the job's) and `cancelled()`, and returns a one-line summary; throwing fails the job with the error's message. `available()` and `check(db, params)` can refuse a step or a request with a reason. The Pipeline page, the API, the autopilot and the CLI pick the step up from the list.

After a change to a stage in `src/stages/registry.ts`, run `npm run docs` and `npm run docs:image`.

`npm run docs:image -- <url>` screenshots the dashboard home page into `docs/images/flowchart.png`. Build the mock UI and serve it first:

```sh
(cd web && VITE_MOCK=1 npx vite build --outDir <dir> --emptyOutDir)
node scripts/serve-spa.mjs <dir> 8980 &
PLAYWRIGHT_DIR=<dir with node_modules/playwright-core> CHROMIUM_PATH=<chromium binary> npm run docs:image -- http://127.0.0.1:8980
```

Playwright is not a dependency of the repo; the header of `scripts/flowchart-shot.mjs` lists the two variables.

## Running a worker

A worker runs untrusted build tasks for the coordinator (the runner process). It holds no GitHub token, no Claude login and no database access: it downloads public source tarballs anonymously, runs each plan step in a fresh container, and sends logs, results and artifacts back, all of which the coordinator treats as untrusted data.

```
autocraft-server worker serve [--config FILE]     # default: $AUTOCRAFT_WORKER_CONFIG
```

### Local sandbox user

Run the worker as a separate OS user without access to the operator's home, tokens or Claude login, with rootless Podman, from its own checkout of this repository. Create the environment on the Build environments page (or `POST /api/envs`); the key is shown once. Save it to a file readable only by the sandbox user, and write the config:

```json
{
  "coordinatorUrl": "http://127.0.0.1:8981",
  "keyFile": "/home/sandbox/.config/craft-worker/key",
  "workDir": "/home/sandbox/work",
  "slots": 2,
  "images": { "rust-stable": "docker.io/library/rust@sha256:<digest>" },
  "runtime": "podman",
  "limits": { "cpus": 4, "memoryGb": 8, "pids": 1024, "minFreeDiskGb": 20 },
  "fetchNetwork": "pasta",
  "display": false,
  "gpu": false
}
```

`"display": true` says the worker can run tasks that render a UI (such as screenshot tasks, which require `display`); without it those tasks stay queued. For such a task the derived image adds software Vulkan and GL drivers (`mesa-vulkan-drivers`, `libvulkan1`, `libgl1-mesa-dri`, `libegl1`) and sets `WGPU_BACKEND=vulkan`; images of other tasks are unchanged. `gpu` is separate and only passes a GPU device through.

`coordinatorUrl` may use plain `http` only for loopback, private-network (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7) and cluster-internal hosts (`.svc`, `.cluster.local`, `.internal`); any other host needs `https`. Only `coordinatorUrl`, `keyFile` and `workDir` are required. `workDir` must not contain commas, colons or spaces. Other keys: `userns` (default `keep-id`), `maxSourceMb` (300), `maxStepSec` (14400), `warmDir` (default `<workDir>/../warm`, same path rules as `workDir`) and `warmMaxGb` (60).

The worker records each step's peak memory from the container's cgroup (v2) while the step runs and sends it as `peakMemBytes`; `oomKilled` is true when the kernel killed the step for reaching the memory limit (`limits.memoryGb`). Both are omitted when the cgroup cannot be read.

Then install `deploy/craft-worker.service` as a systemd user unit of the sandbox user (the file's header lists the steps).

### Toolchain images

`images` maps a toolchain name (what tasks `require`) to an image. The defaults are `rust-stable` = `docker.io/library/rust:1-bookworm` and `node-24` = `docker.io/library/node:24-bookworm`. Tags move, so pin each image to a digest:

```
podman pull docker.io/library/rust:1-bookworm
podman image inspect --format '{{index .RepoDigests 0}}' docker.io/library/rust:1-bookworm
```

Put the printed `...@sha256:...` reference into `images`. The reported capabilities list the keys of `images`. A task that requires several toolchains runs in the first one that has an image.

#### Nightly toolchain images

The nightly checks (Nightly report) need three more images, defined in `deploy/container`:

| Toolchain | Containerfile | Contains |
| --- | --- | --- |
| `rust-nightly` | `Containerfile.rust-nightly` | nightly, miri with its sysroot built at image time, rust-src, llvm-tools, clang, cargo-fuzz, the wasm32 target |
| `rust-cross` | `Containerfile.rust-cross` | stable, wasm32-unknown-unknown, x86_64-pc-windows-gnu, mingw-w64 |
| `rust-audit` | `Containerfile.rust-audit` | stable, cargo-audit |

On the worker host, as the sandbox user, build each one, then pin it by digest and add it to `images` in the worker config:

```
podman build -f deploy/container/Containerfile.rust-nightly -t localhost/rust-nightly deploy/container
podman image inspect --format '{{.Id}}' localhost/rust-nightly
```

```
"images": { "rust-nightly": "localhost/rust-nightly", "rust-cross": "localhost/rust-cross", "rust-audit": "localhost/rust-audit" }
```

Restart the worker; the environment then reports the toolchains. A check whose toolchain no enabled, online environment reports is recorded as skipped (no toolchain). Images pushed to a registry are referenced by `name@sha256:...` like the defaults.

### What a step runs in

Every step is `podman run --rm` with: `--network none` (the `fetchNetwork` for steps marked `fetch`), `--read-only` root with a 2 GB tmpfs on `/tmp`, `--cap-drop all`, `--security-opt no-new-privileges`, `--userns keep-id`, `--cpus`, `--memory` (swap equal), `--pids-limit`, and four mounts: `/src` (the source as an overlay: steps may write next to the sources, as tests in a CI checkout can, and the writes are dropped when the step ends), `/target` (build output), `/cache` (CARGO_HOME) and `/out` (artifacts). No other mounts and no environment from the host; a step marked `fetch` also gets no gate env and no craft-fonts or craft-i18n mount. A step that exceeds its timeout is killed and recorded as timed out; a failing step ends the plan. The work dir and containers are removed after each task and at worker start. Directories a step left unreadable get their owner permissions back before the removal; a work dir that still cannot be removed is logged and renamed to `stuck-task-<id>-<random>`, retried at every start, and never fails the task's result or the worker's start.

The disk check runs before every claim: below `minFreeDiskGb` (20) free on the work dir's file system, the worker claims nothing and reports `disk N GB free (needs 20)` as its paused reason.

### Patches and warm target dirs

A claimed task may carry `patch`, a git-format unified diff of at most 1 MiB. After the source is unpacked and before the first step, the worker runs `git apply --check` and then `git apply` on the host. Patches with paths outside the tree (absolute, `..`, `.git`), symlinks or binary content are refused. A patch that is refused or does not apply fails the task with no step run; the summary is `patch does not apply: <first git error line>` or `patch refused: <reason>`. A malformed `patch` or `warm` field also fails that task only.

A task may carry `warm: { key, role }` (`key` is the repo name, `[a-z0-9-]`, up to 64 characters). The worker keeps at most one warm cargo target dir per key in `warmDir`, with a JSON record (commit, size, last use). A `build` task is a build of the repo's upstream main: it runs with an empty target dir and, when every step succeeded, replaces the warm dir for its key atomically with its target dir. A `use` task starts with a copy of the warm dir (`cp -a --reflink=auto`) or an empty target dir, and discards it afterwards, so a PR build never changes the warm dir. After each store, least recently used warm dirs are removed until the total is within `warmMaxGb`. The free-disk pause measures the smaller free space of the work dir and the warm dir.

### Shared warm snapshot store

With several build machines, each worker's warm dirs exist only on its own disk. A snapshot store on a separate machine (the cache node) lets every worker start PR builds warm.

Run it with `autocraft-server worker store serve --config FILE` (or `$AUTOCRAFT_STORE_CONFIG`). Config keys: `dir` (absolute, required), `readKey` and `writeKey` (required, at least 16 characters, different), `listen` (default `127.0.0.1:8990`), `maxGb` (200; least recently read snapshots are removed above it), `maxUploadGb` (20; larger bodies are refused), `requestTimeoutSec` (3600; the longest an upload may take) and `idleTimeoutSec` (120; a connection silent for that long is closed). It speaks plain HTTP: the transport must be TLS (a proxy in front) or a private cluster network. Keep the config file mode 0600.

API, all with `Authorization: Bearer <key>`:

- `GET /store/<key>` answers the record `{ commit, size, sha256, stored, bytes, signature }`, or 404.
- `GET /store/<key>/blob` streams the `.tar.zst` snapshot.
- `PUT /store/<key>?commit=&sha256=&stored=&bytes=&signature=` stores a snapshot. It needs the write key. The body goes to a temp file while its sha256 is computed; the snapshot replaces the previous one atomically only when the body arrived complete and matches `sha256`. An interrupted or oversized upload changes nothing.

`<key>` is the warm key (`[a-z0-9-]`, up to 64 characters). The read key also works for the two GET routes; the write key works for everything.

#### Signing

The cache node is not trusted for content. A worker that uploads signs `(key, commit, sha256, stored, bytes)` with an Ed25519 private key; the store keeps the signature in the record. Every worker that downloads verifies it with the public keys in its config and refuses unsigned snapshots and bad signatures. `stored` is the time of the main build. Generate a key pair with `autocraft-server worker store keygen --private FILE --public FILE` (the private key file is created mode 0600 and never overwritten). The store itself needs neither key.

#### Worker config

`warmStore: { url, readKey, verifyKeyFiles, writeKey?, signKeyFile?, timeoutSec }`. `url` follows the same rule as `coordinatorUrl`: plain http only to loopback, private-network and cluster-internal hosts; redirects are refused, so keys reach only the configured host. `verifyKeyFiles` lists public key paths. `writeKey` and `signKeyFile` are set together, only on workers that run trusted main builds; a worker with `signKeyFile` takes only tasks without a PR, a patch or a merge batch. `timeoutSec` defaults to 600. Without `warmStore` workers behave as described above. All transfers run in the worker process on the host, never in a build container, and the container never receives the URL or keys.

- After a `build` task (upstream main; a `build` task cannot carry a patch) has replaced the local warm dir, a worker with a `writeKey` takes a hard-link copy of it under the warm lock, then packs (`tar | zstd`), signs and uploads the copy without holding the lock. `use` tasks (PR builds) never write. The upload is skipped when the local warm dir has changed in the meantime. Warm publish never records cargo's lock files (`.cargo-*lock`), warm apply creates every empty file as its own inode, and every restore or copy into a build target deletes the lock files it holds, because cargo deadlocks on flock files that share an inode.
- When a `use` task starts, the worker starts a download in the background and the task uses the local warm dir as it is now; the next task gets the new snapshot. Concurrent tasks share one download. The download happens only when the store's snapshot is signed correctly and newer (`stored`) than the local one; the swap checks this again under the warm lock. The blob is first written to a spool file and its sha256 is checked against the signed record; only then is it unpacked, by the same safe extractor as source tarballs (regular files, directories and links inside the tree, no path through a symlink, no special mode bits), capped at the signed size plus slack. A worker runs one download at a time, and the free-disk check counts the download in progress. Key files are read when the worker config is loaded, so a bad path stops the worker at start.

Build workers need synchronized clocks (NTP): `stored` is compared across machines to decide which snapshot is newer. A snapshot larger than `warmMaxGb`, or one that would take the free disk under `limits.minFreeDiskGb`, is skipped.
- A store that is down, slow (past `timeoutSec`), refuses the key or returns a bad snapshot is logged and ignored. A worker host without `zstd` skips both directions with a log line.

### Crate cache

The shared crate cache (`<workDir>/crate-cache`) is never mounted into a container. Each task gets its own `CARGO_HOME`, seeded by copying `.crate` files from the shared cache and deleted with the task. Cargo does not re-verify files already in its cache, so nothing a task wrote is trusted. Right after each `fetch` step, before any build script or test has run, the worker process on the host admits a file to the shared cache only if it is a regular `.crate` in the official crates.io registry directory (`index.crates.io-*`) and its sha256 equals the checksum in the crates.io sparse index (fetched over HTTPS, looked up once per crate name). Other registries, git sources, anything written by offline steps and anything the index lookup cannot confirm are never admitted. Build output (`/target`) is shared only through the warm target dirs below.

`rustPlan()` (`src/worker/rust.ts`) returns the Rust steps: `fetch deps` (`cargo fetch --locked`, network, with the image's toolchain, no repository cargo config and an empty environment apart from the toolchain paths), then `build` and `test` with `--offline --locked`. A whole-workspace plan builds `--workspace --lib --bins` and tests `--workspace --lib --bins --tests` (`src/worker/rust-targets.ts`): examples, benches and doctests are left to the repository's CI. The warm producer builds the same targets, and the implement prompt tells workspace sessions to build and test with these commands, so their builds reuse the warm version's units. A plan for named crates (`-p`) builds `--all-targets`. The source is read-only, so `Cargo.lock` must be committed. The nightly checks' networked steps (`cargo fetch`, `cargo audit fetch`) run the same way (`fetchScript()`), with the toolchain the image makes active.

### Remote hosts

A remote worker is the same program with a config whose `coordinatorUrl` points to the coordinator's worker listener (`AUTOCRAFT_WORKER_LISTEN`, exposed over the tailnet behind TLS) and its own key. Register it as another environment; the coordinator hands tasks to whichever environment has a free slot that satisfies the task's requirements.

## Production install

A production install runs the dashboard, the runner, the sync timer and a daily database backup as system services of one unprivileged user, and deploys by `git push`. `<root>` is that user's home. Files in `deploy/`:

| File | Use |
|---|---|
| `autocraft.env.example` | The settings file, `<root>/config/autocraft.env`: every path (database, caches, secrets, accounts), the listen addresses and the public URL. |
| `systemd/autocraft-*.service`, `*.timer` | System units with `@ROOT@` and `@USER@` placeholders: dashboard, runner, sync (every minute) and backup (daily). They read the settings file. |
| `post-receive` | Bootstrap hook for `<root>/repo.git` (a bare repo). Install it once; each deploy replaces it with the copy in the deployed commit. It runs `deploy/hook.sh` from the pushed commit and passes that commit (`AUTOCRAFT_DEPLOY_SHA`), so the release is the commit that was pushed even if the branch moves during the deploy. |
| `hook.sh` | Snapshots the database, pauses the sync timer, builds `<root>/releases/<commit>` (dependencies, `web/dist`), updates the sandbox worker code (when `AUTOCRAFT_WORKER_SSH` is set; SSH accepts only a known host key, from `<key>.known_hosts` when it exists, else the user's `known_hosts`) switches the `<root>/app` symlink and restarts the units named by `AUTOCRAFT_UNITS`. A failed deploy prints the command that redeploys the same commit. |
| `push.sh` | `deploy/push.sh REMOTE [REF]`: pushes a branch to the bare repo. |
| `backup.sh` | `backup.sh [PREFIX [KEEP]]`: consistent SQLite snapshot (`VACUUM INTO`), compressed, newest KEEP kept. With `AUTOCRAFT_DB_URL` it makes no backup and exits 3: the Postgres provider keeps the backups. |

Layout: `<root>/{repo.git,releases,app,data,cache,config}` (`app` is a symlink to the current release). `<root>/config` holds the settings file, `secrets.json` (mode 0600), `accounts.json` and the per-account Claude config directories. The user needs `node` 24, `git`, `pnpm`, `sqlite3`, `curl`, `bwrap`, `gh` (logged in, with its git credential helper), `claude` (logged in per account) and `jev` on its PATH (`<root>/.local/bin` comes first). The restart needs a sudoers entry allowing the user `systemctl restart` of its own units, and `start`/`stop` of the sync timer, without a password. The units load `autocraft.env` themselves as the app user. The dashboard unit sees that file, `releases/`, `repo.git` and `.local` read-only (`ReadOnlyPaths=`): the process that faces the network cannot change what the other units source or run. The worker runs as a separate user (see Running a worker); `AUTOCRAFT_WORKER_SSH` and an SSH key at `<root>/.ssh/id_craftsandbox` let the hook install its code through the worker's forced-command key.

### Rolling back to an older release

Redeploy the older commit with its bare repo's hook. A release migrates the schema it expects, but leaves tables and triggers that newer code added. The incremental planner's change log is one of them: its triggers keep writing `item_changes` under a release that never reads or prunes it. Before rolling back to a release without the incremental planner, stop the runner and run `autocraft-server plan-log drop`. It removes the `plan_` triggers and the planner's tables and clears the schema stamp, so whichever release connects next migrates; a later deploy of a newer release creates them again. `autocraft-server plan-log status` shows the log size, the pass counts and durations per kind, the most frequent full-pass causes and the number of shadow differences.

## Running in a container

To move a running systemd install to a container, follow [migration.md](migration.md). For one host, `deploy/compose/compose.yaml` runs the dashboard, the runner and the periodic container with Docker Compose (see "VPS with Docker Compose" there).

One image runs the dashboard, the runner and the one-shot sync and backup commands, beside the systemd install (which is unchanged). Sandbox workers are not part of the image; they keep running on their own machines and reach the runner's worker API.

### Build and run

```
docker build -f deploy/container/Dockerfile -t autocraft .
docker run -v data:/data -v config:/config -e AUTOCRAFT_BASE_URL=https://autocraft.example.com autocraft-server dashboard
```

The image is built on Docker Hardened Images for Node 26 on Debian 13: the shell-less runtime variant receives a prepared file tree with `bash`, `dash` (`/bin/sh`), coreutils, grep, sed, tar, gzip, findutils, `script`, `git`, `bubblewrap`, `sqlite3`, `curl`, `zstd`, `tini`, pnpm, the production dependencies, the built `web/dist` and the Claude CLI (`--build-arg CLAUDE_CODE_VERSION=...`, default the version the systemd install runs). It runs as uid 10001. It contains `gh` (pinned by checksum; authenticate with the `GH_TOKEN` environment variable) but not `jev`; Jev is reached through Cloudflare Workers AI when `AUTOCRAFT_JEV_CLOUDFLARE_*` is set, and while it is neither, Haiku does Jev's work (the runner records the outage "not installed" and checks the `PATH` on every pass), and a derived image that adds `jev` restores it. `--build-arg SOURCE_COMMIT=<sha>` records the commit the dashboard shows (the image has no `.git`). `tini` is PID 1 and reaps the jobs' child processes.

The first argument picks the process, exactly as the systemd units start them:

| Command | Runs | Systemd unit |
|---|---|---|
| `dashboard` (default) | `autocraft-server dash serve` | `autocraft-dashboard` |
| `runner` | `autocraft-server runner serve` (also the worker API) | `autocraft-runner` |
| `sync [args]` | `autocraft-server sync`, one-shot | `autocraft-sync` |
| `backup [PREFIX [KEEP]]` | `deploy/backup.sh`, one-shot, default prefix `daily` | `autocraft-backup` |
| anything else | passed to the `autocraft` CLI, for example `pipeline status` | |

Run one dashboard and one runner per database, on one host (SQLite). The runner and sync hold lock files holding a process id. A lock left by a crashed container is recognised as stale, but a process id check cannot see another container: two runners on one volume are not excluded. Run one replica with the Recreate strategy (or a StatefulSet with one replica).

### Volumes

| Mount | Holds | Access |
|---|---|---|
| `/data` | the database, caches, job logs, checkouts, backups, `HOME` | read-write, uid 10001 |
| `/config` | `secrets.json` (mode 0600, owned by uid 10001), `accounts.json`, the Claude config directories | read-write: accounts added on the dashboard create directories and write credentials and usage readings here |

Both are declared `VOLUME`s. `sync` and `backup` need `/data` and the same environment as the dashboard and runner.

### Settings

Every path is set by an environment variable. When a variable is unset, the code falls back to the default in the second column (a directory under `HOME`); the image and the systemd settings file set the values in the other two columns.

| Variable | Code default | Image | Systemd example |
|---|---|---|---|
| `AUTOCRAFT_DATA_DIR` (reference documents, artifacts, item snapshot) | the SQLite file's directory | `/data` | unset |
| `AUTOCRAFT_DB` | `mirror.db` in `AUTOCRAFT_DATA_DIR` when that is set, else `~/.local/share/autocraft/mirror.db` | unset (`/data/mirror.db`) | `<root>/data/mirror.db` |
| `AUTOCRAFT_SECRETS_FILE` | none (required) | `/config/secrets.json` | `<root>/config/secrets.json` |
| `AUTOCRAFT_ACCOUNTS` | none | `/config/accounts.json` | `<root>/config/accounts.json` |
| `AUTOCRAFT_ACCOUNTS_ROOT` (Claude config directories) | none | `/config/claude` | `<root>/config/claude` |
| `AUTOCRAFT_USAGE_DIR` | `<accounts root>/.usage` | `/data/cache/autocraft/usage` | `<root>/cache/autocraft/usage` |
| `XDG_CACHE_HOME` (model, image and label caches) | `~/.cache` | `/data/cache` | `<root>/cache` |
| `AUTOCRAFT_LOCK_DIR` | `~/.cache/autocraft-logs` | `/data/cache/autocraft/locks` | `<root>/cache/autocraft/locks` |
| `AUTOCRAFT_RUNNER_LOGS` (job logs) | `~/.cache/autocraft-logs/jobs` | `/data/cache/autocraft/jobs` | `<root>/cache/autocraft/jobs` |
| `AUTOCRAFT_DIFF_CACHE` | `~/.cache/autocraft/diffs` | `/data/cache/autocraft/diffs` | `<root>/cache/autocraft/diffs` |
| `AUTOCRAFT_CHECKOUT_DIR` | `~/.cache/autocraft/checkouts-v2` | `/data/cache/autocraft/checkouts` | `<root>/cache/autocraft/checkouts` |
| `AUTOCRAFT_FIXUP_DIR` (bare git cache) | `~/.cache/autocraft/fixups` | `/data/cache/autocraft/fixups` | `<root>/cache/autocraft/fixups` |
| `AUTOCRAFT_BACKUP_DIR` | `<database dir>/backups` | `/data/backups` | `<database dir>/backups` |
| `AUTOCRAFT_ARTIFACT_DIR` | `<data dir>/artifacts` | unset | unset |
| `AUTOCRAFT_SNAPSHOT_DIR` | `<data dir>/item-snapshot` | unset | unset |
| `AUTOCRAFT_CLAUDE_CWD` | `~/.cache/autocraft/claude-cwd` | unset | unset |
| `AUTOCRAFT_MODEL_CACHE` | `$XDG_CACHE_HOME/autocraft/models` | unset | unset |
| `AUTOCRAFT_WEB_DIST` | `web/dist` of the code | unset | unset |
| `AUTOCRAFT_CLAUDE_BIN` | `claude` on `PATH` | `/usr/local/bin/claude` | unset (`<root>/.local/bin` is on `PATH`) |
| `AUTOCRAFT_LISTEN` (dashboard) | `127.0.0.1:8993` | `0.0.0.0:3005` | `127.0.0.1:3005` |
| `AUTOCRAFT_WORKER_LISTEN` (worker API) | `127.0.0.1:8981` | `0.0.0.0:8981` | `127.0.0.1:8981` |
| `AUTOCRAFT_HEALTH_LISTEN` (runner probes only) | none | none | none |
| `AUTOCRAFT_STOP_TIMEOUT` (seconds the runner may take to stop) | `25` | unset | unset |
| `AUTOCRAFT_RUNNER_REPLICAS` (copies of the runner and periodic; see [Two replicas](#two-replicas)) | `1` | unset | unset |
| `HOME` | the user's home | `/data/home` | the app user's home |

`AUTOCRAFT_BASE_URL` (no default; the public origin) and `AUTOCRAFT_TRUST_PROXY` stay as described under Dashboard server. The older `CRAFT_AUTO_*` names still work.

### Logs

The dashboard, the runner, sync and backup write to stdout and stderr. The runner also writes one file per job under `AUTOCRAFT_RUNNER_LOGS`, and keeps the end of each in the database.

### Health endpoints

`GET /healthz` answers 200 `ok` while the process is up. `GET /readyz` answers 200 while the database answers a query and 503 otherwise. A runner that waits as a standby (see [Two replicas](#two-replicas)) answers `/healthz` with 200 `ok: standby` and `/readyz` with 503 `not ready: standby`. In Kubernetes with two replicas every runner pod is ready on `/healthz` and the worker API's EndpointSlice names the leader alone (Two replicas). Neither needs authentication and neither returns data. They are served by the dashboard (before sign-in), by the runner's worker API listener (before the worker key check) and, when `AUTOCRAFT_HEALTH_LISTEN` is set, by a listener of the runner that serves only these two paths.

### Health checks

The dashboard computes the checks below from the database on each request; nothing runs on a timer. The warnings menu in the header lists the ones that are not `ok` (red for `fail`; viewers see that a check is bad but not its cause or repos they cannot see), and `GET /healthz/checks` returns them for external monitoring (no sign-in; ids and states only, plus `since` and counts for a signed-in operator or maintainer; 200 for `ok` and `warn`, 503 when any check is `fail`). Thresholds are the constants in `THRESHOLDS` in `src/health-checks.ts`.

| Id | Fails or warns when |
|---|---|
| `runner` | `runner_heartbeat` is missing or older than 2 minutes (fail) |
| `runner-leader`, `periodic-leader` | Postgres with leader election only (see [Two replicas](#two-replicas)): no leader has written its status (`leader:<role>` in `settings`) for 1 minute (fail). While it is `ok`, `since` is when the leader took over and `count` is the number of standbys waiting; a missing standby is not a problem. Warn when a standby runs while the leader or a standby has `AUTOCRAFT_RUNNER_REPLICAS` 1 |
| `worker:<env id>` (`workers` in the endpoint) | an enabled build environment has not reported (`last_seen_at`) for 5 minutes, or never (fail) |
| `build-queue` | a build task has been queued for over 10 minutes: fail when no enabled environment has reported in 5 minutes, else warn (a security task while no confidential environment is ready counts under `confidential-env` instead) |
| `remote-calls` | the inference mode is `user-local`, a remote model call has been queued for over 10 minutes, and no helper has claimed any call in that time (warn) |
| `remote-starved-<tier>` | the inference mode is `user-local`, a helper that is not Manual only reported `ready` in the last 6 minutes, and the oldest queued call of the tier has waited over 30 (top), 20 (mid) or 5 (small) minutes (warn) |
| `remote-manual` | the inference mode is `user-local`, every Task Runner that reported `ready` in the last 6 minutes is Manual only, and a model call has waited over 10 minutes (warn) |
| `remote-no-taker` | the inference mode is `user-local` and a tracked repo with the pipeline on has had no Task Runner that may take its calls for over 10 minutes: none reported `ready` in the last 6 minutes outside a cool-off (Manual only ones count), or the role rules, a non-write permission confirmed within 10 minutes or My repos leave each one out, or its user has no task ticked in My tasks. The dashboard checks the repos once a minute; the text names the repos (warn) |
| `interactive-no-taker` | Discord is configured (`AUTOCRAFT_DISCORD_KEY_FILE` is set in the dashboard) and the inference mode is `user-local`, and either no operator's Task Runner is ready with an Interactive slot and a small-tier model (the text says why: no slots, quota-held until a time, paused, cooling off, not connected), or a Discord call has waited over 60 seconds in the queue (warn) |
| `confidential-env` | a security fix or a security build task waits and no confidential build environment is ready (warn) |
| `sync` | no successful `sync_runs` row ended in the last 10 minutes, or the last 3 runs failed (fail) |
| `sync-repos` (`sync-repo:<repo>` in the dashboard) | a tracked repo could not be read by the last sync (warn; fail when more than half of the tracked repos have an error, for example after a token lost access). The reason is `sync_repo_errors`: `not-found` (moved, renamed or deleted; the new name is shown when GitHub's REST endpoint redirects), `forbidden`, `transient` or `error` |
| `accounts` | every enabled Claude account is paused or signed out (fail) |
| `github-rate` | fewer than 500 (warn) or 100 (fail) GitHub points are left until the next reset |
| `author-ids` | the last pass that binds contributors' account ids failed (`author_ids_error`) and logins with merged or closed PRs are still unbound: their earlier PRs count toward no whitelist tier until a pass succeeds (warn) |

A repo that fails is skipped for that run and the sync continues with the others; the run exits non-zero only when every repo it tried failed, or after three transient failures in a row or a rate-limit stop (a GitHub outage). A full re-sync keeps its cursor before the first failed repo. A repo is never untracked automatically: untrack it or track it under its new name, and its warning goes with the next successful read (a not-found record also clears when the org listing shows the repo again).

### Stopping

On SIGTERM or SIGINT the runner claims no new jobs, sends SIGTERM to each running job's process, queues each unfinished one to resume, closes its listeners and exits 0. A job's process refuses GitHub writes from then on, waits up to 7 seconds for the writes it has in flight to finish and be recorded, then stops the rest of its process group; whatever is left gets SIGKILL 10 seconds after the SIGTERM. A cancel and a deadline stop end the process the same way. If that takes longer than `AUTOCRAFT_STOP_TIMEOUT` seconds, it exits 1. Set the orchestrator's grace period above that value: `docker run --stop-timeout 30`, Compose `stop_grace_period: 30s`, or the Kubernetes default `terminationGracePeriodSeconds: 30`. The dashboard closes its connections and the database and exits 0.

### Restarts and resumed jobs

A restart of the runner, the dashboard or both (a deploy, a crash, a moved pod) needs no drain. A job the runner stops, or finds left `running` when it starts, goes back to the queue under the same id (`src/runner/resuming.ts`):

- The job's row gets `resumes` + 1 and loses its start time, process, progress and error; its job items stay. Its log gets a line that it is queued to resume, and the resumed run appends to the same log. The job starts again from the beginning, with a fresh deadline, like any queued job: the planner sees it queued and queues no second job for the same work. The resumed run's model usage and its counts of handled items and other progress (`items`, `acted`, which the daily limits read) add to the earlier runs'. Token usage rows of a resumed run have their own run id or agent names (`-r1`, `r1.`), so the earlier run's rows stay. A run killed without its stop (SIGKILL after the grace time, a crash) leaves its token usage rows, which the Cost page counts, but adds nothing to the job's usage.
- A job resumes only when the stop ended it: its process exited on the stop signal (code 143) or was killed. A job that finished or failed on its own during the stop ends done or failed with its own result. A job resumes at most 12 times when the runner was stopped on purpose (a deploy), and at most 2 times after an unclean stop (the runner crashed or was killed without the stop; `jobs.crash_resumes` counts these). A stop past either limit fails it with "The runner stopped while this job ran", which the failure backoff does not count. A job whose cancel was asked ends cancelled, and a job already told to stop at its deadline does not resume either. A command-line run (`requested_by` `cli`) never resumes: the command runs its process and records its end. A runner that starts and finds one `running` kills its process and fails it.
- Its remote calls stay as they are: queued calls wait (a call whose caller stopped polling is not offered to Task Runners), leased calls keep running on their Task Runners, and a Task Runner that answers during the restart (it retries its submit for 30 minutes) leaves the reply on the call. When the resumed run makes a call with the same prompt, prompt version, bundle (`remote_calls.bundle_hash`, a sha256 of the bundle's canonical JSON) and parent call, it adopts that call instead of queuing a new one, and reads the reply or waits for it. Each earlier call is adopted at most once, also when the run makes two equal calls side by side, and a reply is read at most once: reading it sets `consumed_at`. An adopted queued call's wait limits count the time it waited before the stop, not the restart. A call whose bundle came out different (the item changed meanwhile) is made again, and the earlier run's queued calls with the same prompt, items and parent are withdrawn; its leased ones run on, since a later call of the run may still adopt them. The agent runs of the earlier calls stay running. The calls the resumed run did not adopt are withdrawn, and their unread replies cleared, when the job ends; the caller-gone sweep leaves the earlier run's calls alone until then, but not the calls the resumed run makes itself.
- A follow-up turn on a remote session (a check reminder, a lint fix) whose first turn the earlier run already read is not adopted: the resumed run asks the first turn again.
- Its creating GitHub writes are not made twice. Before a comment, a review, an issue, a pull request, an issue transfer, a CI run approval or rerun, a push or an advisory write, `src/github/write.ts` looks for the audit row of the same write by the job's earlier run (same job id, action, target and write key) and returns its recorded result. The write key is a hash of what tells the job's writes apart: a comment's text with the decision, card, comment or command it answers; a review's head and text; a CI run and its attempt (a run still going whose earlier attempt the job reran is the job's own rerun); the commit of a push; the head and base of a pull request. A text that came out different (a local model call that answered differently) is posted. A push the earlier run made is still recorded for the push-outcome breaker, once per action, repo, pull request and commit. Closes, labels, assignments, edits and merges are not looked up: the guard's current-state checks and GitHub itself make a repeat a no-op.
- At the stop the runner signals the job's process alone. A write asked for from then on is not made: its caller waits until the process exits, so no step records it as a failed item, and the resumed run makes it. The writes in flight finish and are recorded (up to 7 seconds), then their callers get up to 1 more second to record what the writes did (a review's row, a push's outcome), cut short once each has asked for its next write or the step returned. Then the process records its usage, stops the rest of its process group (model calls, builds) and exits. A write still in flight when the 7 seconds ran out leaves its audit row in state `started`; the resumed run makes it again and logs it, and the new row names the unknown one in `repeats`.
- Local model calls (Jev, Claude on an account, Haiku) and local steps (checkouts, builds) run again; model-queue waits and work leases of the stopped run end.

### Two replicas

On Postgres the runner and the periodic chores can run as two copies (for example two pods on different nodes), so that a lost pod or node does not stop the pipeline. One copy of each role leads and works; the other waits as a standby and takes over within seconds. The runner and the periodic chores are elected separately. On SQLite every process runs on one host and always leads.

How it works (`src/db/leader.ts`, `src/db/fence.ts`):

- A copy leads while it holds its role's lease: a row of `leader_leases` (role, holder, epoch, `expires_ms`) whose end lies ahead on the database server's clock. The leader renews it every 2 seconds to 10 seconds ahead, on a database connection of its own (application name `autocraft-leader-runner` or `autocraft-leader-periodic`), outside the pools and the writer lock, so busy pools or a long write transaction do not delay a renewal. A renewal names the leader's epoch, so it never renews a lease another copy has taken. The lease connection runs plain statements and works through any pooler or proxy.
- A standby reads the lease every 2 seconds. It logs that it waits, writes its status every 10 seconds (`leader:<role>:standby:<host>:<pid>` in `settings`) and starts nothing. Once the lease has expired (or there is none), it takes it with one conditional statement in a write transaction, which moves the role's epoch: one more than before and at least the server's clock in ms, so a new epoch is above every earlier one even when the row was lost or replaced by a database copy. A standby runner answers the probes on the worker API address (`/healthz` 200, `/readyz` 503) and runs neither the worker API, the build pod launcher nor the Discord bot. A standby `periodic` runs no sync.
- The leader writes its status (`leader:<role>`: holder, epoch, since, and what the server reports of the lease connection: `tcp_keepalives_idle`, `tcp_user_timeout` and the client address) every 10 seconds. With one replica a slow or failed renewal is never a loss by itself; with two or more, 8 seconds without a successful renewal is (below).
- The new leader fences its process and every process it starts to its epoch (`AUTOCRAFT_FENCE`). Every write transaction of a fenced process checks, right after it takes the writer lock, that the lease still has that epoch, and fails if the epoch moved.
- Then the new runner does what a restarted runner does: `recover()` queues the jobs left running to resume or ends them (see [Restarts and resumed jobs](#restarts-and-resumed-jobs)), and the build pod and workspace launcher picks up the pods, volumes and workspaces from their rows on its first pass.

When the lease connection fails, the next renewal opens another. A lease that expired while no other copy took it is renewed again under the same epoch, and the leader carries on without stopping anything. It has lost the lease when a renewal changes no row (another copy took the lease and moved the epoch), or a fenced write or the status write is refused, and with two or more replicas also when no renewal has succeeded for 8 seconds by the wall clock (a stall or freeze of the process counts). Then it starts nothing more, kills the process groups of its jobs and of their model calls (or of the running chores) with SIGKILL and exits with code 75, so the supervisor restarts it and it comes back as a standby. Its jobs resume on the new leader as after a crash: GitHub writes that recorded a result are not made again, and a write still in flight leaves an audit row in state `started`, which the resumed run makes again. A clean stop ends the lease at once, so a standby takes it at its next read.

`AUTOCRAFT_RUNNER_REPLICAS` (default 1) is the number of copies of the runner and periodic containers the install runs; set it alike on both. With 1, no standby waits to take over, so a failed or slow renewal never kills jobs by itself: the leader keeps renewing, for as long as the database is unreachable, while its jobs keep running. It still kills its jobs and exits 75 when the epoch moved, which happens when a deploy briefly runs the old and the new pod and the new one takes an expired lease. With 2 or more, the 8-second limit applies, so that a leader cut off from the database, or frozen, stops before its 10-second lease expires and a standby can take it. A copy that waits as a standby while set to 1 logs a warning, and the `runner-leader` or `periodic-leader` health check warns, so two replicas left at the default do not run without the limit unnoticed.

Why nothing is written twice: every write of a fenced process runs under the writer lock (a write under a named lock takes the writer lock as well there), and the new leader moves the epoch in a write transaction. A write of the old leader or of one of its jobs either committed before the epoch moved, or sees the new epoch and fails. Every GitHub write first records its audit row in a write transaction, so a fenced job cannot start one either, and the pod launcher and the jobs' workspace sessions check the epoch before every Kubernetes change (pod and volume creates and deletes, commands in pods). GitHub and Kubernetes calls already in flight when the epoch moves finish; the old leader kills the jobs that made them when it notices the loss. With two or more replicas the old leader gives up after 8 seconds without a successful renewal, while its lease lasts 10 seconds from its last one, both measured from the renewal; the lease's end is on the server's clock, so the hosts' clocks do not need to agree. With one replica the old leader does not give up on its own; a copy that wins meanwhile (the new pod of a deploy) moves the epoch, so the old leader's writes and Kubernetes changes are refused from then on, and it stops at its next renewal or fenced write. GitHub calls its jobs make without a write to the database in between are not fenced.

Every database connection (the pools as well as the lease connection) sets `tcp_keepalives_idle` 5, `tcp_keepalives_interval` 2, `tcp_keepalives_count` 3 and `tcp_user_timeout` 10 s, so a server that the client reaches directly drops a client that went silent after about 11 seconds, and `idle_in_transaction_session_timeout` 60 s, so a transaction whose client stopped sending ends after a minute. Behind a proxy the keepalives cover only the proxy's own connection to the server: a client that is frozen while its host still answers (or whose silence the proxy does not notice) keeps its session, so only the idle-transaction timeout frees its writer lock. The pools and the lease connection set them with `SET` when a connection opens, before its first statement; a setting the server refuses (or, on the lease connection, does not answer within 3 seconds) is logged once per process and keeps the server's default. Only `statement_timeout` is a startup parameter.

How long a failover takes, until the new leader starts its recovery:

| Event | The lease is free | Takeover |
|---|---|---|
| Clean stop (rolling update, pod deleted, node drained) | after the leader has stopped its jobs (at most `AUTOCRAFT_STOP_TIMEOUT`, 25 seconds) and ended its lease | at most 2 seconds later |
| Process or container killed, out of memory | when the lease expires, at most 10 seconds after the last renewal | at most 12 seconds |
| Node lost, network split, process frozen | when the lease expires, at most 10 seconds after the last renewal; a leader still running stopped itself after 8, a frozen one stops when it runs again | at most 12 seconds, when the lost leader had no write transaction open. Otherwise the takeover waits for the writer lock until that transaction ends: about 11 seconds when the server reaches the client directly and drops it, up to 60 seconds (`idle_in_transaction_session_timeout`) behind a proxy; the takeover's lock wait gives up after 30 seconds and tries again |
| Lease connection dropped, leader still running | the leader renews on a new connection at its next renewal | none |

Before enabling two replicas on PlanetScale:

- Try one fenced write on a branch of the database: the fence check is a `DO` block, which the `pg_strict` extension or the provider may refuse. If it is refused, the check has to become a function `autocraft_fence(role, epoch)` created by a migration and called after the writer lock.
- Check that the logs show no refused or timed-out settings and that the `conn` part of `leader:<role>` shows the keepalive settings in effect.
- Freeze one replica (SIGSTOP) and time the takeover: it must come within the table's bounds, and the frozen copy must stop itself once it runs again.
- Set `AUTOCRAFT_RUNNER_REPLICAS` to 2 on the runner and periodic containers.

Running two replicas in Kubernetes:

- Put the runner and the periodic containers in a Deployment of their own with two replicas and pod anti-affinity on the node, apart from the dashboard. Every runner pod is ready on `/healthz`, leader or standby: a standby that is not ready would hold a rolling update, since the old leader is never replaced while the new pod waits, and the Deployment would never become Available.
- The worker API reaches the leader through an EndpointSlice the runner writes (`src/build/worker-endpoint.ts`). The `autocraft-worker-api` Service has no selector; its one EndpointSlice is created empty by the deployment. The slice needs the label `kubernetes.io/service-name: autocraft-worker-api`, which ties it to the Service; the label `endpointslice.kubernetes.io/managed-by` set to something other than the EndpointSlice controller (for example `autocraft-runner`), so the controller leaves it alone; and, with Flux, the annotation `kustomize.toolkit.fluxcd.io/ssa: IfNotPresent`, so Flux creates it once and a reconcile never removes the leader's address. The runner that takes the lead writes its pod IP and worker API port into it, after its epoch is fenced and with the epoch checked again right before the write, and then reads the slice at every 10-second status beat and writes it again when it names anything else, so a failed write is tried again at the next beat. The write carries the slice's `resourceVersion`, so it cannot replace a newer leader's address written after the read. A runner that loses the lead does not touch the slice; the next leader overwrites it. The dashboard and the build workers use the Service for the worker API.
- Runner environment: `AUTOCRAFT_WORKER_ENDPOINTSLICE` (the slice's name), `AUTOCRAFT_POD_IP` and `AUTOCRAFT_POD_NAME` (from the downward API); the namespace is the service account's. The runner's service account may `get`, `patch` and `update` that one EndpointSlice. Without `AUTOCRAFT_WORKER_ENDPOINTSLICE` the runner writes no slice.
- The leader records each check of the slice in `leader:runner:endpoint`. The `runner-leader` health check fails while the slice has named another address than the leader's, or could not be read or written, for more than 30 seconds.
- `/data` is per pod (an `emptyDir`): caches, checkouts, fixup clones, the item snapshot, the reference search index, job log files and `HOME`; a new pod rebuilds them. The files that are not a cache are on one ReadWriteMany claim mounted by `subPath` at their usual paths, so every replica sees the same ones: `/data/config` (accounts), `/data/claude` (Claude logins), `/data/reference` and `/data/artifacts`.
- `terminationGracePeriodSeconds` stays above `AUTOCRAFT_STOP_TIMEOUT`, so a clean stop hands over without killing jobs.

### Sandbox (bubblewrap)

Tool-using Claude calls run in `bwrap` (see Pipeline runner). Docker's default profile blocks it in two places: the seccomp profile denies creating the user namespace, and the masked paths under `/proc` deny the `--proc /proc` mount. Tested with rootless Docker on a kernel that allows unprivileged user namespaces:

| Flags | `bwrap --unshare-all --ro-bind / / true` | the runner's sandbox command (`--proc /proc`, `--dev /dev`) |
|---|---|---|
| none | fails: no permission to create a namespace | fails |
| `--security-opt seccomp=unconfined` | works | fails: cannot mount proc |
| `--security-opt seccomp=unconfined --security-opt apparmor=unconfined` | works | fails: cannot mount proc |
| `--cap-add SYS_ADMIN` | fails: `pivot_root` not permitted | not tried further |
| `--security-opt systempaths=unconfined` | fails: namespace | fails |
| `--security-opt seccomp=unconfined --security-opt systempaths=unconfined` | works | works (`claude --version` ran inside it) |

The runner container therefore needs an unconfined seccomp profile and unmasked `/proc` paths. With Docker that is `--security-opt seccomp=unconfined --security-opt systempaths=unconfined`. In Kubernetes: pod `spec.hostUsers: false`, and on the runner container `securityContext.procMount: Unmasked` and `securityContext.seccompProfile.type: Unconfined`. `procMount: Unmasked` is accepted only on pods with `hostUsers: false` and only on clusters that support `ProcMountType` (a feature gate in older releases). These settings are not tested on a cluster. `apparmor=unconfined` was not needed where no AppArmor profile applies; on a host that confines the container with one that denies user namespaces, it may be. No extra capabilities are needed. Only the runner needs these settings; the dashboard, sync and backup run with the defaults. Without them, set `AUTOCRAFT_NO_SANDBOX=1` to run without tool mode.

### Kubernetes

`deploy/k8s/autocraft.yaml` holds two Services and a StatefulSet with one replica. Edit the image and `AUTOCRAFT_BASE_URL`, then apply it. It is plain YAML, checked only by a YAML parse (no cluster was available).

| Choice | Reason |
|---|---|
| One pod, three containers: `dashboard`, `runner` and `periodic` (three containers, two shared volumes) | The database is SQLite on a ReadWriteOnce volume, so every process that opens it must run on the same node. Separate pods would need node affinity. |
| StatefulSet, one replica | The old pod is gone before the new one starts, so two runners never share the volume. The lock files cannot exclude a second pod. |
| `periodic` container instead of CronJobs | A CronJob pod may land on another node, where the volume cannot attach. The container runs `autocraft-server periodic`, which runs `deploy/periodic.sh`: `sync` every 60 seconds after the previous run, like the timer, and `backup daily 7` once a day. |
| Two volume claims, `data` and `config` (ReadWriteOnce) | `/config` is writable because the app writes accounts, Claude logins and usage readings there. |
| Pod `hostUsers: false`, `runAsNonRoot`, uid and `fsGroup` 10001 | The user namespace is required for the runner's `procMount: Unmasked`. |
| Runner container: `procMount: Unmasked`, `seccompProfile: Unconfined` | The sandbox requirement above. The other containers keep the defaults. |
| Probes on `/healthz` and `/readyz`; `terminationGracePeriodSeconds: 30` | The dashboard probes its own port; the runner probes the worker API port. |
| `autocraft-worker-api` Service on 8981 | For workers inside the cluster. Do not publish it. |

The manifest holds no secret values. Before the first start:

1. Set `replicas: 0` and apply the manifest, so the claims exist and no pod holds them. Place `secrets.json` on the config volume as uid 10001 with mode 0600 with a short-lived helper pod that mounts the `config-autocraft-0` claim (`kubectl cp`, then `chown 10001:10001` and `chmod 600`). Delete the helper, then scale the StatefulSet to 1. A ReadWriteOnce claim attaches to one node, so the helper and the pod cannot run together. The migration runbook ([migration.md](migration.md)) uses the same sequence.
2. Create the Secret `autocraft-github` with key `token` (a GitHub token for `gh`: `repo`, `read:org`, `workflow`) with `kubectl create secret generic autocraft-github --from-literal=token=...` typed by the operator.

### Build pods

A `kubernetes` build environment has no worker. The runner starts one pod run per build task in the cluster it runs in, through the Kubernetes API with its own service-account token (`/var/run/secrets/kubernetes.io/serviceaccount`). Untrusted code runs only in those pods, never next to AutoCraft.

```
autocraft-server envs add pods --label "Cluster pods" --kind kubernetes --slots 4 [POD SETTINGS]
autocraft-server envs set pods --toolchain-image rust-stable=<registry>/rust-stable@sha256:<digest>
autocraft-server envs set pods --enabled no
```

A task runs as a sequence of pods that share one volume (a PersistentVolumeClaim per task). Each pod is labelled `app.kubernetes.io/name=autocraft-build`, `craft.build/env=<env id>`, `craft.build/task=<task id>`, `craft.build/stage` and `craft.build/network`:

| Stage | Image | `craft.build/network` | What it does |
|---|---|---|---|
| task | AutoCraft | `api` | Fetches the task (source URL, patch, steps) with a one-time key and writes it to the volume. |
| source | AutoCraft | `fetch` | Downloads the source tarball, applies the patch and reads the CI gate at the base commit (env, craft-fonts and craft-i18n checkouts). Reports what it found in its termination message. |
| steps | toolchain | `fetch`, `mirror` or `none` | One pod per run of consecutive plan steps with the same network mode. A `disk` container (AutoCraft image) first measures the task's volume. Each step is then a container (ordered init containers, the last one the pod's container) that copies the pristine source into its own `/src` and runs under `timeout`. Steps that read the compile cache run at the CI runners' checkout path (Compile cache below). |
| upload | AutoCraft | `api` | Uploads the artifacts of the steps that ran, when a step names any. |

Images. Every AutoCraft program a pod runs comes from the AutoCraft image (`--image`, by default the runner's own `AUTOCRAFT_IMAGE`, which each deploy moves): the task, source and upload pods, and in step pods `disk`, `mirror-wait`, `warm-restore`, `warm-publish`, `warm-gc` and `warm-copy`; a workspace pod's `ws` helper is copied from it by an init container. The shell that wraps each step, the package check and the workspace layout script are part of the pod spec the runner writes. The toolchain image (`--toolchain-image`) holds only Rust, cargo tools and system packages, so a change to AutoCraft takes effect with the deploy, and the toolchain image is rebuilt only to change Rust or packages.

- The runner reads each step's exit code, OOM kill and times from pod status, and its output from the pod log. Nothing in a pod reports a result.
- A running step's output reaches the task log every launcher pass (5 seconds), at most 512 KB of new output per pass, complete lines only; the rest follows when the step ends. The runner keeps how far each container's output reached (`build_pod_runs.log_positions`) in the same transaction as the lines it appends, so a runner restart neither repeats nor drops a line. The task, source, warm publish and upload containers' output, and a warm restore's or copy's, reaches the log when the container ends.
- The one-time key reaches only the `api` pods. It can read its task and upload its artifacts; it stops working when the task pod ends, and the upload pod gets a new one. No key is valid while repository code runs.
- Every pod: `restartPolicy: Never`, a `kubernetes.io/arch` node selector from `--arch`, no service-account token, no service links, non-root (uid 10001, `fsGroup` 10001), `RuntimeDefault` seccomp, no privilege escalation, all capabilities dropped, read-only root, CPU, memory and ephemeral-storage requests and limits, `activeDeadlineSeconds`, and the optional runtime class.
- `fetch` and `mirror` steps get neither the CI gate's env nor the checkouts, as in the container runtime. Tasks that need a display are not taken. A task whose CI gate names a package the toolchain image lacks fails with the package named: pods cannot install packages. Offline step pods of a repository with a warm target start from their node's warm version (Warm starts below), and so do its workspaces (Workspaces at the CI paths below).
- A pod that disappears while its node is gone or unknown, cannot pull its image for 3 minutes after a node took it, stays in deletion or on a node that stopped reporting for 5 minutes, or runs 5 minutes past a deadline Kubernetes should have enforced, loses its task: requeued once, then failed, as for a worker that stops answering. The runner owns these tasks, so the worker heartbeat timeout does not apply to them.
- Disruption reruns. A pod the cluster takes away (a `DisruptionTarget` condition for preemption, kubelet termination, an API eviction or a taint, a pod the kubelet evicted because the node ran low on a resource, or a pod that vanished while its node stayed Ready) is created again for the same stage on the same volume, without using an attempt, so the build continues from the `target/` and cargo cache already there. The task log says so. After 3 such reruns the next one loses the task. An eviction for the pod's own ephemeral storage or `emptyDir` size limit is the step's failure. A step the kernel OOM-killed is the task's own failure: the task fails, and the repository's step memory grows (Pod sizes below).
- A pod no node takes: a later stage's pod is pinned to the node of the task's volume, so one the scheduler reports as short of CPU or memory there waits until the task's deadline (a capacity wait, shown as the environment's health warning); for any other reason it loses the task after 15 minutes. A task pod recreated after a disruption is pinned the same way. A first (task) pod the scheduler reports as short of room for 15 minutes is deleted and placed again, on another node when one fits, since its volume is not bound yet, at most twice; after that, or for any other reason, it loses the task after 15 minutes. A task whose deadline passes while its pod waits for room ends as failed ("passed its deadline waiting for build capacity") instead of being requeued.
- A failed create of a later stage's pod (rate limit, an API error) is retried after 15 s, doubling to at most 5 minutes; after 6 tries or 15 minutes the task is lost. A create the namespace's ResourceQuota refuses is a capacity wait: retried every minute until the task's deadline, not counted as a try. A task whose first pod cannot be created goes back to the queue without using an attempt; the environment then takes no task for a minute (when the quota refused it, a capacity wait shown as a health warning).
- After a restart the runner deletes pods and volumes whose task is no longer the environment's. The namespace cannot change while tasks run.

Capacity (`--capacity`). `fixed` takes up to `--slots` tasks at once. `cluster`, the default for new environments, sizes the work to the cluster and keeps `--slots` as the ceiling. An environment stored without the setting runs `fixed` until an operator switches it (`envs set <id> --capacity cluster`).

- When a task waits, each pass (no timer of its own) reads the nodes and the namespace's ResourceQuota once, shared by the environments in that namespace. The runner reads no other pod in the cluster.
- The quota is the build budget: `hard - used` for requests and limits of CPU and memory and, when the quota names them, of ephemeral storage. Node room is a Ready, schedulable node of the environment's arch, its allocatable minus `--node-reserve-cpu` and `--node-reserve-memory`, minus what our own runs reserve there. A run reserves its largest stage's request (pods.ts `taskRequest`) on its node for its whole life.
- Tasks are claimed in queue order while the next one fits the quota and some node; the first that does not fit ends claiming for the pass, so no smaller task takes its place. A task larger than every node of the arch (Ready or not), or than the quota's hard total, is left to other environments with a health warning; when no other enabled environment may run it, it fails at once with the size it needs.
- The scheduler is the feedback for the pods we cannot see: while one of our pods is Pending as Unschedulable, the environment claims nothing new.
- Placement: the runner picks the node (nodes whose warm status holds the repo's warm key first, then the node with the most free room at that moment, so runs spread), records it and the reservation on the run, and gives the task pod a required `kubernetes.io/hostname` affinity, so the volume binds there and every later stage follows.
- Environments that share a namespace but differ in `--arch` or node reserve each read their own view and do not see each other's claims against the quota; a create the quota then refuses is a capacity wait.
- The environment offers its running tasks plus how many more of the next task fit (at most `--slots`). If the nodes or the quota cannot be read (a 403 or another error), the environment runs its fixed `--slots` with a health warning.

Pod sizes. The task, source and upload pods request 500m CPU and 1Gi. Step containers request `--cpu-request` (limit `--cpu-limit`) and the repository's step memory, each at most `--max-pod-memory`. Step memory is automatic: each step wrapper samples its container's anonymous memory (cgroup `memory.stat`, once a second) and the task records the peak. With at least 3 measured builds in the last 30 days (the newest 20 count, each with its largest step), the request is the median build's peak and the limit the highest peak times 1.3, at least 2 GiB above it. With fewer, the environment's `--memory-request`/`--memory-limit` apply. An OOM-killed step raises the memory its repository has by 1.5 times, up to `--max-pod-memory` and the largest node's allocatable memory, and the raise stays as a floor under the automatic size. `autocraft-server tasks sizes list` shows every pipeline repository's effective memory and warm target, each marked automatic or override. `tasks sizes set <repo> --memory Q [--limit Q]` sets an override (the limit defaults to twice the request), `--memory auto` returns to automatic, and `--warm-target tmpfs|pvc|none|auto` does the same for the warm target. `tasks sizes clear <repo>` makes both automatic. Every build pod gets `--priority-class` (default `craft-build-task`), a low priority, so CI runners and services preempt builds; disruption reruns carry the build on.

Compile cache. With `--sccache-url` set, offline steps that mount the build dirs read the compile cache the cluster's CI runners fill (sccache over WebDAV, the read-only endpoint), when the repo has a CI gate. rustc runs through sccache in read-only mode; a step never writes the cache, and the pods never get its write credentials. The step's pod carries `craft.build/cache=read`, which the cluster's NetworkPolicy uses to let it reach the cache. sccache keys a compile on the compiler's libraries and version, its own release, the arguments, every `CARGO_*` variable and the working directory, so a cached step matches the gate's job:

| Matches CI | How |
|---|---|
| Rust release and sccache release | The `rust-stable` image pins both (`deploy/container/Containerfile.rust-stable`): the Rust release the gate's `stable` currently installs, and the sccache release the gate pins. A new Rust stable release means a new image. |
| `CARGO_HOME` | `/cache/cargo`, as on the runners, so registry crates compile in the same directory. |
| Checkout and target dir | The step works in `/home/runner/_work/<repo>/<repo>` (the same directory is also `/src`), with the target dir at its default `target/` there, not `CARGO_TARGET_DIR`. |
| Env | The gate's job env (`CARGO_INCREMENTAL=0`, `CARGO_NET_RETRY=10`, `RUST_BACKTRACE=1`, `CARGO_TERM_COLOR=always`, the last given to rustc only, so the step's output stays plain), then its `env`, `linux-env`, `dev-debug` and `dev-strip`. |
| Store | `sccache/<cache-version>` from the gate's `cache-version`. |

The step's output ends with `sccache --show-stats` (hits and misses). A step falls back to plain rustc when the cache cannot be reached, and a toolchain image without sccache builds uncached with a line saying so. Entries exist only for what the runners compiled (main-branch runs of repos whose gate enables sccache, for dependencies of every repo), so workspace crates of other repos and anything built with other features or profiles miss.

Disk use. The `local-path` provisioner does not enforce a volume's size: a step can write to `/target`, `/cache` and `/out` until the node's disk is full, and a node under disk pressure evicts other pods. What bounds it:

| Bound | Effect |
|---|---|
| The `disk` check before every step pod | Fails the task when the volume holds more than `--storage` (or more than two million files). It runs between step pods, not during a step. |
| `--max-step-sec` and each step's own limit | Caps how long one step can write. |
| `--ephemeral-limit` | Caps each container's `/src` copy, `/tmp` and logs (emptyDirs with a size limit); the kubelet evicts only that pod. |
| `--deadline-sec` | Caps the whole task; the volume is deleted when the task ends. |

So a single step can still exceed `--storage` while it runs, by as much as it can write in its time limit. A storage class that enforces size (a block volume, or a quota-capable local provisioner) removes that gap.

Settings (`envs add` and `envs set` options; `envs list` shows them):

| Option | Default | Meaning |
|---|---|---|
| `--namespace` | `craft-builds` | Namespace of the pods and volumes. |
| `--image` | `runner` | AutoCraft image of the task, source and upload pods. `runner` uses the runner's `AUTOCRAFT_IMAGE`. |
| `--toolchain-image NAME=REF` | none | Image the steps of tasks naming toolchain `NAME` run in; `NAME=none` removes it. With none set, the environment takes no task that names a toolchain (every pipeline build names `rust-stable`). `deploy/container/Containerfile.rust-stable` builds the `rust-stable` image. Steps run offline with a read-only rustup home, so a repository's `rust-toolchain.toml` must name the image's Rust release and only components and targets the image has; otherwise rustup's install attempt fails the step (`could not create temp file`). |
| `--worker-url` | `http://autocraft-worker-api.craft.svc:8981` | The worker API as the `api` pods reach it. |
| `--cpu-request`, `--cpu-limit` | `4`, `16` | Per step container. |
| `--memory-request`, `--memory-limit` | `4Gi`, `8Gi` | Per step container, for a repository without its own size (Pod sizes above). |
| `--max-pod-memory` | `64Gi` | Most memory a step container requests or is limited to, also after OOM raises. |
| `--capacity` | `cluster` | `cluster` or `fixed` (Capacity above); environments stored without it run `fixed`. |
| `--node-reserve-cpu`, `--node-reserve-memory` | `0`, `0` | Held back on every node under `cluster` capacity. |
| `--priority-class` | `craft-build-task` | Priority class of every build pod; `none` for the cluster's default. |
| `--ephemeral-request`, `--ephemeral-limit` | `4Gi`, `16Gi` | Per container: `/src` copies, `/tmp` and logs. |
| `--storage`, `--storage-class` | `40Gi`, `local-path` | The task's volume: source, `/target`, the cargo cache, `/out`, checkouts. A ReadWriteOnce local volume keeps a task's later pods on the node of its first. |
| `--deadline-sec` | `10800` | Longest a task may take from its first pod to its last. |
| `--max-step-sec` | `7200` | Longest one step may run, below its own limit. |
| `--runtime-class` | none | A sandbox runtime class (gVisor, Kata) when the cluster has one. |
| `--arch` | `x86_64` | Architecture the pods run on, for claim matching. |
| `--sccache-url` | none | Read-only WebDAV endpoint of the CI runners' compile cache (Compile cache above); `none` turns it off. |
| `--crate-mirror` | none | ClusterIP of the crate mirror that `mirror` steps use (Crate mirror above). |
| `--display` | `no` | `yes` when the toolchain images carry Mesa software Vulkan (the `rust-stable` image does): the environment reports the `display` capability and takes tasks that require it (screenshot verification). |
| `--warm-writer` | `no` | The warm producer (Warm producer above); needs `--sccache-url`, `--cache-write-url`, `--writer-secret` and `--signing-secret`. |
| `--cache-write-url` | none | Read-write WebDAV endpoint of the compile cache and warm store. |
| `--writer-secret`, `--signing-secret` | none | Secrets in the namespace: the cache's write credentials (`username`, `password`) and the warm store's Ed25519 signing key (`private.pem`). |

Crate mirror. A `mirror` step reaches crates.io and GitHub only through the crate mirror: its pod (`craft.build/network=mirror`) has `hostAliases` that resolve `index.crates.io`, `static.crates.io`, `github.com` and `api.github.com` to `--crate-mirror` (the mirror's fixed ClusterIP), mounts the ConfigMap `craft-mirror-ca` (key `ca.crt`) at `/etc/craft-mirror`, sets `CARGO_HTTP_CAINFO`, `GIT_SSL_CAINFO` and `SSL_CERT_FILE` to it, and sets `CARGO_NET_RETRY=10`. The dependency fetch passes these four through its cleared environment. Only an environment with `--crate-mirror` takes a task with a `mirror` step. The network policy admits a new pod's IP a few seconds after it starts, so a `mirror-wait` init container (after `disk`) retries a TCP connect to the mirror on port 443 every 200 ms for up to 30 s, and the task fails as an environment error, "the crate mirror is not reachable", if none succeeds.

Screenshots in pods. A pod has no display server. An environment with `--display yes` reports the `display` capability, so tasks that require it (the screenshot verification of a PR with visible UI changes) are claimed only there. Its step containers get `VK_ICD_FILENAMES` (lavapipe), `WGPU_BACKEND=vulkan`, `LP_NUM_THREADS` and a shader cache under `/tmp/cache`, since the root filesystem is read-only and only `/tmp` is writable. Take the before and after renders in the same toolchain image so they match byte for byte.

Warm producer. An environment with `--warm-writer yes` builds the current default-branch head of each covered repo in the pipeline scope, and publishes the result to the warm store (`warm/v1/` on the compile cache's WebDAV server, signed; src/warm/). It takes only tasks of step `warm`, and no other environment takes those, so it never runs PR code, a patch or a merge batch. Run it in its own namespace (`--namespace craft-warm`), since its pods hold the cache's write credentials and the signing key. Every pipeline repo is covered once any publish was trimmed (the publish left out the units its build did not use; it reads both cargo's `.fingerprint` layout and the `build/<package>/<hash>/` unit dirs, and a target with no profile dir of either kind is published untrimmed); before that, only repos an operator added are, since an untrimmed target grows by a whole set of units per dependency repin. `autocraft-server envs warm-repos` lists the covered repos and why. `warm-repos add <owner/name>` covers a repo before that point, `warm-repos exclude <owner/name>` never builds one, and `warm-repos remove <owner/name>` takes either back.

```
autocraft-server envs add warm --label "Warm producer" --kind kubernetes --slots 2 --namespace craft-warm --warm-writer yes \
  --sccache-url http://<cache>:8080 --cache-write-url http://<cache>:8081 --writer-secret craft-warm-cache-writer \
  --signing-secret craft-warm-signing [--crate-mirror <mirror ClusterIP>] --memory-limit 48Gi --toolchain-image rust-stable=<image>
autocraft-server envs warm-interval 15
```

| Rule | Detail |
|---|---|
| Queue | The main-CI poll (every 2 minutes) queues a `warm` task for a repo whose current head has no ended warm build with the writer's `rust-stable` image, unless one is queued or running. A new head and a new toolchain image both queue one; for a new image with the same toolchain (Warm starts below) that build restores the previous version, rebuilds nothing and records the new image's digest. A head whose warm build failed is not built again. |
| Claim | The task builds the newest head when it starts (merges that land while it waits share one build), at most one runs per repo, and builds of one repo start at least `warm_min_interval_minutes` apart (default 15, `envs warm-interval`). The plan is the environment's: `fetch deps` through the crate mirror when `--crate-mirror` is set, else over `fetch`. |
| Build pod | `toolchain-id` (toolchain image) writes the image's `rustc -vV` and toolchain file to the pod's `/meta`, which the build steps mount read-only. `warm-restore` (AutoCraft image) then fills a memory-backed target dir at `/home/runner/_work/<repo>/<repo>/target` with the key's newest version; a missing or unverifiable version, or one built with another toolchain, is a cold start. The build step runs at the CI paths with the gate's env, `CARGO_HOME=/cache/cargo` and sccache writing `sccache/<cache-version>` on `--cache-write-url`: the gate's `warm-command` (bash, offline) when it has one, else AutoCraft's workspace build, `cargo test --workspace --lib --bins --tests --no-run --locked` and `cargo build --workspace --lib --bins --locked` (the step log names which one ran). A repo's `warm-command` should build the same units as AutoCraft's workspace build (the same features and targets); otherwise build pods and workspace sessions rebuild instead of reusing the warm version. `warm-publish` then publishes the target and `CARGO_HOME`, with the image's digest, `rustc -vV` and toolchain key; once a day `warm-gc` follows it (3 versions per key, 24 h blob grace, 150 GiB). |
| Credentials | The writer Secret (keys `username`, `password`) reaches the build step, the publish and the gc as `secretKeyRef` env; the signing Secret (key `private.pem`) is mounted only into the restore, the publish and the gc, which verify with its public half. |
| Labels | The build pod carries `craft.build/network=none` and `craft.build/cache=write`, which reaches the cache's read and write ports. |
| Memory | The target dir is in memory, so `--memory-limit` must hold the target plus the build's peak. |
| Results | The task's results end with `warm publish`; a failed publish fails the task, a failed gc only logs. |

Worker environments keep their own warm builds (step `verify`, once a day per repo, queued only while a worker environment is enabled); build pods never take those.

What the cluster must provide:

| Item | Detail |
|---|---|
| `AUTOCRAFT_IMAGE` on the runner container | The image the runner itself runs, by digest (the downward API does not expose it). Or set `--image`. |
| Runner service account | Its token mounted into the runner container only, at the standard path. |
| Role in the build namespace | `pods`: create, get, list, watch, delete; `pods/log`: get; `persistentvolumeclaims`: create, get, list, delete. |
| NetworkPolicies in the build namespace | No ingress. `craft.build/network=none`: no egress. `fetch`: DNS and public 80/443, no private ranges. `api`: DNS and the runner's 8981. `mirror`: the crate mirror's 443 only, no DNS. With `--sccache-url`: `craft.build/cache=read` reaches the cache's read-only port (and DNS, for its service name). A warm producer's namespace: `craft.build/cache=write` reaches both cache ports and DNS. |
| ConfigMap `craft-mirror-ca` | With `--crate-mirror`: in the build namespace, key `ca.crt`. |
| Ingress to the runner | 8981 from the build namespace, if the runner's namespace denies by default. |

The health check `worker:<env id>` fails when the runner is not in a cluster, the API does not answer, the service account lacks a permission (checked with SelfSubjectAccessReview every minute), no AutoCraft image is known, or a pod could not be created. It warns when a pod has waited more than 3 minutes to start and when no toolchain image is set.

### Workspace tools

A session's `work` tools (shell, shell_status, shell_kill, read, write, edit, glob, grep, app_start, app_stop, screenshot, and fetch_dependencies below) run in its workspace pod through the helper `ws`; the job checks the arguments and the per-session limits (2,000 calls, 3 h of shell time by the job's clock, 4 execs at once, 4 background commands, 300 images). The call files under `/work/.ws` are writable by the session, so what they say about a command only informs those limits: the hard bounds are the pod's own (`activeDeadlineSeconds`, CPU and memory limits, the pid limit). `autocraft-server workspace tool <id> <tool> '<json args>'`, in the runner container, makes one call as a session would and prints its result.

**Apps and screenshots.** The pod's `ws init` starts Xvfb on `:0` (2880x1800x24, 96 dpi, no TCP, no window manager). The session drives an app through the app's own CLI with `shell`; the app tools only start, look at and stop it.

| Tool | What the helper does |
|---|---|
| `app_start` | `ws app-start`: starts Xvfb again if the display stopped answering (the result says so), refuses past 4 running apps (one with no pid 5 s after its start counts as ended), and runs the binary (below `/work`) in a session of its own, in `/work/src`, with `WGPU_BACKEND=vulkan`, `LP_NUM_THREADS=4`, lavapipe's `VK_ICD_FILENAMES` and `WINIT_X11_SCALE_FACTOR` from `scale`. The session's `env` (at most 16; not `DISPLAY`, `HOME`, `WINIT_X11_SCALE_FACTOR`, `VK_*`, `LP_*`, `XDG_*`) reaches only the app, through `env`, over these defaults, so `WGPU_BACKEND=gl` selects llvmpipe GL. It waits up to 30 s for a viewable top-level window: the largest one whose `_NET_WM_PID` belongs to the app's session, else the largest new window no process claims. Result: app id (the app_start call's id), pid, window id and geometry, log path (`/work/.ws/apps/<n>.log`); if the app exits first, its exit code and the last 4 KiB of its log; with no window after 30 s, the app keeps running and the result says so. The app picks its own window size: nothing resizes it. |
| `app_stop` | `ws app-stop`: SIGTERM to the app's session (SIGKILL with `force`), SIGKILL after 5 s; exit code and the last 2 KiB of the log. |
| `screenshot` | `ws shot`: captures the screen with ImageMagick `import -window root` and crops it to the app's window (re-found on each shot, so a recreated window is followed), then to `region` in window pixels. Without `app` it takes the only running app, else the whole screen. The full-size PNG stays at `/work/.ws/shots/<n>.png`; the image returned is scaled in the pod to `max_edge` (256–1568, default 1568) and checked job-side like `read`'s images. Each image counts toward the 300. |

The image carries Xvfb, x11-utils (`xwininfo`, `xprop`), ImageMagick, Mesa's lavapipe and llvmpipe and the fallback fonts (`deploy/container/Containerfile.rust-stable`). A runner restart hands app_start and screenshot calls still running back to the session along with shell calls: app_start then waits for the app it already started instead of starting another.

**Agent workspaces.** Operators' and maintainers' own agents open workspaces and call these tools through the MCP Connector (see Workspaces under [MCP Connector](#mcp-connector)); the runner runs those calls with the same session code and limits.

**Trying a workspace session.** `autocraft-server workspace try <repo> <sha> --item N --prompt TEXT --for LOGIN [--workspace ID] [--env ID] [--keep] [--deadline-sec N]`, in the runner or dashboard container, records a `workspace_sessions` row (kind `try`) and queues a `workspace-try` job, printing both ids. The item is an issue or PR of the repo that the model call is filed under; the prompt is at most 8 KiB and goes only into the call, never into the job's params or log. The job creates a workspace for the commit (or takes the live one `--workspace` names, which must hold the same repo and commit), waits for it to be ready (failing when the launcher fails or ends it, or after 26 minutes), then runs one session with the fix-issue patch prompt's model and effort, with only the workspace tools and a time limit of `--deadline-sec` (300 to 7200, default 3600). `--for` names the GitHub login (which must have a registered Task Runner) whose Task Runners alone run the call, in one of their slots, whatever their repo choices. The call fails the session if it waits more than 30 minutes in all for a Task Runner; while it is queued or leased the launcher does not park the workspace. A runner restart resumes the job on the same workspace and call. Its log has the outcome and cost, the number of tool calls and their shell time, and `git diff --stat` against the base commit with the new files. The model's final reply is written to the job log after the outcome line (job logs are hidden from viewers) and shown by `workspace show <id>` for the workspace's latest try session, each cut at 4 KiB. The workspace is ended afterwards unless `--keep` is given; the session row keeps the outcome. A job that ends without ending its session (its deadline, a cancel, a stop it does not resume from) has the session failed and the workspace ended (unless kept) on the launcher's next pass.

### Crate mirror

`autocraft-server crate-mirror serve` is a read-only mirror of crates.io and of an allowlist of GitHub repositories, for build pods without public egress. Clients keep the public URLs and reach the mirror through host aliases and a private CA, so cargo writes the same `registry/src/index.crates.io-<hash>` and `git/checkouts/<name>-<hash>` paths as with direct access (a `replace-with` source would change those directory names, and with them every fingerprint and sccache key). The process needs no database or GitHub credentials.

It terminates TLS for four names and picks the certificate by SNI; a client that sends another name, or none, fails the handshake, and a Host header that differs from the SNI name gets 421.

| Name | Serves |
|---|---|
| `index.crates.io` | Sparse index files and `config.json`, pulled through and cached 60 s. When upstream fails (5xx, timeout, unreachable), a copy up to 7 days old is served; older or never fetched: 502. Upstream 404 is passed on, drops the cached copy and is remembered for the same 60 s. ETag/If-None-Match with the client; the mirror revalidates upstream with its own conditional request. |
| `static.crates.io` | `/crates/<name>/<version>/download` and `/crates/<name>/<name>-<version>.crate`. A miss looks up the version's `cksum` in the upstream index over real TLS (never the cache), downloads the file and keeps it only if its sha256 matches; otherwise 502 and nothing stored. Stored files are never replaced. |
| `github.com` | Git smart HTTP for allowlisted repos only: `GET <owner>/<repo>[.git]/info/refs?service=git-upload-pack` and `POST …/git-upload-pack`, answered by `git upload-pack --stateless-rpc` from a bare mirror (protocol v0 and v2). Everything else, including receive-pack, is 404. |
| `api.github.com` | Always 404. Cargo asks it whether a git dependency moved; a 404 makes cargo fetch instead. |

Only GET and HEAD are accepted, plus that one POST. No client header reaches upstream (`Git-Protocol` only selects the local upload-pack protocol). For the POST, the repo, content type and encoding are checked before the body is read.

Limits:

- Sizes: index responses 32 MiB, `.crate` downloads 100 MiB, git request bodies 16 MiB (also after gzip), git responses 4 GiB.
- Clients: 1,024 connections, 100 streams per HTTP/2 connection, 10 s for the TLS handshake, 10 s for HTTP/1.1 headers and 60 s for the whole request, 30 s for a POST body, 120 s idle.
- Busy: 64 upstream requests (index refreshes and crate downloads, `--upstream-slots`) and 8 git processes serving clients at once. Requests past that wait in line, first come first served, up to 2,000 waiting per limit and 60 s each; a request the line cannot hold or that waited 60 s gets 503 with `Retry-After`. An index file with a copy under 7 days old is served from it instead of waiting. Cache hits take no upstream slot, and identical requests (same index file or crate version) share one upstream fetch, also while it waits. An upload-pack that produces no output for 60 s (the client stopped reading) is killed.
- Disk: no crate download starts while the data volume has less than 2 GiB free (`disk-low` in the log, 503); a full disk is logged as `disk-full`, and an index file that cannot be stored is still served.

**Storage** (`<data dir>/`): `index/` (LRU by last read, cap 2 GiB), `crates/` (LRU by last read, cap 50 GiB; a read sets the file's mtime at most hourly, so the order survives restarts), `git/<owner>/<repo>.git` (bare mirrors of `refs/heads/*` and `refs/tags/*`, HEAD following upstream's default branch). Every allowlisted repo is fetched (`git fetch --prune`) at start and every 2 minutes, and on `info/refs` when its last fetch is older than 30 s; a failed fetch counts as an attempt, so for the next 30 s requests are served from the mirror as it is without trying upstream again. An `info/refs` request waits at most 15 s for a fetch when a mirror already exists, then serves it. `git gc` runs weekly per repo. The allowlist is reread on each 2-minute pass; a repo removed from it is 404 from then on and its mirror is deleted. When the file cannot be read, the previous list stays in force and nothing is deleted. Repos must be public: the mirror fetches without credentials.

**Logs**: one JSON line per request on stdout (`event: "request"`, host, method, path without the query, status, ms, `cache: hit|miss|revalidated|stale`, bytes), plus `upstream-error`, `checksum-mismatch`, `disk-low`, `disk-full`, `store-error`, `git-fetch`, `git-gc`, `git-error`, `git-allowlist-error`. No client addresses or headers are logged.

**Config** (flag, then variable, then default):

| Flag | Variable | Default | |
|---|---|---|---|
| `--listen` | `AUTOCRAFT_MIRROR_LISTEN` | `0.0.0.0:8443` | TLS listener (map the Service's 443 to it) |
| `--health-listen` | `AUTOCRAFT_MIRROR_HEALTH_LISTEN` | `0.0.0.0:8080` | Plain HTTP, `/healthz` and `/readyz` only; the answer carries store sizes and the repo count |
| `--data-dir` | `AUTOCRAFT_MIRROR_DIR` | `/data` | Volume for the stores |
| `--tls-dir` | `AUTOCRAFT_MIRROR_TLS_DIR` | `/tls` | `<name>.crt` and `<name>.key` for each of the four names (a leaf with several names may be repeated under each); all eight files are required at start and reloaded within 5 minutes when they change |
| `--git-allowlist` | `AUTOCRAFT_MIRROR_GIT_ALLOWLIST` | none | File, one `owner/repo` per line, `#` comments |
| `--git-repos` | `AUTOCRAFT_MIRROR_GIT_REPOS` | none | Inline list, comma or space separated; added to the file's |
| `--crate-cap-gb` | `AUTOCRAFT_MIRROR_CRATE_CAP_GB` | `50` | |
| `--index-cap-gb` | `AUTOCRAFT_MIRROR_INDEX_CAP_GB` | `2` | |
| `--upstream-slots` | `AUTOCRAFT_MIRROR_UPSTREAM_SLOTS` | `64` | Upstream requests at once |

The mirror pod itself must resolve the real names (no host aliases) and reach public 443. It runs as any uid that can write the data dir, with `git` on `PATH` (the AutoCraft image has it).

**Clients.** `hostAliases` mapping the four names to the mirror Service's ClusterIP, the CA certificate mounted (for example at `/etc/craft-mirror/ca.crt`) and:

- `CARGO_HTTP_CAINFO=/etc/craft-mirror/ca.crt` for cargo's own HTTP (index, downloads) and for git dependencies fetched by cargo's built-in git (libgit2), which goes through the same HTTP stack.
- `GIT_SSL_CAINFO=/etc/craft-mirror/ca.crt` for the git CLI, which cargo uses with `CARGO_NET_GIT_FETCH_WITH_CLI=true`.
- `SSL_CERT_FILE=/etc/craft-mirror/ca.crt` for other OpenSSL-based tools.
- `CARGO_NET_RETRY=10`, so cargo retries a 503 from a full line instead of failing the fetch.

The CA file replaces the system bundle for these clients, so they trust nothing but the mirror. Cargo's HTTP stack also reads `SSL_CERT_FILE` when `CARGO_HTTP_CAINFO` is unset. Verified with cargo 1.99 in a container with host aliases to the mirror: `cargo fetch --locked` of a project with crates.io dependencies and a GitHub git dependency (by tag) wrote `registry/src/index.crates.io-1949cf8c6b5b557f` and `git/checkouts/ryu-9e38bd28e6ca957f`, the same names as a direct fetch, both with the default libgit2 mode and `CARGO_HTTP_CAINFO` alone and with `CARGO_NET_GIT_FETCH_WITH_CLI=true` plus `GIT_SSL_CAINFO`; without the CA cargo fails with an invalid-certificate error. `cargo update` in a CARGO_HOME that already had the git dependency asked `api.github.com`, got 404 and fetched from the mirror.

### Warm starts

A repository's warm target lets its build pods start from the warm version their node holds (Warm sync on the nodes below) instead of an empty target dir. Warm producers' own builds never do.

A version is built with a toolchain: the toolchain image's digest, `rustc -vV`, and the image's toolchain key, the sha256 of `/usr/local/share/autocraft/toolchain.txt`, which `Containerfile.rust-stable` writes at build time: what can change compiled output (Rust release, components, targets, sccache release, and the versions of the C toolchain, of the tools build scripts run or load such as clang, cmake, protoc, perl and python3, and of every `-dev` package). A pod starts from a version built with its own image, or with another image whose `rustc -vV` and toolchain key are both the same (src/warm/toolchain.ts). A rebuild that changes none of these keeps every warm version, including one that only adds packages no build script runs, loads or links against (Xvfb, Mesa's drivers, ImageMagick, a runtime library without its `-dev` package); a new Rust release, C toolchain or `-dev` package does not. The runner knows an image's key once a version built with it is on a node (the warm producer's build after the image changes); until then a pod of that image starts only from versions of the same digest. In the pod, `toolchain-id` (toolchain image) reads the key before `warm-copy` or `warm-restore` checks it again. Versions published before toolchain keys were recorded carry none, so they match only their own digest. It is automatic from the key's last published version: `tmpfs` when the memory-backed dir below needs at most 16 GiB, `pvc` when larger, `none` until a version is published. `tasks sizes set <repo> --warm-target tmpfs|pvc|none` overrides it, `auto` returns to the automatic choice.

| Target | Where the copy goes | When it is used |
|---|---|---|
| `tmpfs` | A memory-backed dir of the version's size times 1.2 plus 4 GiB (room for a second set of dependency units after a Cargo.lock change), which the pod's memory request and limit grow by. The task reserves it on its node when it starts, sized from the key's last published version. | That size is under 32 GiB, within what the task reserved, and fits beside the memory limit on the largest build node. |
| `pvc` | The task's volume. | Only when the version was built from the checkout's own Cargo.lock: a target one dependency update behind saves about what the copy costs. |

For each offline step pod of such a task the runner reads the node's `warm-status-<node>`. The pod starts warm when the status lists the repository's key built with the pod's toolchain and CI env, and the target's rule holds; the task log says which version it starts from, or why it starts cold. The pod mounts the node's claim `craft-warm-<node>` read-only with `subPath: <key>` at `/warm`, runs its steps at the CI checkout paths, and first runs `warm-copy` (AutoCraft image), which:

1. Resolves `current` once and reads everything from the version dir it names, so a swap by warm-sync during the copy cannot mix versions. Verifies the version's `latest.json` with the public key from the ConfigMap `warm-verify-key` (key `public.pem`, mounted at `/keys/verify`) and the manifest's sha256 against it, and checks that the commit is the one the runner chose and that paths, toolchain (against what `toolchain-id` wrote), CI env (the gate env, cache version and craft-fonts and craft-i18n commits) and (for `pvc`) Cargo.lock match. Anything else is a cold start, logged.
2. Copies the target and CARGO_HOME with 8 `cp -a` processes at once (the top four directory levels are split into batches of entries; modes, mtimes, symlinks and hard links are kept; CARGO_HOME goes into a dir beside it) whose entries then move in with renames, keeping what an earlier step already fetched, and logs `warm copy N GB in X s`. A failed copy leaves neither behind and starts cold. A volume target that already holds a finished copy or a build (a later offline pod of the same task, a rerun) is kept, and a task whose first offline pod started cold stays cold.
3. Sets every checkout file's mtime to 2001-01-01 and the files that changed since the warm commit to now, so cargo rebuilds only what changed. It also sets every file of the gate's extra checkouts (`/craft-fonts`, `/craft-i18n`, under the volume's `ext/`) to 2001-01-01, because their path-dependency inputs (such as the font manifest) would otherwise make cargo rebuild every crate that reads them; the warm-copy container does this while the volume is still writable (the steps mount them read-only), and only for a `trimmed` version (its env hash, which covers both commits, matched). An untrimmed version may hold units the producer restored from a build against other checkouts, so there the ext mtimes stay as copied. A cold start leaves all mtimes alone. For a file of the warm commit that the checkout no longer has, the nearest `Cargo.toml` above it and its nearest remaining dir count as changed. The source pod makes that list from a tree-only fetch of the warm commit from GitHub. This needs a version whose manifest is `trimmed`: the producer's publish left out every unit its build did not read, so each unit kept was checked at the warm commit. Without that, or without the list (the fetch failed, more than 5,000 files changed, or the node took a newer version meanwhile), every file counts as changed: correct, but every workspace crate rebuilds.

**Fetching dependencies.** The workspace pod has no network, so a session that adds a crate or a newer version of one calls `fetch_dependencies` after editing `Cargo.toml` (src/build/workspace-fetch.ts). The job starts a fetch pod (`<workspace pod>-fetch-<call>`, label `craft.build/network=mirror`) on the workspace's volume, at its paths and env without `CARGO_NET_OFFLINE` (with `HOME=/tmp` and no global or system git config), with a build pod's mirror parts: the mirror's CA, `mirror-wait` (30 s) and hostAliases that send crates.io and GitHub to the crate mirror. It runs `cargo fetch` (not `--locked`, `CARGO_NET_RETRY=10`, 10 min limit) in `/work/src` or the `path` given, which updates `Cargo.lock` and `CARGO_HOME` on the volume. The result is the `Cargo.lock` diff against the base commit (`git diff -- ':(glob)**/Cargo.lock'` in the workspace pod, cut at 30 KiB), or the end of cargo's output. A fetch holds all of the session's exec slots, so it waits for the foreground commands running and the session's other calls wait for it (background commands keep running); the launcher's checkpoint waits for it too. A failed read of the pod is retried until the call's deadline. Without the environment's `crateMirror` setting the tool refuses, and a mirror that does not accept connections fails the call: there is no fallback to the public network. The implement prompt mentions the tool only where the environment has a mirror; elsewhere a session that needs a dependency reports blocked. The job deletes the pod when the fetch ends; the launcher's pass deletes a fetch pod whose workspace is no longer ready on the pod it was made for (parked, ended, resumed elsewhere) or that is older than any fetch can take (about 16 min). A runner restart hands the call back to the session, which waits for the same pod.

### Workspaces at the CI paths

A workspace of a repository with a warm target (layout 2, recorded on the row when it is requested) works where the CI runner builds, so its first build starts from its node's warm version as a build pod's does (src/build/workspace-layout.ts), when the session builds with the whole-workspace commands the implement prompt names. Other repositories keep layout 1: checkout `/work/src`, `CARGO_HOME=/work/cargo`, `CARGO_TARGET_DIR=/work/target`.

| Path | Layout 2 |
|---|---|
| `/home/runner/_work/<repo>/<repo>` | The checkout (volume subPath `checkout`). `/work/src` is a link to it, so the session's paths stay the same; `ws` accepts files below it (`WS_CHECKOUT`). |
| `<checkout>/target` | The target dir, no `CARGO_TARGET_DIR`: volume subPath `cargo-target`. `/work/target` is a link to it. `ws untar` ignores the mount point and excludes `/target` from git. |
| `/cache/cargo` | `CARGO_HOME` (volume subPath `cache`). |
| `/craft-fonts`, `/craft-i18n` | The session's own copies of the CI gate's checkouts at the commits the base commit names, read-only (subPaths under `ext/`), copied in while seeding from AutoCraft's clones. |

The pod's env is the CI gate's step env at the base commit (as a build pod's source pod reads it, with `CI=1` and `CARGO_INCREMENTAL=0`) plus the workspace's own: `HOME=/work/home`, `CARGO_NET_OFFLINE=true` and the display. While requested, the runner reads the gate and the sha256 of the base commit's `Cargo.lock` from its clone, 3 tries 30 s apart before the workspace fails.

How the target starts:

1. A fresh volume is sized from the key's last published size: 2.6 times it plus 8 GiB, at least the environment's `--workspace-storage` (photocraft's 27 GB target grows to 50-70 GB in a session). The runner picks a node whose fresh warm status lists the key built with the workspace's toolchain and CI env hash, and the base commit's Cargo.lock; the newest version wins, then the node with the fewest workspaces, then the lower disk usage; nodes whose disk is over 85% full are skipped. A workspace's target is always on its volume, whatever the repository's warm target (`tmpfs` and `pvc` alike): the warm target only decides whether the workspace starts warm (`none` starts cold), and the Cargo.lock check applies to every warm start. Otherwise the target starts cold, and the reason is logged.
2. A warm pod mounts that node's claim `craft-warm-<node>` read-only, which pins it there, and runs `warm-copy` before the workspace container, with the Cargo.lock sha256 from the runner (the checkout arrives later). Any node holding the version may run the workspace, the AutoCraft service's nodes included: the pod's isolation (restricted Pod Security, no service-account token, no network, no credentials) is what keeps it apart. A pod the scheduler cannot place on its warm node for 3 minutes is made again cold, without the claim.
3. Seeding unpacks the source, the gate's checkouts and then sets the checkout's mtimes against the warm commit: every file to 2001-01-01 and the files changed since the warm commit (from the runner's clone, with the build pods' deleted-file rule) to now, when the version is `trimmed`; otherwise every file to now. The same step sets every file of the gate's checkouts under `/work/ext` to 2001-01-01 in `list` mode (a trimmed version); in `all` mode they stay as copied. A checkpoint applied on a rebuild then gives its files newer mtimes.
4. The result is the row's `warm` note (`warm copy N GB in X s from <key>@<commit> on <node>`, or `started cold: <why>`), shown on the item page's history and by `workspace show`; `warm_commit` names the version.

A parked workspace resumed on its kept volume keeps its target and copies nothing. A resume onto a new volume starts over from step 1.

### Warm sync on the nodes

`autocraft-server warm-sync` runs on every node (a DaemonSet in the cache namespace) and keeps the newest signed version of each assigned warm key in a node directory that build and workspace pods mount read-only. Versions come from the warm store (`warm/v1/` on the shared WebDAV cache, src/warm/store-client.ts), read through its anonymous read-only URL.

Layout of the node directory:

| Path | What it is |
|---|---|
| `<key>/gen-<sha12>/target`, `cargo` | One version: the target dir and the dependency part of CARGO_HOME, with the producer's modes and mtimes. |
| `<key>/gen-<sha12>/meta.json` | Key, repo, commit, `stored`, bytes, files, toolchain image, rustc, toolchain key, env hash, and the checkout, target and CARGO_HOME paths the producer built at. Cargo's fingerprints hold absolute paths, so a consumer builds at those paths. |
| `<key>/gen-<sha12>/manifest.zst` | The version's manifest, the hard-link source for the next one. |
| `<key>/gen-<sha12>/latest.json` | The version's signed record from the store, which build pods verify before they copy from it. |
| `<key>/current` | Symlink to the version consumers start from. |

Every 60 seconds the agent:

1. Reads the assignment and every assigned key's `latest.json`, and verifies its signature. A latest.json that is unsigned, signed by another key, or older (`stored`) than the newest version this node ever accepted for the key is refused, and the held version stays. The newest accepted `stored` is kept in `<dir>/<key>.floor`, which survives a key being retired and its directory deleted. To accept an older latest.json on purpose (the producer's clock was ahead and published a `stored` in the future), delete `<dir>/<key>.floor` on every node, and the held version's directory if its `stored` is the future value.
2. Plans the cap: keys in priority order, each with the bytes of the version it holds until its newer version is current (a key with no version counts its newest). A key that does not fit under `maxGbPerNode` after the keys above it is left out, and stops being current; a key whose version grew pushes lower keys out only once the larger version is current.
3. Syncs each key whose newest version it does not hold, one at a time. It builds `gen-<sha12>.tmp` from the manifest: files whose sha256 and mode match the current version (mtime within the slack) are hard links, provided the file is still as the agent left it (owned by the agent's uid and gid and not group- or other-writable; a kubelet fsGroup relabel breaks this), and the rest are downloaded and checked against their sha256. Disk writes are paced to `AUTOCRAFT_WARM_WRITE_MB_PER_SEC`. The finished dir is renamed into place and `current` is swapped with a rename. No new version starts while the node filesystem is at least `AUTOCRAFT_WARM_MAX_FS_PCT` full or would be after adding the version's full size (files that become hard links cost nothing, so this is a bound), and a download stops when use reaches the limit. Only a missing blob, one larger than the manifest says, one that is not valid zstd or one whose sha256 differs counts as a bad blob; timeouts, connection errors, 5xx answers and a full disk are plain failures. A failed sync leaves `current` untouched and is retried after 10 minutes or when latest.json changes.
4. Deletes versions that stopped being current more than `AUTOCRAFT_WARM_GRACE_MIN` ago, so copies that started from them can finish. Build pods may build straight from the read-only mount until their deadline (`deadlineSec`, 3 h by default), so the grace period must be at least the longest deadline plus 30 minutes; the agent cannot see deadlines, so the default is 210 minutes and must be raised with the deadline. A new version never reuses the name of a version still in its grace period (it gets a `-2`, `-3` suffix). A key no longer assigned also stops being current and goes the same way.
5. Writes the ConfigMap `warm-status-<node>` when what it says changes, and every 5 minutes from a timer that runs while a sync is in progress, so a long sync does not make the node look stale.

Versions on disk that have not yet been checked get group/other write cleared once (marker `.modes-ok2`). Nothing is deleted for this: a file with another owner or group is not reused and the next version downloads it.

Settings, all environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `AUTOCRAFT_WARM_STORE_URL` | required | WebDAV root of the warm store, read-only port. Plain http only to cluster-internal or private hosts. |
| `AUTOCRAFT_WARM_VERIFY_KEYS` | required | Comma-separated Ed25519 public key PEM files, read each cycle. |
| `AUTOCRAFT_WARM_NODE` | required | The node's name (downward API `spec.nodeName`). |
| `AUTOCRAFT_WARM_DIR` | `/var/lib/craft-warm` | The node directory (hostPath). |
| `AUTOCRAFT_WARM_ASSIGN_DIR` | `/etc/warm-assign` | The mounted `warm-assign` ConfigMap, read each cycle. |
| `AUTOCRAFT_WARM_PLACEMENT_DIR` | `/etc/warm-placement` | The mounted `warm-placement` ConfigMap (optional), read each cycle. |
| `AUTOCRAFT_WARM_STATUS_NAMESPACE` | the pod's namespace | Where the status ConfigMap is written. |
| `AUTOCRAFT_WARM_WRITE_MB_PER_SEC` | 150 | Download write rate in MB/s; 0 for no limit. |
| `AUTOCRAFT_WARM_POLL_SEC` | 60 | Time between cycles. |
| `AUTOCRAFT_WARM_GRACE_MIN` | 210 | How long a replaced version stays; at least the longest build deadline plus 30 minutes. |
| `AUTOCRAFT_WARM_MAX_FS_PCT` | 80 | No new versions at or above this filesystem use. |

`--once` runs one cycle and exits. When the assignment cannot be read, the agent changes nothing in that cycle.

The `warm-assign` ConfigMap has two keys, mounted as files:

```yaml
data:
  repos: |
    # one warm key per line, highest priority first
    deckcraft
    designcraft
  maxGbPerNode: "300"
```

`maxGbPerNode` is in GiB and counts the versions keys are current at. A replaced version stays for the grace period on top of it, and the filesystem limit bounds the total.

Placement. The runner places each covered repo's key (Warm producer above) on 2 nodes, so a build has a choice of warm node without every node holding every repo. It writes `placement.json` in the ConfigMap `warm-placement` (`{"version":1,"keys":[{"key":…,"nodes":[…]}]}`, keys in priority order) at most every 5 minutes, when the result changed. A key stays on its nodes while they report and have room; otherwise it goes to the nodes with the most room: free disk up to 85% of the filesystem, plus the warm bytes the node holds, at most `maxGbPerNode`, less what larger keys placed before it take. When `placement.json` holds a placement, an agent keeps only the keys placed on its node, in its order, and `repos` is not used; without one (no ConfigMap, or the cluster's initial `{}`), it keeps every key `repos` lists. The runner never creates the ConfigMap, and writes nothing while no node reports or no repo is covered.

The status ConfigMap holds one key, `status.json`: `node`, `updated` (ms, the node's clock), `fs` (`sizeBytes`, `usedBytes`, `usedPct`), `keys` (key → `commit`, `stored`, `bytes`, `image`, `envHash`, `synced`), `pending` (assigned key → why it is not at its newest version), and `error` (present when the assignment cannot be read; the agent then changes nothing), and `badBlobs` (key → sha256 of blobs that were missing or did not match their sha256 in a failed sync; the producer passes them to publish's recheck). The agent writes it with the in-cluster service-account token, so its service account needs `create` and `patch` on configmaps in its namespace. The status ConfigMaps carry the label `craft.build/warm-status=node`. One service account serves every node, so any node's agent can write any node's status; that is acceptable while the status is informational.

What the DaemonSet needs:

| Item | Detail |
|---|---|
| User | A uid of its own, not the build pods' uid, so build pods cannot write warm files. Read-only root filesystem, no capabilities. |
| Volumes | hostPath `/var/lib/craft-warm` read-write; ConfigMaps `warm-assign` and `warm-verify-key` (key `public.pem`) mounted read-only, and `warm-placement` mounted read-only with `optional: true`. |
| Network | Egress to the cache's read-only port and the API server. |

**On the runner.** The pod launcher reads every `warm-status-*` ConfigMap in `craft-cache` (or `AUTOCRAFT_WARM_STATUS_NAMESPACE`) once a minute; that needs `list` on configmaps there (it selects by the label `craft.build/warm-status=node`). Placement needs `get` there and `patch` on the ConfigMap `warm-placement`, which the cluster's configuration creates once (with `{}`) and does not overwrite. A status not rewritten for 15 minutes counts as not warm and is not counted in M. A node whose agent reports an error shows `node: message` on the environment's Warm row and in `envs list`. Each kubernetes environment reports a line per key, shown on its card under Warm and by `envs list`: `warm: <key> <sha12> on N/M nodes`, where N nodes hold the key's newest version and M nodes report a status.

**Caches report.** The Caches block on the Build environments page (`GET /api/envs/caches`, everyone signed in, keys of repos the reader cannot see left out) and `autocraft-server envs caches [--json]` show the same report:

| Part | Shows | Source |
|---|---|---|
| Repositories | Per covered, added, excluded or built repo: the published version (the last successful warm task: commit, end, size) and whether it is up to date, behind main or of another toolchain image than the warm writer's; the last warm task (state, summary, link); the warm target and whether an operator set it; how many fresh nodes hold the published version | `build_tasks` (step `warm`), `main_ci`, `build_sizes`, the `warm_bytes:<key>` settings, warm-repos coverage |
| Nodes | Per node: when its status was written (stale after 15 minutes), disk use, warm bytes (current and in grace), each key held (commit, size, synced, an older version, not placed here), pending keys with the reason, bad blob counts, an agent error | the `warm-status-*` ConfigMaps |
| Placement | Per key, its nodes and whether each holds the newest version, an older one or none yet; why the runner could not place | the runner's last placement pass |
| Crate mirror | The git allowlist and the environments with `--crate-mirror` | ConfigMap `crate-mirror-git-allowlist` (key `allowlist.txt`, `AUTOCRAFT_MIRROR_ALLOWLIST_CONFIGMAP` to rename) in the warm status namespace, read every 5 minutes while an enabled environment has a crate mirror; the runner's `get` on configmaps there covers it |

Only the runner reads the cluster, so the pod launcher stores its reads in the settings row `warm_report` when they change, and at least every 5 minutes while only the report times move. The row bumps the `envs` live topic, which the planner does not read. The mirror's health and store sizes (its `/healthz`) are not in the report: the runner cannot reach the mirror's health port.

## Similar items and semantic search

`autocraft-server embed [--all] [--threads N] [--batch N]` embeds every tracked item whose text changed since its last embedding (`--all`: every tracked item) into `item_embeddings`, and removes vectors of items that left the mirror or the tracked repos. Each batch commits on its own, so an interrupted run continues where it stopped. The dashboard reads the table for "Similar items" on the Item page and for the search box's meaning toggle; it embeds search queries, and items without a vector yet, itself.

- Model: [bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) (384 dimensions, int8 ONNX from `Xenova/bge-small-en-v1.5`), run on the CPU through `@huggingface/transformers`. The first use downloads it (34 MB) from Hugging Face.
- Text: the title, a newline, then the first 1,000 characters of the body with HTML comments, code blocks, images, URLs and Markdown markup removed (`src/embed/text.ts`); at most 256 tokens. Its hash decides whether an item is embedded again.
- Vectors are float32 and unit length; the server keeps them in memory, reloads them when the table changes, and ranks by dot product (cosine similarity).

| Variable | Meaning |
|---|---|
| `AUTOCRAFT_MODEL_CACHE` | Where model files are kept. Default `$XDG_CACHE_HOME/autocraft/models` (`~/.cache/...`). Missing files are downloaded at the first embedding, so the directory can be scratch storage (a Kubernetes `emptyDir`); each new process then downloads the model once. |
| `AUTOCRAFT_EMBED_MODEL` | `bge-small-en-v1.5` (default), `multilingual-e5-small` or `all-MiniLM-L6-v2`. Changing it makes the next `embed` run embed everything again. |
| `AUTOCRAFT_EMBED_THREADS` | CPU threads for `embed` (default and maximum 8). The server uses 2. |

## License

AutoCraft is dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.

## Reference documentation

A repo can have private reference documentation: plain-text pages (`.txt`, `.md`), the images they name (`.png`, `.jpg`, `.gif`, `.webp`, `.svg`; a page names one as an `[image: images/<file>]` line) and the source PDF, in `<data dir>/reference/<repo>/` (the directory of the mirror database). The calls that judge reference-app behaviour (`review.opus`, `dupes.compare-prs.opus`, `decide.prepare`, `conversation.turn`) get the folder read-only at `/reference` when it exists.

- Import: `tar -cf - -C <dir> . | autocraft-server reference import <repo> [--replace]`. The archive may hold plain files only, at most one sub-directory level, names of `[A-Za-z0-9._-]`, 1 GB in total. It is extracted beside the folder and renamed into place; the import is audited as `reference-import`.
- List: `autocraft-server reference list` (repo, file count, size).
- `node scripts/reference-split.mjs <pdftotext -layout output> <out-dir>` writes one file per page (`p0001.txt` is PDF page 1) and an `index.txt` of page headings.
- The content is never quoted, cited, named or posted: not in reviews, comments, decisions, the repository or commits.

## Job deadlines and check limits

The deadline of a job is the larger of the step's `maxMin` (`src/stages/registry.ts`, from the history of finished jobs) and the bound the code allows (`src/runner/deadlines.ts`: for each model call its prompt's time limit, plus the check tool's wall time and a turn per lint round for a patch call, times its attempts and the job's items, plus a quarter and 5 minutes). Past it the runner records `stopped: ran past N min`; the job sees that at its item boundaries, finishes the writes of its current item and stops. If it is still running 10 minutes later the runner stops its process as a cancel does. The job is failed with that message, and the step waits at least 1 hour before the planner starts it again, whatever the input does. A job that writes no new job log line for longer than its longest single model call plus 10 minutes (`stepNoProgressMin`; the registry floor for a step with no model call) is stopped the same way with `stopped: no progress for N min`, with the same 1-hour wait and header warning. Operator cancel is unchanged: it stops the process at once. The header shows a warning until an operator acknowledges it or a later job of the step succeeds.

Floors of `maxMin` in minutes, about twice the longest job in 30 days of history: fixup 120; decide 75; opus-review 70; premerge, main-fix, embed 60; dupes-compare 50; cifix 40; prioritize, labels-apply, conversation, postmerge, areas-* 30; classify-new 20; merge 15; classify-all 120; every other step 10. A step missing from the registry (the security steps, review-batch) has 60 unless the code's bound is larger.

The check tool stops one check after 5 times the median duration of the repo's recent checks of that command (the last 20 successful runs of the same shape, at least 3; full or partial run by crate and test name; exit code 0 for cargo; measured from when a worker took the task), within 5 to 15 minutes; with less history the limit is 15 minutes. The limit covers run time only; a check that waits for a worker keeps the 45-minute cap on all check time of the call. The job log then says what the check was doing: the task state (still queued means no worker took it) and the last 20 lines of the task's output. The worker streams `cargo check` and `cargo test` output to the task log as well as to the artifact, and the log stays with the task (`build_task_logs`, shown on the task's page).
