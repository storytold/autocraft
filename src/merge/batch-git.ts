// Git side of an integration batch, in the same locked-down bare cache repository as the fix-up step: merges
// are computed in memory with `git merge-tree`, so no working tree exists and no hook, filter or repo code runs.
import { Git } from "../fixup/git.ts";

export class BatchGit extends Git {
  /** Fetches the default branch and returns its head commit. */
  async fetchMain(org: string, repo: string, branch: string): Promise<string> {
    await this.init();
    await this.must(["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", `https://github.com/${org}/${repo}.git`, `+refs/heads/${branch}:refs/batch/main`]);
    return (await this.must(["rev-parse", "refs/batch/main"])).trim();
  }

  /** The tree of merging commit `b` into `a`, or null when they conflict. */
  async mergeTree(a: string, b: string): Promise<string | null> {
    const r = await this.git(["merge-tree", "--write-tree", "--no-messages", a, b]);
    if (r.code === 1) return null;
    if (r.code !== 0) throw new Error(`git merge-tree failed: ${r.stderr.trim().split("\n").pop() ?? r.code}`);
    return r.stdout.split("\n")[0]!.trim();
  }

  /**
   * Keeps a merge train car's tip under `refs/batch/car/<id>`, so a car built on it finds the commit after the cache is collected, and
   * drops the refs of the cars not in `live`.
   */
  async keepCar(id: number, sha: string, live: readonly number[]): Promise<void> {
    await this.git(["update-ref", `refs/batch/car/${id}`, sha]);
    const refs = await this.git(["for-each-ref", "--format=%(refname)", "refs/batch/car/"]);
    for (const ref of refs.code === 0 ? refs.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : []) {
      const n = Number(ref.slice("refs/batch/car/".length));
      if (Number.isInteger(n) && n !== id && !live.includes(n)) await this.git(["update-ref", "-d", ref]);
    }
  }

  /** Whether a car's tip is in the cache, fetched from the branch it was pushed to (`fork`, `<owner>/<repo>`) when it is not. */
  async haveCar(car: { id: number; commit_sha: string; branch: string; fork: string | null }): Promise<boolean> {
    await this.init();
    const have = async () => (await this.git(["cat-file", "-e", `${car.commit_sha}^{commit}`])).code === 0;
    if (await have()) return true;
    if (!car.fork) return false;
    const r = await this.git(["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", `https://github.com/${car.fork}.git`, `+refs/heads/${car.branch}:refs/batch/car/${car.id}`]);
    return r.code === 0 && await have();
  }

  /** A merge commit with the given parents. */
  async mergeCommit(tree: string, parents: string[], message: string, who: { name: string; email: string }): Promise<string> {
    const env = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
    return (await this.must(["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-F", "-"], { input: message, env })).trim();
  }
}
