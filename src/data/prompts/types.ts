// The stored revisions of model prompts and repository guidance (table prompt_revisions).

export type PromptRevisionKind = "release" | "edit" | "rollback" | "use-release";

export type PromptRevision = {
  id: number;
  promptId: string;
  /** "base" for an instance-wide prompt; a repo name for that repo's guidance. */
  scope: string;
  rev: number;
  kind: PromptRevisionKind;
  /** Claude: the template text with lock markers; Jev: JSON {questions: {key: {instructions, criteria?}}}; guidance: markdown ("" = none). */
  body: string;
  /** The hash of the text that runs: what a call records as its prompt_version. */
  version: string;
  /** The version of the code default the revision was made against. */
  defaultHash: string | null;
  /** The release default: the running code's own text runs. */
  follows: boolean;
  fromRev: number | null;
  active: boolean;
  author: string;
  at: string;
  note: string;
};
