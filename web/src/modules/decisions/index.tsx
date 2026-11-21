import type { ViewDef } from "../../registry/types";
import { DecisionBrowse } from "./DecisionBrowse";
import { PhoneInbox } from "./PhoneInbox";

/** The Decisions tab of the Needs you page: one browse surface (filter rail, list, read-only preview). A row still opens the item page. */
export const decisionsView: ViewDef = {
  id: "decisions",
  title: "Decisions",
  panels: [{ id: "browse", title: "Decisions", component: DecisionBrowse, defaultSize: 100 }],
  phone: PhoneInbox,
};
