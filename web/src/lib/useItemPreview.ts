import { useQuery } from "../api/client";
import type { ItemPageData } from "../api/types";
import { useUser } from "../shell/UserContext";

/** The existing item-page GET, never action components. Inactive snapshots are discarded, not retained per browsed item. */
export function useItemPreview(selection: { repo: string; number: number } | null): { data: ItemPageData | undefined; loading: boolean; error: string | undefined } {
  const user = useUser();
  const key = `item-page:preview:${user.login}:${user.role}:${selection ? `${selection.repo}#${selection.number}` : "none"}`;
  const q = useQuery<ItemPageData | null>(key, async (api) => {
    if (!selection) return null;
    const result = await api.itemPage(selection.repo, selection.number);
    if ("unchanged" in result) throw new Error("The preview returned no item data. Try opening the full task.");
    return result;
  }, { enabled: selection !== null, gcTime: 0 });
  // Placeholder data may belong to another item OR role; neither is safe to expose in this preview.
  const data = selection && !q.loading && q.data?.repo === selection.repo && q.data.number === selection.number ? q.data : undefined;
  return { data, loading: !!selection && !data && !q.error, error: selection ? q.error?.message : undefined };
}
