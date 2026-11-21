import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../cn";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: "sm" | "md";
  invalid?: boolean;
}

/** Text input on the sunken surface; 44 px high on phones. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ size = "md", invalid, className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      {...rest}
      className={cn(
        // 16 px on phones: below that iOS zooms the page when an editable field takes focus.
        "min-w-0 rounded border bg-sunken text-sm leading-5 outline-none placeholder:text-ink/40 focus:border-accent/60 disabled:opacity-60 max-md:h-11 max-md:text-[16px]",
        size === "sm" ? "h-7 px-2 text-xs" : "h-8 px-2.5",
        invalid ? "border-bad/60" : "border-line",
        className,
      )}
    />
  );
});
