import { useQuery } from "../../api/client";
import { useNavProject, usePageProject } from "../../api/scope";
import type { NeedsPage } from "../../api/types";
import { useUser } from "../../shell/UserContext";

/** A summary receipt is specific to both its reader and the effective project. */
function useProjectSummary(project: string | null) {
  const user = useUser();
  const scope = JSON.stringify([user.login, user.role, project]);
  const query = useQuery(`needs:summary:${scope}`, async (api): Promise<{ scope: string; page: NeedsPage }> => ({ scope, page: await api.needs({}) }), { project, gcTime: 0 });
  const receipt = !query.error && query.data?.scope === scope ? query.data.page : undefined;
  return { ...query, data: receipt, loading: query.loading || (!receipt && !query.error) };
}

/** Page tabs and stopped rows follow the copied list URL, not a different saved pick. */
export function useSummary() {
  return useProjectSummary(usePageProject());
}

/** The badge counts the project its navigation link opens, including on an unscoped page. */
export function useNavSummary() {
  return useProjectSummary(useNavProject());
}
