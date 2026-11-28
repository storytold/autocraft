// The Items page: a paged browser over every item of the visible repos, with a qualifier search, views, filters and a
// command bar for several items at once. On desktop the item in `?open=` shows in a resizable panel beside the list, which
// the view lays out itself, since the panel shows only while an item is open. An author's page lists their items the same way.
import type { FeatureModule, PanelDef } from "../../../registry/types";
import { lazyView } from "../../../registry/lazyView";
import { t } from "../../../../../src/i18n/index.ts";

const ItemsView = lazyView(() => import("./views"), "ItemsView");
const AuthorView = lazyView(() => import("./AuthorView"), "AuthorView");

const panels: PanelDef[] = [{ id: "main", title: t("Items"), component: ItemsView, defaultSize: 100 }];

export const maintainItemsModule: FeatureModule = {
  id: "maintain-items",
  permission: "viewer",
  commands: [{ id: "go-items", keys: "g i", label: t("Go to items"), group: "Go to" }],
  routes: [
    { path: "items", scoped: true, view: { id: "maintain-items", title: t("Items"), phone: ItemsView, panels } },
    // Older links to a filtered list open the same page.
    { path: "items/filters", scoped: true, view: { id: "maintain-items-filters", title: t("Items"), phone: ItemsView, panels } },
    // An author's page: their counts and their items, with the same rows and item panel.
    { path: "authors/:login", view: { id: "author", title: t("Author"), phone: AuthorView, panels: [{ id: "main", title: t("Author"), component: AuthorView, defaultSize: 100 }] } },
  ],
};
