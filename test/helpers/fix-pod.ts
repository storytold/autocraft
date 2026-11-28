// A fix session's pod and model for tests: each workspace's pod runs the real workspace helper on a scratch /work seeded at the
// head, and the model is a fake whose calls write the files the test gives into that tree and reply with the report. AutoCraft's
// checks in the pod find nothing.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "./raw-db.ts";
import type { KubeApi } from "../../src/build/kube-api.ts";
import type { WorkspaceCallRequest } from "../../src/build/workspace-call.ts";
import { WS_POD_PATH } from "../../src/build/workspace.ts";
import { createWorkspace, moveWorkspace } from "../../src/build/workspaces.ts";
import type { CheckRound } from "../../src/implement/checks.ts";
import type { Outcome } from "../../src/remote/calls.ts";
import { ensureSession, loadSessions, updateSession, type FixSessionKind } from "../../src/fixsession/store.ts";
import type { StepEnv } from "../../src/fixsession/turn.ts";

const helper = new URL("../../deploy/container/ws", import.meta.url).pathname;
/** The id of the n-th call queued (1-based). */
export const callId = (n: number): number => 5000 + n;

/** `src`: a git directory holding `head`; `top`: where the pods' scratch trees go. The env "pods" is created on `db`. */
export function fixPod(db: Db, o: { top: string; src: string; head: string; repo?: string }) {
  const roots = new Map<number, string>();
  const seed = (ws: number): string => {
    const root = join(o.top, `pod-${ws}`);
    for (const d of ["src", "home", ".ws/calls"]) mkdirSync(join(root, d), { recursive: true });
    const seeded = spawnSync("sh", [helper, "untar"], { env: { ...process.env, WS_ROOT: root }, input: execFileSync("git", ["archive", o.head], { cwd: o.src }) });
    roots.set(ws, root);
    return seeded.stdout.toString().trim().split(" ")[2]!;
  };
  const api = {
    listPods: async (_ns: string, selector: string) => {
      const id = /craft\.build\/workspace=(\d+)/.exec(selector)![1]!;
      return [{ metadata: { name: `ws-${id}`, labels: { "craft.build/workspace": id } }, status: { phase: "Running" } }];
    },
    exec: async (_ns: string, pod: string, _c: string, argv: string[], x: { stdin?: Buffer | AsyncIterable<Buffer> }) => {
      const root = roots.get(Number(pod.slice(3)))!;
      const local = (a: string) => a.replace(/\/work(?=\/|$|\s|")/g, root);
      const [cmd, ...args] = argv[0] === WS_POD_PATH ? ["sh", helper, ...argv.slice(1)] : argv;
      const p = spawn(cmd!, args.map(local), { env: { ...process.env, WS_ROOT: root } });
      const out: Buffer[] = [];
      p.stdout.on("data", (b: Buffer) => out.push(b));
      if (x.stdin && !Buffer.isBuffer(x.stdin)) for await (const chunk of x.stdin) p.stdin.write(chunk);
      p.stdin.end(Buffer.isBuffer(x.stdin) ? x.stdin : undefined);
      const code = await new Promise<number | null>((r) => p.on("close", r));
      return { exitCode: code, stdout: Buffer.concat(out), stderr: Buffer.alloc(0), truncated: false };
    },
    deletePod: async () => {},
  } as unknown as KubeApi;
  // The launcher's part: a parked workspace that is resumed gets its pod back on the same volume, tree and base kept.
  setInterval(() => {
    for (const ws of roots.keys()) void moveWorkspace(db, ws, ["requested"], "ready", { pod: `ws-${ws}` }).catch(() => {});
  }, 50).unref();

  const queued: WorkspaceCallRequest[] = [];
  let edits: (r: WorkspaceCallRequest) => Record<string, string | null> = () => ({});
  let report: Record<string, unknown> = { status: "done", summary: "Made the change." };
  let unclaimed: (r: WorkspaceCallRequest) => boolean = () => false;
  const deps: Pick<StepEnv, "api" | "agents" | "checks" | "calls" | "pollMs"> = {
    api, pollMs: 50,
    agents: async () => "Build with cargo build --offline.\n",
    checks: async (_pod, c) => ({ round: c.round, base: c.base, diffStat: "", files: [], crates: [], findings: [], notes: [], noVerdict: [], diffHash: "", needsDependency: false, clean: true } as unknown as CheckRound),
    calls: {
      async queue(_db, r) {
        queued.push(r);
        const id = callId(queued.length), now = Date.now();
        await db.run(db.k.insertInto("main.remote_calls").values({
          id, step: "fixup", stage: 0, prompt_id: r.promptId, prompt_version: r.promptVersion, tier: r.tier, effort: r.effort, asked_model: r.model, bundle: JSON.stringify({ system: r.system }),
          state: "queued", since: now, seen_at: now, max_attempts: 2, timeout_ms: 1000, parent_id: r.parentId ?? null,
        } as never));
        return id;
      },
      async await(_db, id): Promise<Outcome> {
        const r = queued[id - callId(1)]!, root = roots.get(r.workspaceId)!;
        if (unclaimed(r)) return { state: "unclaimed" };
        for (const [p, text] of Object.entries(edits(r))) {
          if (text === null) { rmSync(join(root, "src", p)); continue; }
          mkdirSync(dirname(join(root, "src", p)), { recursive: true });
          writeFileSync(join(root, "src", p), text);
        }
        return { state: "done", text: JSON.stringify(report), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null } as never, byModel: null, costUsd: 0.5, turns: 3, sessionId: "s", runId: null };
      },
    },
  };

  /** A live session of `kind` on item `n` with a ready workspace at the head. */
  const session = async (kind: FixSessionKind, n: number) => {
    const ws = await createWorkspace(db, { repo: o.repo ?? "app", baseSha: o.head, envId: "pods", owner: "test" });
    await moveWorkspace(db, ws, ["requested"], "ready", { pod: `ws-${ws}`, base_commit: seed(ws) });
    const s = await ensureSession(db, kind, o.repo ?? "app", n);
    assert.ok("session" in s);
    await updateSession(db, s.session.id, { workspaceId: ws, head: o.head });
    return (await loadSessions(db, [s.session.id])).get(s.session.id)!;
  };
  return {
    api, deps, queued, session,
    /** Each call writes the files `f` gives into the tree (null deletes one), then replies with `r`; a call `lost` picks is not taken (unclaimed). */
    model(f: typeof edits, r: Record<string, unknown> = { status: "done", summary: "Made the change." }, lost: typeof unclaimed = () => false) { edits = f; report = r; unclaimed = lost; },
    /** The workspace's scratch /work. */
    root: (ws: number) => roots.get(ws)!,
  };
}
