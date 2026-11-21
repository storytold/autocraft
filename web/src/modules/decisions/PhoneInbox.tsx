import type { ViewProps } from "../../registry/types";
import { DecisionBrowse } from "./DecisionBrowse";

/**
 * Phone flow: the same browse surface. BrowseLayout turns the filter rail and the preview into
 * side sheets at this width, so there is no second list header or filter dialog here.
 */
export function PhoneInbox(props: ViewProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DecisionBrowse {...props} phone />
    </div>
  );
}
