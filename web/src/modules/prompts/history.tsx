// A base prompt's revisions with rollback, and the notice of a newer release default for an edited prompt.
import { useState } from "react";
import { t } from "../../../../src/i18n/index.ts";
import { useApi, useQuery } from "../../api/client";
import type { PromptInfo } from "../../api/types";
import { Button } from "../../ui/atoms/Button";
import { DisclosureButton } from "../../ui/molecules/DisclosureButton";
import { LineDiff } from "../../ui/molecules/LineDiff";
import { NoteDialog, RevisionList, savedOrThrow } from "./review";

const historyKey = (id: string) => `prompt-history:${id}`;

export function PromptHistory({ p }: { p: PromptInfo }) {
  const api = useApi();
  const { data, error } = useQuery(historyKey(p.id), (a) => a.prompt.history(p.id));
  if (!data) return <p className="py-2 text-sm text-ink/60">{error ? error.message : t("Loading.")}</p>;
  return (
    <RevisionList
      idBase={`prompt-${p.id}`}
      revisions={data.revisions}
      diff={(rev) => ({ key: `prompt-diff:${p.id}:${rev - 1}:${rev}`, load: async () => (await api.prompt.diff(p.id, rev - 1, rev)).diff })}
      rollback={p.edit.mayEdit ? async (rev, note) => savedOrThrow(await api.prompt.rollback(p.id, { rev, note })) : undefined}
    />
  );
}

/** The release default the active edit was made against: the newest revision before it that ran the release's text. */
function useEditBase(p: PromptInfo): number | null {
  const { data } = useQuery(historyKey(p.id), (a) => a.prompt.history(p.id), { enabled: p.edit.newerDefault });
  const active = p.edit.rev;
  return data?.revisions.find((r) => active !== null && r.rev < active && (r.kind === "release" || r.kind === "use-release"))?.rev ?? null;
}

export function ReleaseNotice({ p }: { p: PromptInfo }) {
  const api = useApi();
  const from = useEditBase(p);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const diff = useQuery(`prompt-diff:${p.id}:${from}:release`, async (a) => (await a.prompt.diff(p.id, from!, "release")).diff, { enabled: open && from !== null });
  const e = p.edit;
  if (!e || !(e.newerDefault || e.structureChanged)) return null;
  const region = `prompt-${p.id}-release-diff`;
  return (
    <section aria-label={t("Release")} className="mb-3 rounded-md border border-warn/40 bg-warn/5 px-3 py-2">
      <p className="text-sm font-medium">
        {e.structureChanged ? t("This release changed the locked parts; your edit is not in use until you re-apply it.") : t("The release has a newer default")}
      </p>
      {from !== null && (
        <>
          <DisclosureButton open={open} onToggle={setOpen} controls={region} className="min-h-9 px-0 max-md:min-h-11">{t("Changes in the release")}</DisclosureButton>
          {open && <div id={region} className="pb-2">{diff.data ? <LineDiff lines={diff.data} label={t("Changes in the release")} /> : <p className="text-xs text-ink/60">{diff.error ? diff.error.message : t("Loading.")}</p>}</div>}
        </>
      )}
      {e.mayEdit && (
        <div className="flex justify-end pb-1">
          <Button onClick={() => setSwitching(true)} className="max-md:h-11">{t("Use the release version")}</Button>
        </div>
      )}
      {switching && <NoteDialog title={t("Use the release version")} action={t("Use the release version")} onClose={() => setSwitching(false)} onConfirm={async (note) => savedOrThrow(await api.prompt.useRelease(p.id, { note }))} />}
    </section>
  );
}
