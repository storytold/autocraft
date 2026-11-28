// Reference pages of the new dashboard: Prompts, Environments and Scans (Repos is in repos.tsx). Each page opens with a short
// list; detail sits in folds.
import { useState } from "react";
import { Link } from "react-router-dom";
import { t } from "../../../../src/i18n/index.ts";
import { useApi, useQuery } from "../../api/client";
import type { ScanView } from "../../api/types";
import { SCAN_STATE, scanActive } from "../../lib/security";
import { scanPath } from "../../lib/links";
import { formatCost } from "../../lib/trace";
import type { ViewProps } from "../../registry/types";
import { Badge } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Select } from "../../ui/atoms/Select";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { useUser } from "../../shell/UserContext";
import { CommentCard, PromptCard } from "../prompts/views";
import { EnvsPanel, PhoneEnvs, Tasks } from "../envs/views";
import { Caches } from "../envs/Caches";
import { WorkspacesList } from "../workspaces/views";
import { Fold, LinkRow, List, Loading, RefPage } from "./parts";

const STAGE_ORDER = ["classify", "priority", "duplicates", "decide", "review", "fix", "integrate", "verify"];
const stageRank = (s: string) => {
  const i = STAGE_ORDER.findIndex((x) => s.toLowerCase().includes(x));
  return i < 0 ? STAGE_ORDER.length : i;
};

export function PromptsView(_: ViewProps) {
  const { data: r, error } = useQuery("prompts", (api) => api.prompts());
  if (!r) return <RefPage title={t("Prompts")}><Loading error={error} /></RefPage>;
  const stages = [...new Set(r.prompts.map((p) => p.stage))].map((s, i) => ({ s, i })).sort((x, y) => stageRank(x.s) - stageRank(y.s) || x.i - y.i).map((x) => x.s);
  // A link to /prompts#<id> opens that prompt's stage; the card opens itself.
  const target = decodeURIComponent(location.hash.slice(1));
  return (
    <RefPage title={t("Prompts")}>
      <p className="text-sm text-ink/70">{t("Every prompt the pipeline sends to a model, as it is sent. Item text is quoted into prompts as untrusted data.")}</p>
      <div className="flex flex-col gap-1">
        {stages.map((s) => {
          const list = r.prompts.filter((p) => p.stage === s);
          return (
            <Fold key={s} title={<span className="font-medium">{s}</span>} summary={list.length} open={list.some((p) => p.id === target)}>
              <div className="space-y-3 py-2">{list.map((p) => <PromptCard key={p.id} p={p} fold />)}</div>
            </Fold>
          );
        })}
        {r.comments.length > 0 && (
          <Fold title={<span className="font-medium">{t("Comments posted on GitHub")}</span>} summary={r.comments.length}>
            <div className="space-y-3 py-2">{r.comments.map((c) => <CommentCard key={c.id} c={c} />)}</div>
          </Fold>
        )}
        <GuidanceFold />
      </div>
    </RefPage>
  );
}

/** The repos that add guidance to their review and fix prompts; each links to its repo page. */
function GuidanceFold() {
  const { data } = useQuery("prompt-guidance", (a) => a.guidance.list());
  if (!data?.length) return null;
  return (
    <Fold title={<span className="font-medium">{t("Repo guidance")}</span>} summary={data.length}>
      <div className="py-2">
        <List>
          {data.map((g) => (
            <LinkRow key={g.repo} to={`/repos/${encodeURIComponent(g.repo)}#guidance`} title={g.repo}
              line={<>r{g.rev}{g.author ? ` · ${g.author}` : ""}{g.at ? <> · <TimeAgo iso={g.at} /></> : null}</>} />
          ))}
        </List>
      </div>
    </Fold>
  );
}

export function EnvironmentsView(props: ViewProps) {
  const q = useQuery("envs", (a) => a.envs.list(), { pollMs: 30_000 });
  if (props.params.id) return <PhoneEnvs {...props} />;
  return (
    <RefPage title={t("Environments")}>
      <ErrorLine error={q.error?.message} />
      {!q.data ? (
        <Loading />
      ) : (
        <List>
          {q.data.map((e) => (
            <li key={e.id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-md font-medium">{e.label}</span>
                <span className="block text-sm text-ink/70">{t("{running} of {slots} in use", { running: e.running, slots: e.slots })}</span>
              </span>
              {!e.enabled ? <Badge>{t("Disabled")}</Badge> : e.pausedReason ? <Badge tone="warn">{t("Paused")}</Badge> : e.online ? <Badge tone="ok">{t("Online")}</Badge> : <Badge tone="bad">{t("Offline")}</Badge>}
            </li>
          ))}
        </List>
      )}
      <div className="flex flex-col gap-1">
        <Fold title={<span className="font-medium">{t("Details and settings")}</span>}>
          <div className="py-2"><EnvsPanel /></div>
        </Fold>
        <Fold title={<span className="font-medium">{t("Workspaces")}</span>}>
          <div className="py-2"><WorkspacesList /></div>
        </Fold>
        <Fold title={<span className="font-medium">{t("Caches")}</span>}>
          <div className="py-2"><Caches /></div>
        </Fold>
        <Fold title={<span className="font-medium">{t("Recent tasks")}</span>}>
          <div className="py-2"><Tasks /></div>
        </Fold>
      </div>
    </RefPage>
  );
}

const usd = (v: number | null) => formatCost(v) ?? "–";

function StartScan({ onStarted }: { onStarted: () => void }) {
  const api = useApi();
  const operator = useUser().role === "operator";
  const repos = useQuery("maintain-repos", (a) => a.maintain.repos());
  const mine = (repos.data ?? []).filter((r) => r.canRun);
  const [repo, setRepo] = useState("");
  const [cap, setCap] = useState("20");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!mine.length) return null;
  const chosen = repo || mine[0]!.name;
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.security.startScan(chosen, cap === "none" ? null : Number(cap));
      onStarted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label={t("Start a scan")} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          {t("Repo")}
          <Select value={chosen} onChange={(e) => setRepo(e.target.value)}>
            {mine.map((r) => <option key={r.name}>{r.name}</option>)}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t("Spend cap")}
          <Select value={cap} onChange={(e) => setCap(e.target.value)}>
            {["5", "20", "50"].map((c) => <option key={c} value={c}>${c}</option>)}
            {operator && <option value="none">{t("No cap")}</option>}
          </Select>
        </label>
        <Button variant="primary" className="h-11" loading={busy} onClick={() => void start()}>{t("Start scan")}</Button>
      </div>
      <ErrorLine error={error} />
    </section>
  );
}

function ScanRow({ s, onChange }: { s: ScanView; onChange: () => void }) {
  const api = useApi();
  const st = SCAN_STATE[s.state];
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <Link to={scanPath(s.id)} className="min-w-0 flex-1 rounded hover:bg-ink/[0.03]">
        <span className="flex flex-wrap items-center gap-2">
          <span className="code text-md font-medium">{s.repo}</span>
          <Badge tone={st.tone}>{st.label}</Badge>
        </span>
        <span className="block text-sm text-ink/70">
          {t("cap {cap}, spent {spent}", { cap: s.capUsd === null ? t("none") : usd(s.capUsd), spent: usd(s.costUsd) })} · {t("{n} findings", { n: s.findingCount })} · {s.startedBy} · <TimeAgo iso={s.startedAt} />
        </span>
      </Link>
      {scanActive(s.state) && s.canAct && (
        <Button className="h-11" onClick={() => void api.security.stopScan(s.id).then(onChange)}>{t("Stop")}</Button>
      )}
    </li>
  );
}

export function ScansView(_: ViewProps) {
  const q = useQuery("security:scans:all", (a) => a.security.scans());
  return (
    <RefPage title={t("Scans")}>
      <StartScan onStarted={q.refetch} />
      <ErrorLine error={q.error?.message} />
      {!q.data ? <Loading /> : q.data.length ? <List>{q.data.map((s) => <ScanRow key={s.id} s={s} onChange={q.refetch} />)}</List> : <p className="text-sm text-ink/70">{t("No scans yet.")}</p>}
    </RefPage>
  );
}
