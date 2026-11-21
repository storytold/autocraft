import { useState } from "react";
import { Markdown } from "./Markdown";

/** Long prose keeps its original text available without filling the task surface. */
export function ExpandableText({ text, markdown = false, limit = 500 }: { text: string; markdown?: boolean; limit?: number }) {
  const [all, setAll] = useState(text.length <= limit);
  const shown = all ? text : `${text.slice(0, limit).trimEnd()}…`;
  return (
    <div className="max-w-prose leading-6 text-ink/85">
      {markdown ? <Markdown source={shown} /> : <p className="whitespace-pre-wrap break-words">{shown}</p>}
      {!all && <button onClick={() => setAll(true)} className="text-xs font-medium text-accent-ink hover:underline max-md:min-h-11">More</button>}
    </div>
  );
}
