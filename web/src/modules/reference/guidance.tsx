// A repo's review guidance on its project page: the text, the prompts it is added to, its revisions and, for whoever runs
// the repo, the edit (check, diff, note) and rollback.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PencilSimpleIcon } from "@phosphor-icons/react";
import { t } from "../../../../src/i18n/index.ts";
import { useApi, useQuery } from "../../api/client";
import type { PromptCheckReply, RepoGuidance } from "../../api/types";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Textarea } from "../../ui/atoms/Textarea";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { DisclosurePanel } from "../../ui/molecules/DisclosurePanel";
import { Markdown } from "../../ui/molecules/Markdown";
import { Section } from "../../ui/molecules/Section";
import { useWrite } from "../../lib/hooks";
import { RevisionList, ReviewStep, isConflict, savedOrThrow } from "../prompts/review";

/** The server's limit (src/prompts/checks.ts GUIDANCE_MAX). */
const GUIDANCE_MAX = 4000;

export function RepoGuidanceSection({ repo }: { repo: string }) {
  const api = useApi();
  const { data, error } = useQuery(`guidance:${repo}`, (a) => a.guidance.get(repo));
  const [editing, setEditing] = useState(false);
  const shown = data?.repo === repo ? data : undefined;
  // A link to the repo page's #guidance lands here once the section has its content.
  useEffect(() => {
    if (shown && window.location.hash === "#guidance") document.getElementById("guidance")?.scrollIntoView();
  }, [shown]);
  return (
    <Section id="guidance" title={t("Review guidance")} className="scroll-mt-4 border-t border-line pt-3">
      {!shown ? (
        error ? <ErrorLine error={error.message} /> : <p role="status" className="text-sm text-ink/50">{t("Loading.")}</p>
      ) : editing ? (
        <GuidanceEditor g={shown} onClose={() => setEditing(false)} />
      ) : (
        <div className="flex flex-col gap-3">
          {shown.text.trim() ? <Markdown source={shown.text} className="text-sm" /> : <p className="text-sm text-ink/60">{t("No guidance.")}</p>}
          {shown.rev !== null && (
            <p className="text-xs text-ink/60">r{shown.rev}{shown.author ? ` · ${shown.author}` : ""}{shown.at ? <> · <TimeAgo iso={shown.at} /></> : null}</p>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="text-ink/60">{t("Added to")}</span>
            {shown.prompts.map((id) => (
              <Link key={id} to={`/prompts#${encodeURIComponent(id)}`} className="inline-flex items-center rounded font-mono text-accent-ink hover:underline max-md:min-h-11">{id}</Link>
            ))}
          </div>
          {shown.mayEdit && (
            <div>
              <Button icon={PencilSimpleIcon} onClick={() => setEditing(true)} className="max-md:h-11">{t("Edit")}</Button>
            </div>
          )}
          {shown.history.length > 0 && (
            <DisclosurePanel title={t("History")} summary={t("{count} revisions", { count: shown.history.length })}>
              <div className="px-4 pb-2">
                <RevisionList idBase={`guidance-${repo}`} revisions={shown.history}
                  rollback={shown.mayEdit ? async (rev, note) => savedOrThrow(await api.guidance.rollback(repo, { rev, note })) : undefined} />
              </div>
            </DisclosurePanel>
          )}
        </div>
      )}
    </Section>
  );
}

function GuidanceEditor({ g, onClose }: { g: RepoGuidance; onClose: () => void }) {
  const api = useApi();
  const write = useWrite();
  const [text, setText] = useState(g.text);
  const [baseRev, setBaseRev] = useState(g.rev);
  const [reply, setReply] = useState<PromptCheckReply | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const review = () => void write.run("check", async () => {
    setNotice(null);
    setReply(await api.guidance.check(g.repo, { body: text, note: "", baseRev }));
  });
  const save = (note: string) => void write.run("save", async () => {
    try {
      const r = await api.guidance.save(g.repo, { body: text, note, baseRev });
      if (!r.ok) {
        setReply((old) => ({ ok: false, problems: r.problems, diff: old?.diff ?? [], version: null }));
        return;
      }
      onClose();
    } catch (e) {
      if (!isConflict(e)) throw e;
      const fresh = await api.guidance.get(g.repo);
      setBaseRev(fresh.rev);
      setReply(null);
      setNotice(t("Someone saved r{rev} meanwhile. Review your changes against it.", { rev: fresh.rev ?? "" }));
    }
  });
  if (reply) return <ReviewStep reply={reply} onBack={() => setReply(null)} onSave={save} busy={write.busy === "save"} error={write.error} />;
  return (
    <div className="flex flex-col gap-2">
      {notice && <p role="alert" className="rounded border border-warn/40 bg-warn/10 px-3 py-2 text-sm">{notice}</p>}
      <label className="flex flex-col gap-1 text-xs text-ink/60">
        <span className="flex items-baseline justify-between gap-2">
          <span>{t("Guidance (Markdown)")}</span>
          <span className="num">{text.length} / {GUIDANCE_MAX}</span>
        </span>
        <Textarea autoFocus value={text} maxLength={GUIDANCE_MAX} rows={8} onChange={(e) => setText(e.target.value)} className="resize-y [field-sizing:content]" />
      </label>
      <ErrorLine error={write.error} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose} className="max-md:h-11">{t("Cancel")}</Button>
        <Button variant="primary" disabled={text.trim() === g.text.trim()} loading={write.busy === "check"} onClick={review} className="max-md:h-11">{t("Review changes")}</Button>
      </div>
    </div>
  );
}
