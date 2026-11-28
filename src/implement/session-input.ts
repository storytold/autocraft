// What the implement.session prompt is rendered from, and the limits of a session. No Node imports: the prompts module,
// which the web mockup imports, reads it.

/** The MCP server of the workspace tools (WORKSPACE_SERVER in src/build/workspace-tools.ts; session.ts checks they match). */
export const SESSION_SERVER = "work";

/** The session call's limits. Tool calls, shell time and screenshots are counted by the workspace tools (SESSION_LIMITS, SESSION_IMAGES). */
export const SESSION_CALL = { timeoutSeconds: 3 * 3600, maxTurns: 1000 } as const;
/** A follow-up turn's time limit: the findings of AutoCraft's checks, or a reply that was not the report. */
export const FOLLOW_UP_CALL = { timeoutSeconds: 90 * 60, maxTurns: 400 } as const;
/** Screenshots of one report AutoCraft copies out. */
export const REPORT_SHOTS_MAX = 20;
export const REPORT_TEXT_MAX = 4000;
export const REPORT_LIST_MAX = 100;

/** A finding of AutoCraft's own checks as the session reads it. */
export type SessionFinding = { check: "fmt" | "clippy" | "test"; file: string; line: number; message: string; rendered: string };

export type SessionInput = {
  ref: string;
  repo: string;
  /** The commit the workspace was seeded at. */
  sha: string;
  /** Written by outsiders. */
  issue: { title: string; body: string; author: string | null };
  plan: { kind: string; summary: string; plan: string; acceptance: string[]; tests: string[]; app: string | null; risks: string[];
    /** The plan's numbered parts a maintainer did not drop, with the numbers they have in the question; absent when the plan names none. */
    parts?: { n: number; title: string; files: string[] }[] };
  /** Operators' and write maintainers' guidance: a Try again note, thread posts the plan was given. */
  guidance: string[];
  /** A session that starts over on an earlier one's changes (its session was lost): what is in the tree and what the checks found. */
  earlier?: { diff_stat: string; findings: SessionFinding[] };
  /** The workspace's environment has a crate mirror, so the session may call fetch_dependencies. Picks the system prompt; not part of the task. */
  fetch_dependencies?: boolean;
};

export const SAMPLE_SESSION: SessionInput[] = [{
  ref: "deckcraft#42",
  repo: "deckcraft",
  sha: "0123456789abcdef0123456789abcdef01234567",
  issue: { title: "Slide numbers restart after a section break", body: "Insert a section break on slide 4: slide 5 shows number 1.", author: "someone" },
  plan: {
    kind: "bugfix", summary: "Number slides across section breaks.",
    plan: "1. Reproduce with a deck of six slides and a break after slide 4.\n2. Number from the deck's start in `numbering.rs`.\n3. Add a regression test.",
    acceptance: ["Slide 5 shows number 5 after a section break on slide 4."], tests: ["cargo test -p deck-model numbering"], app: null, risks: [],
  },
  guidance: [],
}];
