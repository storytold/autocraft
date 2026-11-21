# Operations reference

Local mirror of every storytold issue and PR, the triage pipeline's state, and the backlog dashboard.

- `autocraft-server sync` fills a SQLite mirror (`~/.local/share/autocraft/mirror.db`, or `$AUTOCRAFT_DB`) from GitHub GraphQL. Agents and scripts query the mirror instead of calling `gh`.
- `autocraft-server whitelist` shows and edits which contributors' PRs may merge on green CI without a decision.
- `autocraft-server decide` turns items that need a maintainer's scope call into dashboard decisions, each with an AI summary (`docs/pipeline.md`, Decide).
- `autocraft-server labels ensure|plan|apply --repo R` is the pipeline's Label stage: puts each item's settled type label and flags on GitHub. `plan` and dry runs only read; `apply --apply` writes, and only for repos an operator approved on the dashboard Repos page. See docs/pipeline.md.
- `autocraft-server dash serve` serves the dashboard.
- `autocraft-server runner serve` runs the pipeline: while the pipeline is On (switch on the dashboard's Pipeline page, or `autocraft-server pipeline on`), it queues and runs the steps that have work, within each stage's daily limit. Turning it Off cancels queued automatic jobs; running ones end at their next model call (queued calls are withdrawn) and their GitHub writes are refused. `autocraft-server pipeline drain` also cancels queued automatic jobs and starts and plans nothing new, while jobs already running finish and keep their writes and their queued and leased model and helper calls (the dashboard shows Draining; `pipeline on` ends it). `pipeline drain` is refused while the pipeline is Off. A deploy runs `pipeline drain`, waits for the running jobs, deploys, then runs `pipeline on --if-draining`, which switches on only a pipeline that is still draining, so an operator's Off stays Off.
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

#### Webhooks

The poll stays the backup and serves repos without the GitHub App. With webhooks on, a change reaches the dashboard in seconds instead of up to a minute. Setup, in the app's GitHub settings under General (an app manager does this):

- Webhook: Active. Webhook URL `<AUTOCRAFT_BASE_URL>/webhooks/github`, content type `application/json`, secret: the value of `github_app_webhook_secret` in the secrets file (GitHub returns it when the app is registered from the dashboard; if the key is empty, set a secret in the app's settings and store the same value as `github_app_webhook_secret` in the secrets file). The dashboard reads the secret at start, so restart it after the secret changes.
- Permissions (Permissions & events): read access to Issues, Pull requests and Checks (and Commit statuses if `status` is wanted; AutoCraft ignores it). The answer to a command in a comment (below) is a comment by the app under the app identity, which needs write access to Issues and Pull requests; an app registered from the dashboard has both (`appManifest` in `src/github/app.ts`). After raising a permission in the app's settings, the owner of each installation approves it there before it takes effect.
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

The app's slug is `github_app_slug` in the secrets file; without the app there are no commands. The **Issue comment** event must be subscribed (it is in the list above).

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
| `AUTOCRAFT_REVIEW_BOTS` | Comma-separated logins of review bots whose comments never make a review stale, besides accounts of type Bot or ending in `[bot]`. Default `coderabbitai,dependabot,renovate`. Read by `sync` (when it stores a comment), the database backfill and the runner, so set it for all three alike. |
| `AUTOCRAFT_WEB_DIST` | Directory of the built frontend. Default `web/dist` in the repo. |
| `AUTOCRAFT_SECRETS_FILE` | JSON file with `github_client_id`, `github_client_secret` and `session_key` (at least 32 characters, random). Must be mode 0600; the server refuses to start if it is missing, incomplete, or readable by group or others. Registering the GitHub App from the dashboard (GitHub App page, operators only) adds `github_app_id`, `github_app_slug`, `github_app_private_key`, `github_app_client_id`, `github_app_client_secret`, `github_app_webhook_secret` and `github_app_owner` (`{"login", "type"}`, the user or organization that owns the app). The GitHub App page's Remove button deletes every `github_app_*` key through the same atomic write (refused while the GitHub identity is the GitHub App) and links to the app's GitHub settings page, where the operator deletes the app. The dashboard rewrites this file itself for that: it writes a temporary file beside it and renames it over the file (a symlink stays a symlink), so the directory must be writable by the server user. Registration checks this first and refuses to start when it cannot write. The server reads the app's keys again whenever the file changes, so registering or removing the app needs no restart. Whether GitHub reads, writes and dashboard sign-in use the box account or the GitHub App is one instance-wide setting (GitHub App page, or `autocraft-server identity [box|app]`); switching ends every dashboard session and takes effect in the runner and the dashboard at their next GitHub call, without a restart. Under `box`, every `gh` and `git` call uses the server user's own `gh` login. Under `app`, every read (GraphQL, REST, git fetch over HTTPS, the image proxy, repository checks when tracking) runs with an installation token of the owner it concerns (the first tracked repo's owner when a read names none) and never sees the box account's credentials; the `gh` login of the server user is not needed. A read for which no installation token can be minted fails with an error naming the owner. The GitHub rate figures shown on the Pipeline page and used by the sync's reserve are those of the token in use. Permission checks of a signed-in person use that person's own token in both modes. |
| `AUTOCRAFT_GITHUB_APP_NAME` | Name suggested on the registration form. Default `AutoCraft`; at most 34 letters, digits, spaces, dashes or underscores. |
| `AUTOCRAFT_TRUST_PROXY` | The number of trusted proxies in front of the server (0 to 9, default 0), for the client address of the rate limits. Each proxy is assumed to append the address it was reached from to `X-Forwarded-For`, so the client is that many entries from the end; with 0 the socket address counts. A proxy that replaces the header with a CDN's client-address header counts as one, and must then refuse connections that do not come from the CDN. |
| `AUTOCRAFT_IMG_CACHE` | Disk cache of the image proxy. Default `$XDG_CACHE_HOME/autocraft/img` (`~/.cache/...`); empty for no disk cache. |

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

With `AUTOCRAFT_DEV_AUTH=1` the server uses a fake GitHub: `/auth/signin` shows a form that signs in as any login typed into it (the login must still be on the access list). It needs no secrets file and starts only on a loopback listen address (default port 8994). If `AUTOCRAFT_BASE_URL` is set it must be an `http://localhost` or `http://127.0.0.1` URL. The server answers 403 to any request that carries `X-Forwarded-For` or a `Host` that is not a loopback name. Repo permissions come from the JSON file named by `AUTOCRAFT_DEV_PERMS`, read on every check: `{"<login>": {"<repo>": "write"}}` (values `admin`, `maintain`, `write`, `triage`, `read`). `AUTOCRAFT_DEV_TOKEN_TTL` sets the fake access tokens' lifetime in seconds (default 8 hours). Open the dashboard as `http://localhost:<port>` so the browser accepts its `Secure` cookies.

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
| `PUT /api/me/settings` `{reserve?, repos?, maxCalls?, manualOnly?}` | maintainers and operators; audited as `usage-reserve`, `my-repos`, `max-calls`, `manual-only` |
| `POST /api/signout` | anyone signed in |
| `GET /api/similar/<repo>/<n>?limit=` (nearest items across the tracked repos, with score; default 10, at most 50), `/api/search?q=&mode=semantic` (search by meaning, same hits plus a score) | anyone signed in; 503 until `autocraft-server embed` has run |

Feedback (picks and text) is display-only. The pipeline reads answers with `autocraft-server decisions list --actionable` (one JSON object per line: option keys of unapplied answers by a current operator), which never includes them.

### MCP Connector

`POST /mcp` on the dashboard's origin is an [MCP](https://modelcontextprotocol.io) server named `autocraft` (title AutoCraft) for contributors' own agents (Claude Code or any client that speaks Streamable HTTP). It lists what the pipeline could not settle on its own and takes feedback back, so a contributor can work the Inbox from the agent they already use, on their own machine and their own model usage. The code is `src/dash/mcp/`.

- **Tokens.** A maintainer or operator makes a Connector token in the MCP Connector block of the Connect page (`/connect`, opened from the user menu), which shows it once with the `claude mcp add --transport http ... --header "Authorization: Bearer <token>"` command and a JSON config for other clients. Connector tokens are `acmcp_` plus 32 random bytes, stored as a SHA-256 hash in `mcp_tokens` (`kind` `connector`), valid for 90 days, at most 5 per login, and revocable by their owner. A Task Runner credential (`acrun_`) works on `/mcp` only with Agent access (see [Task Runner credentials](#task-runner-credentials)); without it, `/mcp` answers 403. Client configs that call the server `autocraft-inbox` keep working: the name exists only in the client, and their tools keep the prefix `mcp__autocraft-inbox__`. An operator can tick **Can answer decisions** to make an answering token (`can_answer`), which lasts 7 days, the longest an operator's dashboard session lasts. A token counts only while its login is on the access list, and its role is read from the list on every call; removing a login deletes its tokens, ending a session of a login (Access page) deletes that login's tokens, and a lowered role deletes its answering tokens and takes answering from its Task Runners. Operators list and revoke any login's tokens on the Access page (`POST /api/access/tokens/revoke` `{id}`, audited as `mcp-token-revoke`; token audit rows are operator-only). A token has no GitHub token of its own: without a live dashboard session of its login, only recently cached permissions count.
- **Transport.** One JSON-RPC message per POST, answered with one JSON body (no event stream: `GET` is 405; notifications get 202; batches get 400). The token goes in `Authorization: Bearer`; the session cookie is never accepted here, and a request whose `Origin` or `Sec-Fetch-Site` names another site is refused. Limits: 120 calls a minute per login, and 300 failed authentications a minute per client address.
- **Tools.** `list_repos` (visible tracked repos with open decisions by kind and fix-ups waiting), `list_inbox` (open decisions, oldest first; `repo`, `kind`, `limit` up to 25, `cursor`), `get_inbox_item` (one decision: question, option keys, summary and recommendation, item text, facts, risks, related items, picks and comments), `send_feedback` (`id`, `option?`, `text?`), `list_merge_queue` (the Queue page's Merge tab: each PR's state, merge path, CI, verify, fast-track weight and place, hold, how it came in and who added it (logins for maintainers and operators only), why it does not merge yet, the next merges with what each waits for, the batches in flight, and pre-approved merges whose PR is no queue row on any page yet, from every visible repo or the one asked for; `repo`, `limit` up to 25 for each list, `cursor` `<queue offset>:<last pre-approval id>` with `x` for a list that is done), and `list_fixups` (open PRs at their current head that the planner holds in the fix-up `hold` bucket with no push of ours under way, with the review's fix list and why the step stopped; viewers get the state only, as on the item page). While answering is available (`answering.enabled`), an answering token of a login that is an operator at the time of the call is also offered `answer_decision` (`id`, `option`, `note?`, `textsHash?` for a duplicate group, `exceptions?` for a batch) and `undo_answer` (`id`); for it, `get_inbox_item` adds `undoable`, the comment the answer would post, and each option's duplicate-group texts with their `textsHash`. Answering is the user's own action and has to execute as that GitHub user, which needs GitHub App user tokens that AutoCraft does not have yet. Until then no token can be made with `answer: true`, the Connect page hides the switch, the answer tools are not listed and the instructions do not mention them; a call to either refuses with a message that the user must sign in again with GitHub App sign-in. The switch is `answering.enabled` in `src/dash/mcp/index.ts`, and the checks below stay ready. Any other token is not offered them and gets an error if it calls them. `list_repos`, `list_fixups` and `list_merge_queue` share a per-login budget of a burst of 20 then 30 a minute. Every result frames GitHub text, and the pipeline's text about it (option labels and what an answer writes included), as untrusted, as the item tools do.
- **Merge queue.** A token whose login is an operator at the time of the call is also offered `set_weight` and the instructions describe it. `queue_pr` and `cancel_queued` are offered and allowed only to an answering token (`McpEnv.canAnswer`, with `answering.enabled`), because a pre-approved merge is a Merge answer given ahead; a call also refuses unless the user has live write permission on the repo (`queue_pr`). A maintainer's answering token (answering needs `maintainer_writes` on) is offered `queue_pr` as well, without its `weight`, and not `set_weight` or `cancel_queued`; the call takes the dashboard's rule for Queue items, so it is refused (403) on a repo without the app identity or the maintainer's write access. Weights are set by operators: a maintainer's `queue_pr` fast-tracks an item not on the list yet with the default weight, leaves an existing weight as it is, and ignores a weight it is sent (the reply says so). `queue_pr` (`item`, `weight?`) is "Queue items" (`POST /api/queue/add`): a PR is pre-approved at its current head and fast-tracked with the weight (default 5), keeping a heavier weight it has; an issue is fast-tracked and its one open closing PR is queued. `set_weight` (`item`, `weight?` or `remove: true`) changes a fast-tracked item's weight, fast-tracks an item not on the list with that weight without approving its merge, or takes it off; it calls `setFastTrackWeight`, `addFastTrack` and `removeFastTrack` directly (the dashboard's `/api/fast-track` routes call the same functions); it checks the repo is visible first and then decides between adding and changing in the same write, so a `queue_pr` of the same item meanwhile cannot leave its weight in place of the one asked for. `cancel_queued` (`item`) is the item page's cancel of a pre-approved merge (`POST /api/items/<repo>/<n>/preapproval/cancel`); the weight stays. `item` is a GitHub URL, `repo#number` or `owner/repo#number`. The role is read on every call, so a login that stopped being an operator is refused (403) even if its agent still lists the tools (a demoted operator keeps `queue_pr` only where a maintainer may queue). Audit rows are the handlers' own (`preapproval`, `fasttrack-add`, `fasttrack-weight`, `fasttrack-remove`), under the operator's login, with `via: "mcp"` in their details. Batch summaries, which can hold raw push and GitHub errors, go to operators and maintainers only, on the dashboard and in `list_merge_queue`.
- **Model calls.** In the `user-local` mode every token is offered `list_model_calls` (the Queue page's Model calls view through the same handler, `GET /api/model-queue`: each waiting call's id, items, step, tier, model, estimated cost, minutes waited, why it waits, its pick and whether the user may pick it, with the ready Task Runner counts and the user's picks; viewers get no picker logins, errors or repo-less calls). A login that is a maintainer or operator when the tools are listed is also offered `pick_model_call` and `unpick_model_call` (`id`), the dashboard's pick and unpick with the same refusals (403 for viewers and for ending another user's pick unless an operator, 409 with the reason a call cannot be picked); audited as `remote-pick` and `remote-unpick` with `via: "mcp"`.
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
| `update` | Downloads the server's current Task Runner over this file (checked with `node --check` first); restart `work` or the service afterwards. A version refusal names this command. |
| `service install [--parallel N]` | Writes and starts a systemd user unit (Linux, `~/.config/systemd/user/autocraft.service`) or a launchd agent (macOS, `~/Library/LaunchAgents/autocraft.plist`) that runs `work` with these arguments and restarts it whenever it ends (systemd `Restart=always`, launchd `KeepAlive`). It keeps `PATH`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `CLAUDE_CONFIG_DIR` from the shell it ran in. The log: `journalctl --user -u autocraft -f` (Linux), `$XDG_CACHE_HOME/autocraft-runner/service.log` (macOS). On Linux, when lingering is off, the command prints a line that the service stops at logout and names `loginctl enable-linger`; `doctor` warns the same while a unit is installed. No root. |
| `service uninstall` / `service status` | Stops and removes the service; prints its state and where its log is. |

**Runner**

| Command | What it does |
|---|---|
| `runner status` | Prints whether the Task Runner claims now, with plan usage, reserve, pause and hold. Exit code 0 only when `ready`. |
| `runner logs [-n N] [-f]` | Prints the last `N` lines (default 50) of the service's log, and follows it with `-f`: `journalctl --user -u autocraft` on Linux, `$XDG_CACHE_HOME/autocraft-runner/service.log` on macOS. |
| `runner pause` | Claims nothing until the plan window resets, whatever the usage. `runner resume` ends it. |
| `runner resume` | Ends a pause, a hold after a provider refusal, and a hold of `work` (a stopped run, failed calls). The usage reading still decides. |
| `runner reserve <5h> <weekly>` | Keeps more of each window free than the server's reserve (percent, 0 to 100). `runner reserve off` drops it. |

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
| `repos` | `list_repos` | Tracked repos with open decisions and fix-ups waiting. |
| `fixups [--repo R] [--limit N]` | `list_fixups` | PRs whose review fixes the pipeline could not apply. |
| `call [<tool> [args]]` | any | Raw access: alone it lists the tools the credential is offered; `call <tool> --help` prints a tool's description and arguments; a tool with one required text argument takes it bare. `call --guide` prints the server's instructions for an agent. |

`next_task`, `task_status`, `answer_decision` and `undo_answer` have no command (`MCP_ONLY`): the task tools tell an MCP agent to run the Task Runner's own commands, and answering stays on the dashboard until it opens to agents. `call` reaches them. A test (`test/autocraft-cli-layout.test.ts`) fails when a server tool has neither a command nor a place in `MCP_ONLY`.

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
- A follow-up turn of a session is offered only to the login that holds the session, first to the Task Runner that names the session in its claim. It waits while the Task Runner that ran the parent call (its credential) runs a lease with a heartbeat in the last 90 seconds, up to 15 minutes; with no such lease it waits 2 minutes. Then the call is withdrawn and the caller starts a fresh one (or skips the turn).
- Max calls at once. Each user may set the most calls all their Task Runners hold leases on together (Connect page, My settings; `PUT /api/me/settings` with `{maxCalls: 1-64}` or `{maxCalls: null}` for no limit, audit `max-calls`). At the limit a claim returns no lease and the reason. A follow-up of the user's own sessions still gets a lease one past the limit, so a session can finish.
- A call the login released is not offered to it again for 10 minutes.
- A claim from a Task Runner older than 1.2.0, or of a protocol version other than 3 or 4, is refused with 409. Version 3 has no `wait` and is answered at once.

**Claim order.** A claim takes the first call it may take in this order:

1. Follow-up turns of the sessions the Task Runner names in its claim, oldest first.
2. The user's own picks that are live (see [Model call queue](#model-call-queue)), oldest pick first; the fast lane takes only the picks that fit it.
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

### Test time scale

`AUTOCRAFT_REMOTE_TIME_SCALE` (a number from 0.01 to 1; unset means 1) is for the load rig (`scripts/loadtest`) only. When set below 1, the dashboard, the job processes and the Task Runners multiply every user-local time window by it: lease and heartbeat windows, the sticky follow-up wait, caller and status freshness, the liveness stamp, cool-off and drop windows, claim retry intervals, the Task Runner's heartbeat, retry, outage and failure-backoff times. Protocol constants keep their production values; the scale applies where they are used. Every process of one instance (dashboard, job processes, Task Runners) must run with the same value. The dashboard logs a warning at start when the variable is set and refuses to start when it is outside 0.01 to 1. Never set it in production.

### Usage reserve and readiness

Each maintainer and operator sets their own reserve on the Connect page: `GET`/`PUT /api/me/settings` with `{reserve: {fiveHour, weekly}}` (any of `reserve`, `repos` and `maxCalls`; the reply adds `repoChoices`), whole percents from 0 to 90, default 20. A viewer gets 403; a change is audited as `usage-reserve`. Every claim and status reply carries it.

- Before each claim the Task Runner reads its harness's plan usage and claims only while every 5-hour and weekly window keeps more than the reserve free. Claude: Claude Code's `GET /api/oauth/usage` with the Task Runner's Claude login, no model call. Codex: `account/rateLimits/read` from `codex app-server` with the Task Runner's own `CODEX_HOME`.
- A local `runner reserve` can only raise the server's reserve.
- One usage read runs at a time per machine: the slots of a process share one request, and processes share a lock file and the cached reading in the Task Runner's cache directory. A reading under a minute old is reused. A failed or refused read is shared for 30 seconds at most, or for the provider's `Retry-After` (up to an hour), before the provider is asked again.
- When a read fails or is refused, the last good reading keeps counting for up to 15 minutes, marked as an earlier reading, while every window has at least 10 points more free than the reserve. Otherwise, and for a missing, unparseable or stale (over 5 minutes) reading or a window kind the Task Runner does not know, the Task Runner holds. A held Task Runner reads again about every 45 seconds, 20% more or less at random so slots do not wake together.
- A Claude login that expires within the call timeout plus 10 minutes makes the Task Runner report `harness-missing`, the same check each call makes before it starts. Claude Code refreshes a login only in its last 5 minutes, so 4 minutes before the end the Task Runner runs the user's own `claude` once outside the sandbox (a one-word Haiku request with no tools, settings, hooks, MCP servers or session file, in an empty folder) with the login's config directory, or the default Keychain item on macOS, and Claude Code refreshes it under its own lock. The Task Runner never refreshes the login itself. A failed try is repeated every 90 seconds. A setup-token, or a Keychain item of another config directory, gets "run claude to refresh it" instead.
- A run the provider refuses for its limit goes back to the queue without using an attempt. The Task Runner holds until the reset the provider named (at most 7 days). A clock time without a time zone holds until a later reading shows headroom.

The Task Runner reports its readiness to `POST /api/remote/status` on every change and at least every 5 minutes, and keeps it in a 0600 status file in its cache directory. Each report also carries its `slots` (the `--parallel` slots and the fast lane), how many are `busy`, and its last error (a server request that failed after its retries, or a failed call's reason; a later success of the same kind clears it); the Connect page shows them per Task Runner. A report is retried up to 4 times within a minute. The Task Runner logs the first server failure and the recovery, one line each.

| Readiness | Meaning |
|---|---|
| `ready` | The Task Runner claims. |
| `quota-held` | A window is at or below the reserve, its usage could not be read, or the provider refused a run. |
| `paused` | The user ran `runner pause`. |
| `cooled-off` | The server gives the login no calls after repeated lost leases or failed replies. |
| `sandbox-failed` | The sandbox check or canary failed. |
| `version-refused` | The server refused the Task Runner's version. |
| `harness-missing` | The harness or its login is missing, no model is set for any tier, the harness version is not audited (Codex), or the Claude login expires soon. |
| `failing` | The Task Runner's last 5 calls failed or were given back in a row; it claims again at the time shown if its checks pass. |

The planner's room is the free slots of the Task Runners whose last status is `ready` and at most 6 minutes old and that are active (their last claim found nothing within 45 seconds, or a lease of theirs heartbeat within 90 seconds): each such Task Runner's reported slots less the leases its token holds, without the fast lane (taken to be present when a Task Runner reports 2 or more slots), since the planner does not know whether its next calls are small-tier or gating, for each user at most what their Max calls at once leaves. Room is counted for the repos the caller's next call names (a job's repo, or the repos of the next item or batch of a job that spans repos): only Task Runners that may take such a call count, by the same rules as claims apart from authorship and picks. Their user fits the role rules (a call that names no repo needs an operator), takes calls on every repo the call names (My repos, narrowed by the Task Runner's own list as of its last idle claim), and may write to it: only a non-write permission confirmed within the last 10 minutes leaves a user out, so a repo no claim has looked at lately still gets calls (the claim checks the permission itself). The queued calls that rank at or above the caller's class in the claim order and that one of those Task Runners may take come first. A queued call nobody's Task Runner may take therefore holds no room from other repos, and one user's slots do not start jobs on repos only another user serves. The runner asks the same room before it starts a job, for the job's repo (a job without a repo param counts every Task Runner); a job whose repo has no taker (see No taker below: a ready Task Runner outside a cool-off that may take it, busy or Manual only included) stays queued. Inside a job, the next item or batch to start is the first in order whose repos have room, so an item without room does not hold back later ones. When none has room and none of the job's calls runs, the first item that a connected, ready Task Runner may take starts anyway; an item no Task Runner may take never starts, and once only such items are left the job ends without them, to be picked again on a later pass. `GET /api/runners` and `my_work` list the user's own Task Runners with their last status. The `remote-Task Runners` live topic follows statuses and leases.

### Per-call tools

A call's bundle lists the servers it may use: `items` (search and read the synced items), `reference` (the repo's reference documentation, where one exists) and `build` (the `check` build tool). Each is served only while the call's lease is live and only to a call whose bundle lists it.

- **HTTP routes.** `POST /api/remote/tool/<server>/<tool>` with the lease secret as bearer token and the tool's arguments as JSON body. The reply is an MCP `tools/call` result. A long call (`check`) sends whitespace before the JSON while it runs.
- **MCP.** `POST /mcp/task/<server>` is a Streamable HTTP MCP server with only that server's tools. Claude gets it through the bundle's MCP config. Codex gets it through its configuration. An agent can use `autocraft mcp` or `autocraft tool` instead.
- **Reference cap.** One lease may read 60 reference passages in all (`reference_search` and `reference_around` together); past that, results are cut with a note.
- **Reference index.** `reference_search` reads the repo's search index as built; a repo without one returns no passages. `autocraft-server reference import` builds it, and `autocraft-server reference index <repo>` builds or refreshes it (the dashboard never builds one: embedding a manual takes minutes of CPU). Searches keep the vectors of up to 4 repos in memory, score them in a worker thread (reloaded when the index file changes) and run at most 4 at a time.
- **Check relay.** `check` runs in the job process that waits for the call, which keeps the call's count, time limit and run set. The dashboard queues the request and polls for the result; a request still waiting when the lease ends is refused.
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

`autocraft-server runner serve` is the only process that runs pipeline steps (how the parts fit together: [docs/pipeline.md](docs/pipeline.md#architecture)). It polls the `jobs` table every 2 seconds, runs each job in a child process (`autocraft-server runner exec <id>`) with its output in a log file, stops jobs whose cancel was requested, and, while the pipeline is On, queues the jobs the stages need (see [docs/pipeline.md](docs/pipeline.md#on-and-off)). Every 20 seconds it also refreshes the flowchart counts (`flow_summary`) of repos whose data changed. On start it marks jobs that an earlier runner left running as failed. A lock file keeps a second runner on the same database from starting.

It reads the same variables as the CLI (`AUTOCRAFT_DB` and the rest), plus:

| Variable | Meaning |
|---|---|
| `AUTOCRAFT_RUNNER_LOGS` | Directory of the per-job log files. Default `~/.cache/autocraft-logs/jobs`. The dashboard reads each job's log from the path recorded in its row, so it must run as a user who can read this directory. |
| `AUTOCRAFT_RUNNER_JOBS` | Most jobs running at once. Default 32. A job whose step calls Claude also waits for a free account slot before it starts. Jobs of one step run together only for different repos, within the `step_parallel` setting (`autocraft-server pipeline parallel [N|none]`, default 1). |
| `AUTOCRAFT_RUNNER_POLL_MS` | Poll interval. Default 2000. |
| `AUTOCRAFT_CALL_IDLE_MIN` | Minutes a Claude call may produce no output (no assistant text, tool use, tool result or progress line) before its process group is stopped (SIGTERM, then SIGKILL after 10 s) and the call fails with `no output for <n> min; stopped`. Default 15. Time spent inside a pending build-tool call (it waits on a worker, up to 45 minutes in all) does not count. |
| `AUTOCRAFT_LOCK_DIR` | Directory of the lock file, shared with `sync`. Default `~/.cache/autocraft-logs`. |
| `AUTOCRAFT_EXTRA_STEPS` | A module exporting `steps: StepDef[]` that is added to the step list, for tests and development (`test/runner-steps.ts` has fake steps). Set it for the dashboard and the runner alike, or not at all. |

The classify steps call `jev` and `claude`, so the runner's `PATH` must reach them. Where `jev` is not installed (containers), set `AUTOCRAFT_JEV_CLOUDFLARE_ACCOUNT` and `AUTOCRAFT_JEV_CLOUDFLARE_TOKEN_FILE` (a mode 0600 file holding a Cloudflare API token) to send every Jev call to Cloudflare Workers AI instead; `AUTOCRAFT_JEV_CLOUDFLARE_MODEL` overrides the model (default `typesafe/jev-1.14.0`). A 401 or 403 from Cloudflare, or an unreadable token file, records the same account outage as a rejected key; 429, 5xx and network errors fail only that call.

To run it as a systemd user service, fill in the placeholders of `deploy/craft-runner.service`, copy it to `~/.config/systemd/user/`, and run `systemctl --user daemon-reload && systemctl --user enable --now craft-runner`. Stopping the service stops running jobs; they show as failed and can be started again.

From a shell: `autocraft-server pipeline on [--if-draining]|off|drain|status` flips the switch and `pipeline limit <step> --per-day N|none` sets a stage's daily limit (both recorded as `cli`). `autocraft-server runner steps` lists steps and their params, `runner enqueue <step> [--<param> <value> ...]` queues a job by hand for debugging (recorded as `cli`), `runner jobs [--state S]` lists jobs, `runner cancel <id>` cancels one.

### Build environments and the worker API

The runner also serves the worker API on its own listener, for workers that run untrusted code (concept and trust rules: [docs/pipeline.md](docs/pipeline.md#build-environments-and-tasks)). It is separate from the dashboard; expose it to remote workers only behind TLS (for example a tailnet-only proxy).

| Variable | Meaning |
|---|---|
| `AUTOCRAFT_WORKER_LISTEN` | `host:port` of the worker API. Default `127.0.0.1:8981`. If it cannot listen, the runner logs the error and carries on. |
| `AUTOCRAFT_ARTIFACT_DIR` | Where task artifacts are stored. Default `artifacts` beside the database. The runner and the dashboard must both see it. |

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

`claim` with `free: 0` is allowed and refreshes the heartbeat and the paused reason. The task is `done` when every step exited 0 without a timeout, otherwise `failed` (empty results too). Errors are `{ "error": text }` with status 400 (bad body), 401 (key), 409 (the task is not running on this environment), 413 (size cap), 415 (artifact type), 429 (rate limit; `Retry-After`).

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

Claude calls run under accounts that an operator enabled (unless the compatible provider below makes them, in which case the accounts are not used). Which accounts exist on a machine comes from files outside the repository, named by environment variables that the runner, the dashboard and the CLI all read:

| Variable | Meaning |
|---|---|
| `AUTOCRAFT_ACCOUNTS` | A JSON file `[{ "id": "b", "configDir": "/path/to/claude-config-b" }]`. `id` is a short key (lowercase letters, digits, `_`, `-`); `configDir` becomes `CLAUDE_CONFIG_DIR` of the `claude` child process of calls made on that account. Directories never appear in the API, the logs or the UI. |
| `AUTOCRAFT_USAGE_DIR` | A directory with one file per account id, `<id>.json`: `{ "written_at": <unix s>, "rate_limits": { "five_hour": { "used_percentage": n, "resets_at": <unix s> }, "seven_day": { ... } } }`. Only that file is read. |
| `AUTOCRAFT_ACCOUNTS_ROOT` | Directory for the config directories of accounts added on the Accounts page (`<root>/<id>`, mode 0700). Without it, accounts can only come from the file. |
| `AUTOCRAFT_CLAUDE_BIN` | The `claude` command used for sign-in, status and usage (default: `claude` on the PATH). |

Example: `AUTOCRAFT_ACCOUNTS=/path/to/accounts.json`, `AUTOCRAFT_USAGE_DIR=/path/to/usage`, `AUTOCRAFT_ACCOUNTS_ROOT=/path/to/accounts`.

Each account in the file gets a row (disabled, labelled with its id) the first time anything lists accounts. Operators set the label, the switch and the number of calls at once on the Accounts page or with `autocraft-server accounts list` and `autocraft-server accounts set <id> [--label X] [--enabled yes|no] [--max-concurrent N]` (1 to 100; recorded as `cli`). Jev has no accounts; its calls at once are the `jev_parallel` setting (default 4), changed with `autocraft-server accounts jev [N]`. Claude calls in flight are limited only by the accounts' free slots; waiting calls take freed slots by priority class (security, then the path to merge, then the rest). An operator can also give an account a long-lived token (*Long-lived token* on the Accounts page, stored as `oauth-token` in the account's config directory, mode 0600): calls on that account use it instead of the login's short-lived token, so sandboxed calls never wait for a token refresh. Allocation and pauses are described in [docs/pipeline.md](docs/pipeline.md#claude-accounts-and-agent-runs).

### Bring your own model

The pipeline's model calls on this host have two providers: the `claude` CLI under the accounts above (the default), and a chat API that speaks the widely used `/chat/completions` JSON shape. The API provider is configured by environment variables only: no key or base URL of it is stored in the database, the API or the UI. Each agent run records the model that answered, in `agent_runs.model`, as a Claude or Jev run does.

| Variable | Meaning |
|---|---|
| `AUTOCRAFT_MODEL_PROVIDER` | `claude` (default) or `compatible`. `compatible` sends every model call to the API. |
| `AUTOCRAFT_CLASSIFIER_PROVIDER` | `jev` (default), `compatible` or `decisions`. `compatible` sends Jev's typed decisions to a chat API; `decisions` sends them to a Decisions API endpoint. |
| `AUTOCRAFT_COMPATIBLE_BASE_URL` | The API root, such as `https://models.example.com/v1`. https, or http on a loopback host for a local server; no user name, password, query or fragment. |
| `AUTOCRAFT_COMPATIBLE_KEY_FILE` | The key, as one line in a file only its owner may read (`chmod 600`; Windows has no such mode, so it is not checked there). Sent as `Authorization: Bearer`. |
| `AUTOCRAFT_COMPATIBLE_MODELS` | A JSON object mapping each tier to a model: `{"top":"...","mid":"...","small":"..."}`. Model calls need all three. |
| `AUTOCRAFT_COMPATIBLE_CLASSIFIER_MODEL` | The model that answers the typed decisions; default: the `small` model. |
| `AUTOCRAFT_COMPATIBLE_MAX_TOKENS` | The `max_tokens` of one request (default 16000; `0` sends none). |
| `AUTOCRAFT_DECISIONS_BASE_URL` | A decisions endpoint's root (default `https://api.openai.com/v1`; it falls back to `AUTOCRAFT_COMPATIBLE_BASE_URL`). `/decisions` is appended. |
| `AUTOCRAFT_DECISIONS_KEY_FILE` | Its key (default: `AUTOCRAFT_COMPATIBLE_KEY_FILE`), with the same 0600 rule. |
| `AUTOCRAFT_DECISIONS_MODEL` | Its model (default `gpt-6-luna`, the model the Decisions API serves today). |

A prompt is registered for a model family (`opus`, `sonnet` or `haiku`); the provider maps the family to its tier and the tier to its model, and the agent run records the model that answered. The variables are read on every call from the process's environment, so a wrong value is reported on the first call; changing the service's environment (its systemd unit, its container's environment) takes a restart of that service, as any other setting does.

**A call.** A prompt without a checkout is one request: the prompt's fixed text as the system message and the item data as the user message, exactly the split the `claude` call makes. A prompt with a checkout (the same condition: the stage passes a checkout and the prompt registers a sandbox) keeps its tools in a loop of at most the prompt's `maxTurns`: `Read`, `Grep` and `Glob`, the names the prompt text already uses, plus `mcp__build__check` for the stages that give the call a build tool. The paths are the sandbox's: `/repo`, `/repos/<name>`, `/repo-docs` and `/reference`. Each is resolved to its real path and must stay inside the directory it names, so a symlink out of a checkout is refused as it would dangle inside a sandbox mount. `Read` shows text with line numbers; a binary file (an image, a PDF) is refused with that reason. `Grep` runs the model's regular expression in a worker thread that is stopped after 5 seconds (`src/agents/grep-worker.ts`), because repository text can suggest a pattern that would otherwise hold the service's event loop; `Glob` and `Grep` walk at most 20000 files a call. A tool the provider does not have answers with what to use instead: `Agent` (the workspace explorer) is not available, and the model searches with Grep instead.

**What is different from a Claude call.**

- No bubblewrap sandbox and no `claude` binary: this host reads the files, and the read is a plain file access under the confinement above. Nothing writes and no shell runs. A build can still be requested through `mcp__build__check`, and that build runs on a build worker as it does for a Claude call, never on this host.
- No item tools (`mcp__items__*`) and no explorer subagent; a workspace call still reads `/repos/<name>` directly.
- Images cannot be read. The two prompts that read them back (`verify.screenshot` and `verify.compare`, which the Screenshots feature plans) are refused: the run records `needs images` and the call fails, rather than a model guessing from words. `Read` refuses any other binary file with its reason, and the reference pages' pictures are therefore unreadable too (their text pages are not).
- No follow-up fix turn: a lint problem repeats the call, up to the step's attempts. The check reminder that asks for a missing clippy run is not sent; the prompt's own rule still asks the model to run the build tool.
- No account and no slot: calls are not queued behind the Claude accounts (the pools' own limits apply), and the Accounts page's accounts are listed but not used. In the user-local inference mode the provider is not used at all: model calls go to maintainers' Task Runners, and only the classifier provider applies.
- `token_usage` and the run both name the model that answered: the registry's alias for a Claude call, the provider's model id for a compatible call (the Cost page groups by that id). The provider's price is not known here, so `cost_usd` is null for its calls.
- The classifier answers Jev's request shape, with the same parsers and thresholds. The 0.9/0.8/0.3 thresholds were set for Jev, and a general model's probabilities are not calibrated; a classifier that is switched off, misconfigured or refused makes the fallback model (Haiku) decide, as it does without Jev.
- A decisions endpoint (`AUTOCRAFT_CLASSIFIER_PROVIDER=decisions`) is the better fit than a chat model for Jev's place: Jev's question object goes to one `POST /decisions` request, each yes-probability becomes a predicate and each choice's criteria become the options, and the typed answers come back as Jev's answers. A refusal, a missing answer or a choice outside the asked options leaves that question unanswered, exactly as Jev answering nothing would. The endpoint reports no tokens, so its runs and usage rows carry no token count and no USD; the cost is the endpoint's own.

**Checking it.** `autocraft-server accounts providers` prints both providers; `GET /api/accounts/providers` returns the same for the Accounts page, which also shows an unreadable key file or an invalid base URL. The health checks report `model-provider` as failed when the environment asks for a provider it cannot supply (in the server mode; the user-local mode runs the model calls on Task Runners and passes), and `classifier-provider` as a warning in both modes. A key the API rejects is recorded as a classifier account outage (`jev_unavailable`); a model call fails with the provider's status in the call's error.

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

- After a `build` task (upstream main; a `build` task cannot carry a patch) has replaced the local warm dir, a worker with a `writeKey` takes a hard-link copy of it under the warm lock, then packs (`tar | zstd`), signs and uploads the copy without holding the lock. `use` tasks (PR builds) never write. The upload is skipped when the local warm dir has changed in the meantime.
- When a `use` task starts, the worker starts a download in the background and the task uses the local warm dir as it is now; the next task gets the new snapshot. Concurrent tasks share one download. The download happens only when the store's snapshot is signed correctly and newer (`stored`) than the local one; the swap checks this again under the warm lock. The blob is first written to a spool file and its sha256 is checked against the signed record; only then is it unpacked, by the same safe extractor as source tarballs (regular files, directories and links inside the tree, no path through a symlink, no special mode bits), capped at the signed size plus slack. A worker runs one download at a time, and the free-disk check counts the download in progress. Key files are read when the worker config is loaded, so a bad path stops the worker at start.

Build workers need synchronized clocks (NTP): `stored` is compared across machines to decide which snapshot is newer. A snapshot larger than `warmMaxGb`, or one that would take the free disk under `limits.minFreeDiskGb`, is skipped.
- A store that is down, slow (past `timeoutSec`), refuses the key or returns a bad snapshot is logged and ignored. A worker host without `zstd` skips both directions with a log line.

### Crate cache

The shared crate cache (`<workDir>/crate-cache`) is never mounted into a container. Each task gets its own `CARGO_HOME`, seeded by copying `.crate` files from the shared cache and deleted with the task. Cargo does not re-verify files already in its cache, so nothing a task wrote is trusted. Right after each `fetch` step, before any build script or test has run, the worker process on the host admits a file to the shared cache only if it is a regular `.crate` in the official crates.io registry directory (`index.crates.io-*`) and its sha256 equals the checksum in the crates.io sparse index (fetched over HTTPS, looked up once per crate name). Other registries, git sources, anything written by offline steps and anything the index lookup cannot confirm are never admitted. Build output (`/target`) is shared only through the warm target dirs below.

`rustPlan()` (`src/worker/rust.ts`) returns the Rust steps: `fetch deps` (`cargo fetch --locked`, network, with the image's toolchain, no repository cargo config and an empty environment apart from the toolchain paths), then `build` and `test` with `--offline --locked`. The source is read-only, so `Cargo.lock` must be committed. The nightly checks' networked steps (`cargo fetch`, `cargo audit fetch`) run the same way (`fetchScript()`), with the toolchain the image makes active.

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
| `backup.sh` | `backup.sh [PREFIX [KEEP]]`: consistent snapshot with `sqlite3 .backup`, compressed, newest KEEP kept. |

Layout: `<root>/{repo.git,releases,app,data,cache,config}` (`app` is a symlink to the current release). `<root>/config` holds the settings file, `secrets.json` (mode 0600), `accounts.json` and the per-account Claude config directories. The user needs `node` 24, `git`, `pnpm`, `sqlite3`, `curl`, `bwrap`, `gh` (logged in, with its git credential helper), `claude` (logged in per account) and `jev` on its PATH (`<root>/.local/bin` comes first). The restart needs a sudoers entry allowing the user `systemctl restart` of its own units, and `start`/`stop` of the sync timer, without a password. The units load `autocraft.env` themselves as the app user. The dashboard unit sees that file, `releases/`, `repo.git` and `.local` read-only (`ReadOnlyPaths=`): the process that faces the network cannot change what the other units source or run. The worker runs as a separate user (see Running a worker); `AUTOCRAFT_WORKER_SSH` and an SSH key at `<root>/.ssh/id_craftsandbox` let the hook install its code through the worker's forced-command key.

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
| `AUTOCRAFT_DB` | `~/.local/share/autocraft/mirror.db` | `/data/mirror.db` | `<root>/data/mirror.db` |
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
| `AUTOCRAFT_ARTIFACT_DIR` | `<database dir>/artifacts` | unset | unset |
| `AUTOCRAFT_SNAPSHOT_DIR` | `<database dir>/item-snapshot` | unset | unset |
| `AUTOCRAFT_CLAUDE_CWD` | `~/.cache/autocraft/claude-cwd` | unset | unset |
| `AUTOCRAFT_MODEL_CACHE` | `$XDG_CACHE_HOME/autocraft/models` | unset | unset |
| `AUTOCRAFT_WEB_DIST` | `web/dist` of the code | unset | unset |
| `AUTOCRAFT_CLAUDE_BIN` | `claude` on `PATH` | `/usr/local/bin/claude` | unset (`<root>/.local/bin` is on `PATH`) |
| `AUTOCRAFT_LISTEN` (dashboard) | `127.0.0.1:8993` | `0.0.0.0:3005` | `127.0.0.1:3005` |
| `AUTOCRAFT_WORKER_LISTEN` (worker API) | `127.0.0.1:8981` | `0.0.0.0:8981` | `127.0.0.1:8981` |
| `AUTOCRAFT_HEALTH_LISTEN` (runner probes only) | none | none | none |
| `AUTOCRAFT_STOP_TIMEOUT` (seconds the runner may take to stop) | `25` | unset | unset |
| `HOME` | the user's home | `/data/home` | the app user's home |

`AUTOCRAFT_BASE_URL` (no default; the public origin) and `AUTOCRAFT_TRUST_PROXY` stay as described under Dashboard server. The older `CRAFT_AUTO_*` names still work.

### Logs

The dashboard, the runner, sync and backup write to stdout and stderr. The runner also writes one file per job under `AUTOCRAFT_RUNNER_LOGS`.

### Health endpoints

`GET /healthz` answers 200 `ok` while the process is up. `GET /readyz` answers 200 while the database answers a query and 503 otherwise. Neither needs authentication and neither returns data. They are served by the dashboard (before sign-in), by the runner's worker API listener (before the worker key check) and, when `AUTOCRAFT_HEALTH_LISTEN` is set, by a listener of the runner that serves only these two paths.

### Health checks

The dashboard computes the checks below from the database on each request; nothing runs on a timer. The warnings menu in the header lists the ones that are not `ok` (red for `fail`; viewers see that a check is bad but not its cause or repos they cannot see), and `GET /healthz/checks` returns them for external monitoring (no sign-in; ids and states only, plus `since` and counts for a signed-in operator or maintainer; 200 for `ok` and `warn`, 503 when any check is `fail`). Thresholds are the constants in `THRESHOLDS` in `src/health-checks.ts`.

| Id | Fails or warns when |
|---|---|
| `runner` | `runner_heartbeat` is missing or older than 2 minutes (fail) |
| `worker:<env id>` (`workers` in the endpoint) | an enabled build environment has not reported (`last_seen_at`) for 5 minutes, or never (fail) |
| `build-queue` | a build task has been queued for over 10 minutes: fail when no enabled environment has reported in 5 minutes, else warn (a security task while no confidential environment is ready counts under `confidential-env` instead) |
| `remote-calls` | the inference mode is `user-local`, a remote model call has been queued for over 10 minutes, and no helper has claimed any call in that time (warn) |
| `remote-starved-<tier>` | the inference mode is `user-local`, a helper that is not Manual only reported `ready` in the last 6 minutes, and the oldest queued call of the tier has waited over 30 (top), 20 (mid) or 5 (small) minutes (warn) |
| `remote-manual` | the inference mode is `user-local`, every Task Runner that reported `ready` in the last 6 minutes is Manual only, and a model call has waited over 10 minutes (warn) |
| `remote-no-taker` | the inference mode is `user-local` and a tracked repo with the pipeline on has had no Task Runner that may take its calls for over 10 minutes: none reported `ready` in the last 6 minutes outside a cool-off (Manual only ones count), or the role rules, a non-write permission confirmed within 10 minutes or My repos leave each one out, or its user has no task ticked in My tasks. The dashboard checks the repos once a minute; the text names the repos (warn) |
| `confidential-env` | a security fix or a security build task waits and no confidential build environment is ready (warn) |
| `sync` | no successful `sync_runs` row ended in the last 10 minutes, or the last 3 runs failed (fail) |
| `sync-repos` (`sync-repo:<repo>` in the dashboard) | a tracked repo could not be read by the last sync (warn; fail when more than half of the tracked repos have an error, for example after a token lost access). The reason is `sync_repo_errors`: `not-found` (moved, renamed or deleted; the new name is shown when GitHub's REST endpoint redirects), `forbidden`, `transient` or `error` |
| `accounts` | every enabled Claude account is paused or signed out (fail) |
| `github-rate` | fewer than 500 (warn) or 100 (fail) GitHub points are left until the next reset |
| `author-ids` | the last pass that binds contributors' account ids failed (`author_ids_error`) and logins with merged or closed PRs are still unbound: their earlier PRs count toward no whitelist tier until a pass succeeds (warn) |

A repo that fails is skipped for that run and the sync continues with the others; the run exits non-zero only when every repo it tried failed, or after three transient failures in a row or a rate-limit stop (a GitHub outage). A full re-sync keeps its cursor before the first failed repo. A repo is never untracked automatically: untrack it or track it under its new name, and its warning goes with the next successful read (a not-found record also clears when the org listing shows the repo again).

### Stopping

On SIGTERM or SIGINT the runner claims no new jobs, signals its running jobs (SIGTERM, then SIGKILL after 10 seconds, as under systemd), closes its listeners and exits 0. If that takes longer than `AUTOCRAFT_STOP_TIMEOUT` seconds, it exits 1. Set the orchestrator's grace period above that value: `docker run --stop-timeout 30`, Compose `stop_grace_period: 30s`, or the Kubernetes default `terminationGracePeriodSeconds: 30`. The dashboard closes its connections and the database and exits 0.

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
| `periodic` container instead of CronJobs | A CronJob pod may land on another node, where the volume cannot attach. The container loops `sync` (every 60 seconds after the previous run, like the timer) and runs `backup daily 7` once a day. |
| Two volume claims, `data` and `config` (ReadWriteOnce) | `/config` is writable because the app writes accounts, Claude logins and usage readings there. |
| Pod `hostUsers: false`, `runAsNonRoot`, uid and `fsGroup` 10001 | The user namespace is required for the runner's `procMount: Unmasked`. |
| Runner container: `procMount: Unmasked`, `seccompProfile: Unconfined` | The sandbox requirement above. The other containers keep the defaults. |
| Probes on `/healthz` and `/readyz`; `terminationGracePeriodSeconds: 30` | The dashboard probes its own port; the runner probes the worker API port. |
| `autocraft-worker-api` Service on 8981 | For workers inside the cluster. Do not publish it. |

The manifest holds no secret values. Before the first start:

1. Set `replicas: 0` and apply the manifest, so the claims exist and no pod holds them. Place `secrets.json` on the config volume as uid 10001 with mode 0600 with a short-lived helper pod that mounts the `config-autocraft-0` claim (`kubectl cp`, then `chown 10001:10001` and `chmod 600`). Delete the helper, then scale the StatefulSet to 1. A ReadWriteOnce claim attaches to one node, so the helper and the pod cannot run together. The migration runbook ([migration.md](migration.md)) uses the same sequence.
2. Create the Secret `autocraft-github` with key `token` (a GitHub token for `gh`: `repo`, `read:org`, `workflow`) with `kubectl create secret generic autocraft-github --from-literal=token=...` typed by the operator.

## Similar items and semantic search

`autocraft-server embed [--all] [--threads N] [--batch N]` embeds every tracked item whose text changed since its last embedding (`--all`: every tracked item) into `item_embeddings`, and removes vectors of items that left the mirror or the tracked repos. Each batch commits on its own, so an interrupted run continues where it stopped. The dashboard reads the table for "Similar items" on the Item page and for the search box's meaning toggle; it embeds search queries, and items without a vector yet, itself.

- Model: [bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) (384 dimensions, int8 ONNX from `Xenova/bge-small-en-v1.5`), run on the CPU through `@huggingface/transformers`. The first use downloads it (34 MB) from Hugging Face.
- Text: the title, a newline, then the first 1,000 characters of the body with HTML comments, code blocks, images, URLs and Markdown markup removed (`src/embed/text.ts`); at most 256 tokens. Its hash decides whether an item is embedded again.
- Vectors are float32 and unit length; the server keeps them in memory, reloads them when the table changes, and ranks by dot product (cosine similarity).

| Variable | Meaning |
|---|---|
| `AUTOCRAFT_MODEL_CACHE` | Where model files are kept. Default `$XDG_CACHE_HOME/autocraft/models` (`~/.cache/...`). |
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

Floors of `maxMin` in minutes, about twice the longest job in 30 days of history: fixup 120; decide 75; opus-review 70; premerge, main-fix, embed 60; dupes-compare, fixissue 50; cifix 40; prioritize, labels-apply, conversation, postmerge, areas-* 30; classify-new 20; merge 15; classify-all 120; every other step 10. A step missing from the registry (the security steps, review-batch) has 60 unless the code's bound is larger.

The check tool stops one check after 5 times the median duration of the repo's recent checks of that command (the last 20 successful runs of the same shape, at least 3; full or partial run by crate and test name; exit code 0 for cargo; measured from when a worker took the task), within 5 to 15 minutes; with less history the limit is 15 minutes. The limit covers run time only; a check that waits for a worker keeps the 45-minute cap on all check time of the call. The job log then says what the check was doing: the task state (still queued means no worker took it) and the last 20 lines of the task's output. The worker streams `cargo check` and `cargo test` output to the task log as well as to the artifact, and the log stays with the task (`build_task_logs`, shown on the task's page).
