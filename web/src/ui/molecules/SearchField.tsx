import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Input } from "../atoms/Input";

/** Search presentation only; the page owns its query and URL policy. */
export function SearchField({ value, onChange, onSubmit, label, placeholder }: { value: string; onChange: (value: string) => void; onSubmit?: (value: string) => void; label: string; placeholder: string }) {
  return <label className="relative block min-w-0 w-full"><span className="sr-only">{label}</span><MagnifyingGlassIcon aria-hidden className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-ink/40" /><Input type="search" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && onSubmit) { e.preventDefault(); onSubmit(value); } }} placeholder={placeholder} className="w-full pl-9" /></label>;
}
