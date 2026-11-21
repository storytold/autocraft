import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "../cn";

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  size?: "sm" | "md";
}

/** Class string of a native select, for the few places that cannot render `Select`. */
export const selectCls = "h-8 max-w-full rounded border border-line bg-sunken px-2.5 text-sm leading-5 outline-none focus:border-accent/60 disabled:opacity-60 max-md:h-11 max-md:text-[16px]";

/** Native select on the sunken surface; 44 px high on phones. Children are `<option>`s. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ size = "md", className, ...rest }, ref) {
  return <select ref={ref} {...rest} className={cn(selectCls, size === "sm" && "h-7 text-xs", className)} />;
});
