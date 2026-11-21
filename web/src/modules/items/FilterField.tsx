import { cn } from "../../ui/cn";

/** One labelled native select, as the approved Items toolbar draws it: the name sits inside the
    control, above the value. Props only; the page owns the value and the URL. */
export function FilterField({ label, value, options, onChange, disabled, disabledHint, className }: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Why the field cannot be used now, shown on the disabled select itself. */
  disabledHint?: string;
  className?: string;
}) {
  return <label role="group" aria-label={label} className={cn(
    "relative flex min-w-0 items-stretch rounded-md border border-line-strong bg-raised focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15",
    disabled && "opacity-55",
    className,
  )}>
    <span className="pointer-events-none absolute left-2.5 top-1.5 text-[10px] font-semibold tracking-[.025em] opacity-60">{label}</span>
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      title={disabled ? disabledHint : undefined}
      onChange={(event) => onChange(event.target.value)}
      className="h-[52px] w-full min-w-0 rounded-md bg-transparent px-2.5 pb-0 pt-[14px] text-[12.5px] leading-5 outline-none disabled:cursor-not-allowed"
    >
      {options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
    </select>
  </label>;
}
