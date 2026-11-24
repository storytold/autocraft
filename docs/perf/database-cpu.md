# Database CPU: findings and fixes

Production Postgres ran at 100% CPU on 2026-11-22. This file records what used the CPU and the fixes. Times are UTC. Figures come from the database's query insights (per query pattern) and from `pg_stat_activity`, `pg_stat_user_tables` and plain `EXPLAIN` (no `ANALYZE`). The database has no `pg_stat_statements`.

## Summary

One query uses almost all of the CPU: the count of unchecked duplicate pairs per item (`uncheckedPairCounts`, `src/dupes/check.ts:43`). In the last hour it took 89% of database CPU. Each run reads about 151 million rows and takes 100 to 115 seconds. It runs whenever the item facts load, including partial reloads and single-item guard checks, so runs follow each other back to back and often overlap.

The cause is a bad join plan inside the `live` CTE (`src/dupes/check.ts:26`). Postgres estimates one row after joining `items` on `embed_hash = b_hash`, so it joins the second `items` copy through `items_state` on `repo` alone and filters number and hash per row. That scans every item of the repo once per pair: about 22,800 unchecked pairs times the repo's item count.

## Timeline

| Window | Runs | CPU seconds | Mean per run |
|---|---|---|---|
| 09:05 to 15:05 | 1,204 | 329 | 0.3 s |
| 15:05 to 18:05 | 403 | 5,140 | 12.7 s |
| 18:05 to 21:05 | 158 | 11,874 | 78 s (recent runs 100 to 115 s) |

The slowdown began between 15:00 and 18:00, before the evening deploys (19:38 dashboard/runner split, about 20:20 and 21:30 image updates). No change to this query landed today after 06:42. The timing fits a plan change after new table statistics: `items` was last auto-analyzed at 18:25, and the pair and item counts keep growing. The evening deploys did not cause it.

## Top queries, last hour

| # | Pattern (normalised) | Calls | CPU s | Share of CPU | Mean | Rows read per call | Code | Called from |
|---|---|---|---|---|---|---|---|---|
| 1 | `WITH u AS (WITH live AS MATERIALIZED (SELECT … FROM duplicate_pairs p JOIN items ia ON (repo, a, a_hash) JOIN items ib ON (repo, b, b_hash) WHERE verdict IS NULL AND (ia.state = ? OR ib.state = ?) AND repo IN (…)) SELECT … FROM live WHERE <scope filter on a> OR <scope filter on b>) SELECT repo, number, count(*) FROM (u.a UNION ALL u.b) GROUP BY …` | 54 | 4,115 | 89% | 79 s | 112 M | `src/dupes/check.ts:26`, `:43` | `loadItemFacts` (`src/core/issue-facts.ts:151`): every planner pass, full and partial (`src/core/plan-engine.ts:158`, `:170`); `loadItemFact` in the write guard (`src/core/guard.ts:129`); `plannedItems` (`src/core/select-items.ts:63`) |
| 2 | `SELECT c.repo, c.number, coalesce(max(c.created_at), ?), coalesce(max(CASE WHEN c.author_association IN (…) OR EXISTS (SELECT … FROM access …) …)) FROM comments c … GROUP BY …` (several variants) | 534 | 118 | 2.7% | 0.06 to 0.75 s | 20 K to 260 K | `src/review/discussion.ts:308`, `:324` | `discussionState`, from the planner |
| 3 | `SELECT i.repo, i.number, i.kind, i.state, … coalesce((SELECT max(? + fq.weight * ? …) FROM fast_track fq …)) FROM items i JOIN tracked_repos t …` | 37 | 40 | 0.9% | 1.1 s | 979 K | `src/core/issue-facts.ts:59`, score from `src/fasttrack.ts:118` | `loadItemFacts` |
| 4 | `SELECT id, repo, number, kind, author, created_at, body, … FROM comments WHERE repo IN (…) AND (review_state IS NULL OR review_state <> ?) AND id > ? ORDER BY id LIMIT ?` | 1,638 | 39 | 0.9% | 33 ms | 2 K | `src/itemtools/snapshot.ts:245` | workspace snapshot copy, paged by id |
| 5 | `SELECT c.repo, c.number, c.classifier, c.at, c.type_label, c.flags, CASE … probs …, c.input_hash FROM classifications c WHERE …` | 31 | 28 | 0.6% | 0.9 s | 26 K | `src/core/issue-facts.ts:194` | `loadItemFacts` |
| 6 | `SELECT DISTINCT repo, base_ref FROM items WHERE kind = ? AND base_ref IS NOT NULL` | 442 | 26 | 0.6% | 75 ms | 85 K (full scan) | `src/fixup/pushable.ts:39` | fix-up push targets |

Over 24 hours query 1 is 58% of CPU (2,072 runs, mean 8.7 s); the rest of the list matches the hour above.

Table scan counters agree. Since the last stats reset, `items` had 46,638 sequential scans reading 2.5 billion rows. `fast_track` (13 rows) and `tracked_repos` (25 rows) had 114 million and 35 million sequential scans. Those are the per-pair `EXISTS` checks in query 1's scope filter. They are cheap one at a time, but they run for every pair.

## Plans for query 1's `live` join

Current shape (plain `EXPLAIN`):

```
Nested Loop  (rows=1)
  -> Nested Loop  (rows=1)
       -> Seq Scan on duplicate_pairs p  (rows=22786)  Filter: verdict IS NULL
       -> Memoize -> Index Scan using items_pkey on items ib   Filter: p.b_hash = embed_hash
  -> Index Scan using items_state on items ia   Index Cond: repo = ib.repo   (rows=980 per pair, filtered on number and hash)
```

The same join written with one `LATERAL (… OFFSET 0)` lookup per side uses `items_embed (repo, number, embed_hash)` for both items. It estimates 13,724 rows, which is close to the real count, and costs one index probe per pair per side:

```sql
FROM duplicate_pairs p
CROSS JOIN LATERAL (SELECT i.state FROM items i WHERE i.repo = p.repo AND i.number = p.a AND i.embed_hash = p.a_hash OFFSET 0) ia
CROSS JOIN LATERAL (SELECT i.state FROM items i WHERE i.repo = p.repo AND i.number = p.b AND i.embed_hash = p.b_hash OFFSET 0) ib
WHERE p.verdict IS NULL AND (ia.state = 'OPEN' OR ib.state = 'OPEN') AND p.repo IN (SELECT name FROM tracked_repos)
```

```
Nested Loop  (rows=13724)
  -> Nested Loop  Join Filter: i.state = 'OPEN' OR i_1.state = 'OPEN'
       -> Nested Loop
            -> Seq Scan on duplicate_pairs p  (rows=22786)
            -> Memoize -> Index Scan using items_embed on items i    Index Cond: repo, number, embed_hash
       -> Memoize -> Index Scan using items_embed on items i_1  Index Cond: repo, number, embed_hash
  -> Memoize -> Index Only Scan using tracked_repos_pkey
```

## Fixes, ranked by CPU saved

| # | Fix | Saves | Where |
|---|---|---|---|
| 1 | Rewrite the `live` join so each item is a parameterised lookup by `(repo, number, embed_hash)`, for example `LATERAL … OFFSET 0` as above, on both databases | about 89% of current CPU; each run should drop from about 100 s to well under a second | `src/dupes/check.ts:26` |
| 2 | Scope `uncheckedPairCounts` to the refs being loaded: a partial reload or `loadItemFact` needs the counts of a few items, not of every pair. Or reuse the counts from the last full load and refresh them only when `duplicate_pairs` or the items' hashes change | most remaining runs of query 1: the guard and partial reloads stop running the full count | `src/core/issue-facts.ts:151`, `src/core/guard.ts:129`, `src/core/plan-engine.ts:170` |
| 3 | Apply the pair scope filter (`pilotExprFor`) once per item, not once per pair side: compute the in-scope item set once and join it | the 114 M `fast_track` and 35 M `tracked_repos` scans | `src/dupes/check.ts:35` |
| 4 | Scope the discussion aggregates to the refs being loaded, or keep them in the planner state between passes | about 2.7% | `src/review/discussion.ts:308`, `:324` |
| 5 | Cache the repo/base_ref list per pass, or add a partial index on `items (repo, base_ref) WHERE kind = 'pr' AND base_ref IS NOT NULL` | about 0.6% | `src/fixup/pushable.ts:39` |
| 6 | Profile the item facts row query (979 K rows read per call) once fix 1 is in, since it is the next largest | about 1% | `src/core/issue-facts.ts:59` |

## Immediate mitigation

No setting turns this query off: it runs inside every item facts load, and the pipeline switch does not stop the planner. Options, none applied:

- Deploy fix 1. This is the only mitigation known to work.
- `ANALYZE items` (and `duplicate_pairs`) might move the plan back to its morning shape, but the one-row estimate is structural, so it may not help or may not last. It is a maintenance command on production and needs approval.

While the query is slow, every planner pass and every guarded GitHub write waits about 100 s for it, so the pipeline runs slowly even when the database has room.

## Follow-up: attribution

Queries carry no SQL comment tags, so the insights cannot split load by loop. A bounded tag per caller (planner pass, runner step, dashboard topic, launcher pass, guard) would show which loop runs a pattern without a code search.

## After fix 1

Fixes 1 and 2 shipped together: each item is a correlated key lookup in the `live` CTE, and partial loads count pairs only for the items being loaded. New pods started at 21:21. The numbers below cover 21:21 to 21:32.

| Query | Calls | Mean | Rows read per call | CPU s |
|---|---|---|---|---|
| Pair counts, before (last hour up to 21:21) | 43 | 71 s | 102 M | 2,965 |
| Pair counts, full load (new pattern) | 34 | 0.27 s | 198 K | 8.9 |
| Pair counts, scoped to loaded refs (new pattern) | 162 | 17 ms | 6 K | 2.3 |

The old pattern last ran at 20:58 plus a few in-flight runs ending 21:20, and has not run since the deploy. Total query CPU fell from about 4,500 CPU seconds per hour, about 1.25 cores busy, to about 0.15 cores. Samples of `pg_stat_activity` after the deploy show no long-running client queries.

The CPU now goes to the patterns that were second to sixth before. Each is under 2% of the last hour:

| # | Pattern | Mean | Rows read per call | Code |
|---|---|---|---|---|
| 1 | Discussion aggregates over `comments` | 0.77 s | 261 K | `src/review/discussion.ts:308`, `:324` |
| 2 | Item facts rows | 1.1 s | 980 K | `src/core/issue-facts.ts:59` |
| 3 | Classifications load | 0.88 s | 26 K | `src/core/issue-facts.ts:194` |
| 4 | Workspace snapshot comment paging | 29 ms (1,773 calls) | 2 K | `src/itemtools/snapshot.ts:245` |
| 5 | PR facts rows | 0.52 s | 491 K | PR facts loader |

Fixes 3 to 7 remain open and are no longer urgent.
