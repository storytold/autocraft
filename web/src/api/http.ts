import type { Api } from "./client";
import { requestProject, SCOPE_HEADER } from "./scope";
import type { MySettings, MySettingsChange, PendingRunnerLogin, User } from "./types";

/** Query string from the set fields; booleans as 1 / 0. */
function qs(f: object): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

const CSRF_HEADER = "X-CSRF-Token";

function signIn(): never {
  location.assign(`/auth/signin?${new URLSearchParams({ return_to: location.pathname + location.search })}`);
  throw new Error("Your session has ended. Signing in again.");
}

/** The dashboard API over fetch, same origin, with the session cookie. */
export function createHttpApi(): Api {
  let csrf: string | null = null;
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((fn) => fn());

  async function call<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, project?: string | null): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (project) headers[SCOPE_HEADER] = project;
    if (method !== "GET") {
      // Every /api/ response carries the session's token; a POST before any GET fetches it first.
      if (!csrf) await call("GET", "/api/me");
      headers[CSRF_HEADER] = csrf ?? "";
      if (body !== undefined) headers["content-type"] = "application/json";
    }
    const r = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
    const token = r.headers.get(CSRF_HEADER);
    if (token) csrf = token;
    if (r.status === 401) signIn();
    if (!r.ok) {
      let msg = `${r.status} ${r.statusText}`;
      try {
        const j = (await r.json()) as { error?: unknown };
        if (typeof j.error === "string") msg = j.error;
      } catch {
        /* not JSON: keep the status line */
      }
      throw Object.assign(new Error(msg), { status: r.status });
    }
    if (r.status === 204) return undefined as T;
    return (await r.json()) as T;
  }

  // Views that mount together often ask for the same thing; they share one request.
  const inflight = new Map<string, Promise<unknown>>();
  const get = <T>(path: string): Promise<T> => {
    const project = requestProject();
    const key = `${project ?? ""} ${path}`;
    let p = inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = call<T>("GET", path, undefined, project).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  };
  async function post<T>(path: string, body?: unknown): Promise<T> {
    const v = await call<T>("POST", path, body);
    changed();
    return v;
  }
  async function put<T>(path: string, body?: unknown): Promise<T> {
    const v = await call<T>("PUT", path, body);
    changed();
    return v;
  }
  async function del<T>(path: string): Promise<T> {
    const v = await call<T>("DELETE", path);
    changed();
    return v;
  }
  return {
    me: Object.assign(() => get<User>("/api/me"), {
      settings: {
        get: () => get<MySettings>("/api/me/settings"),
        put: (body: Partial<MySettingsChange>) => put<MySettings>("/api/me/settings", body),
      },
    }),
    repos: () => get("/api/repos"),
    repoOwners: () => get("/api/repos/owners"),
    areas: {
      get: (repo) => get(`/api/areas/${encodeURIComponent(repo)}`),
      edit: (repo, edit) => post(`/api/areas/${encodeURIComponent(repo)}/edit`, edit),
      run: (repo, step) => post(`/api/areas/${encodeURIComponent(repo)}/run`, { step }),
      accept: (id, body) => post(`/api/area-proposals/${id}/accept`, body ?? {}),
      dismiss: async (id) => {
        await post(`/api/area-proposals/${id}/dismiss`);
      },
    },
    live: () => get("/api/live-board"),
    health: () => get("/api/health"),
    item: (repo, number) => get(`/api/items/${encodeURIComponent(repo)}/${encodeURIComponent(String(number))}`),
    itemTrace: (repo, number, q = {}) =>
      get(`/api/items/${encodeURIComponent(repo)}/${encodeURIComponent(String(number))}/trace${qs({ ...q, kinds: q.kinds?.join(",") })}`),
    itemTraceDetail: (repo, number, id) => get(`/api/items/${encodeURIComponent(repo)}/${encodeURIComponent(String(number))}/trace/event${qs({ id })}`),
    activity: (q = {}) => get(`/api/activity${qs({ ...q, kinds: q.kinds?.join(",") })}`),
    search: (q) => (q.trim() ? get(`/api/search?${new URLSearchParams({ q })}`) : Promise.resolve([])),
    progress: () => get("/api/progress"),
    maintain: {
      home: () => get("/api/maintain/home"),
      queue: () => get("/api/maintain/queue"),
      stats: (period) => get(`/api/maintain/stats${qs({ period })}`),
      items: (q) => get(`/api/maintain/items${qs({ ...q, filters: undefined, filter: q.filters?.join(","), areas: undefined, area: q.areas?.join(","), refs: q.refs?.join(",") })}`),
      browse: (q) => get(`/api/maintain/browse${qs({ ...q, refs: q.refs?.join(",") })}`),
      command: (text, opts) => post("/api/commands", { text, ...(opts?.items?.length ? { items: opts.items } : {}), asked: opts?.asked }),
      repos: () => get("/api/maintain/repos"),
      asked: () => get("/api/maintain/asked"),
      control: (input) => post("/api/controls", input),
    },
    maintainItem: {
      get: (repo, number) => get(`/api/maintain/items/${encodeURIComponent(repo)}/${encodeURIComponent(String(number))}`),
      command: async (repo, number, text, asked) => {
        const r = await post<{ items: { outcome: string }[]; lines: string[] }>(`/api/items/${encodeURIComponent(repo)}/${encodeURIComponent(String(number))}/command`, { text, asked });
        return { ok: r.items.length > 0 && r.items.every((i) => i.outcome === "run"), lines: r.lines };
      },
      control: async (body) => {
        const r = await post<{ ok: boolean; line: string }>("/api/controls", body);
        return { ok: r.ok, lines: [r.line] };
      },
    },
    itemPage: (repo, number, since) => get(`/api/items/${encodeURIComponent(repo)}/${number}/page${qs({ since })}`),
    itemChat: {
      get: (repo, number, since) => get(`/api/items/${encodeURIComponent(repo)}/${number}/chat${qs({ since })}`),
      send: (repo, number, conversation, text) => post(`/api/items/${encodeURIComponent(repo)}/${number}/chat`, { conversation, text }),
      withdraw: (repo, number) => post(`/api/items/${encodeURIComponent(repo)}/${number}/chat/withdraw`),
    },
    itemPeek: (repo, number) => get(`/api/items/${encodeURIComponent(repo)}/${encodeURIComponent(String(number))}/peek`),
    authorStats: (login) => get(`/api/authors/${encodeURIComponent(login)}`),
    securityList: () => get("/api/security/findings"),
    findingPage: (repo, number) => get(`/api/security/findings/${encodeURIComponent(repo)}/${number}/page`),
    mainCi: () => get("/api/main-ci"),
    contributors: {
      list: (filter) => get(`/api/contributors${qs(filter)}`),
      previewRule: (rule) => get(`/api/contributors/rule-preview${qs(rule)}`),
      setRule: (rule) => post("/api/contributors/rule", rule),
      override: (login, input) => post(`/api/contributors/${encodeURIComponent(login)}/override`, input),
    },
    security: {
      overview: (repo) => get(`/api/repos/${encodeURIComponent(repo)}/security`),
      startScan: (repo, capUsd) => post(`/api/repos/${encodeURIComponent(repo)}/security/scans`, { capUsd }),
      stopScan: (id) => post(`/api/security/scans/${id}/stop`),
      continueScan: (id, capUsd) => post(`/api/security/scans/${id}/continue`, { cap: capUsd }),
      scans: (repo) => get(`/api/security/scans${qs({ repo })}`),
      scan: (id) => get(`/api/security/scans/${id}`),
      finding: (repo, number) => get(`/api/security/findings/${encodeURIComponent(repo)}/${number}`),
      act: (repo, number, action, reason) => post(`/api/security/findings/${encodeURIComponent(repo)}/${number}`, { action, reason }),
    },
    repoAdmin: {
      list: () => get("/api/repos/all"),
      track: (name) => post("/api/repos/track", { name }),
      untrack: (name) => post("/api/repos/untrack", { name }),
      approveMerging: (name, approved) => post(approved ? "/api/repos/merge-approve" : "/api/repos/merge-revoke", { name }),
      approvePushing: (name, approved) => post(approved ? "/api/repos/push-approve" : "/api/repos/push-revoke", { name }),
      approveCommenting: (name, approved) => post(approved ? "/api/repos/comment-approve" : "/api/repos/comment-revoke", { name }),
      approveFixing: (name, approved) => post(approved ? "/api/repos/fixissue-approve" : "/api/repos/fixissue-revoke", { name }),
      approveStatusComments: (name, approved) => post(approved ? "/api/repos/prstatus-approve" : "/api/repos/prstatus-revoke", { name }),
      approveMainFixing: (name, approved) => post(approved ? "/api/repos/mainfix-approve" : "/api/repos/mainfix-revoke", { name }),
      approveCiRuns: (name, approved) => post(approved ? "/api/repos/ci-approve" : "/api/repos/ci-revoke", { name }),
      setOptionalCheck: (name, check, on) => post(on ? "/api/repos/optional-check-add" : "/api/repos/optional-check-remove", { name, check }),
      setPipeline: (name, on) => post(on ? "/api/repos/pipeline-on" : "/api/repos/pipeline-off", { name }),
      setBuildFeature: (name, feature, on) => post("/api/repos/build-feature", { name, feature, on }),
      approveLabels: (name, approved) => post(approved ? "/api/repos/labels-approve" : "/api/repos/labels-revoke", { name }),
    },
    inference: {
      get: () => get("/api/settings/inference"),
      put: (body) => put("/api/settings/inference", body),
      jev: () => get("/api/settings/jev"),
      setJev: (enabled) => put("/api/settings/jev", { enabled }),
    },
    mcp: {
      tokens: () => get("/api/mcp/tokens"),
      create: (label, answer = false) => post("/api/mcp/tokens", { label, answer }),
      revoke: (id) => post("/api/mcp/tokens/revoke", { id }),
    },
    runners: {
      list: () => get("/api/runners"),
      pending: (code) => get<PendingRunnerLogin>(`/api/runners/pending?code=${encodeURIComponent(code)}`).catch((e: unknown) => {
        if ((e as { status?: number }).status === 404) return null;
        throw e;
      }),
      approve: (code, label, scopes, otherMachine) => post("/api/runners/approve", { code, ...(label !== undefined && { label }), ...scopes, ...(otherMachine && { otherMachine: true }) }),
      deny: (code) => post("/api/runners/deny", { code }),
      revoke: (id) => post("/api/runners/revoke", { id }),
      setScopes: (id, scopes) => post("/api/runners/scopes", { id, ...scopes }),
      rename: (id, label) => post("/api/runners/rename", { id, label }),
    },
    modelQueue: {
      get: (f) => get(`/api/model-queue${qs(f ?? {})}`),
      pick: (id) => post(`/api/model-queue/${encodeURIComponent(String(id))}/pick`, {}),
      unpick: (id) => post(`/api/model-queue/${encodeURIComponent(String(id))}/unpick`, {}),
    },
    access: {
      overview: () => get("/api/access"),
      add: (input) => post("/api/access/add", input),
      remove: (login) => post("/api/access/remove", { login }),
      setRole: (login, role) => post("/api/access/role", { login, role }),
      revokeSession: (id) => post("/api/access/sessions/revoke", { id }),
      revokeToken: (id) => post("/api/access/tokens/revoke", { id }),
      audit: (filter) => get(`/api/audit${qs(filter)}`),
    },
    githubApp: {
      status: () => get("/api/admin/github-app"),
      createLink: (org) => post("/api/admin/github-app/links", { org }),
      revokeLink: (id) => post("/api/admin/github-app/links/revoke", { id }),
      remove: () => post("/api/admin/github-app/remove", {}),
      setIdentity: (identity) => post("/api/admin/github-app/identity", { identity }),
      allowOwner: (login) => post("/api/admin/github-app/owners", { login }),
      removeOwner: (login) => post("/api/admin/github-app/owners/remove", { login }),
      ackForeignInstalls: () => post("/api/admin/github-app/foreign-ack", {}),
    },
    discord: {
      setup: () => get("/api/admin/discord"),
      setChannel: (channelId, watched) => put("/api/admin/discord/channel", { channelId, watched }),
      setChannelRepo: (channelId, repo) => put("/api/admin/discord/channel-repo", { channelId, repo }),
      setContact: (contact) => put("/api/admin/discord/contact", { contact }),
      setReact: (on) => put("/api/admin/discord/react", { on }),
      setReactEmoji: (emoji) => put("/api/admin/discord/react", { emoji }),
      setRolePanel: (panel) => put("/api/admin/discord/role-panel", panel ?? { off: true }),
      removeLink: (id) => post("/api/admin/discord/unlink", { id }),
      addFilingRepo: (repo) => post("/api/admin/discord/filing-repos/add", { repo }),
      removeFilingRepo: (repo) => post("/api/admin/discord/filing-repos/remove", { repo }),
      setOffer: (repo, on) => post("/api/admin/discord/offer", { repo, on }),
      account: () => get("/api/account/discord"),
      unlinkOwn: () => post("/api/account/discord/unlink", {}),
      linkCode: () => post("/api/account/discord/code", {}),
    },
    classifiers: {
      report: (sel) => get(`/api/classifiers${qs(sel)}`),
      disagreements: (f) => get(`/api/classifiers/disagreements${qs(f)}`),
    },
    cost: (run) => get(`/api/cost${qs({ run })}`),
    downloads: (range, app) => get(`/api/downloads${qs({ range, app })}`),
    pipeline: {
      overview: () => get("/api/pipeline"),
      jobs: (f) => get(`/api/pipeline/jobs${qs(f)}`),
      job: (id) => get(`/api/pipeline/jobs/${id}`),
      run: (step, params) => post("/api/pipeline/jobs", { step, params }),
      cancel: (id) => post(`/api/pipeline/jobs/${id}/cancel`),
      state: () => get("/api/pipeline/state"),
      setEnabled: (enabled) => put("/api/pipeline/state", { enabled }),
      setLimit: (step, limit) => put(`/api/pipeline/limits/${encodeURIComponent(step)}`, limit),
      resetLimit: (step) => post(`/api/pipeline/limits/${encodeURIComponent(step)}/reset`),
      ackDeadline: (step) => post(`/api/pipeline/steps/${encodeURIComponent(step)}/deadline-ack`),
      resumeTrip: (stage) => post(`/api/pipeline/trips/${encodeURIComponent(stage)}/resume`),
      heldAuthors: () => get("/api/pipeline/outside/held"),
      releaseAuthor: (author) => post("/api/pipeline/outside/release", { author }),
      setOutsideLimits: (input) => put("/api/pipeline/outside-limits", input),
    },
    envs: {
      list: () => get("/api/envs"),
      create: (input) => post("/api/envs", input),
      update: (id, input) => put(`/api/envs/${encodeURIComponent(id)}`, input),
      rotateKey: (id) => post(`/api/envs/${encodeURIComponent(id)}/rotate-key`),
      caches: () => get("/api/envs/caches"),
    },
    buildFeatures: {
      list: () => get("/api/build/features"),
      set: (input) => post("/api/build/features", input),
    },
    nightly: {
      grid: () => get("/api/nightly"),
      series: (repo, bench) => get(`/api/nightly/bench/${encodeURIComponent(repo)}/${encodeURIComponent(bench)}`),
      select: (input) => post("/api/nightly/select", input),
      openIssue: (input) => post("/api/nightly/issue", input),
    },
    screenshotSetup: {
      list: () => get("/api/build/screenshots"),
      put: (repo, config) => put(`/api/build/screenshots/${encodeURIComponent(repo)}`, config),
      remove: (repo) => del(`/api/build/screenshots/${encodeURIComponent(repo)}`),
    },
    workspaces: {
      list: (f) => get(`/api/workspaces${qs(f)}`),
      get: (id) => get(`/api/workspaces/${id}`),
      calls: (id, q) => get(`/api/workspaces/${id}/calls${qs({ before: q?.before, after: q?.after, running: q?.running?.join(",") })}`),
      output: (id, call) => get(`/api/workspaces/${id}/calls/${call}`),
      imageUrl: (id, call) => `/api/workspaces/${id}/calls/${call}/image`,
    },
    tasks: {
      list: (f) => get(`/api/tasks${qs(f)}`),
      get: (id) => get(`/api/tasks/${id}`),
      cancel: (id) => post(`/api/tasks/${id}/cancel`),
    },
    agents: {
      list: (f) => get(`/api/agents${qs(f)}`),
      get: (id) => get(`/api/agents/${id}`),
      refusals: (window) => get(`/api/agents/refusals${qs({ window })}`),
      transcript: (runId, id) => get(`/api/agents/${runId}/transcripts/${id}`),
    },
    transcriptStore: {
      status: () => get("/api/admin/transcript-store"),
      save: (input) => put("/api/admin/transcript-store", input),
      clear: () => del("/api/admin/transcript-store"),
      test: (input) => post("/api/admin/transcript-store/test", input ?? {}),
    },
    rates: (window) => get(`/api/rates${qs({ window })}`),
    prompts: () => get("/api/prompts"),
    prompt: {
      get: (id) => get(`/api/prompts/${encodeURIComponent(id)}`),
      history: (id) => get(`/api/prompts/${encodeURIComponent(id)}/history`),
      diff: (id, from, to) => get(`/api/prompts/${encodeURIComponent(id)}/diff${qs({ from: String(from), to: String(to) })}`),
      check: (id, body) => post(`/api/prompts/${encodeURIComponent(id)}/check`, body),
      save: (id, body) => post(`/api/prompts/${encodeURIComponent(id)}`, body),
      rollback: (id, body) => post(`/api/prompts/${encodeURIComponent(id)}/rollback`, body),
      useRelease: (id, body) => post(`/api/prompts/${encodeURIComponent(id)}/use-release`, body),
    },
    guidance: {
      list: () => get("/api/prompt-guidance"),
      get: (repo) => get(`/api/repos/${encodeURIComponent(repo)}/guidance`),
      check: (repo, body) => post(`/api/repos/${encodeURIComponent(repo)}/guidance/check`, body),
      save: (repo, body) => post(`/api/repos/${encodeURIComponent(repo)}/guidance`, body),
      rollback: (repo, body) => post(`/api/repos/${encodeURIComponent(repo)}/guidance/rollback`, body),
    },
    batch: (id) => get(`/api/batches/${id}`),
    async signOut() {
      await call("POST", "/api/signout");
      location.assign("/auth/signed-out");
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    semanticSearch: (q) => get(`/api/search?${new URLSearchParams({ q, mode: "semantic" })}`),
    next: () => get("/api/next"),
    mention: () => get("/api/mention"),
    queuePage: (f) => get(`/api/queue/page${qs(f)}`),
    controls: { run: (input) => post("/api/controls", input) },
    queueControl: {
      batchRemove: async (item) => void (await post("/api/merge/batch-remove", { item })),
      stopBatch: async (id) => void (await post(`/api/queue/batches/${id}/stop`)),
    },
  };
}
