import { describe, it, expect, vi } from "vitest";
import { Worker } from "node:worker_threads";
import { createProjectSearchService, MAX_FILE_RESULTS } from "./project-search-service.cjs";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture() {
  let reads = 0;
  const service = createProjectSearchService({
    terminalManager: { getSession: () => ({ type: "ssh", cwd: "/app" }) },
    remoteFileService: {
      getHome: async () => "/home/me",
      list: async (_id, root) => {
        reads++;
        await delay(10);
        return root === "/app"
          ? Array.from({ length: 100 }, (_, i) => ({ type: "directory", name: `dir-${i}`, path: `/app/dir-${i}` }))
          : Array.from({ length: 3 }, (_, i) => ({ type: "file", name: `hit-${i}`, path: `${root}/hit-${i}` }));
      }
    }
  });
  return { service, reads: () => reads };
}
describe("file search cancellation", () => {
  it.each([false, true])("replaces delayed SSH traversals (regex=%s) and keeps latest results", async regex => {
    const { service, reads } = fixture();
    const first = service.searchWorkspaceEntries("ssh", "missing", undefined, { regex }, "one").catch(e => e.code);
    await delay(200);
    const second = service.searchWorkspaceEntries("ssh", "missing", undefined, { regex }, "two").catch(e => e.code);
    await delay(200);
    const latest = service.searchWorkspaceEntries("ssh", "missing", undefined, { regex }, "three");
    expect(await first).toBe("SEARCH_CANCELLED");
    expect(await second).toBe("SEARCH_CANCELLED");
    expect((await latest).results).toEqual([]);
    console.log(JSON.stringify({ regex, reads: reads(), baselineReads: 303 }));
    expect(reads()).toBeLessThan(150);
    expect(service.cancelFileSearch("ssh", "three")).toBe(false);
    const result = await service.searchWorkspaceEntries("ssh", "hit", undefined, { regex, entryType: "file" }, "four");
    expect(result.results).toHaveLength(MAX_FILE_RESULTS);
    expect(result.results.every(entry => entry.type === "file" && entry.name.startsWith("hit"))).toBe(true);
  });
  it.each([false, true])("stops issuing reads after explicit cancellation (regex=%s)", async regex => {
    const { service, reads } = fixture();
    const pending = service.searchWorkspaceEntries("ssh", "missing", undefined, { regex }, "close").catch(e => e.code);
    await delay(35);
    expect(service.cancelFileSearch("ssh", "wrong")).toBe(false);
    expect(service.cancelFileSearch("ssh", "close")).toBe(true);
    const atCancel = reads();
    expect(await pending).toBe("SEARCH_CANCELLED");
    await delay(30);
    expect(reads()).toBe(atCancel);
  });
});

it("terminates a regex worker during expensive matching and recovers", async () => {
  const post = vi.spyOn(Worker.prototype, "postMessage");
  const terminate = vi.spyOn(Worker.prototype, "terminate");
  try {
    const service = createProjectSearchService({
      terminalManager: { getSession: () => ({ type: "ssh", cwd: "/app" }) },
      remoteFileService: { getHome: async () => "/home", list: async () => Array.from({ length: 256 }, () => ({ name: "a".repeat(40) + "!", path: "/app/file", type: "file" })) }
    });
    const pending = service.searchWorkspaceEntries("ssh", "(a+)+$", undefined, { regex: true }, "expensive").catch(e => e.code);
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    expect(service.cancelFileSearch("ssh", "expensive")).toBe(true);
    expect(await pending).toBe("SEARCH_CANCELLED");
    expect(terminate).toHaveBeenCalled();
    expect((await service.searchWorkspaceEntries("ssh", "missing", undefined, {}, "next")).results).toEqual([]);
  } finally { post.mockRestore(); terminate.mockRestore(); }
});
it.each(["searchFiles", "searchWorkspaceEntries"])("cancels local traversal in %s after an in-flight read", async method => {
  let resolveRead;
  let reads = 0;
  const service = createProjectSearchService({
    terminalManager: { getSession: () => ({ type: "windows", cwd: "C:\\app" }) },
    fsApi: { promises: {
      stat: async () => ({ isDirectory: () => true }), realpath: async p => p,
      readdir: async () => { reads++; return new Promise(resolve => { resolveRead = resolve; }); }
    } }
  });
  const pending = service[method]("local", "missing", undefined, {}, "close").catch(e => e.code);
  await vi.waitFor(() => expect(reads).toBe(1));
  service.cancelFileSearch("local", "close");
  resolveRead([{ name: "child", isDirectory: () => true, isFile: () => false }]);
  expect(await pending).toBe("SEARCH_CANCELLED");
  expect(reads).toBe(1);
});
