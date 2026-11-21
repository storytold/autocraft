import type { User } from "../api/types.ts";

/** Viewers are read-only; maintainers and operators leave comments and suggestions. */
export const canComment = (user: User): boolean => user.role !== "viewer";
