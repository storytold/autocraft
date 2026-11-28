-- Mirror tables: written only by `autocraft-server sync`, overwritten from GitHub.

CREATE TABLE IF NOT EXISTS repos (
  name TEXT PRIMARY KEY,              -- "photocraft"; unique across owners
  owner TEXT NOT NULL DEFAULT 'storytold', -- GitHub org or user
  visibility TEXT,
  default_branch TEXT,
  open_prs INTEGER,
  open_issues INTEGER,
  synced_at TEXT,                     -- ISO time of the last finished sync
  high_water TEXT                     -- max updatedAt seen; incremental syncs stop below it
);

CREATE TABLE IF NOT EXISTS items (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- 'pr' | 'issue'
  state TEXT NOT NULL,                -- 'OPEN' | 'CLOSED' | 'MERGED'
  title TEXT, body TEXT, url TEXT,
  author TEXT, author_type TEXT, author_association TEXT,
  created_at TEXT, updated_at TEXT, closed_at TEXT, merged_at TEXT,
  merged_by TEXT,
  state_reason TEXT,                  -- issues: COMPLETED | NOT_PLANNED | DUPLICATE
  is_draft INTEGER,
  labels TEXT,                        -- JSON array of names
  assignees TEXT,                     -- JSON array of logins
  comments_count INTEGER,
  reactions_count INTEGER,
  -- PR only
  additions INTEGER, deletions INTEGER, changed_files INTEGER,
  head_ref TEXT, head_oid TEXT, head_repo TEXT, base_ref TEXT,
  maintainer_can_modify INTEGER,
  mergeable TEXT,                     -- MERGEABLE | CONFLICTING | UNKNOWN
  review_decision TEXT,
  ci_state TEXT,                      -- statusCheckRollup state of the head commit
  closing_issues TEXT,                -- JSON array of issue numbers
  detail_level TEXT,                  -- 'full' (open: comments, reviews) | 'light' (closed)
  embed_hash TEXT,                    -- hash of the embedded text, set at sync (src/itemhash.ts)
  class_hash TEXT,                    -- the classifier's input hash under class_scheme
  class_scheme TEXT,
  jev_failed_hash TEXT,               -- class_hash at which a classify.jev request gave no valid verdict while Jev was up
  PRIMARY KEY (repo, number)
);
CREATE INDEX IF NOT EXISTS items_state ON items(repo, kind, state);
CREATE INDEX IF NOT EXISTS items_author ON items(author);

CREATE TABLE IF NOT EXISTS comments (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  id TEXT PRIMARY KEY,                -- GraphQL node id
  kind TEXT,                          -- 'comment' | 'review'
  author TEXT, created_at TEXT, body TEXT,
  review_state TEXT,                  -- reviews: APPROVED | CHANGES_REQUESTED | COMMENTED
  commit_oid TEXT
);
CREATE INDEX IF NOT EXISTS comments_item ON comments(repo, number);
CREATE INDEX IF NOT EXISTS comments_created ON comments(created_at);

-- Work tables: ours, never touched by sync.

-- One row per classifier verdict; several classifiers may judge the same item.
CREATE TABLE IF NOT EXISTS classifications (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  classifier TEXT NOT NULL,           -- 'haiku' | 'jev' | 'sonnet' | 'owner'
  run_id TEXT NOT NULL,
  at TEXT NOT NULL,
  type_label TEXT,                    -- bugfix | performance | missing feature | small extra | plugin candidate | infra
  want TEXT,                          -- yes | no | unclear
  reference TEXT,                     -- claimed reference-app behaviour, or NULL
  flags TEXT,                         -- JSON array
  dup_of INTEGER,
  reason TEXT,
  probs TEXT,                         -- JSON, Jev: {type: {label: p}, top, security, needs_decision}
  PRIMARY KEY (repo, number, classifier, run_id)
);

-- Where each item stands in the pipeline (latest row wins).
CREATE TABLE IF NOT EXISTS stages (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  stage TEXT NOT NULL,                -- classified | labeled | reviewed | take | hold | close | needs-decision | batched | merged | closed | fixed-by-us
  at TEXT NOT NULL,
  actor TEXT,                         -- session or agent name
  note TEXT,                          -- one line, public-safe
  docket TEXT                         -- Docket issue key when a decision is asked there
);
CREATE INDEX IF NOT EXISTS stages_item ON stages(repo, number, at);

-- The latest stages row per item, kept by the trigger below so reads never scan
-- `stages`. A later `at` wins; at the same `at` the newer insert wins. `reviewed`
-- is 1 once the item has had a `reviewed` row. db.ts fills the table once for a
-- database that had stages before it existed.
CREATE TABLE IF NOT EXISTS item_stage (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  stage TEXT NOT NULL, at TEXT NOT NULL,
  reviewed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, number)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS stages_latest AFTER INSERT ON stages BEGIN
  INSERT INTO item_stage (repo, number, stage, at, reviewed) VALUES (NEW.repo, NEW.number, NEW.stage, NEW.at, NEW.stage = 'reviewed')
  ON CONFLICT (repo, number) DO UPDATE SET
    stage = CASE WHEN excluded.at >= item_stage.at THEN excluded.stage ELSE item_stage.stage END,
    at = CASE WHEN excluded.at >= item_stage.at THEN excluded.at ELSE item_stage.at END,
    reviewed = item_stage.reviewed OR excluded.reviewed;
END;

-- Contributor whitelist: the automatic tier comes from merge history;
-- an override from the owner always wins.
-- The GitHub account id first seen for each author login (written by the sync). The whitelist's history and allow overrides belong to that account only.
CREATE TABLE IF NOT EXISTS author_ids (
  login TEXT PRIMARY KEY,
  id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS whitelist_overrides (
  login TEXT PRIMARY KEY,
  status TEXT NOT NULL,               -- 'allow' | 'deny'
  note TEXT,                          -- private: never in a public export
  by TEXT, at TEXT
);

-- Token use per agent run, for cost per item and stage.
CREATE TABLE IF NOT EXISTS token_usage (
  run_id TEXT NOT NULL, agent TEXT NOT NULL,
  stage TEXT, model TEXT, repo TEXT,
  items INTEGER,
  input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  started_at TEXT, ended_at TEXT,
  cost_usd REAL,                      -- as reported by the CLI; Jev: input tokens at TypeSafe's price
  PRIMARY KEY (run_id, agent)
);

-- One row per prepare call of a decision; manual: an operator asked for it (exempt from the daily cap, src/decide/prepared.ts).
CREATE TABLE IF NOT EXISTS decision_prepares (decision_id TEXT NOT NULL, at TEXT NOT NULL, manual INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS decision_prepares_decision ON decision_prepares(decision_id, at);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
-- The lease of each leader role on Postgres (src/db/leader.ts): `holder` leads while expires_ms (the server's clock, ms
-- since 1970) lies ahead and renews it every few seconds; a standby takes an expired lease and moves `epoch`, which fences
-- the writes of every earlier holder (src/db/fence.ts). Unused on SQLite.
CREATE TABLE IF NOT EXISTS leader_leases (role TEXT PRIMARY KEY, holder TEXT NOT NULL, epoch INTEGER NOT NULL, expires_ms INTEGER NOT NULL);
-- whitelist rule defaults; editable with `autocraft-server whitelist rule`
INSERT OR IGNORE INTO settings VALUES ('whitelist_min_merged', '5');
INSERT OR IGNORE INTO settings VALUES ('whitelist_min_merge_rate', '0.6');

-- Decisions for people. The pipeline asks; only a signed-in operator answers, on the dashboard or through
-- their own agent with an answering token (src/dash/mcp/) (spec: docs/dashboard-spec.md).
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- scope | duplicate | close | merge | hold | split | other | backlog (a person's Backlog press on an item with no open question: written answered Backlog, deleted by Reopen or Undo)
  repo TEXT,                          -- null only for a batch spanning repos
  number INTEGER,                     -- null for a batch
  items TEXT,                         -- batch: JSON [{repo, number}]
  question TEXT NOT NULL,
  context TEXT,
  facts TEXT,                         -- JSON array of short strings
  options TEXT NOT NULL,              -- JSON [{key, label}]
  recommended TEXT,
  recommended_reason TEXT, recommended_by TEXT,
  prepared_at TEXT, prepared_head TEXT,  -- when the prepare step stored its summary, pick and drafts, and the PR head it prepared for
  prepared_discussion TEXT,           -- id of the newest counted comment the prepare read ('' none)
  prepare_failed_head TEXT,           -- the PR head at the last failed prepare try (a new head starts the tries again)
  recommend_failures INTEGER, recommend_failed_at TEXT,  -- recommendation calls that gave no valid answer, and the last one  -- one-sentence reason and the model that gave the recommendation (null: none from a model)
  public_text TEXT,
  asked_at TEXT NOT NULL, asked_by TEXT,
  docket TEXT,
  answer TEXT, answer_note TEXT,      -- answer_note is private
  exceptions TEXT,                    -- batch: JSON [{repo, number, answer}]
  answered_by TEXT, answered_at TEXT,
  applied_at TEXT,
  summary TEXT, summary_by TEXT, summary_at TEXT,  -- AI summary of the item or batch, by which model, when
  adopted_opinion TEXT,               -- decision_opinions.id when the answer adopted an opinion
  snoozed_by TEXT,                    -- operator who snoozed the open question
  snoozed_at TEXT,                    -- the question is snoozed while the item has no activity after this (snoozedExpr)
  exec_state TEXT, exec_reason TEXT,  -- the answer's GitHub write: pending | waiting-token | waiting-permission | done | failed, and why it waits or failed; an open decision: settling while a card runs (reason `<card id>:<login>`); an answered one: disputed (src/answers/hold.ts)
  dispute_by TEXT, dispute_reason TEXT, dispute_at TEXT  -- who disputed the unapplied answer, why, and when
);
CREATE INDEX IF NOT EXISTS decisions_open ON decisions(answer, kind, repo);
CREATE INDEX IF NOT EXISTS decisions_asked ON decisions(answer, asked_at);
CREATE INDEX IF NOT EXISTS decisions_answered ON decisions(answered_at);
-- db.ts adds the summary and adopted_opinion columns to databases created before them.

-- Opinions: non-binding picks by anyone signed in. Display-only: the pipeline
-- and every CLI command agents run never read this table or decision_comments.
CREATE TABLE IF NOT EXISTS decision_opinions (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  login TEXT NOT NULL COLLATE NOCASE,
  option TEXT,                        -- option key, or NULL for a note only
  note TEXT,
  at TEXT NOT NULL,
  permission TEXT NOT NULL,           -- the login's GitHub permission on the repo when given: write | none
  retracted_at TEXT,                  -- set when changed or retracted; one live row per login and decision
  via TEXT                            -- 'mcp' when an agent sent it for the login; NULL from the dashboard (db.ts adds it to older databases)
);
CREATE UNIQUE INDEX IF NOT EXISTS decision_opinions_live ON decision_opinions(decision_id, login) WHERE retracted_at IS NULL;

CREATE TABLE IF NOT EXISTS decision_comments (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  login TEXT NOT NULL COLLATE NOCASE,
  at TEXT NOT NULL,
  body TEXT NOT NULL,
  via TEXT                            -- 'mcp' when an agent sent it for the login; NULL from the dashboard (db.ts adds it to older databases)
);
CREATE INDEX IF NOT EXISTS decision_comments_decision ON decision_comments(decision_id, at);
CREATE INDEX IF NOT EXISTS decision_comments_at ON decision_comments(at);
CREATE INDEX IF NOT EXISTS decision_opinions_at ON decision_opinions(at);

-- Who is looking at a decision; a claim lapses after 10 minutes without activity.
CREATE TABLE IF NOT EXISTS decision_claims (
  decision_id TEXT NOT NULL,
  login TEXT NOT NULL COLLATE NOCASE,
  since TEXT NOT NULL,                -- when this look started
  at TEXT NOT NULL,                   -- last activity
  PRIMARY KEY (decision_id, login)
);

-- Accounts. Only logins on the access list can sign in.
CREATE TABLE IF NOT EXISTS access (
  login TEXT PRIMARY KEY COLLATE NOCASE,
  role TEXT NOT NULL,                 -- operator | maintainer | viewer
  added_by TEXT, added_at TEXT,
  note TEXT,                          -- private
  github_id INTEGER                   -- numeric GitHub user id, bound at the first sign-in; later sign-ins must match
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,           -- sha256 of the cookie value
  login TEXT NOT NULL COLLATE NOCASE,
  csrf TEXT NOT NULL,
  token_enc TEXT,                     -- user's GitHub token, encrypted with the session key
  created_at TEXT NOT NULL, last_seen TEXT NOT NULL, expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_login ON sessions(login);

-- Personal credentials of two kinds. `connector`: the MCP Connector (POST /mcp, src/dash/mcp/): a signed-in user's own agent
-- reads the inbox and sends feedback as that user, with the user's current role from the access list; shown once.
-- `runner`: a Task Runner (/api/remote/*) that claims model calls in the user-local inference mode; the runner makes the
-- credential itself and only its hash arrives here, through a device login (runner_logins).
-- can_answer: the token may answer decisions and approve merges (an operator, or a maintainer where maintainers settle, opted it
-- in); a connector token that answers lasts 7 days, a runner keeps its sliding expiry.
-- can_agent: a runner credential may also use /mcp (its user ticked Agent access); connector tokens always may.
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT NOT NULL COLLATE NOCASE,
  token_hash TEXT NOT NULL UNIQUE,    -- sha256 of the token
  label TEXT,
  can_answer INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, last_used_at TEXT, expires_at TEXT NOT NULL,
  can_run INTEGER NOT NULL DEFAULT 0, -- 1 exactly when kind = 'runner'; read by servers from before `kind`, written until it is dropped
  idle_claim_at INTEGER,              -- ms since epoch: the token's last claim that found nothing to take (src/remote/room.ts)
  idle_tiers TEXT, idle_repos TEXT,   -- JSON: the tiers and repos (null: any) that empty claim asked for
  kind TEXT NOT NULL DEFAULT 'connector', -- connector | runner
  machine TEXT,                       -- runner: JSON { hostname, platform, arch } the runner sent at login
  can_agent INTEGER NOT NULL DEFAULT 0
);
-- Leases that ended without a release or a reply (lost heartbeat, past a time limit), at most one per token in 10 minutes
-- and one per call and login in 2 hours, newest 2 hours kept; counted per login toward its cool-off (src/remote/cooloff.ts).
CREATE TABLE IF NOT EXISTS remote_lease_drops (
  token_id INTEGER NOT NULL, at INTEGER NOT NULL,
  login TEXT COLLATE NOCASE,
  call_id INTEGER                     -- remote_calls.id of the lost lease
);
CREATE INDEX IF NOT EXISTS remote_lease_drops_token ON remote_lease_drops(token_id, at);
-- Pipeline-on repos that no Task Runner may take calls on in the user-local inference mode, since when (src/remote/takers.ts):
-- the dashboard's minute maintenance keeps them, the remote-no-taker health check reads them.
CREATE TABLE IF NOT EXISTS remote_no_taker (
  repo TEXT PRIMARY KEY,
  since INTEGER NOT NULL              -- ms since epoch
) WITHOUT ROWID;
-- The cool-off of a login's helpers in the user-local inference mode (src/remote/cooloff.ts): no calls until `until`.
CREATE TABLE IF NOT EXISTS remote_cooloffs (
  login TEXT PRIMARY KEY COLLATE NOCASE,
  until INTEGER,                      -- ms since epoch; null or past when not cooling off
  reason TEXT,                        -- why, as the claim reply and the Connect page show it
  failures INTEGER NOT NULL DEFAULT 0, -- failed replies (ok: false) in a row
  failures_since INTEGER              -- the first of them
);
-- The secret hashes of leases that ended or went back to the queue, so their routes answer 410 rather than 401 (kept 24 hours).
CREATE TABLE IF NOT EXISTS remote_lease_tombstones (
  secret_hash TEXT PRIMARY KEY,
  call_id INTEGER NOT NULL,
  at INTEGER NOT NULL                 -- ms since epoch
);
CREATE INDEX IF NOT EXISTS remote_lease_tombstones_at ON remote_lease_tombstones(at);
-- The dashboard's liveness stamp (src/remote/liveness.ts), one row: written every 5 seconds; `since` is when the current
-- unbroken run of stamps began. Leases expire only while the dashboard was alive for the whole idle window.
CREATE TABLE IF NOT EXISTS remote_liveness (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  alive_at INTEGER NOT NULL,
  since INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_tokens_login ON mcp_tokens(login);
-- The last status of each helper (an agent token that may run tasks) in the user-local inference mode (src/remote/helpers.ts):
-- readiness (src/remote/protocol.ts Readiness), until and reason as the helper sent them, JSON of its models, reserve and usage.
CREATE TABLE IF NOT EXISTS remote_helpers (
  token_id INTEGER PRIMARY KEY,
  login TEXT NOT NULL COLLATE NOCASE,
  readiness TEXT NOT NULL,
  until TEXT, reason TEXT,
  harness TEXT NOT NULL,
  models TEXT NOT NULL, reserve TEXT NOT NULL, usage TEXT,
  reported_at INTEGER NOT NULL,       -- ms since epoch
  slots INTEGER, busy INTEGER,        -- calls the helper runs at once (its --parallel slots and the fast lane), and how many run now
  last_error TEXT,                    -- JSON { text, at }: the helper's last failure that no success has cleared
  helper_version TEXT                 -- the helper's version from its latest status or claim
);
-- Device logins of Task Runners (POST /api/remote/login/start, /poll; approved on the Connect page). The runner keeps the
-- credential and sends its hash; approval inserts a `runner` mcp_tokens row with that hash as token_hash. Times are ms since epoch.
CREATE TABLE IF NOT EXISTS runner_logins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_code TEXT NOT NULL,            -- 8 characters of BCDFGHJKLMNPQRSTVWXZ, stored uppercase without the hyphen; single use
  secret_hash TEXT NOT NULL,          -- sha256 hex of the runner's credential (protocol LoginStart.credentialHash)
  label TEXT,
  machine TEXT,                       -- JSON { hostname, platform, arch } as the runner sent it
  ip TEXT,                            -- the requesting client address
  helper_version TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied | expired
  login TEXT COLLATE NOCASE,          -- the user who approved or denied it
  token_id INTEGER,                   -- the mcp_tokens row the approval made
  want_agent INTEGER NOT NULL DEFAULT 1, -- the scopes the runner asked for (LoginStart.scopes); the approver sets the final ones
  want_answer INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS runner_logins_code ON runner_logins(user_code);
CREATE UNIQUE INDEX IF NOT EXISTS runner_logins_secret ON runner_logins(secret_hash);
CREATE INDEX IF NOT EXISTS runner_logins_expires ON runner_logins(expires_at);
-- Each user's own settings, one row per key (src/remote/reserve.ts: reserve_five_hour, reserve_weekly; src/remote/my-repos.ts: repos;
-- src/remote/max-calls.ts: max_calls; manual_only: '1' when the user's runners take only the calls the user picked and
-- follow-ups of their own sessions).
CREATE TABLE IF NOT EXISTS user_settings (
  login TEXT NOT NULL COLLATE NOCASE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (login, key)
);
-- The GitHub App's user token of each login, written at every sign-in while the GitHub identity is the app.
-- Separate from sessions: later steps act for a login when it has no live session.
CREATE TABLE IF NOT EXISTS user_tokens (
  login TEXT PRIMARY KEY COLLATE NOCASE,
  github_id INTEGER NOT NULL,
  token_enc TEXT NOT NULL,            -- sealed JSON of the whole token set (access, refresh, expiry times), like sessions.token_enc
  version INTEGER NOT NULL DEFAULT 1, -- compare-and-swap counter for refreshes
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok'   -- ok; refresh-failed: the refresh token is dead or expired, the login must sign in again
);
-- Sealed token sets waiting for the dashboard to revoke them at GitHub. A row stays until GitHub confirms the revoke,
-- or until `attempts` failed sweeps have used it up.
CREATE TABLE IF NOT EXISTS user_token_revocations (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  token_enc TEXT NOT NULL,            -- sealed like user_tokens.token_enc, or like the session's token_enc (see aad)
  queued_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'grant', -- grant: the login's whole authorization (access removed); token: one token (a revoked session)
  aad TEXT,                           -- what token_enc was sealed with; null: the user_tokens one for `login`
  attempts INTEGER NOT NULL DEFAULT 0 -- failed sweeps so far
);

-- The registered GitHub App (src/github/app-keys.ts): at most one row, id 1. keys_enc null: the app was removed, and a
-- secrets file's app keys are not imported again (they are imported only while no row exists).
CREATE TABLE IF NOT EXISTS github_app (
  id INTEGER PRIMARY KEY,
  app_id TEXT,
  slug TEXT,
  keys_enc TEXT,                      -- sealed JSON of the app's keys (TokenBox, aad 'github_app:1')
  updated_at TEXT NOT NULL
);

-- The GitHub App user token of a Discord reporter (src/discord/reporter.ts), keyed by the Discord user's keyed hash. Not a
-- dashboard login: it grants no access, it only lets the bot file an issue as that GitHub account.
CREATE TABLE IF NOT EXISTS reporter_tokens (
  reporter TEXT PRIMARY KEY,          -- keys.hash("author", discord user id)
  github_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  token_enc TEXT NOT NULL,            -- sealed JSON of the token set; aad names this table and the reporter
  version INTEGER NOT NULL DEFAULT 1, -- compare-and-swap counter for refreshes
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok'   -- ok; refresh-failed: the reporter must sign in again
);
-- Single-use sign-in states of reporters; only the hash of the state is kept.
CREATE TABLE IF NOT EXISTS reporter_states (
  state_hash TEXT PRIMARY KEY,
  reporter TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  verifier TEXT NOT NULL              -- PKCE verifier of the authorization
);
-- Issues filed from Discord, for the per-login and per-repo daily limits.
CREATE TABLE IF NOT EXISTS discord_filed (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  login TEXT NOT NULL COLLATE NOCASE,
  reporter TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS discord_filed_at ON discord_filed (at);
-- Counters of the public issue flow, for the Discord page's usage: one row per event, no text and no Discord ids. Rows older than 8 days are pruned.
CREATE TABLE IF NOT EXISTS discord_events (
  at TEXT NOT NULL,
  kind TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS discord_events_at ON discord_events (at);
-- Public repos of any owner the Discord issue bot files into without tracking them: no sync, no pipeline, no search.
-- A name here is never a tracked repo or a `repos` row of another owner (repo names are unique across owners).
CREATE TABLE IF NOT EXISTS discord_filing_repos (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL
);

-- Tracked public repos the Discord issue bot does not offer in its repo select. No row: offered. Search, pings and
-- channel defaults are unaffected.
CREATE TABLE IF NOT EXISTS discord_hidden_repos (
  name TEXT PRIMARY KEY,
  hidden_by TEXT,
  hidden_at TEXT
);

-- One row per started GitHub App registration: the manifest flow's single-use state nonce.
CREATE TABLE IF NOT EXISTS github_app_states (
  state TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  session_hash TEXT NOT NULL,         -- id_hash of the session that started the registration
  created_at TEXT NOT NULL
);

-- GitHub accounts the GitHub App may be installed on (src/github/allowed-owners.ts). No row: any account may install it
-- and nothing is removed; with rows, an installation on another account is uninstalled. Installations match by account id;
-- a row whose id GitHub could not tell yet matches by login until a later read fills it.
CREATE TABLE IF NOT EXISTS app_allowed_owners (
  login TEXT PRIMARY KEY COLLATE NOCASE,  -- as GitHub spells it; refreshed from the installation when the id matches
  account_id INTEGER UNIQUE,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL
);

-- One-time links an operator hands to an org owner to set the GitHub App up in their org. Only the hash of the link's secret is kept.
CREATE TABLE IF NOT EXISTS github_setup_links (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  created_by TEXT NOT NULL,           -- the operator the owner is asked to make an app manager
  hash TEXT NOT NULL UNIQUE,          -- sha256 of the secret in the URL
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  used_at TEXT,
  used_by TEXT,                       -- the org owner's login
  installation_id INTEGER
);

CREATE TABLE IF NOT EXISTS repo_permissions (
  login TEXT NOT NULL COLLATE NOCASE,
  repo TEXT NOT NULL,
  permission TEXT NOT NULL,           -- admin | maintain | write | triage | read | none
  checked_at TEXT NOT NULL,
  PRIMARY KEY (login, repo)
);

-- The pipeline's own cache of PR authors' permissions (src/fixup/author-permission.ts); separate from repo_permissions, which settles dashboard users.
CREATE TABLE IF NOT EXISTS author_permissions (
  login TEXT NOT NULL COLLATE NOCASE,
  repo TEXT NOT NULL,
  permission TEXT,                    -- admin | write | read | none; NULL until a read succeeds
  checked_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0, -- failed reads since the last success
  first_failure_at TEXT,
  PRIMARY KEY (login, repo)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,             -- PKCE code verifier
  return_to TEXT,
  identity TEXT,                      -- the GitHub identity (box | app) the sign-in started under
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  at TEXT NOT NULL,
  login TEXT NOT NULL,
  action TEXT NOT NULL,               -- answer | undo | adopt | opinion | opinion-retract | comment | override | rule | access-add | access-remove | access-role | session-revoke | sign-in | sign-in-refused (at most one row per login per hour; details.refused counts them) | repo-track | repo-untrack | labels-approve | labels-revoke | merge-approve | merge-revoke | labels-apply | assign | merge | merge-refused | comment-approve | comment-revoke | review-post | review-edit | act-comment | act-close | act-skip | job-request | job-cancel | deadline-ack | pipeline-switch | stage-limit | env-create | env-change | env-rotate-key | task-cancel | unassign | batch-again | ci-approve | ci-revoke | ci-run-approve
  target TEXT,
  details TEXT                        -- JSON
);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
CREATE INDEX IF NOT EXISTS audit_target ON audit(target);
CREATE INDEX IF NOT EXISTS audit_assign ON audit(target) WHERE action IN ('assign', 'unassign');

-- Dashboard query indexes.
CREATE INDEX IF NOT EXISTS items_closed ON items(closed_at, state);
CREATE INDEX IF NOT EXISTS items_created ON items(created_at);
CREATE INDEX IF NOT EXISTS items_pr_author ON items(kind, author, state, repo, merged_at);
CREATE INDEX IF NOT EXISTS items_open ON items(state, repo, number);
CREATE INDEX IF NOT EXISTS classifications_run ON classifications(run_id, classifier, repo, number);
-- The newest verdict of a classifier (latestRun) without reading every row.
CREATE INDEX IF NOT EXISTS classifications_latest ON classifications(classifier, at);
CREATE INDEX IF NOT EXISTS classifications_dup ON classifications(repo, dup_of) WHERE dup_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS token_usage_run ON token_usage(run_id, stage, model);

-- Repos the dashboard, pipeline and sync work on. `repos` keeps every org repo
-- (metadata only for untracked ones); operators choose here.
CREATE TABLE IF NOT EXISTS tracked_repos (
  name TEXT PRIMARY KEY,
  added_by TEXT,
  added_at TEXT
);
-- Every repo that was ever tracked: pipeline rows (jobs, tasks, runs) outlive untracking, and the dashboard hides them from non-operators by this list.
CREATE TABLE IF NOT EXISTS ever_tracked_repos (name TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS tracked_repos_ever AFTER INSERT ON tracked_repos BEGIN
  INSERT OR IGNORE INTO ever_tracked_repos (name) VALUES (NEW.name);
END;
-- Seeded once; the flag keeps the seed from returning after an operator empties the list.
INSERT INTO tracked_repos (name, added_by, added_at)
SELECT column1, 'seed', strftime('%Y-%m-%dT%H:%M:%SZ', 'now') FROM (VALUES
  ('photocraft'),
  ('pdfcraft'),
  ('wordcraft'),
  ('filmcraft'),
  ('gridcraft'),
  ('lightcraft'),
  ('cadcraft'),
  ('vectorcraft'),
  ('effectcraft'),
  ('designcraft'),
  ('deckcraft'),
  ('artcraft'),
  ('soundcraft'),
  ('figcraft'),
  ('texturecraft'),
  ('materialcraft'),
  ('stencilcraft'),
  ('craft-libs'),
  ('craft-launcher'),
  ('craft-anything'),
  ('craft-i18n'),
  ('craft-fonts'),
  ('font-preview-service'),
  ('artcraft-services'),
  ('egui'),
  ('winit')
) WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'tracked_seeded')
  AND NOT EXISTS (SELECT 1 FROM tracked_repos);
INSERT OR IGNORE INTO settings VALUES ('tracked_seeded', '1');

-- Pipeline jobs: the only channel from the dashboard to the runner
-- (`autocraft-server runner serve`). The dashboard inserts requests and cancel
-- marks; the runner claims, runs and finishes jobs. Steps are defined in code
-- (src/runner/steps.ts); params are validated against the step's schema
-- before a row is written.
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step TEXT NOT NULL,
  params TEXT NOT NULL,               -- JSON object, validated
  requested_by TEXT NOT NULL,         -- login, 'pipeline' (autopilot), 'cli' (a command-line run) or 'cli-queue' (queued by a command)
  requested_at TEXT NOT NULL,
  state TEXT NOT NULL,                -- queued | running | done | failed | cancelled
  started_at TEXT, ended_at TEXT,
  progress TEXT,                      -- one line, set while running
  summary TEXT,                       -- one line when done
  error TEXT,                         -- one line when failed
  usage TEXT,                         -- JSON {calls, input, output, costUsd} of model calls made by the job
  log_path TEXT,                      -- runner-side file; never sent to the browser
  pid INTEGER,                        -- the job's child process while running
  cancel_requested_at TEXT,
  cancel_requested_by TEXT,
  repo TEXT,                          -- params.repo, for the autopilot's per-repo lookups
  items INTEGER,                      -- items the job handled (classified, asked, reviewed, merged ...), for the daily limits
  acted INTEGER,                      -- other progress the job made (a batch advanced or opened, a decision asked ...); with items 0, the job was idle
  resumes INTEGER NOT NULL DEFAULT 0, -- times a runner stop or restart put the running job back in the queue (src/runner/resuming.ts)
  crash_resumes INTEGER NOT NULL DEFAULT 0 -- the resumes after an unclean stop (a crash or kill without the stop signal)
);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state, id);
-- The end of each job's log, copied by the runner from the job's log file in chunks of whole lines (src/runner/job-log.ts),
-- for a dashboard that does not share the runner's disk. Only the last 256 KiB of a job are kept, for 90 days; pruneJobs also deletes them with the job.
CREATE TABLE IF NOT EXISTS job_log_chunks (
  job_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  start INTEGER NOT NULL,             -- byte offset of the chunk in the log file; the first kept chunk's > 0: earlier text was dropped
  next_start INTEGER NOT NULL,        -- byte offset after the chunk in the log file (the chunk is scrubbed, so its length may differ)
  chunk TEXT NOT NULL,                -- scrubbed
  at TEXT NOT NULL,                   -- when it was copied; pruneJobLogs deletes chunks after 90 days
  PRIMARY KEY (job_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS job_log_chunks_at ON job_log_chunks(at);
CREATE INDEX IF NOT EXISTS jobs_step ON jobs(step, id);
CREATE INDEX IF NOT EXISTS jobs_step_started ON jobs(step, started_at);
CREATE INDEX IF NOT EXISTS jobs_user_ended ON jobs(requested_by, ended_at);

-- Daily limits per autopilot stage (UTC day); NULL means no limit, 0 pauses the
-- stage. The pipeline switch itself lives in settings (pipeline_enabled,
-- pipeline_changed_by, pipeline_changed_at).
CREATE TABLE IF NOT EXISTS stage_limits (
  step TEXT PRIMARY KEY,
  per_day INTEGER,                    -- items per day
  updated_by TEXT, updated_at TEXT
);
INSERT OR IGNORE INTO stage_limits (step, per_day) VALUES
  ('embed', NULL), ('decide', 100), ('checks', NULL),
  ('labels-apply', NULL), ('merge', 10), ('act', 20), ('fixup', 20), ('verify', 30), ('opus-review', 40);

-- One row per `autocraft-server sync` run, kept for two days, for the Pipeline page.
CREATE TABLE IF NOT EXISTS sync_runs (
  started_at TEXT NOT NULL,
  ended_at TEXT,
  mode TEXT,
  items INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS sync_runs_started ON sync_runs(started_at);
-- When AutoCraft last read an item from GitHub (poll or webhook re-read): when that read started, before its first request, never later. Bookkeeping: no live topic.
CREATE TABLE IF NOT EXISTS item_reads (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
) WITHOUT ROWID;
-- Items a verified GitHub App webhook named, for the runner to re-read. One row per item, so a burst collapses. Bookkeeping: no live topic.
CREATE TABLE IF NOT EXISTS sync_requests (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  event TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
) WITHOUT ROWID;
-- Commands a person wrote to the GitHub App in a comment (`@<app> merge queue`, `@<app> autorepin <pr>`, src/github/commands.ts), for the runner to
-- carry out and answer. Only these fields of the delivery are kept, never the comment's text. Bookkeeping: no live topic.
CREATE TABLE IF NOT EXISTS github_commands (
  comment_id INTEGER PRIMARY KEY,     -- GitHub's id of the comment: a redelivery adds nothing
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  pr INTEGER NOT NULL,                -- 1: the comment is on a pull request
  command TEXT NOT NULL,              -- merge-queue | autorepin | answer (maintainer workflow repos)
  weight INTEGER,                     -- the fast-track weight given, or null for the default
  login TEXT NOT NULL,                -- the commenter, as GitHub sent it
  github_id INTEGER NOT NULL,         -- the commenter's numeric GitHub id
  created_at TEXT NOT NULL,           -- the comment's creation time on GitHub: the PR head is pinned to this moment
  requested_at TEXT NOT NULL,         -- when the delivery arrived
  state TEXT NOT NULL,                -- queued | done | refused | ignored (no answer) | expired
  result TEXT,                        -- what the answer says
  done_at TEXT,
  tried_at TEXT,                      -- the last try that waited on GitHub (a re-read or a read that failed); the next one waits a minute
  retries INTEGER NOT NULL DEFAULT 0, -- tries GitHub could not settle (permission, comment or head read)
  allowed INTEGER,                    -- 1: the commenter may queue on the repo, so the answer needs no comment approval
  reply TEXT,                         -- posted | failed | none (no answer is given); null while the answer is still to post
  ref_repo TEXT,                      -- autorepin: the repository of the pull request it names, as written (`owner/name` or `name`); null with ref_number: autorepin off
  ref_number INTEGER,
  ref_branch TEXT,                    -- autorepin `via <branch>`: the dependency's branch to pin from; null: its default branch
  parsed TEXT                         -- answer (maintainer workflow repos): JSON Parsed (src/workflow/types.ts); null for the other commands
);
CREATE INDEX IF NOT EXISTS github_commands_state ON github_commands(state, reply);
-- Autorepin (src/repin): once the pull request `ref_repo#ref_number` is merged, the pull request `repo#number` gets a commit that
-- sets the `rev` of its Cargo dependencies on `ref_repo` to that merge commit. One row per pull request and dependency repository;
-- a new command for the same pair replaces it. Bookkeeping: no live topic.
CREATE TABLE IF NOT EXISTS autorepins (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  ref_repo TEXT NOT NULL,             -- tracked repo name of the dependency
  ref_number INTEGER NOT NULL,
  login TEXT NOT NULL,                -- who asked; their access is checked again before the push
  github_id INTEGER NOT NULL,         -- the asker's numeric GitHub id: the login must still be bound to it at the push
  requested_at TEXT NOT NULL,
  state TEXT NOT NULL,                -- waiting (for the merge) | locking (the lockfile task runs) | pushed | failed | cancelled
  sha TEXT,                           -- the commit pinned to (the merge commit, or with ref_branch the first commit of that branch holding it), once read
  head TEXT,                          -- the PR head the task works on (locking) and the commit was made on (pushed)
  task_id INTEGER,                    -- locking: the build task that writes Cargo.lock
  tries INTEGER NOT NULL DEFAULT 0,   -- attempts that did not finish (GitHub unreadable, the head moved, the task failed)
  tried_at TEXT,                      -- the last such attempt; the next one waits a minute (set ahead while the merge has not reached ref_branch)
  to_head TEXT,                       -- the commit pushed, written right before the push (pushed with null: nothing needed changing)
  result TEXT,                        -- what the comment on the pull request says
  done_at TEXT,
  notice TEXT,                        -- posted | failed | none; null while the comment is still to post
  ref_branch TEXT,                    -- `via <branch>`: pin to the first commit of this branch of ref_repo that holds the merge; null: the merge commit on the default branch
  PRIMARY KEY (repo, number, ref_repo)
) WITHOUT ROWID;
-- The latest `autorepin off` per pull request: a command written before it (one carried out late, after retries) sets nothing.
-- Bookkeeping: no live topic.
CREATE TABLE IF NOT EXISTS autorepin_offs (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  off_at TEXT NOT NULL,               -- the creation time of the off command's comment
  PRIMARY KEY (repo, number)
) WITHOUT ROWID;
-- A tracked repo the last sync could not read: skipped for the run, retried by the next. Bookkeeping: no live topic.
CREATE TABLE IF NOT EXISTS sync_repo_errors (
  repo TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- not-found | forbidden | transient | error
  message TEXT NOT NULL,
  moved_to TEXT,                      -- owner/name GitHub's REST endpoint redirects to, for not-found
  since TEXT NOT NULL,                -- first failure of the current streak
  at TEXT NOT NULL                    -- latest failure
);

-- What the last live read of a PR's formal reviews found (changes-requested.ts); sync never touches it.
CREATE TABLE IF NOT EXISTS review_gates (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  blocked INTEGER,                    -- 1 when a reviewer with write access has changes requested; NULL before any read
  by_login TEXT,                      -- those reviewers, comma separated
  read_at TEXT,                       -- ISO time of the last successful read
  failures INTEGER NOT NULL DEFAULT 0, -- reads that failed since the last success
  PRIMARY KEY (repo, number)
);

-- CI and merge state of open PRs at their head commit, for review candidates.
-- Written by `autocraft-server checks` and the Review stage; sync never touches it.
CREATE TABLE IF NOT EXISTS pr_checks (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,
  state TEXT,                         -- OPEN | CLOSED | MERGED at fetch time
  is_draft INTEGER,
  overall TEXT NOT NULL,              -- success | failure | pending | none (no checks ran)
  checks TEXT NOT NULL,               -- JSON [{name, state}]; state: success | failure | pending | skipped
  mergeable TEXT,                     -- MERGEABLE | CONFLICTING | UNKNOWN
  maintainer_can_modify INTEGER,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);

-- The code review: one Opus pass per PR head commit.
CREATE TABLE IF NOT EXISTS opus_reviews (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,
  run_id TEXT,
  at TEXT NOT NULL,
  model TEXT,
  mode TEXT NOT NULL,                 -- full | delta
  base_head TEXT,                     -- delta: the head Opus had reviewed before
  verdict TEXT,                       -- take | take-fix | hold | close
  sure INTEGER,                       -- 1 when Opus is sure of its verdict
  reason TEXT,
  fixes TEXT,                         -- JSON [{file, change}], the complete list for take-fix
  risks TEXT,                         -- JSON [string]
  -- public_review (added column): JSON {summary, points}, the text posted on the PR; NULL when the reply had none
  -- base_ref (added column): the base branch the reviewed diff was computed against; NULL for reviews stored before it was recorded
  -- workflow (added column): for an item on the maintainer workflow, JSON {outside_purpose: {lines, note} | null, recommendation: string | null}
  PRIMARY KEY (repo, number, head_oid)
);

-- Every Opus review ever stored, appended with each write of opus_reviews (which keeps only the latest per head).
-- A take or take-fix with sure = 0 here keeps its head needing a person's Merge? answer even after a later review of the same head is sure.
CREATE TABLE IF NOT EXISTS opus_review_history (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,
  at TEXT NOT NULL,
  model TEXT, mode TEXT, verdict TEXT, sure INTEGER,
  reason TEXT, risks TEXT, fixes TEXT, summary TEXT, why TEXT, public_review TEXT
);
CREATE INDEX IF NOT EXISTS opus_review_history_head ON opus_review_history(repo, number, head_oid);

-- What a review did with the fixes of an earlier take-fix that were never applied (a new head came first): kept in
-- its fix list, explained in its reason, or unaddressed. One row per fix, replaced with the review of the head.
CREATE TABLE IF NOT EXISTS opus_carried_fixes (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,             -- the head the review was made at
  from_head TEXT NOT NULL,            -- the head of the take-fix that asked for the change
  file TEXT NOT NULL, change TEXT NOT NULL,
  outcome TEXT NOT NULL,              -- kept | explained | unaddressed
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS opus_carried_fixes_head ON opus_carried_fixes(repo, number, head_oid);

-- The verdict every later stage reads, per reviewed head commit: the Opus verdict.
-- A PR with no row here is not reviewed yet. An unsure take or take-fix keeps its verdict;
-- the merge queue asks a person before merging it.
DROP VIEW IF EXISTS final_reviews;
CREATE VIEW final_reviews AS
SELECT repo, number, head_oid, run_id, at, model, verdict, reason, fixes, risks, sure, mode, base_head, seen_at, disc_hash
FROM opus_reviews WHERE verdict IS NOT NULL;

-- Merge attempts by the Integrate stage, one row per try at a PR head.
-- outcome: merged | refused (the merge command or a pre-merge check said no, with why).
CREATE TABLE IF NOT EXISTS merges (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,
  run_id TEXT NOT NULL,
  at TEXT NOT NULL,
  path TEXT NOT NULL,                 -- rule (merge without asking) | operator (answered Merge? decision)
  method TEXT,                        -- squash | merge; null when refused before the command ran
  outcome TEXT NOT NULL,              -- merged | refused
  reason TEXT,                        -- one line, public-safe
  ci TEXT, mergeable TEXT             -- CI and mergeable state GitHub reported at the attempt
);
CREATE INDEX IF NOT EXISTS merges_item ON merges(repo, number, at);

-- Full-text search over item titles and bodies and comment bodies. Both are
-- external-content tables (the text stays in items and comments only), kept
-- current by these triggers; db.ts builds them once for an existing database.
-- The sync writes items with an upsert, which keeps their rowids, and connect()
-- turns on recursive_triggers so an INSERT OR REPLACE also runs the delete triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, body, content='items', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE IF NOT EXISTS comments_fts USING fts5(
  body, content='comments', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2');

CREATE TRIGGER IF NOT EXISTS items_fts_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS items_fts_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts (items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS items_fts_au AFTER UPDATE OF title, body ON items
WHEN old.title IS NOT new.title OR old.body IS NOT new.body OR old.rowid <> new.rowid BEGIN
  INSERT INTO items_fts (items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO items_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS comments_fts_ai AFTER INSERT ON comments BEGIN
  INSERT INTO comments_fts (rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER IF NOT EXISTS comments_fts_ad AFTER DELETE ON comments BEGIN
  INSERT INTO comments_fts (comments_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER IF NOT EXISTS comments_fts_au AFTER UPDATE OF body ON comments
WHEN old.body IS NOT new.body OR old.rowid <> new.rowid BEGIN
  INSERT INTO comments_fts (comments_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO comments_fts (rowid, body) VALUES (new.rowid, new.body);
END;
CREATE INDEX IF NOT EXISTS items_updated ON items(updated_at);
CREATE INDEX IF NOT EXISTS items_state_updated ON items(state, updated_at);
CREATE INDEX IF NOT EXISTS items_author_nocase ON items(author COLLATE NOCASE);

-- Sentence embeddings of tracked items, for similar items and semantic search.
-- Written by `autocraft-server embed` (src/embed/); the dashboard only reads them.
CREATE TABLE IF NOT EXISTS item_embeddings (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  model TEXT NOT NULL,                -- embedder id: "<model>:<dtype>:<max tokens>"; another model's rows count as missing
  hash TEXT NOT NULL,                 -- of the embedded text (src/embed/text.ts), so only changed items are embedded again
  vec BLOB NOT NULL,                  -- float32, little-endian, unit length
  at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);

-- Flowchart counts per repo (src/flow/), so the home page adds up a few hundred
-- small rows instead of counting the mirror. The runner refreshes the rows of
-- repos whose items, verdicts, decisions, reviews, checks or merges changed, and
-- every row at least every ten minutes; the dashboard counts a repo itself only
-- when it has no row yet.
CREATE TABLE IF NOT EXISTS flow_summary (
  repo TEXT PRIMARY KEY,
  counts TEXT NOT NULL,               -- JSON {key: count}, keys as in src/flow/count.ts
  counted_at TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,   -- 1: changed since counted_at, waiting for the next refresh
  decisions_sig TEXT                  -- the repo's decisions when counted, to notice answers and undos
);

-- Claude accounts an operator may enable. A row exists for each account in the
-- box config (AUTOCRAFT_ACCOUNTS); the config directory is never stored here.
CREATE TABLE IF NOT EXISTS claude_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,                -- the only name shown to people
  enabled INTEGER NOT NULL DEFAULT 0,
  max_concurrent INTEGER NOT NULL DEFAULT 2,
  updated_by TEXT,
  updated_at TEXT
);

-- Usage readings, written by the runner when a reading changes; kept 30 days.
-- t is the reading's own time (ISO), so a reading is recorded once.
CREATE TABLE IF NOT EXISTS account_usage_samples (
  account_id TEXT NOT NULL,
  t TEXT NOT NULL,
  five_hour_pct REAL,
  weekly_pct REAL,
  PRIMARY KEY (account_id, t)
) WITHOUT ROWID;

-- One row per model call made through the prompt registry. Ids grow with time,
-- so newest-first paging is a keyset on id. Prompt and output text live in
-- agent_run_texts; both are kept ten years.
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  step TEXT NOT NULL,
  stage INTEGER NOT NULL,
  prompt_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  provider TEXT NOT NULL,             -- claude | jev
  model TEXT NOT NULL,
  account_id TEXT,                    -- null for Jev
  items TEXT NOT NULL DEFAULT '[]',   -- JSON [{repo, number}], at most 50
  item_count INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,                -- running | done | failed
  started_at TEXT NOT NULL,
  ended_at TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  summary TEXT,
  error TEXT,
  progress TEXT,                      -- running: the latest line of what the call is doing
  cost_usd REAL,                      -- the call's cost in USD (Jev: input tokens times the flat price); null for rows from before this column
  user_login TEXT,                    -- user-local mode: the maintainer whose helper ran the call
  harness TEXT,                       -- user-local mode: claude | codex
  reported_model TEXT                 -- user-local mode: the model the harness reported
);
CREATE INDEX IF NOT EXISTS agent_runs_state ON agent_runs(state, id);
CREATE INDEX IF NOT EXISTS agent_runs_step ON agent_runs(step, id);
CREATE INDEX IF NOT EXISTS agent_runs_job ON agent_runs(job_id, id);
CREATE INDEX IF NOT EXISTS agent_runs_started ON agent_runs(started_at);

-- Model calls waiting for a slot (Claude) or Jev capacity: bookkeeping for the call queue in src/agents/call.ts.
-- Written by the calling process every poll; rows not seen for 30 s are ignored, runner start deletes all.
CREATE TABLE IF NOT EXISTS model_waits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,             -- claude | jev
  class INTEGER NOT NULL,             -- 0 | 1 | 2
  job_id INTEGER,
  step TEXT NOT NULL,
  repo TEXT,
  since INTEGER NOT NULL,             -- ms since epoch, when the call began to wait
  seen_at INTEGER NOT NULL,           -- ms since epoch, last poll
  eligible INTEGER NOT NULL DEFAULT 0, -- 1 when an account could take the call at the last poll
  level INTEGER NOT NULL DEFAULT 2    -- urgency band of the call's first item, 4 (P0) to 0 (P4); orders waiters of a repo within a class
);
CREATE INDEX IF NOT EXISTS model_waits_seen ON model_waits(seen_at);

-- Model calls of the user-local inference mode (src/remote/calls.ts): the calling process inserts a call and polls it
-- until a maintainer's helper has claimed, run and submitted it. Times are ms since epoch.
CREATE TABLE IF NOT EXISTS remote_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  step TEXT NOT NULL,
  stage INTEGER NOT NULL,
  run_id INTEGER,                     -- the agent run of the current or last lease
  prompt_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  tier TEXT NOT NULL,                 -- top | mid | small
  effort TEXT NOT NULL,
  asked_model TEXT NOT NULL,          -- the registry's model name the stage asked for (opus, sonnet, haiku)
  bundle TEXT NOT NULL,               -- JSON TaskBundle (src/remote/protocol.ts) without callId
  state TEXT NOT NULL,                -- queued | leased | done | failed
  items TEXT NOT NULL DEFAULT '[]',   -- JSON [{repo, number}]: eligibility and the lease title
  repo TEXT,                          -- the job's repo: queue fairness and eligibility
  class INTEGER NOT NULL DEFAULT 0,   -- queue class, as model_waits
  level INTEGER NOT NULL DEFAULT 2,   -- urgency band, as model_waits
  since INTEGER NOT NULL,             -- when the call was made
  seen_at INTEGER NOT NULL,           -- the calling process's last poll; a call not polled for a while has lost its caller
  queued_since INTEGER,               -- while queued: when it entered the queue
  queued_ms INTEGER NOT NULL DEFAULT 0, -- time spent queued before the current lease
  user_login TEXT COLLATE NOCASE,     -- the lease holder
  harness TEXT, harness_version TEXT,
  model TEXT,                         -- the model the claim declared for the tier; a submit must report the same
  lease_secret_hash TEXT,             -- sha256 of the lease secret
  token_id INTEGER,                   -- the agent token that claimed the lease; the lease ends when it may no longer run tasks
  leased_at INTEGER, heartbeat_at INTEGER,
  started_at INTEGER,                 -- the lease's first `running` heartbeat: the call's time limit counts from here
  claim_id TEXT,                      -- the claim's request id (protocol Claim.requestId) that leased it
  attempt INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL,      -- the prompt's attempts limit
  timeout_ms INTEGER NOT NULL,        -- the bundle's wall-clock limit
  parent_id INTEGER,                  -- a follow-up turn: the call whose harness session it continues
  sticky_login TEXT COLLATE NOCASE,   -- a follow-up turn: only this user's helper holds the session
  for_login TEXT COLLATE NOCASE,      -- the call runs on this user's own Task Runners only (a maintainer's conversation turn); follow-ups keep it
  own_lane INTEGER NOT NULL DEFAULT 0, -- 1 while leased on the Task Runner's own lane (Claim.ownLane): counts toward no slot or Max calls at once
  bound_slot INTEGER NOT NULL DEFAULT 0, -- 1: a call bound to for_login that runs in one of that user's Task Runner slots (counts toward Max calls at once), never in the own lane
  released_by TEXT COLLATE NOCASE, released_at INTEGER, -- the last helper that gave the lease back: not offered that login again for a while
  release_wait_ms INTEGER,            -- how long that give-back keeps the call from released_by's runners; NULL: RELEASE_SKIP_MS (src/remote/calls.ts)
  setup_retries INTEGER NOT NULL DEFAULT 0, -- give-backs after a local setup failure that got the short wait (SETUP_RETRY_MS): at most max_attempts
  progress TEXT,                      -- the helper's last progress line
  reply TEXT, usage TEXT, turns INTEGER, session_id TEXT, duration_ms INTEGER,
  error TEXT,
  ended_at INTEGER,
  reference_repo TEXT,                -- the repo whose reference documentation the call's reference tools search
  root TEXT,                          -- the lease's path root: the claim's directory the sandbox paths are placed below (macOS helpers), or NULL for the fixed paths
  authors TEXT,                       -- JSON: lowercase logins that authored or co-authored an item of the call, read when it was queued (author preference)
  picked_by TEXT COLLATE NOCASE,      -- a user picked the queued call for their own Task Runners ("Run on my Task Runner"); cleared on requeue and unlease
  picked_at INTEGER,
  pick_until INTEGER,                 -- the pick counts until then
  no_taker_since INTEGER,             -- while queued: since when no Task Runner may take it (src/remote/takers.ts); withdrawn after a while
  bundle_hash TEXT,                   -- the reuse key (src/remote/reuse-key.ts): a resumed job adopts its earlier run's call with the same key
  consumed_at INTEGER,                -- when the caller read the done reply; a done call not yet read can still be adopted
  base_stdin TEXT,                    -- the bundle's stdin as queued, once a lease rewrote it (a workspace session's resume note)
  refusals INTEGER NOT NULL DEFAULT 0, -- retries after a model's safety filter declined the call (submitCall): at most one, and none uses an attempt
  refused_token INTEGER               -- the runner token whose model declined the call, when it was queued again for another Task Runner: not offered it again
);
CREATE INDEX IF NOT EXISTS remote_calls_state ON remote_calls(state, tier);
CREATE INDEX IF NOT EXISTS remote_calls_ended ON remote_calls(state, ended_at);
CREATE INDEX IF NOT EXISTS remote_calls_seen ON remote_calls(state, seen_at);
CREATE INDEX IF NOT EXISTS remote_calls_job ON remote_calls(job_id) WHERE job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS remote_calls_secret ON remote_calls(lease_secret_hash) WHERE lease_secret_hash IS NOT NULL;

-- `check` calls of a remote call's harness, relayed from the dashboard to the job process that holds the call's CheckTool
-- (src/remote/check-relay.ts): the dashboard inserts a request and polls for its result, the job's awaitCall loop runs it.
CREATE TABLE IF NOT EXISTS remote_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER NOT NULL,
  run_id INTEGER,                     -- the lease's agent run, which the check's model_checks row is recorded under
  input TEXT NOT NULL,                -- JSON tool arguments as the harness sent them
  state TEXT NOT NULL,                -- requested | running | done
  result TEXT,                        -- JSON {text, isError?}
  requested_at INTEGER NOT NULL,      -- ms since epoch
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS remote_checks_call ON remote_checks(call_id, state);
CREATE INDEX IF NOT EXISTS remote_checks_ended ON remote_checks(state, ended_at);

-- Reference passages served to remote calls (src/remote/tools.ts): each lease gets a limited number, and every one is recorded.
CREATE TABLE IF NOT EXISTS remote_passages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER NOT NULL,
  run_id INTEGER,                     -- the lease's agent run: the cap counts per lease
  user_login TEXT NOT NULL COLLATE NOCASE,
  repo TEXT NOT NULL,
  passage_id INTEGER NOT NULL,        -- id in the repo's reference index
  page TEXT NOT NULL,
  at INTEGER NOT NULL                 -- ms since epoch
);
CREATE INDEX IF NOT EXISTS remote_passages_lease ON remote_passages(call_id, run_id);

-- Who is working a PR, issue or finding right now: bookkeeping for src/runner/leases.ts. A lease whose job is not
-- running is free; runner start and a job's end delete its rows.
CREATE TABLE IF NOT EXISTS work_leases (
  key TEXT PRIMARY KEY,               -- pr:<repo>#<n> | issue:<repo>#<n> | finding:<repo>#<n>
  job_id INTEGER NOT NULL,
  step TEXT NOT NULL,
  taken_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_run_items (
  run_id INTEGER NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  PRIMARY KEY (run_id, repo, number)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS agent_run_items_repo ON agent_run_items(repo, run_id, number);

-- prompt and output are gzip BLOBs; rows written before compression hold plain text.
CREATE TABLE IF NOT EXISTS agent_run_texts (
  run_id INTEGER PRIMARY KEY,
  prompt TEXT,
  output TEXT
);

-- The tool uses of one model call (stream events), in order. Arguments are scrubbed and capped; only the size of a result is kept.
CREATE TABLE IF NOT EXISTS agent_run_tools (
  run_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,                 -- JSON, at most 4000 characters
  result_bytes INTEGER,
  is_error INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,                    -- arrival of the stream line; null for the non-streamed output form
  ended_at TEXT,
  check_id INTEGER,                   -- model_checks row, for the check tool
  PRIMARY KEY (run_id, seq)
) WITHOUT ROWID;

-- Full transcripts of model calls (every model message, tool call and tool result), one row per Task Runner attempt.
-- The gzip JSONL object lives in the transcript store (src/transcripts: an S3-compatible bucket or a local directory);
-- the row is its pointer and summary. Kept ten years, like agent_run_texts.
CREATE TABLE IF NOT EXISTS agent_run_transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  call_id INTEGER,                    -- remote_calls.id
  attempt INTEGER NOT NULL DEFAULT 0, -- the call's attempt the transcript is of
  outcome TEXT NOT NULL,              -- done | failed | refused
  store TEXT NOT NULL,                -- local | s3
  bucket TEXT,                        -- s3: the bucket the object is in
  object_key TEXT NOT NULL,
  bytes INTEGER NOT NULL,             -- size of the stored (gzip) object
  raw_bytes INTEGER NOT NULL,         -- size of the JSONL
  sha256 TEXT NOT NULL,               -- of the stored object
  lines INTEGER NOT NULL,             -- events in the transcript
  tool_count INTEGER NOT NULL,
  last_tool TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_run_transcripts_run ON agent_run_transcripts(run_id, id);

-- Transcripts a Task Runner may still send (ROUTES.transcript) for an attempt it has just submitted, by the lease secret's
-- hash: the upload takes its row, and rows past `until_ms` are dropped on the next insert.
CREATE TABLE IF NOT EXISTS transcript_waits (
  secret_hash TEXT PRIMARY KEY,
  run_id INTEGER NOT NULL,
  call_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  outcome TEXT NOT NULL,              -- done | failed | refused
  root TEXT,                          -- the claim's path root
  until_ms INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS jobs_started ON jobs(started_at);

-- Build environments: places that run untrusted code (workers), registered by an
-- operator. The worker key is shown once and stored as a SHA-256 hash.
CREATE TABLE IF NOT EXISTS build_envs (
  id TEXT PRIMARY KEY,                -- lowercase letters, digits and hyphens
  label TEXT NOT NULL,                -- the only name shown to people
  kind TEXT NOT NULL,                 -- local-sandbox | remote | kubernetes
  enabled INTEGER NOT NULL DEFAULT 1,
  slots INTEGER NOT NULL,             -- the operator's cap; the worker may report fewer
  confidential INTEGER NOT NULL DEFAULT 0, -- set by an operator, never by the worker: takes the security lane's private tasks and no PR code
  confidential_since TEXT,            -- when the flag (or the environment, while flagged) was last turned on
  confidential_online_at TEXT,        -- the worker's first call after confidential_since: from then on it can take private tasks
  key_hash TEXT NOT NULL,
  capabilities TEXT,                  -- JSON Capabilities as last reported by the worker
  reported_slots INTEGER,
  version TEXT,
  paused_reason TEXT,                 -- as last reported by the worker
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT,
  settings TEXT,                      -- JSON KubeSettings of a kubernetes environment
  health TEXT,                        -- JSON { state, text, since } the pod launcher last found; null when all is well
  health_at TEXT                      -- when the pod launcher last wrote health
);

-- Tasks: one unit of untrusted execution created by a pipeline step.
CREATE TABLE IF NOT EXISTS build_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  step TEXT NOT NULL,                 -- pipeline step that created it
  repo TEXT NOT NULL,
  number INTEGER,                     -- PR
  head_sha TEXT NOT NULL,
  base_sha TEXT,
  requires TEXT NOT NULL,             -- JSON Requires
  priority INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL,                 -- JSON TaskStep[]
  state TEXT NOT NULL,                -- queued | claimed | running | done | failed | cancelled | lost
  env_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,  -- claims so far; a lost task is requeued once
  queued_at TEXT NOT NULL,
  claimed_at TEXT, started_at TEXT, ended_at TEXT,
  heartbeat_at TEXT,
  cancel_requested_at TEXT,
  results TEXT NOT NULL DEFAULT '[]', -- JSON, as reported by the worker
  summary TEXT,                       -- one line, as reported by the worker
  log_bytes INTEGER NOT NULL DEFAULT 0,
  artifact_bytes INTEGER NOT NULL DEFAULT 0,
  patch TEXT,                         -- unified git diff the worker applies to the checkout (at most 1 MiB)
  warm_key TEXT,                      -- build-cache key shared by tasks of one repo
  warm_role TEXT,                     -- use | build
  sandbox_env TEXT,                   -- JSON SandboxEnv: image and CI-gate inputs the worker used
  warm_image TEXT                     -- warm tasks: the toolchain image the task was queued with
);
CREATE INDEX IF NOT EXISTS build_tasks_queue ON build_tasks(priority DESC, id) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS build_tasks_env ON build_tasks(env_id, state);
CREATE INDEX IF NOT EXISTS build_tasks_active ON build_tasks(heartbeat_at) WHERE state IN ('claimed', 'running');
CREATE INDEX IF NOT EXISTS build_tasks_repo ON build_tasks(repo, id);

-- A build task running in Kubernetes pods (src/build/launcher.ts): one row while its pods and volume exist.
-- The pod key authenticates only the task's API pods and dies with the row.
CREATE TABLE IF NOT EXISTS build_pod_runs (
  task_id INTEGER PRIMARY KEY,
  env_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  pvc TEXT NOT NULL,                  -- the task's volume
  stage INTEGER NOT NULL DEFAULT 0,   -- 0 task, 1 source, 2.. step groups, then upload (pods.ts)
  pod TEXT,                           -- the stage's pod
  pod_created_at TEXT,
  prepared TEXT,                      -- JSON Prepared from the source pod
  results TEXT NOT NULL DEFAULT '[]', -- JSON TaskResult[] read from pod status
  failed TEXT,                        -- summary of the first failure; later step groups are skipped
  ran INTEGER NOT NULL DEFAULT 0,     -- plan steps that ran
  logged TEXT NOT NULL DEFAULT '[]',  -- JSON list of "<pod>/<container>" whose output is in the task log
  create_tries INTEGER NOT NULL DEFAULT 0, -- failed creates of the stage's pod in a row
  failing_since TEXT,                 -- the first of them
  retry_at TEXT,                      -- when the next create is tried
  started_at TEXT NOT NULL,
  node TEXT,                          -- the node the run was placed on; its volume binds there
  reserved_cpu_m INTEGER,             -- the run's largest stage request, held on that node for the run's life
  reserved_mem_bytes INTEGER,
  disruptions INTEGER NOT NULL DEFAULT 0, -- stage pods the cluster took away (preemption, eviction) and that were recreated
  replaces INTEGER NOT NULL DEFAULT 0, -- first pods no node had room for, deleted and placed again
  log_positions TEXT NOT NULL DEFAULT '{}' -- JSON {"<pod>/<container>": LogPos}: how far a running container's output reached the task log
);

-- What an operator set, or an OOM kill taught, for a repository's build step pods (src/build/sizing.ts); without a row
-- memory and warm target are automatic.
CREATE TABLE IF NOT EXISTS build_sizes (
  repo TEXT PRIMARY KEY,
  memory_request_bytes INTEGER NOT NULL,
  memory_limit_bytes INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  reason TEXT NOT NULL,               -- what set it: an operator, or an OOM-killed step
  warm_target TEXT NOT NULL DEFAULT 'auto',  -- tmpfs | pvc | none, or auto: where its build pods put a warm target (src/build/warm-mount.ts)
  memory_source TEXT NOT NULL DEFAULT 'operator'  -- operator | oom (a floor) | auto (the memory columns are unused)
);

-- A workspace: one session's pod and volume in a kubernetes environment (src/build/workspace-launch.ts). The row
-- outlives both, so a lost volume can be rebuilt from the base plus the checkpoint.
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  base_sha TEXT NOT NULL,             -- the repository commit the source comes from
  base_commit TEXT,                   -- the commit `ws untar` made of it in the pod; checkpoints diff against it
  app TEXT,
  env_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'requested', -- requested | starting | seeding | ready | parked | ended | failed
  state_at TEXT NOT NULL,             -- when the row entered its state
  pod TEXT,
  pod_created_at TEXT,                -- the last create of the pod, failed or not
  create_tries INTEGER NOT NULL DEFAULT 0, -- creates of the pod since it last started
  pvc TEXT,                           -- null once deleted (a parked volume past its keep time)
  node TEXT,                          -- where the volume lives (local-path pins it)
  limits TEXT NOT NULL DEFAULT '{}',  -- JSON WorkspaceLimits
  checkpoint BLOB,                    -- `git diff --binary` against base_commit, at most 5 MiB
  checkpoint_at TEXT,
  last_call_at TEXT,
  next_call INTEGER NOT NULL DEFAULT 1, -- the next `ws run` call number
  error TEXT,                         -- why it failed, or the last checkpoint problem
  owner TEXT,                         -- what asked for it: `cli` or a job id
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  remote_call_id INTEGER,             -- the remote call whose session uses the workspace's tools (src/build/workspace-relay.ts)
  volume_fresh INTEGER NOT NULL DEFAULT 0, -- 1: the volume was made empty for the current start, so seeding fills it
  resume_tries INTEGER NOT NULL DEFAULT 0, -- resumes that failed since the workspace was last ready
  checkpoint_error TEXT,              -- why the last checkpoint failed; while set, the volume holds work no checkpoint has
  restored TEXT,                      -- how the last resume brought the tree back: kept | checkpoint <checkpoint_at> | empty
  restored_at TEXT,
  layout INTEGER NOT NULL DEFAULT 1,  -- 1: checkout /work/src, CARGO_HOME /work/cargo; 2: the CI paths (src/build/workspace-layout.ts)
  prepared TEXT,                      -- layout 2: JSON WorkspacePrepared, the CI gate's env at the base commit
  warm TEXT,                          -- layout 2: JSON WorkspaceWarm, how the current volume's target started
  warm_commit TEXT                    -- the warm version the target was copied from; null when it started cold
);
CREATE INDEX IF NOT EXISTS workspaces_env ON workspaces(env_id, state);

-- Every exec in a workspace: the session's tool calls and the launcher's own seeding and checkpoints. Text is untrusted.
CREATE TABLE IF NOT EXISTS workspace_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  n INTEGER,                          -- the `ws run` call number; null for other helper subcommands
  tool TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '{}',    -- JSON
  state TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed
  result TEXT,                        -- JSON: the helper's header and the cleaned, capped output
  created_at TEXT NOT NULL,
  started_at TEXT,
  deadline_at TEXT,                   -- past this a call still marked running no longer keeps the pod from parking
  finished_at TEXT,
  run_id INTEGER                      -- a session's call: the agent run of the lease it came from
);
CREATE INDEX IF NOT EXISTS workspace_calls_ws ON workspace_calls(workspace_id, id);

-- A model session in a workspace (src/build/workspace-session.ts): what it was asked, where it ran and how it ended.
-- `prompt` is operator text: it goes only into the session's model call, never into job params or logs.
CREATE TABLE IF NOT EXISTS workspace_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT,                          -- what the session is for: try (an operator's test session)
  repo TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  item INTEGER NOT NULL,              -- the issue or PR in repo the session works for
  prompt TEXT,
  env_id TEXT NOT NULL,               -- the kubernetes environment of a workspace the session creates
  keep INTEGER NOT NULL DEFAULT 0,    -- 1: the workspace stays live after the session
  deadline_sec INTEGER NOT NULL,      -- the session call's time limit
  state TEXT NOT NULL DEFAULT 'queued', -- queued | starting | running | done | failed
  outcome TEXT,                       -- one line once it ended
  workspace_id INTEGER,               -- given, or set when the job creates the workspace
  remote_call_id INTEGER,
  job_id INTEGER,
  requested_by TEXT NOT NULL,
  for_login TEXT COLLATE NOCASE,      -- a try session: the login whose own Task Runners run its model call
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS build_tasks_state ON build_tasks(state, id);
CREATE INDEX IF NOT EXISTS build_tasks_ended ON build_tasks(ended_at);

-- Log chunks as the worker sent them (text, untrusted); capped per task.
CREATE TABLE IF NOT EXISTS build_task_logs (
  task_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  step TEXT NOT NULL,
  chunk TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
) WITHOUT ROWID;

-- Artifact metadata; the bytes are files under the artifact directory.
CREATE TABLE IF NOT EXISTS build_artifacts (
  task_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,         -- from sniffing the bytes, never from the worker's header
  file TEXT NOT NULL,                 -- path under the artifact directory
  PRIMARY KEY (task_id, name)
) WITHOUT ROWID;

-- GitHub writes made after an operator's answer (src/act): one row per decision
-- and item. done: commented and closed; skipped: the item had already closed
-- or its head moved, nothing written; failed: retried by the next run (a
-- comment_url on a failed row means the comment is posted and only the close is left).
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT NOT NULL,
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- comment-close
  state TEXT NOT NULL,                -- done | skipped | failed | stopped (failed ACT_MAX_ATTEMPTS times; a person retries, undoes or answers again)
  comment_url TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, -- failed tries; db.ts adds it to older databases
  UNIQUE (decision_id, repo, number, kind)
);
CREATE INDEX IF NOT EXISTS actions_item ON actions(repo, number);
-- Fix-up tries by the Integrate stage on take-fix PRs, one row per try (or per
-- head for cannot-push and too-large). state: pushed | failed | refused (the
-- patch or a pre-push check said no) | cannot-push | too-large | asked (the fixes
-- were posted as a comment on a PR we can't push to), comment-failed (final: that comment failed after its request went out),
-- comment-unsent (that comment never reached GitHub: asked again after a backoff, src/core/rules.ts unsentAsk; a carry-over's row has source 'carry'), pushing (written before the push, to_head is the commit about to be
-- pushed; replaced by the push's outcome; one left behind by a crash counts as a try). Only the first
-- three count against the two tries per PR. superseded: a row whose reason no longer applies (kept for the record, ignored).
-- source: NULL = the review's fix list, 'premerge' = the pre-merge review's fix list (up to PREMERGE_FIX_ROUNDS rounds per PR).
CREATE TABLE IF NOT EXISTS fixups (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  from_head TEXT NOT NULL,            -- the reviewed head commit the fix was made on
  to_head TEXT,                       -- the pushed commit; NULL unless pushed
  state TEXT NOT NULL,
  reason TEXT,                        -- one line, public-safe
  files TEXT,                         -- JSON [path] the fix names (pushed: the files changed)
  attempt INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fixups_item ON fixups(repo, number, created_at);
-- CI fix tries (src/cifix): one row per try at a head whose gate check failed. kind: format | code | infra.
-- state: infra (waiting for the one rerun) | rerun | formatting (formatter task queued, task_id) | pushed | asked (patch posted as a comment) |
-- linting (a model patch is stored, patch/lint_task/lint_round/lint_state, and waits for its lint task) | failed | refused | rejected | cannot-push | push-denied | pushing (written before the push, to_head is the commit about to be pushed) |
-- skipped (final: nothing to fix here, not a try) | capped (final: the PR's limit of 2 pushed fixes or 4 tries is used; not a try) | rerunning (rerun requested, written before the gh calls) | comment-failed (final: the patch comment failed) | comment-unsent (the comment never reached GitHub, not a try: the stored patch or formatter result is posted again after a backoff, src/core/rules.ts unsentAsk; a patch without a lint task is kept as a linting row with no lint_task) | superseded (a row whose reason no longer applies; ignored) | unread (the failure log could not be read yet, not a try: read again after a backoff, src/core/rules.ts CIFIX_UNREAD_DELAYS_MS). Tries are the rows in formatting, pushing, pushed, failed, refused and rejected.
CREATE TABLE IF NOT EXISTS ci_fixes (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head TEXT NOT NULL,                 -- the head commit whose check failed
  to_head TEXT,                       -- the pushed commit; NULL unless pushed
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,                        -- one line, public-safe
  files TEXT,                         -- JSON [path] changed
  attempt INTEGER NOT NULL,
  task_id INTEGER,                    -- build task of a formatter run
  runs TEXT,                          -- JSON [run id] of the failed Actions runs (infra rows: what the rerun targets)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ci_fixes_item ON ci_fixes(repo, number, head);
-- One verification per PR head commit (Verify stage). kind: ci-enough | tests | regression.
-- state: planned (tasks queued) | running | passed | failed | error (the plan was invalid, no task) | ci-enough | stale (the PR moved on) | unavailable (private or non-Rust repo: nothing to build, the Merge? decision says so).
CREATE TABLE IF NOT EXISTS verifications (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  base_sha TEXT,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,               -- at most 25 words
  plan TEXT,                          -- JSON, the validated plan
  model TEXT,
  head_task_id INTEGER,
  base_task_id INTEGER,
  state TEXT NOT NULL,
  summary TEXT,                       -- why it failed or errored (failed: written by Haiku)
  note TEXT,                          -- on a pass: what the result does not show
  created_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (repo, number, head_sha)
);
CREATE INDEX IF NOT EXISTS verifications_state ON verifications(state);
-- Per-repo setup for before/after UI screenshots (edited by operators; validated by src/verify/screenshot-config.ts).
-- driver: args | jsonl. commands: JSON of named commands with validated parameters. ui_paths: JSON list of globs; a PR touching none is not screenshotted.
CREATE TABLE IF NOT EXISTS screenshot_config (
  repo TEXT PRIMARY KEY, package TEXT NOT NULL, example TEXT NOT NULL,
  driver TEXT NOT NULL,
  commands TEXT NOT NULL,
  ui_paths TEXT NOT NULL,
  size TEXT, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);
-- One screenshot run per PR head. state: planned | running | rendered | compared | error | stale | skipped.
-- verdict: unchanged | as-claimed | unrelated | unclear | regression. reason: the planner's 25-word reason; plan: the validated script JSON.
CREATE TABLE IF NOT EXISTS screenshot_runs (
  repo TEXT NOT NULL, number INTEGER NOT NULL, head_sha TEXT NOT NULL, base_sha TEXT,
  state TEXT NOT NULL,
  reason TEXT, plan TEXT,
  head_task_id INTEGER, base_task_id INTEGER,
  verdict TEXT,
  clear INTEGER, comparison TEXT, model TEXT, held INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, finished_at TEXT, PRIMARY KEY (repo, number, head_sha));
CREATE INDEX IF NOT EXISTS screenshot_runs_state ON screenshot_runs(state);
-- Our own workspace build of a PR head (pr-builds feature), a second opinion beside upstream CI; never part of the merge decision.
-- scope: outside | all (the repo's setting when queued). state: queued | passed | failed | error | stale. disagree: failed while CI passed at the same head.
CREATE TABLE IF NOT EXISTS pr_builds (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  base_sha TEXT,
  scope TEXT NOT NULL,
  task_id INTEGER,
  retried INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  summary TEXT,                       -- why it failed or errored
  ci_overall TEXT,                    -- upstream CI at the head when the build ended
  disagree INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (repo, number, head_sha)
);
CREATE INDEX IF NOT EXISTS pr_builds_state ON pr_builds(state);
-- Priority of an open item (Prioritize step). text_hash is the item's embed_hash when the models ran;
-- the models run again only when it changes, while score is recomputed from the mirror on each pass.
-- impact: the priority level, P0 (critical) to P4 (backlog). score: reach 0-99, the tie-breaker inside a level. model: jev (sure) | haiku | jev-unsure (no Haiku answer).
CREATE TABLE IF NOT EXISTS item_priority (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  text_hash TEXT NOT NULL,
  impact TEXT NOT NULL,
  jev_impact TEXT, jev_p REAL,
  haiku_impact TEXT,
  score INTEGER NOT NULL,
  model TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
CREATE INDEX IF NOT EXISTS item_priority_score ON item_priority(score);
-- An unsure Jev answer of a Jev step with a Haiku fallback whose Haiku tier did not answer (src/agents/step.ts runTiered):
-- the next pass reuses it while the Jev request (input_hash: sha256 of its body) is unchanged, instead of asking Jev again.
-- answer: the step's parsed value as JSON. Not a result: the step stores nothing until the fallback answers.
CREATE TABLE IF NOT EXISTS jev_unsure (
  prompt_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  answer TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (prompt_id, ref)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS verifications_finished ON verifications(finished_at);

-- Duplicate candidates (Duplicates stage). a < b. A pair is checked once per pair of text hashes
-- (embed_hash of each item); verdict is NULL until a model has answered. jev_p is Jev's yes-probability,
-- haiku the second opinion (duplicate | distinct | unsure) when Jev was not sure either way.
-- canonical is the one to keep. by_operator marks a pair an operator answered "not a duplicate" or "keep both" for.
CREATE TABLE IF NOT EXISTS duplicate_pairs (
  repo TEXT NOT NULL,
  a INTEGER NOT NULL, b INTEGER NOT NULL,
  a_hash TEXT NOT NULL, b_hash TEXT NOT NULL,
  similarity REAL NOT NULL,
  jev_p REAL,
  haiku TEXT,
  verdict TEXT,                       -- duplicate | distinct | unsure
  canonical INTEGER,
  by_operator INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  checked_at TEXT,
  PRIMARY KEY (repo, a, b, a_hash, b_hash)
);
CREATE INDEX IF NOT EXISTS duplicate_pairs_open ON duplicate_pairs(verdict, similarity);
-- The text hash each open item had when its neighbours were last looked up.
CREATE TABLE IF NOT EXISTS duplicate_scans (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  hash TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
-- One attempt to fix an issue (Fix stage), one row per issue. state: retry (a patch is due; round is the last
-- one tried) | testing (head and base tasks queued) | passed (pushed and opened by the next collect) |
-- pr-opened | skipped (triage: not a clear fix; retried only when the issue text changes) | failed.
CREATE TABLE IF NOT EXISTS fix_attempts (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  main_sha TEXT NOT NULL,             -- default branch head the patch is made and tested on
  text_hash TEXT NOT NULL,            -- of the issue title and body when triaged
  state TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  files TEXT,                         -- JSON [path] the patch may edit
  crate TEXT, crate_dir TEXT,
  patch TEXT,                         -- the latest validated patch (fix and test file)
  test_patch TEXT,                    -- the test file alone
  head_task_id INTEGER, base_task_id INTEGER,
  retries INTEGER NOT NULL DEFAULT 0, -- tasks queued again after a build-environment error
  push_tries INTEGER NOT NULL DEFAULT 0,
  summary TEXT,                       -- why the last round failed (public-safe, one line)
  pr_url TEXT,
  reason TEXT,                        -- triage reason, or why it failed
  -- size (S | M | L | XL) is added by migration: the triage's estimate of the fix
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
CREATE INDEX IF NOT EXISTS fix_attempts_state ON fix_attempts(state);
INSERT OR IGNORE INTO stage_limits (step, per_day) VALUES ('fixissue', 10);

-- One attempt to implement a queued issue on workspace sessions (src/implement). One row per attempt; at most one row
-- of an issue is not ended. state: planning | asked (a question waits for its answer) | planned | implementing |
-- checking | fixing (check findings go back to the session) | opening | pr-opened | revising (a follow-up on our PR) |
-- stuck (a decision waits) | merged | closed | failed | cancelled.
CREATE TABLE IF NOT EXISTS implementations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  queued_by TEXT NOT NULL,            -- the login of the fast_track row: every model call runs on their Task Runner
  state TEXT NOT NULL,
  attempt INTEGER NOT NULL,           -- 1 for the issue's first attempt
  text_hash TEXT NOT NULL,            -- of the issue title and body when the attempt started or last planned
  base_sha TEXT,                      -- default branch head the work is based on
  workspace_id INTEGER,
  plan_json TEXT,                     -- the plan call's reply (JSON)
  plan_md TEXT,
  plan_call_id INTEGER, session_call_id INTEGER,
  report_json TEXT,                   -- the session's last report (JSON)
  diff_hash TEXT, diff_stat TEXT,
  branch TEXT,
  pr_number INTEGER, pr_url TEXT,
  decision_id TEXT,                   -- the open question or stuck decision
  reason TEXT,                        -- why it is stuck, failed or cancelled (one line)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS implementations_current ON implementations(repo, number) WHERE state NOT IN ('merged', 'closed', 'failed', 'cancelled');
CREATE INDEX IF NOT EXISTS implementations_item ON implementations(repo, number, attempt);
CREATE INDEX IF NOT EXISTS implementations_state ON implementations(state);
-- What each step of an implementation did: kind plan | session | follow-up | checks | refusal | question.
CREATE TABLE IF NOT EXISTS implementation_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  implementation_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  call_id INTEGER,                    -- remote_calls.id of the round's model call, if it had one
  result TEXT,                        -- JSON
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS implementation_rounds_of ON implementation_rounds(implementation_id, id);
INSERT OR IGNORE INTO stage_limits (step, per_day) VALUES ('implement', NULL);

-- Work rank of an open item (src/rank): level, type, size and reach in one sortable integer, recomputed
-- by the rank step from stored results, without a model. breakdown is JSON with each part.
CREATE TABLE IF NOT EXISTS item_rank (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  score INTEGER NOT NULL,
  breakdown TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
CREATE INDEX IF NOT EXISTS item_rank_score ON item_rank(score);

-- Opus checks of the patches we write (src/patchcheck): one row per check, before a fix-up is pushed or a fix PR is opened.
-- subject: the commit the patch applies to (the PR head for kind fixup, the default branch head for kind fixissue).
CREATE TABLE IF NOT EXISTS patch_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                 -- fixup | fixissue
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  subject TEXT NOT NULL,
  patch_hash TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,   -- the fix round, or the fix-up try
  verdict TEXT NOT NULL,              -- approve | reject
  reasons TEXT NOT NULL,
  problems TEXT NOT NULL,             -- JSON [text]
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS patch_checks_item ON patch_checks(repo, number, id);

-- Integration batches of the merge queue (src/merge/batch.ts): merge-eligible PRs of one repo landed together through one
-- integration branch and one PR. state: checking (sandbox task running) | open (batch PR open, upstream CI running) |
-- merged | failed (a single PR that failed: on hold) | split (failed with several PRs: two child batches retry the halves) |
-- superseded (main moved or a member changed: a new batch took over).
CREATE TABLE IF NOT EXISTS merge_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,               -- integration-<repo>-<yyyymmdd>-<n>
  state TEXT NOT NULL,
  base_sha TEXT NOT NULL,             -- default branch head the batch was built on
  commit_sha TEXT NOT NULL,           -- head of the integration branch
  parent_id INTEGER,                  -- the batch this one split or replaced
  task_id INTEGER,                    -- sandbox task of the combined tree
  retries INTEGER NOT NULL DEFAULT 0, -- task queued again after a build-environment error
  pr_number INTEGER, pr_url TEXT,
  summary TEXT,                       -- why it failed (public-safe, one line)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  fork TEXT,                          -- <owner>/<repo> the branch was pushed to; null before the push
  merge_sha TEXT,                     -- merge commit of the batch PR, when the merge command reported it
  build_state TEXT,                   -- batch-build feature: NULL (not built) | pending | passed | failed | skipped
  build_tries INTEGER NOT NULL DEFAULT 0, -- build tasks queued for the batch
  ci_reruns INTEGER NOT NULL DEFAULT 0, -- failed runs of the batch PR rerun (once, when no PR was traced)
  ci_rerun_at TEXT                    -- when that rerun was asked for
);
CREATE INDEX IF NOT EXISTS merge_batches_repo ON merge_batches(repo, state);
CREATE TABLE IF NOT EXISTS merge_batch_prs (
  batch_id INTEGER NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,             -- the PR head merged into the batch
  position INTEGER NOT NULL,
  PRIMARY KEY (batch_id, number)
);
CREATE INDEX IF NOT EXISTS merge_batch_prs_pr ON merge_batch_prs(number, head_oid);

-- The PR status comment of each PR (src/prstatus): one comment, edited in place when the status line changes.
CREATE TABLE IF NOT EXISTS pr_status_comments (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  comment_id TEXT,                    -- the number in the comment's #issuecomment- URL; null when none is known
  author TEXT,                        -- login that posted it (plainLogin); a comment of another identity is not edited
  line TEXT,                          -- the status line as last posted; null before the first post
  steps TEXT NOT NULL DEFAULT '[]',   -- JSON [{step, at}]: the steps the comment has shown, oldest first
  final INTEGER NOT NULL DEFAULT 0,   -- 1 once the merged line is posted or the comment was deleted on GitHub: no more writes
  failures INTEGER NOT NULL DEFAULT 0, -- writes that failed in a row
  retry_at TEXT,                      -- after 3 failures in a row: not tried again before this time
  updated_at TEXT NOT NULL,
  pinged TEXT,                        -- '<workflow id>:<rec_at>' of the last question its asked people were pinged about (src/prstatus/ping.ts); '<key> given up' after PING_TRIES failed pings
  ping_failures INTEGER NOT NULL DEFAULT 0, -- failed pings in a row of the question not pinged yet; apart from the edit's failures
  PRIMARY KEY (repo, number)
);

-- Last `claude auth status` of each account: sign-in state, method, plan and
-- the login's end date. Nothing else of the status (no email) is kept.
CREATE TABLE IF NOT EXISTS claude_account_status (
  account_id TEXT PRIMARY KEY,
  logged_in INTEGER NOT NULL,
  method TEXT,
  plan TEXT,
  login_expires_at TEXT,
  checked_at TEXT NOT NULL
);

-- When an account's long-lived token (`claude setup-token`, kept in the account's
-- config directory, never here) was set and when a call last found it rejected.
CREATE TABLE IF NOT EXISTS claude_account_tokens (
  account_id TEXT PRIMARY KEY,
  set_at TEXT NOT NULL,
  rejected_at TEXT
);

-- The one pull request review we posted per PR (review-post): its GraphQL node
-- id and the head commit its body describes. A later Opus review at a new head
-- edits this review in place.
CREATE TABLE IF NOT EXISTS review_posts (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  review_id TEXT NOT NULL,
  head_oid TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  edited_at TEXT,
  -- Who posted it: `legacy` (the box account) or the identity of the grant; NULL for rows from before this was recorded (legacy).
  posted_as TEXT,
  PRIMARY KEY (repo, number)
);
INSERT OR IGNORE INTO stage_limits (step, per_day) VALUES ('review-post', 40);

-- Duplicate groups compared in one pass (src/dupes/compare.ts). One row per set of
-- same-kind group members (kind pr | issue), keyed by the sorted numbers. hash covers
-- each member's state, head commit and text hash: a change re-runs the comparison.
-- source: model | closed (a closed or merged member wins without a call) | rule (the
-- model failed; canonical.ts decided) | single. result is the model's JSON per other member.
CREATE TABLE IF NOT EXISTS dupe_comparisons (
  repo TEXT NOT NULL,
  key TEXT NOT NULL,                  -- kind:n1,n2,...
  kind TEXT NOT NULL,                 -- pr | issue
  members TEXT NOT NULL,              -- JSON [numbers]
  hash TEXT NOT NULL,
  kept INTEGER NOT NULL,
  source TEXT NOT NULL,
  model TEXT,
  reason TEXT,
  result TEXT,                        -- JSON {others: [...], rounds: n}
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, -- consecutive rule results at this hash; a rule result is tried again after 24 h, three times at most
  at TEXT NOT NULL,
  PRIMARY KEY (repo, key)
);
-- The group decision (kind duplicate, id repo:dupegroup:<lowest member>) and its members.
-- role: keep (one per kind) | close (a duplicate of the keep of its kind: target) | stay (open, not closed).
-- detail is the comparison's JSON for the member (better, carry, adds, duplicate) for the Act step.
-- applied_answer is the answer whose roles were written to dupe_group_items.
CREATE TABLE IF NOT EXISTS dupe_groups (
  decision_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  source TEXT NOT NULL,               -- model | closed | rule
  applied_answer TEXT
);
CREATE TABLE IF NOT EXISTS dupe_group_items (
  decision_id TEXT NOT NULL,
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- pr | issue
  role TEXT NOT NULL,
  target INTEGER,
  detail TEXT,
  base_role TEXT NOT NULL,            -- the roles as the comparison gave them; an answer's roles are rebuilt from these
  base_target INTEGER,
  head TEXT,                          -- a PR's head commit and an issue's text hash when the decision was asked; Act skips a member that differs
  PRIMARY KEY (decision_id, number)
);
CREATE INDEX IF NOT EXISTS dupe_group_items_item ON dupe_group_items(repo, number);
-- What the Act step already wrote for a group decision, per member and step (comment | details | close). Written right after each write so a retry never repeats it.
CREATE TABLE IF NOT EXISTS dupe_group_posts (
  decision_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  step TEXT NOT NULL,
  url TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (decision_id, number, step)
);
-- Carry-over of a kept PR's group: parts of the closed PRs to port onto it (Fix-up). queued | done | held.
CREATE TABLE IF NOT EXISTS dupe_carries (
  decision_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,            -- the kept PR
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  outcome TEXT,                       -- pushed | asked | gone | too-large | failed, with reason
  to_head TEXT,
  from_head TEXT,                     -- the head the pushed commit was made on
  updated_at TEXT NOT NULL,
  PRIMARY KEY (decision_id, number)
);
-- The exact comments each answer of a group decision posts (src/dupes/texts.ts), written when the decision is asked. option: accept | keep:<n>.
CREATE TABLE IF NOT EXISTS dupe_group_texts (
  decision_id TEXT NOT NULL,
  option TEXT NOT NULL,
  number INTEGER NOT NULL,
  step TEXT NOT NULL,                 -- close | details | suggestion
  text TEXT NOT NULL,
  PRIMARY KEY (decision_id, option, number, step)
);
-- Failed writes per member, so one permanent error does not block every later group.
CREATE TABLE IF NOT EXISTS dupe_group_fails (
  decision_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  fails INTEGER NOT NULL,
  PRIMARY KEY (decision_id, number)
);

-- Fast track (src/fasttrack.ts): items an operator moved to the front of every stage that orders work by the work rank.
-- id is the order they were added in; the lowest id runs first. Rows of closed or merged items are ignored, not deleted.
CREATE TABLE IF NOT EXISTS fast_track (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  -- 1 to 10: heavier items go first; equal weights keep the order added.
  weight INTEGER NOT NULL DEFAULT 5,
  UNIQUE (repo, number)
);

-- Retired (src/db/retired-names.ts): merge holds, which are held items (src/db/holds-to-items.ts). A release before that reads them.
CREATE TABLE IF NOT EXISTS merge_holds (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  held_by TEXT NOT NULL,
  held_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
-- Conversations with Opus: one per item, shown to everyone with access to the repo (src/conversations).
-- item_block is written once, when the conversation starts, and sent byte for byte on every turn so the prompt's start stays cached.
CREATE TABLE IF NOT EXISTS conversations (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  item_block TEXT NOT NULL,
  item_sig TEXT NOT NULL,             -- hash of the item's head commit and text as the block (or the last update turn) described them
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,           -- operator login, or 'opus' when a recommendation started it
  PRIMARY KEY (repo, number)
);
-- Turns in prompt order (seq order). block is the exact text the prompt carries for the turn, written with the turn.
-- An operator turn waits for its reply while status is 'pending' (queued) or 'answering' (a run claimed it); there is at most one
-- per conversation, and it has no seq until it is answered or failed. A system turn that arrives while a run answers is 'held'
-- (no seq) and takes the next seq after the reply, so the prompt the run sent stays a prefix of the next one.
CREATE TABLE IF NOT EXISTS conversation_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- operator | maintainer | opus | system
  login TEXT NOT NULL,                -- the writer's login, 'opus' or 'system'
  at TEXT NOT NULL,
  body TEXT NOT NULL,
  block TEXT NOT NULL,
  status TEXT,                        -- operator and maintainer turns: pending | answering | answered | failed; system turns: held | NULL
  error TEXT,
  notes TEXT,                         -- opus turns: JSON array of notes about dropped cards
  seq INTEGER,                        -- position in the prompt; NULL while pending, answering or held
  claim TEXT,                         -- answering: token of the run that holds the message
  claimed_at TEXT,
  progress TEXT                       -- answering: JSON array of the last few progress lines, newest last
);
CREATE INDEX IF NOT EXISTS conversation_turns_item ON conversation_turns(repo, number, id);
CREATE INDEX IF NOT EXISTS conversation_turns_at ON conversation_turns(at);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_waiting ON conversation_turns(repo, number) WHERE status IN ('pending', 'answering');
-- Action cards Opus proposed on a turn. params are the exact parameters; text is the editable comment of a comment card.
CREATE TABLE IF NOT EXISTS conversation_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id INTEGER NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- resolution | comment | answer | label | backlog | duplicate | resolve | close (the last seven are legacy single actions)
  params TEXT NOT NULL,               -- JSON
  text TEXT,
  description TEXT NOT NULL,          -- one plain line written by our code from the parameters
  state TEXT NOT NULL DEFAULT 'proposed',  -- proposed | queued | running | done | failed | dismissed
  result TEXT,                        -- what happened, in one line
  result_url TEXT,
  error TEXT,
  acted_by TEXT,
  acted_at TEXT,
  edited_by TEXT,
  edited_at TEXT,
  seen TEXT,                          -- JSON {head, last_comment}: the item as Opus last saw it; null on cards from before it was recorded
  choice_id TEXT,                     -- the decision_choices row the card was run from (Do it on a choice); NULL for cards Opus proposed (db.ts adds it to older databases)
  queued_at TEXT,                     -- state queued: when the press found no room under the daily GitHub write limit
  queue_args TEXT,                    -- JSON {skip, note, noteStaysOut, role}: what the press carried, kept for the later run
  dispute_by TEXT, dispute_reason TEXT, dispute_at TEXT -- a queued press someone else disputed: the drain skips it until the presser or an operator keeps or dismisses it
);
-- The open_issue step of a card that merges the PR (a Merge answer, or a fix-up that merges): held at the press and filed by the Act step
-- once the PR merged (src/conversations/held.ts). A row in `filing` is written before the call, so a restart never files it twice.
CREATE TABLE IF NOT EXISTS held_followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,           -- the conversation card that held it
  choice_id TEXT,                     -- the decision_choices row the card was run from, if any
  decision_id TEXT,                   -- the Merge? decision the card answered Merge; NULL for a fix-up that merges
  answer_seq INTEGER,                 -- answer, undo and reopen audit rows of that decision once the card answered: a later one ends the row's merge path
  preapproval_id INTEGER,             -- the pre-approved merge the card started; NULL for a Merge answer
  repo TEXT NOT NULL, number INTEGER NOT NULL,  -- the PR
  issue_repo TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  by TEXT NOT NULL,                   -- who pressed the card
  at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'held', -- held | filing | filed | dropped | failed (a row left in filing: the outcome is unknown)
  issue_number INTEGER,
  url TEXT,
  reason TEXT,                        -- dropped or failed: why; held: why the last try did not file it
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  workflow_id INTEGER,                -- the maintainer workflow the follow-up was held for; NULL on rows held before workflows
  approved_at TEXT                    -- the workflow's merge approval as it stood when the follow-up was held
);
CREATE INDEX IF NOT EXISTS held_followups_item ON held_followups(repo, number);
CREATE INDEX IF NOT EXISTS held_followups_state ON held_followups(state);
-- Maintainer posts (decision comments and opinions) an operator chose to share with Opus. Excluded unless a row exists; `sent_turn`
-- is the operator turn whose stored block carries the text (each post is sent once).
CREATE TABLE IF NOT EXISTS conversation_includes (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  source TEXT NOT NULL,               -- decision-comment:<id> | decision-opinion:<id>
  by TEXT NOT NULL,
  at TEXT NOT NULL,
  sent_turn INTEGER,
  PRIMARY KEY (repo, number, source)
);
-- Opus's drafts and pick for a decision's answer choices (core action plus extras). Only model output is stored; the core list is computed when read.
CREATE TABLE IF NOT EXISTS decision_choices (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  turn_id INTEGER,                    -- the conversation turn that wrote it; NULL for prepare
  stamp TEXT NOT NULL,                -- decisionStamp at write
  seen TEXT,                          -- JSON {head, last_comment}: the item as Opus saw it
  source TEXT NOT NULL,               -- prepare | conversation | converted
  drafts TEXT NOT NULL,               -- JSON: core key -> {params?, extras: [{id, kind, on, ...fields}]}
  added TEXT NOT NULL DEFAULT '[]',   -- JSON: core keys Opus added
  pick TEXT NOT NULL,                 -- JSON {core, reason}
  state TEXT NOT NULL DEFAULT 'current',  -- current | replaced
  created_at TEXT NOT NULL,
  asked_by TEXT                       -- source conversation: the login whose message the reply that wrote it answered
);
CREATE INDEX IF NOT EXISTS decision_choices_item ON decision_choices(repo, number, state);
CREATE INDEX IF NOT EXISTS decision_choices_decision ON decision_choices(decision_id, state);
CREATE INDEX IF NOT EXISTS conversation_cards_turn ON conversation_cards(turn_id);
CREATE INDEX IF NOT EXISTS conversation_cards_item ON conversation_cards(repo, number);
-- The chat of an item (src/data/chat). A conversation refers to an item (repo, number), or to none (both null). An item has one main
-- conversation (is_main = 1). title: the entry of the workflow the item had when the conversation started ("Review", ...), or "Conversation".
CREATE TABLE IF NOT EXISTS chat_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT,
  number INTEGER,
  is_main INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL            -- the login whose message or workflow started it, or 'autocraft'
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_conversations_main ON chat_conversations(repo, number) WHERE is_main = 1;
CREATE INDEX IF NOT EXISTS chat_conversations_item ON chat_conversations(repo, number, id);
-- What people wrote in a conversation, on any surface, as written; and AutoCraft's recommendations and end lines.
-- kind: said | recommended | finished. via: dashboard | github | discord | agent | cli | autocraft. payload: JSON, by kind
-- (said: {url?, reconstructed?}; recommended: {workflowId, rec, parts, asked}; finished: {workflowId, state, merged, base}).
-- workflow_event_id: the workflow_events row a said message produced; turn_id: the conversation_turns row of a question to Opus;
-- workflow_id: the workflow a recommendation or end line is about; github_comment_id: GitHub's numeric id of the comment a said message copies.
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  author TEXT NOT NULL,               -- a login, or 'autocraft'
  via TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  payload TEXT,
  workflow_event_id INTEGER,
  turn_id INTEGER,
  workflow_id INTEGER,
  github_comment_id INTEGER,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_conversation ON chat_messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS chat_messages_author ON chat_messages(author, at);
CREATE INDEX IF NOT EXISTS chat_messages_event ON chat_messages(workflow_event_id) WHERE workflow_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_messages_turn ON chat_messages(turn_id) WHERE turn_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_messages_workflow ON chat_messages(workflow_id, kind) WHERE workflow_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_comment ON chat_messages(github_comment_id) WHERE github_comment_id IS NOT NULL;
-- One Task Runner notice per workflow and reason (the payload names it): src/data/chat/messages.ts recordNotices.
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_notice ON chat_messages(workflow_id, payload) WHERE kind = 'notice';

-- A repo's area list, one row per saved version; the current version is the highest.
CREATE TABLE IF NOT EXISTS area_lists (
  repo TEXT NOT NULL,
  version INTEGER NOT NULL,
  areas TEXT NOT NULL,                -- JSON [{name, description}]
  at TEXT NOT NULL,
  by TEXT,                            -- operator login, or NULL for a CLI save
  note TEXT,                          -- what the save did, one line
  PRIMARY KEY (repo, version)
);

-- The area of each item. area NULL with a list_version means "none of these" was the answer for that version.
-- A row whose area survived a list change moves to the new version; a NULL row stays on the version it was asked against.
CREATE TABLE IF NOT EXISTS item_areas (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  area TEXT,
  source TEXT NOT NULL,               -- jev | haiku | operator
  confidence REAL,                    -- Jev's top probability, else NULL
  list_version INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
CREATE INDEX IF NOT EXISTS item_areas_area ON item_areas(repo, area);

-- Area lists proposed by a model, waiting for the operator. kind 'propose' is a whole list; 'suggest' is areas to add.
CREATE TABLE IF NOT EXISTS area_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- propose | suggest
  areas TEXT NOT NULL,                -- JSON [{name, description, state}] with state open | accepted | ignored
  created_at TEXT NOT NULL,
  created_by TEXT,
  state TEXT NOT NULL DEFAULT 'open', -- open | accepted | dismissed (a suggest closes once every area is decided)
  decided_by TEXT,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS area_proposals_repo ON area_proposals(repo, state);

-- Actions runs waiting for a maintainer's approval (check suite conclusion action_required) at a PR head, one row per PR
-- (src/merge/ci-approval.ts). runs: JSON [{id, name, event}] still waiting; approved: ids of runs we approved whose
-- suites have not finished yet; reread: a refused merge said runs wait, the step reads them; failed: JSON {runId: failed
-- approvals}; cross_repo: the PR comes from a fork.
CREATE TABLE IF NOT EXISTS ci_run_approvals (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,
  cross_repo INTEGER NOT NULL DEFAULT 0,
  runs TEXT NOT NULL,
  approved TEXT NOT NULL,
  reread INTEGER NOT NULL DEFAULT 0,
  failed TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  approved_at TEXT,
  PRIMARY KEY (repo, number)
);

-- Merges of the default branch into conflicted take / take-fix PRs by the Fix-up step (src/fixup/conflict.ts), one row per try (or
-- per head for asked). state: merged (pushed) | failed | refused (validation said no) | rejected (the Opus check said no) | asked
-- (a comment asked the contributor to merge or rebase), comment-failed (final: that comment failed after its request went out), comment-unsent (that comment never
-- reached GitHub: asked again after a backoff, src/core/rules.ts unsentAsk), superseded (a skip or refusal under limits since replaced; neither held nor a try), pushing (written before the push, to_head is the merge commit about to be pushed). merged, pushing, failed, refused and rejected are tries; two per head.
CREATE TABLE IF NOT EXISTS conflict_merges (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  from_head TEXT NOT NULL,            -- the PR head the base was merged into
  to_head TEXT,                       -- the pushed merge commit; NULL unless merged
  base_sha TEXT,                      -- the base branch commit merged in
  state TEXT NOT NULL,
  reason TEXT,                        -- one line, public-safe
  files TEXT,                         -- JSON [path] the resolver resolved ([] for a clean merge)
  -- state linting: patch (JSON [{path, mode, content}], the resolved files), lint_task and lint_round (1 = first resolution) wait for the lint task of the resolution
  attempt INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conflict_merges_item ON conflict_merges(repo, number, created_at);

-- Post-merge review (src/postmerge): one Opus review of what a pipeline merge landed, latest per PR.
-- findings: JSON array of the validated findings; error: why no review was stored (retry: ... is tried again after an hour).
-- merge_sha: the commit the review read (the merge commit, else the PR's last head).
CREATE TABLE IF NOT EXISTS postmerge_reviews (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  merge_sha TEXT NOT NULL,
  at TEXT NOT NULL,
  model TEXT,
  run_id TEXT,
  findings TEXT,
  error TEXT,
  tries INTEGER NOT NULL DEFAULT 0,   -- consecutive reviews that ended in a retry: error; the third becomes held
  PRIMARY KEY (repo, number)
);
-- What the filing step did with each finding of a review (review_at identifies the review).
-- state: filing (written before gh issue create runs; one left in this state has an unknown outcome and is never retried) | filed |
-- failed (gh refused with no possible side effect; attempts counts the tries, retried after 1 h and then 6 h, three at most) |
-- skipped-duplicate (duplicate_of: the PR or issue number that covers it) | skipped-limit | skipped-minor | skipped-stale (the cited file is gone).
-- A skipped-limit row is replaced when the finding is filed later.
CREATE TABLE IF NOT EXISTS postmerge_followups (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  review_at TEXT NOT NULL,
  finding INTEGER NOT NULL,
  title TEXT NOT NULL,
  issue_number INTEGER,
  url TEXT,
  state TEXT NOT NULL,
  at TEXT NOT NULL,
  duplicate_of INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  note TEXT,                          -- one line: why a failed attempt failed
  PRIMARY KEY (repo, number, review_at, finding)
);
CREATE INDEX IF NOT EXISTS postmerge_followups_issue ON postmerge_followups(repo, issue_number);
-- Only merges from this moment on are reviewed unless `postmerge backfill` moves it back.
INSERT OR IGNORE INTO settings (key, value) VALUES ('postmerge_since', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
-- Merges outside the pipeline's scope, such as those a person approved in a repo whose Pipeline switch is off, from this moment on.
INSERT OR IGNORE INTO settings (key, value) VALUES ('postmerge_unscoped_since', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- CI on the default branch of every synced repo, one row per head commit seen. Written by the main-ci step.
-- state: green | red | optional | running | none (src/mainci/classify.ts).
CREATE TABLE IF NOT EXISTS main_ci (
  repo TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  branch TEXT NOT NULL,
  state TEXT NOT NULL,
  failing TEXT NOT NULL,              -- JSON [{name, url}]: the checks that failed
  checks TEXT NOT NULL,               -- JSON [{name, state, url}]; state: success | failure | pending | skipped
  committed_at TEXT,
  headline TEXT,                      -- first line of the commit message
  first_seen_at TEXT NOT NULL,
  state_changed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, head_sha)
);
CREATE INDEX IF NOT EXISTS main_ci_repo_time ON main_ci(repo, committed_at);

-- Red default branches (src/mainfix): one row per (repo, head, failing gate check), written once the check is sorted.
-- verdict: flaky | infra | code (Haiku, from the failed step's log).
-- state: rerun-requested (flaky: the failed jobs were rerun, written before the call; `tries` counts the requests GitHub refused
--   since the last one it took, and while it is above 0 the rerun is asked again after 5, 15, 60 minutes, then hourly) | rerun-passed (the head turned green) |
--   issue-opening (infra: written before the issue is created) | issue-opened (issue_number; later red heads of the streak share it) |
--   issue-failed (infra: GitHub refused the issue) | asked, declined (infra: rows of an earlier question) |
--   needs-fix (code, or red again after a rerun: waits for the fix PR step) | nothing-to-do (nothing readable to act on, or main is
--   green again, or an open PR already covers the failure: `#N` in the reason) | pr-opened (our fix PR: pr_number, pr_url) |
--   fix-failed (no fix PR could be made: reason; a person takes over) | unread (check "(none)": the head's failure log could not be
--   read yet; written at the first read; read again once per main CI poll interval for an hour, then hourly, while the head is the
--   repo's newest and red; not a classification; at a classified head it holds a fix PR's re-read that found no log, timed the same) | unclassified (check "(none)":
--   `tries` model replies sorted none of the failed checks, the third makes the row nothing-to-do; a classification call that ended without
--   a reply is no try; asked again 5 minutes after the last). One attempt per row.
CREATE TABLE IF NOT EXISTS main_fixes (
  repo TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  "check" TEXT NOT NULL,
  verdict TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,                        -- one line, public-safe
  run_id INTEGER,                     -- the failed Actions run
  run_url TEXT,
  excerpt TEXT,                       -- scrubbed tail of the failed step's log
  decision_id TEXT,
  issue_number INTEGER,
  pr_number INTEGER,                  -- the fix PR
  pr_url TEXT,
  -- state linting: the one model patch of the head's rows (patch, files JSON, lint_task, lint_round, lint_state pending | requeued) waits for its lint task
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, head_sha, "check")
);

-- Pre-merge review (src/premerge): one adversarial review per PR head the rule would merge.
-- findings: JSON PremergeFinding[] once a review is stored (NULL until then); error: why the last try stored none
-- (retried after 1 h, the third failed try makes the head failed); searched: what the reviewer looked at.
CREATE TABLE IF NOT EXISTS premerge_reviews (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,
  at TEXT NOT NULL,
  run_id TEXT,
  model TEXT,
  findings TEXT,
  searched TEXT,
  error TEXT,
  tries INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, number, head_oid)
);

-- The follow-up issue of a PR a maintainer approved for merge (src/premerge/followups.ts): one row per PR head whose pre-merge
-- review found defects that do not stop the merge. The first row's write opens the PR's one issue (issue_number, url); a later
-- head's row comments on it. state: filing (written before the write), filed, failed (note: why GitHub refused it, or that it was
-- never sent), or unsent (the write sent nothing: tried again after a backoff, src/core/rules.ts unsentAsk; note: the JSON list of
-- the times of those tries, kept while the retry is filing).
CREATE TABLE IF NOT EXISTS premerge_followups (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,
  issue_number INTEGER,
  url TEXT,
  state TEXT NOT NULL,
  at TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (repo, number, head_oid)
);

-- The review side of the same follow-up issue (src/premerge/followups.ts): one row per reviewed head of a PR approved for merge
-- whose Opus review had fixes, or a hold, that do not block the merge (src/core/review-blocking.ts). The issue is the one of
-- premerge_followups or this table, whichever opened it; a later row comments on it. state as in premerge_followups.
CREATE TABLE IF NOT EXISTS review_followups (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,
  issue_number INTEGER,
  url TEXT,
  state TEXT NOT NULL,
  at TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (repo, number, head_oid)
);

-- What the merge rule reads from a PR's cached diff at one head (src/review/diff.ts), written by the code that writes or
-- removes the cache files; one row while the diff of that head is cached. reasons: JSON string[] of sensitive-content
-- reasons (the conservative ones while pending); lines: changed lines of the diff; pending: the diff waits for the
-- files and workflow steps read beside it; last_read: ms of the last re-read for them.
CREATE TABLE IF NOT EXISTS diff_facts (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,
  reasons TEXT NOT NULL,
  lines INTEGER NOT NULL,
  pending INTEGER NOT NULL,
  last_read INTEGER,
  PRIMARY KEY (repo, number, head_oid)
);

-- What operators said once, kept so reviews of related work see it (src/memory/). One row per source: the answer note of a
-- decision, a comment (or review) of an operator on GitHub that AutoCraft did not post, or an operator's message in a conversation.
-- source_id is the decision id, the comment's node id or the turn's id. embedding: float32 unit vector of the item title and the text, by `model`.
CREATE TABLE IF NOT EXISTS owner_statements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind TEXT NOT NULL,          -- decision-note | comment | conversation
  source_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER,
  item_title TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  embedding BLOB,
  model TEXT,
  UNIQUE (source_kind, source_id)
);

-- The planner's output (src/core/plan-cache.ts): what is due for each item at the end of the last planner pass. One row per
-- PR or item; written by the planner only, in one transaction, only the rows that changed. For a PR, `state` is the state of
-- its review-to-merge Plan and `item_state` that of its triage plan; for an issue `state` is the triage state. `actions` is JSON
-- [{kind, head, params?}] in priority order, triage actions first; `reasons` is JSON string[] (why it is outside the merge rule).
CREATE TABLE IF NOT EXISTS item_plans (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- pr | issue
  head TEXT,
  state TEXT NOT NULL,
  item_state TEXT,
  actions TEXT NOT NULL,
  wait TEXT,
  reasons TEXT NOT NULL,
  note TEXT,
  view TEXT NOT NULL DEFAULT '{}',    -- JSON for the dashboard (PlanView in src/core/plan-cache.ts): next-step text, scope, label, queue fields
  planned_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
) WITHOUT ROWID;

-- A counter every write to item_plans moves: the planner keeps the stored rows in memory between passes and reads them again only when it moved.
CREATE TABLE IF NOT EXISTS item_plans_rev (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL);
INSERT OR IGNORE INTO item_plans_rev (id, rev) VALUES (1, 0);
CREATE TRIGGER IF NOT EXISTS item_plans_rev_i AFTER INSERT ON item_plans BEGIN UPDATE item_plans_rev SET rev = rev + 1; END;
CREATE TRIGGER IF NOT EXISTS item_plans_rev_u AFTER UPDATE ON item_plans BEGIN UPDATE item_plans_rev SET rev = rev + 1; END;
CREATE TRIGGER IF NOT EXISTS item_plans_rev_d AFTER DELETE ON item_plans BEGIN UPDATE item_plans_rev SET rev = rev + 1; END;

-- What each autopilot lane's next jobs take, as the last planner pass listed it (LaneItem[] as JSON, capped); the Next page reads it.
CREATE TABLE IF NOT EXISTS lane_next (
  lane TEXT PRIMARY KEY,
  total INTEGER NOT NULL,
  items TEXT NOT NULL,
  at TEXT NOT NULL
) WITHOUT ROWID;

-- One row per run of the build tool by a patch-writing model (src/checktool): the command, its outcome in one line, and the worker task that ran it.
CREATE TABLE IF NOT EXISTS model_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,                     -- the agent run (model call) that made it
  step TEXT NOT NULL,                 -- fixup | cifix | fixissue
  repo TEXT NOT NULL,
  number INTEGER,
  head TEXT NOT NULL,
  command TEXT NOT NULL,              -- fmt | clippy | check | test
  crate TEXT,
  test_name TEXT,
  task_id INTEGER,
  outcome TEXT,                       -- null while running; e.g. "0 findings", "exit 101", "refused: ..."
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS model_checks_item ON model_checks(repo, number, id);
CREATE INDEX IF NOT EXISTS model_checks_median ON model_checks(repo, command, id);

-- Commits the pipeline pushed to a branch of its own (pushOwnBranch: the first commit of a Fix, main CI fix or security fix PR, a batch tip).
-- The pipeline's own PR keeps its own tier only at such a head, or one reached from it through our own later pushes (pushChainOf).
CREATE TABLE IF NOT EXISTS own_commits (
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  action TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (repo, sha)
);

-- Every push of ours to a PR branch (fix-up, conflict merge, CI fix, fix-issue PR) and what it did to the PR's required checks.
-- before_res / after_res: green | red | pending | none | unknown (required checks only; optional ones are ignored); before_res is
-- stale for a green whose run predates the default branch head the push's run merges with. A branch created by the push has no
-- earlier head: it takes the CI result of the newest default-branch head with a final one, else of its base commit. outcome stays NULL until the checks at to_oid are final;
-- then kept-green | fixed | broke | still-red | unknown | stale (after a stale before; the circuit breaker skips it). number is NULL for a fix-issue push until its PR's checks arrive.
-- stage: fixup | cifix | fixissue (the circuit breaker's stage); action: the audit action of the push.
CREATE TABLE IF NOT EXISTS push_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  stage TEXT NOT NULL,
  action TEXT NOT NULL,
  repo TEXT NOT NULL, number INTEGER,
  from_oid TEXT, to_oid TEXT NOT NULL,
  before_res TEXT NOT NULL,
  after_res TEXT,
  outcome TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS push_outcomes_to ON push_outcomes(repo, to_oid);
CREATE INDEX IF NOT EXISTS push_outcomes_stage ON push_outcomes(stage, id);

-- The pushes AutoCraft makes to pull requests, each written right before its push and never overwritten by another: the head it was made
-- on, the commit, and when. A push that never landed left a commit no head is.
CREATE TABLE IF NOT EXISTS own_pushes (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  from_oid TEXT NOT NULL, to_oid TEXT NOT NULL,
  action TEXT NOT NULL,               -- the audit action of the push (fixup-push, cifix-push, conflict-push, implement-push, autorepin-push)
  at TEXT NOT NULL,                   -- right before the push
  lines INTEGER,                      -- how many of the pull request's lines it changed; NULL when unknown
  landed_at TEXT,                     -- when git reported it done; NULL until then, and when a crash came first
  PRIMARY KEY (repo, number, to_oid)
) WITHOUT ROWID;

-- Circuit breaker: a stage that stopped itself. One row per push stage and repo (stage `<stage>:<repo>`, stage one of fixup,
-- cifix, fixissue, merge), one per push stage for its trip on every repo (`<stage>`), and `outside-surge` for the outside-author
-- protections; active = 1 while tripped, until an operator, or for a repo's row a maintainer with write access to it, clears it
-- (autocraft-server pipeline resume <key>, or the Resume button). Pushes and merges from before cleared_at do not count towards
-- the next trip of that row.
-- evidence: JSON of refs (repo#number and commits).
CREATE TABLE IF NOT EXISTS stage_trips (
  stage TEXT PRIMARY KEY,             -- <stage>:<repo> | <stage> | outside-surge
  active INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL,
  evidence TEXT NOT NULL,
  tripped_at TEXT NOT NULL,
  cleared_at TEXT, cleared_by TEXT
);

-- Item links: records that attach to a GitHub item. plan_history gets a row each time the planner (src/core/plan-cache.ts)
-- stores a different state or wait for an item (old_state is NULL for the first plan seen); job_items lists the items a job
-- handled (src/runner/job-items.ts), with a one-line outcome. Both are pruned with the jobs (ten years).
CREATE TABLE IF NOT EXISTS plan_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head TEXT,
  old_state TEXT, new_state TEXT NOT NULL,   -- new_state is 'gone' when the item left the plan set
  old_wait TEXT, wait TEXT,
  reasons TEXT NOT NULL,              -- JSON string[], as in item_plans
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_history_item ON plan_history(repo, number, id);
CREATE INDEX IF NOT EXISTS plan_history_at ON plan_history(at);
-- The liveness check's result (src/liveness.ts), replaced as a whole after planner passes: the open items that are stuck (nothing will move
-- them and nobody is asked) or long (live, but plan state and wait unchanged past the limit). `since` is when state or wait last changed.
CREATE TABLE IF NOT EXISTS liveness_items (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- pr | issue
  verdict TEXT NOT NULL,              -- stuck | long
  cause TEXT NOT NULL,
  state TEXT NOT NULL, wait TEXT, phase TEXT NOT NULL,
  since TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS job_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  outcome TEXT,                       -- one line
  at TEXT NOT NULL,
  ref TEXT                            -- the decision the job asked about the item, when it asked one
);
CREATE INDEX IF NOT EXISTS job_items_item ON job_items(repo, number, id);
CREATE INDEX IF NOT EXISTS job_items_job ON job_items(job_id, id);

-- The item trace (src/dash/api/trace.ts) reads every table by (repo, number); these had no index for it.
CREATE INDEX IF NOT EXISTS agent_run_items_item ON agent_run_items(repo, number, run_id);
CREATE INDEX IF NOT EXISTS build_tasks_item ON build_tasks(repo, number, id);
CREATE INDEX IF NOT EXISTS decisions_item ON decisions(repo, number);
CREATE INDEX IF NOT EXISTS push_outcomes_item ON push_outcomes(repo, number);

-- Per-item GitHub detail the item list sync does not carry (src/activity.ts): the changed files of a PR's head, its commits, and its label
-- and force-push timeline events. activity_sync records the head and update time each item was last read at.
CREATE TABLE IF NOT EXISTS pr_files (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head TEXT NOT NULL,
  path TEXT NOT NULL,
  additions INTEGER NOT NULL, deletions INTEGER NOT NULL,
  change_type TEXT NOT NULL,          -- ADDED | MODIFIED | DELETED | RENAMED | COPIED | CHANGED
  PRIMARY KEY (repo, number, head, path)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS pr_commits (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  oid TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  author TEXT,                        -- GitHub login; null when the commit email maps to no account
  first_seen_at TEXT,                 -- when the sync first read the commit; committed_at is author-controlled and is clamped to it
  co_authors TEXT,                    -- JSON [login]: the commit's authors as GitHub lists them (the git author and Co-authored-by trailers)
  PRIMARY KEY (repo, number, oid)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS item_activity (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  id TEXT NOT NULL,                   -- GraphQL node id of the timeline event
  kind TEXT NOT NULL,                 -- labeled | unlabeled | force-push
  at TEXT NOT NULL,
  actor TEXT,
  label TEXT,                         -- labeled and unlabeled
  before_oid TEXT, after_oid TEXT,    -- force-push
  PRIMARY KEY (repo, number, id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS activity_sync (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head TEXT,
  updated_at TEXT,
  read_at TEXT NOT NULL,
  error TEXT,                         -- the last failed read; the item is read again at retry_at
  retry_at TEXT,
  PRIMARY KEY (repo, number)
) WITHOUT ROWID;

-- The items a batch decision (number IS NULL) names in its `items` JSON, so the trace finds them by (repo, number).
-- Filled by the triggers below and once for older rows (src/db.ts: buildDecisionItems).
CREATE TABLE IF NOT EXISTS decision_items (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  decision_id TEXT NOT NULL,
  PRIMARY KEY (repo, number, decision_id)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS decision_items_ins AFTER INSERT ON decisions WHEN new.number IS NULL AND json_valid(new.items) AND json_type(new.items) = 'array' BEGIN
  INSERT OR IGNORE INTO decision_items (repo, number, decision_id)
    SELECT json_extract(j.value, '$.repo'), json_extract(j.value, '$.number'), new.id FROM json_each(new.items) j
    WHERE typeof(json_extract(j.value, '$.repo')) = 'text' AND typeof(json_extract(j.value, '$.number')) = 'integer';
END;
-- Dropped first: IF NOT EXISTS keeps an older definition of a trigger whose body changed.
DROP TRIGGER IF EXISTS decision_items_upd;
CREATE TRIGGER decision_items_upd AFTER UPDATE ON decisions WHEN old.items IS NOT new.items OR old.number IS NOT new.number BEGIN
  DELETE FROM decision_items WHERE decision_id = new.id;
  INSERT OR IGNORE INTO decision_items (repo, number, decision_id)
    SELECT json_extract(j.value, '$.repo'), json_extract(j.value, '$.number'), new.id FROM json_each(CASE WHEN new.number IS NULL AND json_valid(new.items) AND json_type(new.items) = 'array' THEN new.items ELSE '[]' END) j
    WHERE typeof(json_extract(j.value, '$.repo')) = 'text' AND typeof(json_extract(j.value, '$.number')) = 'integer';
END;
CREATE TRIGGER IF NOT EXISTS decision_items_del AFTER DELETE ON decisions BEGIN
  DELETE FROM decision_items WHERE decision_id = old.id;
END;

-- The activity stream reads each source's newest rows by time (src/dash/api/activity.ts).
CREATE INDEX IF NOT EXISTS items_merged ON items(merged_at) WHERE merged_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS item_activity_at ON item_activity(at);
CREATE INDEX IF NOT EXISTS stages_at ON stages(at);
CREATE INDEX IF NOT EXISTS job_items_at ON job_items(at);
CREATE INDEX IF NOT EXISTS model_checks_started ON model_checks(started_at);
CREATE INDEX IF NOT EXISTS build_tasks_queued ON build_tasks(queued_at);
CREATE INDEX IF NOT EXISTS push_outcomes_at ON push_outcomes(at);
CREATE INDEX IF NOT EXISTS patch_checks_created ON patch_checks(created_at);
CREATE INDEX IF NOT EXISTS opus_review_history_at ON opus_review_history(at);
CREATE INDEX IF NOT EXISTS premerge_reviews_at ON premerge_reviews(at);
CREATE INDEX IF NOT EXISTS postmerge_reviews_at ON postmerge_reviews(at);
CREATE INDEX IF NOT EXISTS verifications_created ON verifications(created_at);
CREATE INDEX IF NOT EXISTS fixups_created ON fixups(created_at);
CREATE INDEX IF NOT EXISTS ci_fixes_created ON ci_fixes(created_at);
CREATE INDEX IF NOT EXISTS conflict_merges_created ON conflict_merges(created_at);
CREATE INDEX IF NOT EXISTS merges_at ON merges(at);
CREATE INDEX IF NOT EXISTS actions_created ON actions(created_at);
CREATE INDEX IF NOT EXISTS conversation_turns_at ON conversation_turns(at);
CREATE INDEX IF NOT EXISTS decisions_asked_at ON decisions(asked_at);
CREATE INDEX IF NOT EXISTS decision_comments_at ON decision_comments(at);

-- Fix-ups an operator asked for by hand (a resolution card's fix-up step), one per PR head: the fix-up step works them with
-- source 'operator' in its fixups rows. state: queued | ended (a try was made, or it was cancelled). preapproval_id is set when the
-- fix-up is the first part of a pre-approved merge.
CREATE TABLE IF NOT EXISTS operator_fixups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  from_head TEXT NOT NULL,
  instructions TEXT NOT NULL,
  by TEXT NOT NULL,
  at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  preapproval_id INTEGER
);
CREATE INDEX IF NOT EXISTS operator_fixups_item ON operator_fixups(repo, number, from_head);

-- Pre-approved merges (src/preapproval): an operator's merge approval given ahead of a fix-up. state: fixup | review | ci | queued |
-- merged | asked | cancelled | failed (see Preapproval in web/src/api/types.ts). head is the pushed commit; fix_id the operator_fixups row.
CREATE TABLE IF NOT EXISTS preapprovals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  by TEXT NOT NULL,
  at TEXT NOT NULL,
  instructions TEXT NOT NULL,
  state TEXT NOT NULL,
  from_head TEXT NOT NULL,
  head TEXT,
  reason TEXT,
  updated_at TEXT NOT NULL,
  fix_id INTEGER,
  workflow_id INTEGER,                -- the item_workflows row whose merge leg this is; null outside the maintainer workflow
  reason_code TEXT,                   -- what reason is (src/core/codes.ts StopCode); NULL: read from its text
  reason_params TEXT                  -- JSON: what the reason names
);
CREATE INDEX IF NOT EXISTS preapprovals_item ON preapprovals(repo, number, id);

-- The maintainer workflow (src/workflow): one live row per started item, in repos whose tracked_repos.workflow is 'new'.
-- entry: review | fixup | implement | merge. state: running | waiting | blocked | recommending (live) | done | stopped |
-- closed | backlog. JSON columns: blocker_params (the blocker's facts), rec (Recommendation in src/workflow/types.ts),
-- plan (PlanPart[]). legacy_preapproval_id: the preapprovals row that works the merge leg.
CREATE TABLE IF NOT EXISTS item_workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- pr | issue
  entry TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 5,
  state TEXT NOT NULL,
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  started_via TEXT NOT NULL,          -- github | discord | agent | dashboard | cli
  base_head TEXT,                     -- the PR head the workflow accepted: author commits after it are a blocker; for an implement issue, the implementation PR head its files beyond the plan were shown at
  approved_by TEXT, approved_at TEXT, approved_via TEXT,
  stopped_by TEXT, stopped_at TEXT,
  blocker TEXT, blocker_params TEXT,
  rec TEXT, rec_at TEXT, rec_head TEXT,
  plan TEXT NOT NULL DEFAULT '[]',
  legacy_preapproval_id INTEGER,
  updated_at TEXT NOT NULL,
  step TEXT,                          -- the step it is at (src/workflow/status.ts StepName), written by the advance pass
  pr_number INTEGER,                  -- an implement workflow: the PR it works on, the newest an attempt of its issue opened for it; null before that (src/data/workflow/link.ts)
  version INTEGER NOT NULL DEFAULT 0, -- how often the row was written, for a write that must not pass another by
  accepted_head TEXT,                 -- the PR head a person accepted; NULL: base_head and the merge legs say it (src/core/evidence.ts acceptedHeads)
  review_asked_at TEXT,               -- a merge entry: a person asked for a model review of the head, newer than this; null when it merges without one
  taken_by TEXT                       -- a row the automatic merge rule started: the person whose answer last ran on it, who its questions go to (src/workflow/asked.ts)
);
CREATE UNIQUE INDEX IF NOT EXISTS item_workflows_live ON item_workflows(repo, number) WHERE state IN ('running', 'waiting', 'blocked', 'recommending');
CREATE INDEX IF NOT EXISTS item_workflows_item ON item_workflows(repo, number, id);
-- What people did to an item's workflow, with the parsed command (never the raw text): started, approved, answered,
-- ambiguous, blocked, stopped, weighted; and, archived, people's answers, the questions left open and the actions of the decision system before it. workflow_id is
-- null for an ambiguous answer on an item with no workflow and for an archived row.
CREATE TABLE IF NOT EXISTS workflow_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  login TEXT NOT NULL,
  via TEXT NOT NULL,
  kind TEXT NOT NULL,
  parsed TEXT,                        -- JSON Parsed (src/workflow/types.ts)
  line TEXT,                          -- the confirmation line given
  at TEXT NOT NULL,
  seen_at TEXT                        -- an answer: when its question was asked, the last moment of which the person had been shown anything
);
CREATE INDEX IF NOT EXISTS workflow_events_item ON workflow_events(repo, number, id);
CREATE INDEX IF NOT EXISTS workflow_events_login ON workflow_events(login, via, at);
-- The readers of what happened last leave the archived rows out: they are written later than what they record.
CREATE INDEX IF NOT EXISTS workflow_events_live ON workflow_events(repo, number, id) WHERE kind <> 'archived';
CREATE INDEX IF NOT EXISTS workflow_events_live_at ON workflow_events(at) WHERE kind <> 'archived';
-- A person's Task Runner taken onto one item's live workflow (take / release): it may claim that workflow's calls while no runner of
-- the starter or approver is ready with room (src/remote/started.ts, src/data/runners/cross.ts startedWorkAllows). The grant ends
-- with the workflow (a new start has another id) or with released_at.
CREATE TABLE IF NOT EXISTS item_runners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  workflow_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  at TEXT NOT NULL,
  released_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS item_runners_live ON item_runners(workflow_id, login) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS item_runners_item ON item_runners(repo, number, id);
CREATE INDEX IF NOT EXISTS workflow_events_workflow ON workflow_events(workflow_id) WHERE workflow_id IS NOT NULL;
-- An archived row (src/db/switch-over.ts) names the answer, open question or action it records in parsed: {"kind": "archived", "legacy": "decision:<id>"}.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_events_archived ON workflow_events(repo, number, parsed) WHERE kind = 'archived';
-- The last "link your account" reply to a GitHub commenter with no AutoCraft login; one a week per login. Bookkeeping: no live topic.
CREATE TABLE IF NOT EXISTS github_link_nudges (
  login TEXT PRIMARY KEY COLLATE NOCASE,
  at TEXT NOT NULL
) WITHOUT ROWID;

-- Security deep scan (src/security). Private to operators and maintainers; never an input of the planner.
-- security_scans.state: modeling | scanning | verifying | done | stopped | capped | failed (modeling includes waiting in the job queue).
CREATE TABLE IF NOT EXISTS security_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  commit_sha TEXT,
  state TEXT NOT NULL,
  cap_usd REAL,                       -- null = no cap
  cost_usd REAL NOT NULL DEFAULT 0,
  estimate_usd REAL,
  areas_total INTEGER NOT NULL DEFAULT 0,
  areas_done INTEGER NOT NULL DEFAULT 0,
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error TEXT,
  job_id INTEGER,
  threat_model TEXT                   -- JSON {summary, entryPoints}
);
CREATE INDEX IF NOT EXISTS security_scans_repo ON security_scans(repo, id);

CREATE TABLE IF NOT EXISTS security_areas (
  scan_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  paths TEXT NOT NULL,                -- JSON array
  entry_points TEXT NOT NULL,         -- JSON array of names
  risk INTEGER NOT NULL,
  why TEXT,
  state TEXT NOT NULL DEFAULT 'pending',   -- pending | done | failed
  cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (scan_id, idx)
) WITHOUT ROWID;

-- state: new | dismissed | backlog | fixing | ready | landing | landed | advisory | awaiting-admin | published, and two internal
-- states the API never lists: unverified (found, not yet checked), disproved (kept so a later scan does not raise it again) and duplicate (a repeat of the finding in duplicate_of).
CREATE TABLE IF NOT EXISTS security_findings (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,            -- per-repo sequence; item key <repo>:finding:<n>
  scan_id INTEGER NOT NULL,
  area TEXT NOT NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  urgent INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  refs TEXT NOT NULL,                 -- JSON [{path, line, claim}]
  category TEXT,
  reach TEXT NOT NULL,
  impact TEXT NOT NULL,
  verification TEXT,                  -- JSON {kind, result, notes, score, proposedTest}
  fingerprint TEXT NOT NULL,
  fix_commit TEXT,
  fix_pr INTEGER,
  ghsa_id TEXT,
  fork TEXT,
  fix_patch TEXT,                     -- the private diff (fix and regression test); never pushed before Land
  fix_title TEXT,                     -- plain title and summary of the change, written to go on a pull request
  fix_summary TEXT,
  fix_branch TEXT,                    -- the neutral branch name, fix-<slug>
  fix_files TEXT,                     -- JSON: the files the diff edits and its test file
  fix_ref TEXT,                       -- local ref of the commit in the bare cache: refs/autocraft/security/<repo>-<n>
  note TEXT,                          -- one line: why a fix failed, or what an admin must do
  env_wait_at TEXT,                   -- set while a fixing finding waits, with no job, for a confidential build environment
  reason TEXT,
  decided_by TEXT,
  duplicate_of INTEGER,               -- a repeat of this earlier finding of the repo (state duplicate)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS security_findings_scan ON security_findings(scan_id, number);

-- Quiet pull requests a finding once had and no longer points at (closed without merging). They stay quiet, also if reopened,
-- until the finding is published or dismissed.
CREATE TABLE IF NOT EXISTS security_quiet_prs (
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  finding INTEGER NOT NULL,
  PRIMARY KEY (repo, pr)
) WITHOUT ROWID;

-- The model calls of a scan, for the cost total and a finding's timeline. kind: model | area | verify.
CREATE TABLE IF NOT EXISTS security_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  area_idx INTEGER,
  finding_number INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  ok INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  agent_run_id INTEGER,               -- the agent run (/agents/:id) the call made; null for rows from before this column and for calls that made none
  resumed INTEGER NOT NULL DEFAULT 0  -- 1 when a fix call continued the session of the round before
);
CREATE INDEX IF NOT EXISTS security_calls_scan ON security_calls(scan_id, id);

-- The build rounds of a finding's private fix. A job queues a round's build tasks and ends; the job that follows reads the
-- result. state: building | failed | passed. session: the kept model session (JSON), while the round is building.
CREATE TABLE IF NOT EXISTS security_fix_rounds (
  repo TEXT NOT NULL, number INTEGER NOT NULL, round INTEGER NOT NULL,
  patch TEXT NOT NULL,                -- the validated patch
  test_patch TEXT NOT NULL,
  title TEXT NOT NULL,                -- the commit's title and summary, kept for the commit a passed round becomes
  summary TEXT NOT NULL,
  head_task INTEGER NOT NULL,
  base_task INTEGER NOT NULL,
  retried INTEGER NOT NULL DEFAULT 0, -- 1 once the tasks were queued again after an environment error
  session TEXT,
  state TEXT NOT NULL DEFAULT 'building',
  failure TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo, number, round)
);

-- The scan test of a finding (feature scan-tests): a test the model wrote from the verify step's proposed test, built and run
-- in the worker on the pinned commit. state: building | confirmed (fails at its test step) | not-shown (passes on the current
-- code) | could-not-build.
CREATE TABLE IF NOT EXISTS security_scan_tests (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  test_path TEXT NOT NULL,
  crate TEXT NOT NULL,
  test_patch TEXT NOT NULL,           -- the diff that adds the test file
  test_source TEXT NOT NULL,          -- the file as written
  task_id INTEGER NOT NULL,
  retried INTEGER NOT NULL DEFAULT 0, -- 1 once the task was queued again after an environment error
  state TEXT NOT NULL DEFAULT 'building',
  detail TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY (repo, number)
);

-- The history of those rounds, kept when a fix ends (ready or given up), without the patches. attempt is the finding's
-- fix_attempts at that time, so one finding's rounds group by attempt.
CREATE TABLE IF NOT EXISTS security_fix_log (
  repo TEXT NOT NULL, number INTEGER NOT NULL, attempt INTEGER NOT NULL, round INTEGER NOT NULL,
  state TEXT NOT NULL,                -- failed | passed | building (a round cut short)
  failure TEXT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  PRIMARY KEY (repo, number, attempt, round)
);

-- Discord mentions (optional feature, see docs/pipeline.md). Channels are what the bot reports; `watched` is the operators' choice.
-- A thread or forum post has `parent_id` set and counts under its parent's `watched`; the admin page lists parents only.
CREATE TABLE IF NOT EXISTS discord_channels (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  guild_name TEXT,
  name TEXT,
  watched INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  default_repo TEXT,                  -- tracked repo whose new-issue page the bot's "File a new issue" button opens
  position INTEGER,                   -- Discord's sort key within its category; NULL until the bot next connects
  category_id TEXT,                   -- the channel's category (discord_categories), not the thread parent
  panel_message TEXT,                 -- the bot's issue panel message in this channel (src/discord/panel.ts), edited in place on re-post
  viewable INTEGER NOT NULL DEFAULT 1 -- 0 when the bot lacks View Channel there (src/discord/perms.ts); the admin page omits such channels unless watched
);
-- Channel categories (type 4), for ordering the admin list like Discord's sidebar.
CREATE TABLE IF NOT EXISTS discord_categories (
  category_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT,
  position INTEGER
);
-- Gateway connection state, one row.
CREATE TABLE IF NOT EXISTS discord_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL,                -- connecting | connected | reconnecting | failed
  detail TEXT,
  at TEXT NOT NULL
);
-- One row per (message, item). `sealed` is AES-256-GCM of guild, channel, message id, time and a keyed hash of the author;
-- `msg_hash` and `channel_hash` are keyed hashes that only serve deletion. No message text and no per-person plain column.
CREATE TABLE IF NOT EXISTS discord_mentions (
  msg_hash TEXT NOT NULL,
  channel_hash TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  sealed TEXT NOT NULL,
  signal INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (msg_hash, repo, number)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS discord_mentions_item ON discord_mentions (repo, number);
CREATE INDEX IF NOT EXISTS discord_mentions_channel ON discord_mentions (channel_hash);
-- The bot's replies to pings, kept to delete a reply when the ping or the quoted message is deleted. `sealed` holds the
-- reply's guild, channel and message id; the hashes are keyed. No message text.
CREATE TABLE IF NOT EXISTS discord_replies (
  ping_hash TEXT PRIMARY KEY,
  quoted_hash TEXT,
  channel_hash TEXT NOT NULL,
  sealed TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS discord_replies_quoted ON discord_replies (quoted_hash) WHERE quoted_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS discord_replies_channel ON discord_replies (channel_hash);
-- What the bot's threads and command replies follow (src/discord/threads.ts): one row per target and item. `target_hash` is the keyed
-- hash of the thread's channel id (`kind` thread), or of the bot's reply when it could not start a thread (`kind` reply); `channel_hash`
-- the keyed hash of the channel the command was sent in. `sealed` holds the guild, the thread's or channel's id, the message id (the
-- thread's first message, or the bot's reply) and a keyed hash of the sender. `command` is the command as the parser writes it,
-- `login` the AutoCraft login it ran as, `at` the last command that added the item. No message text.
CREATE TABLE IF NOT EXISTS discord_follows (
  target_hash TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL,
  channel_hash TEXT NOT NULL,
  sealed TEXT NOT NULL,
  command TEXT NOT NULL,
  login TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (target_hash, repo, number)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS discord_follows_item ON discord_follows (repo, number);
CREATE INDEX IF NOT EXISTS discord_follows_channel ON discord_follows (channel_hash);
-- What the bot last posted about each item a target follows (src/discord/results.ts), so a restart posts nothing twice. `status_hash` is a
-- hash of the status line last posted; `result_key` the workflow id and recommendation time of the result last posted, `result_hash`
-- a hash of its text and `link_hash` of its GitHub link; `sealed` the result message's id sealed with the target and item (keys.ts),
-- '' when none. No message text. A row goes once its (target, item) row in `discord_follows` is gone.
CREATE TABLE IF NOT EXISTS discord_follow_posts (
  target_hash TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  status_hash TEXT NOT NULL,
  result_key TEXT NOT NULL DEFAULT '',
  result_hash TEXT NOT NULL DEFAULT '',
  link_hash TEXT NOT NULL DEFAULT '',
  sealed TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL,
  PRIMARY KEY (target_hash, repo, number)
) WITHOUT ROWID;

-- Discord accounts linked to dashboard logins (src/discord/links.ts). `user_hash` is a keyed hash of the Discord user id; the id
-- itself is never stored. `source` says how the link was made: code (a dashboard user's `/autocraft account action:link` code; only these run
-- commands) or verify (the public /verify pages, which prove the GitHub account but give no AutoCraft login). `discord_link_codes` holds the keyed hash of each unused link code (one per login) until it is used or expires.
CREATE TABLE IF NOT EXISTS discord_links (
  user_hash TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  linked_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS discord_links_login ON discord_links (login);
CREATE TABLE IF NOT EXISTS discord_link_codes (
  code_hash TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  expires_at TEXT NOT NULL
) WITHOUT ROWID;
-- Discord users who asked the bot to stop tracking their messages (`/autocraft optout`, src/discord/store.ts). `user_hash` is a keyed
-- hash of the Discord user id. Their messages record no mentions; what they send to the bot still runs. Bookkeeping: not a change topic.
CREATE TABLE IF NOT EXISTS discord_optouts (
  user_hash TEXT PRIMARY KEY,
  opted_out_at TEXT NOT NULL
) WITHOUT ROWID;

-- Decision alerts by direct message (src/discord/alerts.ts). A row of `discord_alerts` is an opted-in linked account: `sealed` holds the
-- direct-message channel id. A row of `discord_alert_msgs` is one message about a decision, kept to edit it after the answer; `sealed` is
-- null for a decision named only in a summary message. Both go when the link is removed. Bookkeeping: not a change topic.
CREATE TABLE IF NOT EXISTS discord_alerts (
  user_hash TEXT PRIMARY KEY,
  sealed TEXT NOT NULL,
  created_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS discord_alert_msgs (
  decision_id TEXT NOT NULL,
  user_hash TEXT NOT NULL,
  sealed TEXT,
  choices_id TEXT,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (decision_id, user_hash)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS discord_alert_msgs_user ON discord_alert_msgs (user_hash, sent_at);

-- The public contributor verification at /verify (src/dash/server/verify.ts). A row of `discord_verify_flows` is one browser's
-- sign-in, keyed by the hash of the random flow id in its cookie; `state_hash` is the hash of the current step's OAuth state, spent
-- when its callback arrives. `step` is discord (waiting for Discord), github (waiting for GitHub), then the outcome: requested (a role
-- request was made), no-merge or unchecked (GitHub could not be asked). `user_sealed` holds the Discord user id proven by the Discord
-- step, sealed with the Discord key, and `user_hash` its keyed hash (to delete the rows on unlink); `login` is the GitHub login
-- proven by the GitHub step. Unfinished flows go at their expiry. A row of `discord_role_grants` asks the runner to give
-- the contributor role to a Discord user whose GitHub login has a merged pull request; the runner writes `result` (granted, already,
-- not-member, forbidden, failed, off). The flow row names its grant so the result page can show it. Rows go after a day.
CREATE TABLE IF NOT EXISTS discord_verify_flows (
  flow_hash TEXT PRIMARY KEY,
  step TEXT NOT NULL,
  state_hash TEXT,
  verifier TEXT,
  user_sealed TEXT,
  user_hash TEXT,
  login TEXT,
  grant_id TEXT,
  expires_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS discord_role_grants (
  id TEXT PRIMARY KEY,
  user_sealed TEXT NOT NULL,
  user_hash TEXT NOT NULL,
  login TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  result TEXT,
  done_at TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS discord_role_grants_open ON discord_role_grants (requested_at) WHERE result IS NULL;
CREATE TRIGGER IF NOT EXISTS discord_links_alerts AFTER DELETE ON discord_links BEGIN
  DELETE FROM discord_alerts WHERE user_hash = old.user_hash;
  DELETE FROM discord_alert_msgs WHERE user_hash = old.user_hash;
END;

-- Reads of the public status layer (src/public/status.ts): merged and posted in the last days.
CREATE INDEX IF NOT EXISTS items_merged_at ON items(merged_at);
CREATE INDEX IF NOT EXISTS review_posts_posted ON review_posts(posted_at);

-- Outside-author protections (src/outside.ts). outside_holds is rewritten on every planner pass: the open items of authors
-- outside the team that wait for model work, either over their daily budget ('limit') or created during a surge ('surge').
-- outside_released lists the items an operator released; they are exempt from both holds.
CREATE TABLE IF NOT EXISTS outside_holds (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- pr | issue
  reason TEXT NOT NULL,               -- limit | surge
  PRIMARY KEY (repo, number)
);
CREATE INDEX IF NOT EXISTS outside_holds_author ON outside_holds(author);
CREATE TABLE IF NOT EXISTS outside_released (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  by TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
-- Items the outside-author holds let through: planned without a hold once, or already worked when the protections began.
-- An admitted item is never held by the daily limit afterwards.
CREATE TABLE IF NOT EXISTS outside_admitted (
  repo TEXT NOT NULL, number INTEGER NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);

-- Downloads report (src/downloads). One row per release asset with GitHub's running download count; platform, processor
-- and format are recomputed from the file name on each poll (null format: not a package, not counted).
CREATE TABLE IF NOT EXISTS release_assets (
  asset_id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL,
  release_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  release_name TEXT,
  published_at TEXT,
  prerelease INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  platform TEXT,
  processor TEXT,
  format TEXT,
  downloads INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  gone_at TEXT                        -- set while GitHub no longer lists the asset; its history stays
);
CREATE INDEX IF NOT EXISTS release_assets_repo ON release_assets(repo);

-- One row per repo that has release files: the app's display name and its star count.
CREATE TABLE IF NOT EXISTS release_apps (
  repo TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stars INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Increases of an asset's download count between polls. t is the start of an ISO hour (span 'h') or of a UTC day (span 'd');
-- hour buckets older than 14 days are folded into day buckets.
CREATE TABLE IF NOT EXISTS download_deltas (
  asset_id INTEGER NOT NULL,
  t TEXT NOT NULL,
  span TEXT NOT NULL,
  delta INTEGER NOT NULL,
  PRIMARY KEY (asset_id, t, span)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS download_deltas_t ON download_deltas(t);

-- A repo's star count, one row per hour in which it changed (and the first poll's reading).
CREATE TABLE IF NOT EXISTS star_samples (
  repo TEXT NOT NULL,
  t TEXT NOT NULL,
  stars INTEGER NOT NULL,
  PRIMARY KEY (repo, t)
) WITHOUT ROWID;

-- Nightly checks (src/nightly): per repo, which checks of the catalogue run and with which crates or fuzz targets.
-- A repo with no enabled row runs nothing. params: JSON {crates?: string[], targets?: string[]}.
CREATE TABLE IF NOT EXISTS nightly_selection (
  repo TEXT NOT NULL,
  check_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  params TEXT,
  PRIMARY KEY (repo, check_id)
) WITHOUT ROWID;

-- One row per repo and night; started_at is what the once-a-day schedule reads. state: running | done.
CREATE TABLE IF NOT EXISTS nightly_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,                  -- the default branch head the checks ran at
  started_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'running'
);
CREATE INDEX IF NOT EXISTS nightly_runs_repo ON nightly_runs(repo, started_at);

-- One row per check of a run. state: queued | pass | fail | error | skipped | warn. summary: one scrubbed line.
-- decision_id / issue_number: the operator decision about opening an issue for a failure streak, and the issue it led to.
CREATE TABLE IF NOT EXISTS nightly_results (
  run_id INTEGER NOT NULL,
  check_id TEXT NOT NULL,
  task_id INTEGER,
  state TEXT NOT NULL,
  summary TEXT,
  issue_number INTEGER,
  decision_id TEXT,
  finished_at TEXT,
  PRIMARY KEY (run_id, check_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS nightly_results_task ON nightly_results(task_id);

-- Benchmark values parsed from a finished bench check; kept 180 days.
CREATE TABLE IF NOT EXISTS nightly_bench (
  repo TEXT NOT NULL,
  bench TEXT NOT NULL,
  sha TEXT NOT NULL,
  at TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  PRIMARY KEY (repo, bench, sha)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS nightly_bench_at ON nightly_bench(repo, bench, at);

-- Work rows for a repo that was never tracked (security scans under `(security):<repo>`, operator build tasks) count it as known, so non-operators do not see them.
CREATE TRIGGER IF NOT EXISTS jobs_ever AFTER INSERT ON jobs WHEN NEW.repo IS NOT NULL BEGIN
  INSERT OR IGNORE INTO ever_tracked_repos (name) VALUES (CASE WHEN NEW.repo LIKE '(security):%' THEN substr(NEW.repo, 12) ELSE NEW.repo END);
END;
CREATE TRIGGER IF NOT EXISTS build_tasks_ever AFTER INSERT ON build_tasks WHEN NEW.repo IS NOT NULL BEGIN
  INSERT OR IGNORE INTO ever_tracked_repos (name) VALUES (CASE WHEN NEW.repo LIKE '(security):%' THEN substr(NEW.repo, 12) ELSE NEW.repo END);
END;
CREATE TRIGGER IF NOT EXISTS agent_run_items_ever AFTER INSERT ON agent_run_items WHEN NEW.repo IS NOT NULL BEGIN
  INSERT OR IGNORE INTO ever_tracked_repos (name) VALUES (CASE WHEN NEW.repo LIKE '(security):%' THEN substr(NEW.repo, 12) ELSE NEW.repo END);
END;

-- Settled verdicts per classification run (src/classify/settled.ts), for queries that count or filter many items. A run
-- is built in full on first use and listed in item_settled_runs; from then on only the items in item_settled_dirty are
-- worked out again. Triggers on classifications mark an item dirty (n counts the marks, so a refresh clears only the
-- marks it saw). Items without a Jev or Haiku verdict have no row ("unclassified").
CREATE TABLE IF NOT EXISTS item_settled (
  run TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  status TEXT NOT NULL,
  label TEXT,
  source TEXT,
  top REAL,
  jev_label TEXT,
  haiku_label TEXT,
  flags TEXT NOT NULL,                -- JSON array
  security INTEGER NOT NULL,
  needs_decision INTEGER NOT NULL,
  referee_label TEXT,
  referee_sure INTEGER,
  referee_reason TEXT,
  referee_final INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run, repo, number)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS item_settled_runs (run TEXT PRIMARY KEY, refreshed_at TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS item_settled_dirty (
  run_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (run_id, repo, number)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS classifications_settled_i AFTER INSERT ON classifications BEGIN
  INSERT INTO item_settled_dirty (run_id, repo, number) VALUES (NEW.run_id, NEW.repo, NEW.number)
    ON CONFLICT (run_id, repo, number) DO UPDATE SET n = n + 1;
END;
CREATE TRIGGER IF NOT EXISTS classifications_settled_u AFTER UPDATE ON classifications BEGIN
  INSERT INTO item_settled_dirty (run_id, repo, number) VALUES (OLD.run_id, OLD.repo, OLD.number), (NEW.run_id, NEW.repo, NEW.number)
    ON CONFLICT (run_id, repo, number) DO UPDATE SET n = n + 1;
END;
CREATE TRIGGER IF NOT EXISTS classifications_settled_d AFTER DELETE ON classifications BEGIN
  INSERT INTO item_settled_dirty (run_id, repo, number) VALUES (OLD.run_id, OLD.repo, OLD.number)
    ON CONFLICT (run_id, repo, number) DO UPDATE SET n = n + 1;
END;

-- State that code writes for its own use, one table per owning module (src/data/<module>). The values once lived in settings
-- rows; src/db/state-copy.ts copies those rows here once and leaves them in place for older processes.

-- Sync bookkeeping (mirror): one row.
CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  org_high_water TEXT,                -- start of the last org-wide incremental sync that finished without failures
  full_sync_cursor TEXT,              -- `<scope>|<name>`: where a resumable full sync carries on
  search_catchup_at TEXT,
  repos_refreshed_at TEXT,
  main_ci_polled_at TEXT,
  releases_polled_at TEXT,
  releases_offset INTEGER,            -- where the next release poll starts in the repo list
  rate_remaining INTEGER,             -- GitHub GraphQL points left after the last sync, and when they reset
  rate_reset_at TEXT,
  points_last_run INTEGER,            -- GraphQL points the last incremental sync and the last full sync spent
  full_points_last_run INTEGER,
  author_ids_backfilled_at TEXT,
  author_ids_error TEXT,              -- `<time> <message>` of the last failed account-id pass
  app_install_sweep_at TEXT,
  webhook_at TEXT,                    -- the newest verified GitHub App webhook delivery
  webhook_started_at TEXT,            -- start of the newest webhook receiver process that has taken a delivery
  polled_at TEXT,                     -- start of the last finished org-wide poll
  poll_missed_at TEXT,                -- start of the last poll that found changes no webhook had brought
  poll_missed TEXT,                   -- that poll's count and first items: `<n> <repo#number> ...`
  deliveries_checked_at TEXT          -- GitHub's list of the app's webhook deliveries was checked up to here
);

-- Webhook deliveries the delivery check asked GitHub to send again (src/github/deliveries.ts), by delivery GUID. GitHub keeps
-- deliveries three days; rows older than that are pruned.
CREATE TABLE IF NOT EXISTS webhook_redeliveries (
  guid TEXT PRIMARY KEY,
  asked INTEGER NOT NULL,             -- redelivery requests made, failed requests included
  asked_at TEXT,                      -- the last request GitHub accepted; an attempt before it is answered by the redelivery
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

-- Per-repo step approvals (control): the repo lets AutoCraft run the step where no person asked for it.
CREATE TABLE IF NOT EXISTS repo_step_approvals (
  repo TEXT NOT NULL,
  step TEXT NOT NULL,                 -- merge | push | comment | fixissue | labels | mainfix | prstatus | ci
  by TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (repo, step)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS audit_action_at ON audit(action, at);

-- Lane bookkeeping (jobs): fingerprints of a lane's inputs at its last job (fp, per step and repo), daily-limit resets
-- (reset, per step), round-robin cursors (cursor: review, verify) and planner marks (mark: planned_at, seqs_seen, wake_at,
-- status, heartbeat, security_poll_at). value is the fingerprint, time, cursor or mark; job_id the job an fp row belongs to.
CREATE TABLE IF NOT EXISTS lane_state (
  kind TEXT NOT NULL,
  step TEXT NOT NULL,
  repo TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL,
  job_id INTEGER,
  at TEXT NOT NULL,
  PRIMARY KEY (kind, step, repo)
) WITHOUT ROWID;
-- Database statements, round trips and time per process scope (runner-tick, claim, dashboard, planner-pass) and UTC minute
-- (`YYYY-MM-DDTHH:MM`), added up by each process's flush.
CREATE TABLE IF NOT EXISTS db_stats (
  scope TEXT NOT NULL,
  minute TEXT NOT NULL,
  statements INTEGER NOT NULL DEFAULT 0,
  round_trips INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, minute)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS db_stats_minute ON db_stats(minute);

-- Classify state (triage): kind jev_failed is the class_hash at which an item's Jev request gave no valid verdict; kind
-- current_run (repo '', number 0) is the classify run the pipeline reads.
CREATE TABLE IF NOT EXISTS classify_state (
  kind TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  value TEXT,
  at TEXT,
  PRIMARY KEY (kind, repo, number)
) WITHOUT ROWID;
-- A duplicate set that changed on GitHub since the sync (triage): the set's hash and when it was dropped, so it is not tried
-- again for a while.
CREATE TABLE IF NOT EXISTS dupe_drops (
  repo TEXT NOT NULL,
  key TEXT NOT NULL,
  hash TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (repo, key)
) WITHOUT ROWID;

-- What a person told AutoCraft to do on GitHub (workflow): a close, comment-close or merge made as that person, or the comment
-- (ask-author, as the app) that asks a pull request's author for more work.
-- state: pending | waiting-token | waiting-permission | done | failed | stopped | skipped. head is the head the person saw:
-- a push after the command stops a close or merge.
CREATE TABLE IF NOT EXISTS workflow_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- close | comment-close | merge | ask-author
  by TEXT NOT NULL,
  head TEXT,
  state TEXT NOT NULL,
  reason TEXT,
  comment_url TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT,
  close_as TEXT,                      -- a close: completed | not-planned | duplicate <repo>#<n>; null: no reason given
  UNIQUE (workflow_id, kind, repo, number)
);
CREATE INDEX IF NOT EXISTS workflow_actions_state ON workflow_actions(state, created_at);
CREATE INDEX IF NOT EXISTS workflow_actions_item ON workflow_actions(repo, number);

-- Review marks per PR (review): when an operator marked the reviews stale, today's count of discussion re-reviews, and the
-- failed review calls at one head.
CREATE TABLE IF NOT EXISTS review_state (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  stale_at TEXT,
  rerun_day TEXT,                     -- UTC day (YYYY-MM-DD) rerun_count counts
  rerun_count INTEGER NOT NULL DEFAULT 0,
  fail_head TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  fail_at TEXT,
  PRIMARY KEY (repo, number)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS opus_reviews_item_at ON opus_reviews(repo, number, at);
CREATE INDEX IF NOT EXISTS opus_review_history_item_at ON opus_review_history(repo, number, at);

-- PRs whose mergeable state GitHub keeps reporting as unknown (merge): checks reads in a row that showed it, REST rereads,
-- and whether it is stuck.
CREATE TABLE IF NOT EXISTS merge_state (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  head TEXT NOT NULL,
  since TEXT NOT NULL,
  reads INTEGER NOT NULL DEFAULT 0,
  rereads INTEGER NOT NULL DEFAULT 0,
  stuck INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, number)
) WITHOUT ROWID;
-- The most PRs a repo's next integration batch takes (merge): grows after a passing batch, halves after a failed one.
CREATE TABLE IF NOT EXISTS merge_repo_state (
  repo TEXT PRIMARY KEY,
  batch_size INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS merge_batches_pr ON merge_batches(repo, pr_number);
-- The recent batches the merge queue's publish backoff reads on every planner pass (src/data/merge/batches.ts loadPublishFailures).
CREATE INDEX IF NOT EXISTS merge_batches_updated ON merge_batches(updated_at);
CREATE INDEX IF NOT EXISTS pr_builds_created ON pr_builds(repo, created_at);

-- The liveness check's last run (planner): one row.
CREATE TABLE IF NOT EXISTS liveness_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  checked_at TEXT,
  open INTEGER                        -- open items the check found
);
-- Planner passes per kind (full, changed, ...) and UTC hour (`YYYY-MM-DDTHH`): count, refs, time and the database work the
-- pass did, a series for the query-growth check. Kept 14 days.
CREATE TABLE IF NOT EXISTS plan_pass_hours (
  kind TEXT NOT NULL,
  hour TEXT NOT NULL,
  passes INTEGER NOT NULL DEFAULT 0,
  refs INTEGER NOT NULL DEFAULT 0,
  last_at TEXT NOT NULL,
  ms INTEGER NOT NULL DEFAULT 0,
  max_ms INTEGER NOT NULL DEFAULT 0,
  db_statements INTEGER NOT NULL DEFAULT 0,
  db_round_trips INTEGER NOT NULL DEFAULT 0,
  db_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, hour)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS plan_pass_hours_hour ON plan_pass_hours(hour);

CREATE INDEX IF NOT EXISTS agent_runs_step_model ON agent_runs(step, model, id);

-- The items of a Task Runner call (runners), in the order of remote_calls.items, written with the call.
CREATE TABLE IF NOT EXISTS remote_call_items (
  call_id INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  PRIMARY KEY (call_id, pos)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS remote_call_items_item ON remote_call_items(repo, number);

-- Build bookkeeping (build): warm_report, warm_bytes:<key>, warm_gc_at, warm_trimmed_publish, warm_rebuild:<repo>,
-- worker_update_pending, worker_update_failures and the runner endpoint (leader:runner:endpoint), with their settings values.
CREATE TABLE IF NOT EXISTS build_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

-- Lookups of the patches AutoCraft writes (changes).
CREATE INDEX IF NOT EXISTS fixups_linting ON fixups(state) WHERE state = 'linting';
CREATE INDEX IF NOT EXISTS fixups_to_head ON fixups(to_head) WHERE state = 'pushed';
CREATE INDEX IF NOT EXISTS ci_fixes_to_head ON ci_fixes(to_head) WHERE to_head IS NOT NULL;
CREATE INDEX IF NOT EXISTS conflict_merges_to_head ON conflict_merges(to_head) WHERE to_head IS NOT NULL;

-- The causes the hourly self-evaluation found (eval, src/eval): one row per cause key, with its evidence, the model's
-- investigation and the issue filed for it on the eval repo.
CREATE TABLE IF NOT EXISTS eval_causes (
  cause_key TEXT PRIMARY KEY,
  detector TEXT NOT NULL,
  summary TEXT NOT NULL,              -- one line from the detector
  state TEXT NOT NULL,                -- new | investigated | filing | filed | declined
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]', -- JSON [{id, at, note, ref?}], newest kept
  seen INTEGER NOT NULL DEFAULT 0,    -- distinct evidence ids seen in all
  investigated_at TEXT,
  investigated_seen INTEGER NOT NULL DEFAULT 0, -- seen when the last investigation was asked
  verdict TEXT,                       -- defect | not-defect | failed
  failures INTEGER NOT NULL DEFAULT 0, -- investigations in a row without a valid reply; 3 stop the retries until new evidence
  finding TEXT,                       -- JSON: the investigation's reply as kept
  model TEXT,
  run_id TEXT,
  issue_number INTEGER,
  filed_at TEXT,
  reported_seen INTEGER NOT NULL DEFAULT 0, -- seen when the issue or its last comment was posted
  commented_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, -- creates of the issue tried
  note TEXT
) WITHOUT ROWID;

-- The issue reviews a maintainer asked for (`review` on an issue, src/issuereview): one row per review of an issue's workflow.
-- state: queued (due), posting (the review is stored, its comment waits to be posted), done (the comment is posted, or its tries are
-- final), failed (no valid review after ISSUE_REVIEW_TRIES calls), ask (the reporter's question waits to be posted), reporter (the
-- question is posted; the review runs again on this row once the reporter answers).
CREATE TABLE IF NOT EXISTS issue_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  requested_by TEXT NOT NULL,         -- who asked for the review: who started it, or answered the question that asked for it
  requested_at TEXT NOT NULL,
  then_implement INTEGER NOT NULL DEFAULT 0, -- `review and implement`: an implement recommendation starts the implementation without a question
  state TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,   -- review calls without a valid review since the row was last due
  tried_at TEXT,
  error TEXT,
  commit_sha TEXT,                    -- the default branch commit the review read
  model TEXT,
  review TEXT,                        -- JSON IssueReview (src/issuereview/prompt.ts)
  reviewed_at TEXT,
  comment_url TEXT,
  post_tries TEXT,                    -- JSON [ISO]: posts of the comment or the question that sent nothing (src/core/rules.ts unsentAsk)
  question TEXT,                      -- state ask or reporter: the question for the reporter
  asked_at TEXT,                      -- when that question was posted
  job_id INTEGER
);
CREATE INDEX IF NOT EXISTS issue_reviews_item ON issue_reviews(repo, number, id);
CREATE INDEX IF NOT EXISTS issue_reviews_workflow ON issue_reviews(workflow_id, id);
