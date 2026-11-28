// Every table the planner's fact loaders (loadPrFacts, loadItemFacts and the set readers they call) read, and what a change
// to a row there means for the plans: which items it re-decides, or that every item must be decided again. The change log
// (src/db/plan-triggers.ts) generates its triggers from this list; src/trigger-sources.ts registers it with the access module's
// permission lifetime. Taken from the SQL the loaders prepare during a full load (test/plan-changes.test.ts checks that every table
// they read is listed).
//
// SQL fragments name the written row `r` (`r.repo`); the triggers put `new` or `old` in its place. Subqueries must not use the
// alias `r` themselves.
import { BOOKKEEPING_SETTINGS } from "./live.ts";
import type { PlanInput } from "./plan-triggers.ts";
import { pgExpr, pgJsonArray } from "../core/pg-expr.ts";

export type { PlanInput, PlanInputClass } from "./plan-triggers.ts";

/** Live states of item_workflows (src/workflow/store.ts LIVE_STATES). */
const WF_LIVE = "('running', 'waiting', 'blocked', 'recommending')";

/** Integration PRs of the checking or open batches that carry PR `number` of `repo` (their scope and CI tip read the members). */
const batchPrsOf = (repo: string, number: string): string =>
  `SELECT b.repo AS repo, b.pr_number AS number FROM merge_batches b JOIN merge_batch_prs bp ON bp.batch_id = b.id
    WHERE b.repo = ${repo} AND bp.number = ${number} AND b.state IN ('checking', 'open') AND b.pr_number IS NOT NULL`;

/** PRs with a hold review that names `repo#number` as a blocking item (src/review/blockers.ts), through review_blockers (src/db/plan-triggers.ts). */
const blockedBy = (repo: string, number: string): string =>
  `SELECT o.repo AS repo, o.number AS number FROM review_blockers rb JOIN opus_reviews o ON o.repo = rb.repo AND o.number = rb.number AND o.head_oid = rb.head_oid
    WHERE rb.b_repo = ${repo} AND rb.b_number = ${number} AND o.verdict = 'hold'`;

/** True when item `a` is in a duplicate edge: its state, text and activity move other members' sets (src/dupes/plan.ts). */
// The unary + keeps SQLite off the verdict index: the item's own pairs are a key lookup.
const inDupeSet = (a: string): string =>
  `(EXISTS (SELECT 1 FROM duplicate_pairs dp WHERE dp.repo = ${a}.repo AND dp.a = ${a}.number AND +dp.verdict = 'duplicate')
    OR EXISTS (SELECT 1 FROM duplicate_pairs dp WHERE dp.repo = ${a}.repo AND dp.b = ${a}.number AND +dp.verdict = 'duplicate'))`;

const changed = (cols: string[]): string => cols.map((c) => `old.${c} IS NOT new.${c}`).join(" OR ");

/**
 * Item columns that change other PRs' facts: long-lived branches (head_ref, head_repo, base_ref, author_association),
 * authors' tiers (state). A PR's text and closing links move issues' open PR, which the PR_REFS input logs by issue.
 */
const PR_CROSS_COLUMNS = ["state", "head_ref", "head_repo", "base_ref", "author_association"];

/**
 * A PR's text edit whose earlier references are not stored: the issues it named are not readable, so every item is decided again.
 * Only sync writes title and body, and it writes text_refs in the same transaction (src/mirror.ts), so the new references are logged.
 */
const PR_TEXT_UNKNOWN = "(new.kind = 'pr' AND old.text_refs IS NULL AND (old.title IS NOT new.title OR old.body IS NOT new.body))";

/** The issues a PR's stored text references (text_refs mentions, which include the closing ones) and closing-issue links name. */
const PR_REFS = `SELECT r.repo AS repo, j.value AS number FROM json_each(CASE WHEN json_valid(r.text_refs) AND json_type(r.text_refs, '$[1]') = 'array' THEN json_extract(r.text_refs, '$[1]') ELSE '[]' END) j WHERE j.type = 'integer'
      UNION SELECT r.repo, j.value FROM json_each(CASE WHEN json_valid(r.closing_issues) AND json_type(r.closing_issues) = 'array' THEN r.closing_issues ELSE '[]' END) j WHERE j.type = 'integer'`;
const pgRefsArray = (x: string): string => `COALESCE(CASE WHEN json_valid(${x}) THEN CASE WHEN json_typeof(${x}::json -> 1) = 'array' THEN ${x}::json -> 1 END END, '[]'::json)`;
const PR_REFS_PG = `SELECT r.repo AS repo, ac_int(j #>> '{}') AS number FROM json_array_elements(${pgRefsArray("r.text_refs")}) j WHERE json_typeof(j) = 'number'
      UNION SELECT r.repo, ac_int(j #>> '{}') FROM json_array_elements(${pgJsonArray("r.closing_issues")}) j WHERE json_typeof(j) = 'number'`;
/** Item columns that change duplicate sets and their stored comparisons. */
const DUPE_COLUMNS = ["state", "title", "body", "embed_hash", "comments_count", "created_at", "closing_issues"];

/** An item write that forces a full pass; `no` is the dialect's false (the CASE keeps SQLite from probing the dupe tables on every write). */
const itemsFullUpdate = (no: string): string => `${changed(["kind", "author", "author_id"])}
      OR (new.kind = 'pr' AND (${changed(PR_CROSS_COLUMNS)})) OR ${PR_TEXT_UNKNOWN}
      OR (CASE WHEN ${changed(DUPE_COLUMNS)} THEN ${inDupeSet("new")} ELSE ${no} END)`;

/**
 * Settings rows the runner, sync and planner write for their own use (src/db/live.ts), and the planner's shadow switch and the app
 * installation sweep's time. No fact reads these.
 */
export const PLAN_IGNORED_SETTINGS = [...BOOKKEEPING_SETTINGS, "plan_shadow", "app_install_sweep_at"];
// Leader and standby status rows (src/db/leader.ts) are rewritten every few seconds and warm sizes after every warm build;
// no fact loader reads them. The build feature switches are read (featureOn), so they stay inputs.
const PLAN_IGNORED_SETTING_LIKE = ["%\\_points\\_last\\_run", "pipeline\\_fp:%", "leader:%", "warm\\_bytes:%"];

/**
 * An UPDATE of repo_permissions that moves facts: a new login, repo or permission, or the refresh of a row that was no longer fresh
 * (see planInputsWith).
 */
export function permissionMoved(permReadTtlMs: number): { sqlite: string; pg: string } {
  const freshS = Math.round(permReadTtlMs / 1000) - 60;
  const moved = (fresh: string): string => `${changed(["login", "repo", "permission"])} OR NOT (old.checked_at > ${fresh})`;
  return {
    sqlite: moved(`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${freshS} seconds')`),
    pg: moved(`to_char(now() AT TIME ZONE 'UTC' - interval '${freshS} seconds', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`).replace(/ IS NOT /g, " IS DISTINCT FROM "),
  };
}

/**
 * The planner's inputs. `permReadTtlMs` is how long a cached write permission counts as fresh (access PERM_READ_TTL): a
 * repo_permissions UPDATE moves facts when it brings a new login, repo or permission, or refreshes a row that was no longer fresh.
 * The pipeline and dashboard sessions refresh a permission before it goes stale (src/preapproval/permissions.ts), so a refresh of a
 * fresh row changes no fact. The threshold is a minute stricter than the lifetime, for clock skew between the database and the planner.
 */
export function planInputsWith(o: { permReadTtlMs: number }): PlanInput[] {
  const permission = permissionMoved(o.permReadTtlMs);
  return [
    // ---- item-keyed ----
    // A bookkeeping column (src/live.ts) that the Plan reads: it is watched here on its own.
    {
      table: "classify_state", class: "item", why: "A classify request that gave no valid verdict at the item's input (a jev_failed row) ends the prioritize hold.",
      when: "r.kind = 'jev_failed'",
    },
    {
      table: "agent_run_items", class: "item", why: "Links a model run to an item; the review gate counts the item's Opus review runs.",
      noTopic: "Written with every model call. A review run only holds the PR's next review back, and the job that made it ends (job-ends).",
    },
    { table: "ci_fixes", class: "item", why: "CI fix rows of one PR (cifix facts, push chain, lint)." },
    { table: "ci_run_approvals", class: "item", why: "Workflow runs waiting at one PR head; an integration PR's tip rows are its own." },
    { table: "ci_vs_main", class: "item", why: "A PR head's failing checks compared with the red default branch's: whether its CI counts as passing." },
    {
      table: "classifications", class: "item", why: "Classifier verdicts of one item.",
      // Without a current_run row the run every item's labels come from is the newest verdict run (latestRun).
      full: "NOT EXISTS (SELECT 1 FROM classify_state cs WHERE cs.kind = 'current_run' AND COALESCE(cs.value, '') <> '')",
    },
    { table: "comments", class: "item", why: "Comments and reviews of one item (discussion state, review gate)." },
    { table: "conflict_merges", class: "item", why: "Conflict merges of one PR (conflict bucket, push chain, lint)." },
    { table: "diff_facts", class: "item", why: "What the merge rule reads from one PR head's cached diff (sensitive reasons, changed lines, pending re-reads)." },
    { table: "duplicate_scans", class: "item", why: "The text hash one item was scanned at." },
    { table: "fixups", class: "item", why: "Fix-up rows of one PR (fix-up, operator fix-up, lint, push chain)." },
    { table: "item_embeddings", class: "item", why: "One item's embedding hash.", columns: ["repo", "number", "model", "hash"] },
    { table: "item_priority", class: "item", why: "One item's priority row." },
    { table: "item_rank", class: "item", why: "One item's rank score." },
    { table: "item_stage", class: "item", why: "One item's stage row." },
    { table: "issue_reviews", class: "item", why: "The reviews of one issue a maintainer asked for: a queued review, or a question for the reporter, is due." },
    {
      table: "screenshot_runs", class: "item", why: "The screenshots at one PR head: a clear regression keeps it from merging until a person answers.", columns: ["head_sha", "held", "comparison", "finished_at"],
      noTopic: "Written by the collect job (job-ends).",
    },
    { table: "merges", class: "item", why: "Merge attempts of one PR." },
    { table: "operator_fixups", class: "item", why: "An operator's fix-up request on one PR." },
    {
      table: "opus_review_history", class: "item", why: "Overwritten reviews of one PR (unsure heads, review counts).",
      noTopic: "Written in the transaction that stores the review (reviews).",
    },
    { table: "postmerge_reviews", class: "item", why: "The post-merge review of one PR." },
    { table: "preapprovals", class: "item", why: "A pre-approved merge of one PR." },
    { table: "premerge_reviews", class: "item", why: "Pre-merge reviews of one PR." },
    { table: "premerge_followups", class: "item", why: "The follow-up issue of one PR approved for merge, per head." },
    { table: "review_followups", class: "item", why: "The follow-up issue of one PR approved for merge, per reviewed head." },
    { table: "push_outcomes", class: "item", why: "Our pushes to one PR (pushed heads, broken heads)." },
    {
      table: "workflow_events", class: "item", why: "When a person last chose to go on with a started item, and who answered it.", when: "r.kind IN ('started', 'answered')",
      noTopic: "Written with the workflow row the event is about (workflows).",
    },
    {
      table: "own_pushes", class: "item", why: "Our pushes to one PR, recorded before each push (our own push chain).",
      noTopic: "Written before its push; the push moves the PR's head (items), which the decision needs.",
    },
    {
      table: "autorepins", class: "item", why: "An autorepin's commit on one PR (our own pushes).", columns: ["head", "to_head"],
      noTopic: "The commit is stored before its push; the push moves the PR's head (items), which the decision needs.",
    },
    { table: "review_state", class: "item", why: "One PR's review flags: stale mark, reruns of the day, failures at a head." },
    {
      table: "merge_state", class: "item", why: "One PR's mergeable-unknown record.", columns: ["head", "since", "stuck"],
      noTopic: "Written by jobs (job-ends) after the checks rows it follows (checks). It names a wait and a question for a person; no lane works on it.",
    },
    { table: "review_gates", class: "item", why: "The changes-requested gate of one PR." },
    { table: "review_posts", class: "item", why: "Our posted review on one PR." },
    { table: "stages", class: "item", why: "One item's labeled note.", when: "r.stage = 'labeled'" },
    { table: "verifications", class: "item", why: "Verification runs of one PR." },
    {
      table: "workflow_actions", class: "item", why: "A merge that waits for its approver's sign-in or access, and a person's close to carry out.",
      columns: ["repo", "number", "workflow_id", "kind", "state", "head"],
    },
    {
      table: "audit", class: "item", why: "Assign and unassign of an item, whose target names it.",
      when: "r.action IN ('assign', 'unassign') AND instr(r.target, '#') > 1",
      refs: "SELECT substr(r.target, 1, instr(r.target, '#') - 1) AS repo, CAST(substr(r.target, instr(r.target, '#') + 1) AS INTEGER) AS number",
      noTopic: "The row is written before GitHub's call, so the mirrored assignees the decision needs arrive later (items). Operator releases are compared as values (src/runner/autopilot.ts).",
    },

    // ---- cross-item ----
    {
      table: "items", class: "cross", why: "One item's mirror row; a new or deleted item, a PR's state, text or branches, an author, or a change to a member of a duplicate set changes other items' facts.",
      refs: "SELECT r.repo AS repo, r.number AS number",
      full: "r.kind = 'pr'",
      fullUpdate: itemsFullUpdate("0"),
      pg: { fullUpdate: pgExpr(itemsFullUpdate("false")) },
    },
    {
      table: "items", class: "cross", why: "An item's state or text hash: the other item of its unchecked duplicate pairs (pairs to check).",
      updateWhen: changed(["state", "kind", "embed_hash"]),
      refs: `SELECT dp.repo AS repo, dp.b AS number FROM duplicate_pairs dp WHERE dp.repo = r.repo AND dp.a = r.number AND +dp.verdict IS NULL
        UNION SELECT dp.repo, dp.a FROM duplicate_pairs dp WHERE dp.repo = r.repo AND dp.b = r.number AND +dp.verdict IS NULL`,
    },
    {
      // Old and new rows both: the issues the earlier text named and those the new text names. Sync clears text_refs when the text
      // changes (schema trigger items_text_refs_stale) and writes the new references after the row.
      table: "items", class: "cross", why: "A PR's text references and closing links: the issues it closes or mentions (issues' open PR).",
      when: "r.kind = 'pr'",
      updateWhen: changed(["title", "body", "closing_issues", "text_refs"]),
      refs: PR_REFS,
      pg: { refs: PR_REFS_PG, updateWhen: pgExpr(changed(["title", "body", "closing_issues", "text_refs"])) },
    },
    {
      table: "items", class: "cross", why: "An item's state: PRs held for it as a blocking item.",
      updateWhen: changed(["state", "kind"]),
      refs: blockedBy("r.repo", "r.number"),
    },
    {
      table: "opus_reviews", class: "cross", why: "The latest review of one PR; integration PRs carrying it check their members' reviews, and PRs held for it as a blocking item read its verdict.",
      refs: `SELECT r.repo AS repo, r.number AS number UNION ${batchPrsOf("r.repo", "r.number")} UNION ${blockedBy("r.repo", "r.number")}`,
    },
    {
      table: "merge_batches", class: "cross", why: "A batch: its integration PR and every member (batch states, active batch, integration scope and tip).",
      refs: "SELECT r.repo AS repo, r.pr_number AS number UNION SELECT r.repo, bp.number FROM merge_batch_prs bp WHERE bp.batch_id = r.id",
    },
    {
      table: "merge_batch_prs", class: "cross", why: "A batch member: the member PR and the batch's integration PR.",
      refs: "SELECT b.repo AS repo, r.number AS number FROM merge_batches b WHERE b.id = r.batch_id UNION SELECT b.repo, b.pr_number FROM merge_batches b WHERE b.id = r.batch_id",
    },
    {
      table: "duplicate_pairs", class: "cross", why: "A pair: both items (pairs to check); a duplicate edge changes the sets of its whole component.",
      refs: "SELECT r.repo AS repo, r.a AS number UNION SELECT r.repo, r.b",
      full: "r.verdict = 'duplicate'",
    },
    { table: "dupe_comparisons", class: "cross", why: "A compared set: every member of the set, which the row does not name.", full: "1" },
    { table: "dupe_drops", class: "cross", why: "A dropped set: its members are not compared again for a while, and the row does not name them.", full: "1",
      noTopic: "Written by the compare job (job-ends); it only holds a set back, and the pass wakes when that ends." },
    {
      // Refs, not a full pass: the rows a change can move are this issue's, its PR's and, through the repo's live count, the repo's other queued issues.
      table: "implementations", class: "cross", why: "An implementation attempt: its issue, its PR (which it revises), and the repo's other open issues started for implementation (live implementations per repo bound new attempts).",
      refs: `SELECT r.repo AS repo, r.number AS number
        UNION SELECT r.repo, r.pr_number WHERE r.pr_number IS NOT NULL
        UNION SELECT w.repo, w.number FROM item_workflows w JOIN items wi ON wi.repo = w.repo AND wi.number = w.number WHERE w.repo = r.repo AND w.entry = 'implement' AND w.state IN ${WF_LIVE} AND wi.state = 'OPEN' AND wi.kind = 'issue'`,
    },
    {
      table: "implementation_rounds", class: "cross", why: "A round of an implementation: its issue (a question round sets who the attempt waits on and from when) and its PR (a revise round says which head was revised).",
      refs: "SELECT m.repo AS repo, m.number AS number FROM implementations m WHERE m.id = r.implementation_id UNION SELECT m.repo, m.pr_number FROM implementations m WHERE m.id = r.implementation_id AND m.pr_number IS NOT NULL",
    },
    {
      table: "build_tasks", class: "cross", why: "A sandbox task's state: its item, and the fix-up, CI fix or conflict merge whose task it is.",
      columns: ["state", "repo", "number"],
      refs: `SELECT r.repo AS repo, r.number AS number
        UNION SELECT f.repo, f.number FROM fixups f WHERE f.lint_task = r.id
        UNION SELECT c.repo, c.number FROM ci_fixes c WHERE c.lint_task = r.id OR c.task_id = r.id
        UNION SELECT m.repo, m.number FROM conflict_merges m WHERE m.lint_task = r.id`,
    },
    {
      table: "agent_runs", class: "cross", why: "An Opus review run's start: the items it ran for (review counts of the review gate).",
      when: "r.step = 'opus-review'", columns: ["step", "started_at", "job_id"],
      noTopic: "Written with every model call; see agent_run_items.",
      refs: "SELECT ai.repo AS repo, ai.number AS number FROM agent_run_items ai WHERE ai.run_id = r.id",
    },
    {
      table: "author_permissions", class: "cross", why: "An author's write permission on a repo: every open PR of that author there (pushable).",
      refs: "SELECT ap.repo AS repo, ap.number AS number FROM items ap WHERE ap.author = r.login AND ap.repo = r.repo AND ap.kind = 'pr' AND ap.state = 'OPEN'",
    },
    {
      table: "pr_checks", class: "cross", why: "Checks of one PR; a new row or one whose overall state moves to or from none can flip its repo's no-CI fact (reposWithNoCi).",
      refs: "SELECT r.repo AS repo, r.number AS number",
      full: "1", fullUpdate: "(COALESCE(old.overall, 'none') = 'none') IS NOT (COALESCE(new.overall, 'none') = 'none')",
    },
    {
      // Commands move a workflow at human pace; its recommendation and plan parts are not planner facts.
      table: "item_workflows", class: "cross", why: "A maintainer workflow: its item's entry, weight and what the merge rule reads (approval, base and accepted head, blocker), the PR of an issue's implement workflow, PRs held for it as a blocking item (its state says whether a person is asked), and, when it starts or ends, the item's scope (duplicate sets, integration PRs).",
      columns: ["repo", "number", "entry", "state", "weight", "approved_by", "approved_at", "base_head", "accepted_head", "blocker", "started_by", "started_at", "pr_number", "review_asked_at"],
      refs: `SELECT r.repo AS repo, r.number AS number UNION SELECT r.repo, r.pr_number WHERE r.pr_number IS NOT NULL UNION SELECT wi.repo, wi.pr_number FROM implementations wi WHERE wi.repo = r.repo AND wi.number = r.number AND wi.pr_number IS NOT NULL UNION ${blockedBy("r.repo", "r.number")}`,
      full: `r.state IN ${WF_LIVE}`,
      fullUpdate: `(old.state IN ${WF_LIVE}) IS NOT (new.state IN ${WF_LIVE})`,
    },
    { table: "outside_holds", class: "cross", why: "An outside-author hold moves an item's scope, and through it duplicate sets, fix PRs and integration PRs.", full: "1" },
    { table: "postmerge_followups", class: "cross", why: "A follow-up links a merged PR in the pilot list to the fix PR of its issue (scope).", full: "1" },
    {
      table: "security_findings", class: "cross", why: "A finding's quiet fix PR: that PR's scope, labels and own-PR facts, and through scope its duplicate sets.",
      columns: ["repo", "number", "state", "fork", "fix_pr"], full: "1",
    },
    { table: "security_quiet_prs", class: "cross", why: "A former quiet PR of a finding (scope, labels).", full: "1",
      noTopic: "Written in the transaction that clears the finding's fix_pr (security_findings, plan-inputs)." },

    // ---- global ----
    { table: "settings", class: "global", why: "Approvals, pilot list, pipeline switch and login, app slugs, classification run, optional checks and the other switches every item reads.",
      when: `r.key NOT IN (${PLAN_IGNORED_SETTINGS.map((k) => `'${k}'`).join(", ")})${PLAN_IGNORED_SETTING_LIKE.map((l) => ` AND r.key NOT LIKE '${l}' ESCAPE '\\'`).join("")}` },
    {
      table: "classify_state", class: "global", why: "The current classification run: it picks the run every item's labels come from.",
      when: "r.kind = 'current_run'",
    },
    { table: "repo_step_approvals", class: "global", why: "Per-repo step approvals (merge, push, comment, implement, labels, main fix, status comment, CI): every item of the repo reads them." },
    { table: "tracked_repos", class: "global", why: "Tracked repos and their pipeline switch (scope of every item)." },
    { table: "repos", class: "global", why: "Visibility and default branch of a repo (every PR there).", columns: ["name", "visibility", "default_branch", "owner"] },
    { table: "github_app", class: "global", why: "The app's slug: which authors and commenters are us.", columns: ["slug"] },
    { table: "access", class: "global", why: "Operator and maintainer roles: who may answer for a repo, whose comments count." },
    {
      table: "repo_permissions", class: "global", why: "Maintainers' write permission per repo: who may answer there.",
      fullUpdate: permission.sqlite, pg: { fullUpdate: permission.pg },
    },
    { table: "author_ids", class: "global", why: "Author logins bound to account ids: tiers of every PR of the author." },
    { table: "whitelist_overrides", class: "global", why: "Operator tier overrides of an author." },
    { table: "stage_trips", class: "global", why: "Tripped breakers, per stage and repo (a fact of every item of the repo, like main_ci); trips are rare, so a full pass costs little." },
    {
      table: "main_ci", class: "global", why: "Default-branch CI per repo (red main).",
      // Not `checks`: the full list moves with every check of a running head, and only the dashboard reads it.
      columns: ["repo", "head_sha", "branch", "state", "failing", "committed_at", "headline", "first_seen_at", "state_changed_at"],
    },
    { table: "main_fixes", class: "global", why: "Fixes of a red default branch: the repo's main CI state and its own fix PR." },
    {
      table: "own_commits", class: "global", why: "Commits the pipeline pushed: whether a PR's head is its own work, through any push chain.",
      noTopic: "Written at the push, before the patch row that names the head (verify, fixes, queue) and before the mirror holds it (items).",
    },
    {
      table: "owner_statements", class: "global", why: "Owner statements that stored reviews of any PR name as conflicts.",
      noTopic: "Rows are inserted once and only their vectors change; a review that names one is written later (reviews).",
    },

    // ---- read, but not a fact input ----
    { table: "review_blockers", class: "none", why: "Kept from opus_reviews by its own triggers; a review's write logs the items it names." },
    { table: "stage_limits", class: "none", why: "Daily limits of the steps, read with the other control rows; no fact reads them." },
    { table: "change_seq", class: "none", why: "Topic counters: the memo key of the discussion state (src/review/discussion.ts), whose inputs are logged themselves." },
  ];
}
