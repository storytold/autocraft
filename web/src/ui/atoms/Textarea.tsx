import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "../cn";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

/** Multi-line input on the sunken surface. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ invalid, className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      {...rest}
      className={cn(
        // 16 px on phones: below that iOS zooms the page when an editable field takes focus.
        "w-full min-w-0 rounded border bg-sunken px-2.5 py-1.5 text-sm leading-5 outline-none placeholder:text-ink/40 focus:border-accent/60 disabled:opacity-60 max-md:text-[16px]",
        invalid ? "border-bad/60" : "border-line",
        className,
      )}
    />
  );
});
