import { useMemo, useState } from "react";
import { Input } from "../atoms/Input";
import { FilterOption } from "./FilterOption";
import { FilterSection } from "./FilterSection";

/** A repository facet; options and selections are supplied by its owner, not fetched here. */
export function RepoFilter({ options, value, onChange, loading }: { options: string[]; value: string[]; onChange: (repos: string[]) => void; loading?: boolean }) {
  const [query, setQuery] = useState("");
  const repos = useMemo(() => [...new Set([...value, ...options])].filter((r) => r.toLowerCase().includes(query.trim().toLowerCase())), [options, value, query]);
  return <FilterSection title="Repositories">
    <FilterOption active={value.length === 0} onClick={() => onChange([])}>All repositories</FilterOption>
    <Input aria-label="Find repositories" placeholder="Find a repository" value={query} onChange={(e) => setQuery(e.target.value)} className="w-full" />
    <div className="max-h-52 space-y-0.5 overflow-y-auto overscroll-contain">
      {repos.map((repo) => <label key={repo} className="flex min-h-9 cursor-pointer items-start gap-2.5 rounded px-2.5 py-2 text-sm hover:bg-ink/[0.04] max-md:min-h-11"><input type="checkbox" checked={value.includes(repo)} onChange={(e) => onChange(e.target.checked ? [...value, repo] : value.filter((r) => r !== repo))} className="mt-0.5 size-4 shrink-0 accent-accent" /><span className="code min-w-0 break-words text-xs leading-5 [overflow-wrap:anywhere]">{repo}</span></label>)}
      {!repos.length && <p className="px-2.5 py-2 text-xs text-ink/50">{loading ? "Loading repositories…" : "No matching repository."}</p>}
    </div>
  </FilterSection>;
}
