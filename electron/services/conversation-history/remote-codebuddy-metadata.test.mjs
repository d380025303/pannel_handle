import { it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

it("caches CodeBuddy list metadata across processes and invalidates individual files", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "codebuddy-metadata-"));
  const script = readFileSync(new URL("./agent-conversation-history-remote.py", import.meta.url), "utf8").replace(/\nmain\(\)\s*$/, "");
  const setup = `
root = os.path.expanduser("~/.codebuddy/projects/project")
os.makedirs(root, exist_ok=True)
original = codebuddy_metadata
parsed = []
def tracked(name):
    parsed.append(os.path.basename(name))
    return original(name)
codebuddy_metadata = tracked
payload = {"providers": ["codebuddy"], "scope": "all", "limit": 200}
def write(index, title="original"):
    with open(os.path.join(root, str(index) + ".jsonl"), "w", encoding="utf-8") as output:
        for row in range(100):
            output.write(json.dumps({"type": "message", "role": "user", "cwd": "/work",
                "timestamp": 1700000000000 + index, "content": [{"type": "text", "text": "x" * 4200}]}) + "\\n")
        output.write(json.dumps({"type": "ai-title", "aiTitle": title}) + "\\n")
`;
  const run = code => {
    const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-c", script + "\n" + setup + code], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  try {
    expect(run(`
for index in range(201): write(index)
started = time.perf_counter()
page = list_history(payload)
print(json.dumps({"parses": len(parsed), "count": len(page["items"]), "cursor": page["nextCursor"]}))
`)).toEqual({ parses: 201, count: 200, cursor: "200" });
    expect(run(`
payload["cursor"] = "200"
page = list_history(payload)
payload["cursor"] = None
first = list_history(payload)
payload.update(scope="cwd", cwd="/other")
empty = list_history(payload)
print(json.dumps({"parsed": parsed, "last": page["items"][0]["ref"], "cursor": page["nextCursor"],
    "first": first["items"][0]["ref"], "empty": empty["items"]}))
`)).toEqual({ parsed: [], last: "codebuddy:0", cursor: null, first: "codebuddy:200", empty: [] });
    expect(run(`
write(200, "changed")
page = list_history(payload)
print(json.dumps({"parsed": parsed, "title": page["items"][0]["title"]}))
`)).toEqual({ parsed: ["200.jsonl"], title: "changed" });
    expect(run(`
name = os.path.join(root, "200.jsonl")
before = os.stat(name)
write(200, "updated")
assert os.stat(name).st_size == before.st_size
# Unix ctime changes even if mtime is restored; Windows ctime is creation time.
os.utime(name, ns=(before.st_atime_ns, before.st_mtime_ns + (1000000000 if os.name == "nt" else 0)))
page = list_history(payload)
print(json.dumps({"parsed": parsed, "title": page["items"][0]["title"]}))
`)).toEqual({ parsed: ["200.jsonl"], title: "updated" });
    expect(run(`
name = os.path.join(root, "200.jsonl")
os.utime(name, ns=(os.stat(name).st_atime_ns, os.stat(name).st_mtime_ns + 1000000000))
def changing(name):
    item = tracked(name)
    if os.path.basename(name) == "200.jsonl": write(200, "racing")
    return item
codebuddy_metadata = changing
list_history(payload)
codebuddy_metadata = tracked
page = list_history(payload)
print(json.dumps({"parsed": parsed, "title": page["items"][0]["title"]}))
`)).toEqual({ parsed: ["200.jsonl", "200.jsonl"], title: "racing" });
    expect(run(`
os.unlink(os.path.join(root, "0.jsonl"))
write(201, "added")
page = list_history(payload)
connection = sqlite3.connect(os.path.expanduser("~/.cache/pannel-handle/codebuddy-metadata-v1/metadata.sqlite"))
assert connection.execute("SELECT count(*) FROM metadata WHERE path LIKE '%/0.jsonl' OR path LIKE '%\\\\0.jsonl'").fetchone()[0] == 0
connection.close()
print(json.dumps({"parsed": parsed, "first": page["items"][0]["title"], "cursor": page["nextCursor"]}))
`)).toEqual({ parsed: ["201.jsonl"], first: "added", cursor: "200" });
    expect(run(`
cached_codebuddy_metadata([])
connection = sqlite3.connect(os.path.expanduser("~/.cache/pannel-handle/codebuddy-metadata-v1/metadata.sqlite"))
assert connection.execute("SELECT count(*) FROM metadata").fetchone()[0] == 0
connection.close()
os.unlink(os.path.expanduser("~/.cache/pannel-handle/codebuddy-metadata-v1/metadata.sqlite"))
with open(os.path.expanduser("~/.cache/pannel-handle/codebuddy-metadata-v1/metadata.sqlite"), "w") as output: output.write("broken")
page = list_history(payload)
print(json.dumps({"parses": len(parsed), "errors": page["errors"], "count": len(page["items"])}))
`)).toEqual({ parses: 201, errors: [], count: 200 });
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30000);
