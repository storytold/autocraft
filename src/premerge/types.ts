// Kept free of Node imports: the prompt registry and the web build read it.

/** What makes a defect stop the merge of a PR a maintainer approved: it breaks behaviour that works on the base branch or the build or tests, a security problem, data loss, or the PR not doing what its title and description say. */
export const BLOCKING_CLASSES = ["regression", "security", "data-loss", "off-purpose"] as const;
export type BlockingClass = (typeof BLOCKING_CLASSES)[number];
/** `class` null: the defect does not stop an approved merge; `why` says why it does or does not, in one sentence. */
export type Blocking = { class: BlockingClass | null; why: string };
/** Characters of a blocking reason that are kept. */
export const BLOCKING_WHY_CHARS = 300;

/** A reply's blocking field: a class or null with its reason, or undefined when the field is missing or not valid (which counts as blocking). */
export function blockingOf(v: unknown): Blocking | undefined {
  if (!v || typeof v !== "object") return undefined;
  const b = v as { class?: unknown; why?: unknown };
  if (b.class !== null && (typeof b.class !== "string" || !(BLOCKING_CLASSES as readonly string[]).includes(b.class))) return undefined;
  return { class: b.class as BlockingClass | null, why: typeof b.why === "string" ? b.why.replace(/\s+/g, " ").trim().slice(0, BLOCKING_WHY_CHARS) : "" };
}

/** True when a classed entry does not stop an approved merge: its class is null. A missing class blocks. */
export const notBlocking = (x: { blocking?: Blocking | null }): boolean => !!x.blocking && x.blocking.class === null;

export type PremergeFinding = {
  severity: "defect" | "minor";
  file: string;
  line: number;
  title: string;
  scenario: string;
  fix?: { file: string; change: string };
  /** The blocking class the review gave a defect (null: not blocking), with one sentence why. Absent on rows stored before the review classed defects, and on a defect the reply gave no valid class: those count as blocking. */
  blocking?: Blocking;
};

/** The file of a finding that names none (a claim of the description): no fix-up can apply it. */
export const NO_FILE = "(description)";

/** What the fix-up is told to change for a defect: the review's own fix, or, when it wrote none, the defect itself (title and scenario) in its file. */
export const defectFix = (d: PremergeFinding): { file: string; change: string } => d.fix ?? { file: d.file, change: `${d.title}: ${d.scenario}` };

/**
 * The defects that stop the merge. On a PR a maintainer approved for merge (`approved`) only the blocking ones do: the approval and green CI
 * merge it past the rest, which are filed as follow-ups. Elsewhere every defect stops it. A defect a person dropped from the workflow's plan
 * (`dropped`: lower-case titles) stops nothing: they overruled it.
 */
export const stoppingDefects = (fs: readonly PremergeFinding[], approved: boolean, dropped: readonly string[] = []): PremergeFinding[] =>
  fs.filter((f) => f.severity === "defect" && (!approved || f.blocking?.class !== null) && !dropped.includes(f.title.toLowerCase()));

/** The defects of a PR approved for merge that do not stop it: they are filed as follow-ups. */
export const followUpDefects = (fs: readonly PremergeFinding[]): PremergeFinding[] => fs.filter((f) => f.severity === "defect" && f.blocking?.class === null);
