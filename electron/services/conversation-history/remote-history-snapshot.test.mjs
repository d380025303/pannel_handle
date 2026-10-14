import { it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

it("lists 10,000 Codex threads once per traversal using cross-process pages", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "history-list-snapshot-"));
  const script = readFileSync(new URL("./agent-conversation-history-remote.py", import.meta.url), "utf8").replace(/\nmain\(\)\s*$/, "");
  const setup = `
database = os.path.join(os.path.expanduser("~"), ".codex", "state_5.sqlite")
count_file = database + ".count"
original_list = list_codex
def counted_list(payload):
    items = original_list(payload)
    with open(count_file, "a") as output: output.write(str(len(items)) + "\\n")
    return items
list_codex = counted_list
payload = {"providers": ["codex"], "cwd": "/work", "scope": "cwd", "limit": 200}
`;
  const run = code => {
    const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-"], {
      input: script + "\n" + setup + code, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8",
    });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    return JSON.parse(result.stdout);
  };
  try {
    const first = run(`
os.makedirs(os.path.dirname(database))
connection = sqlite3.connect(database)
connection.execute("CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER, first_user_message TEXT, preview TEXT, source TEXT)")
connection.executemany("INSERT INTO threads VALUES (?, '/work', 'title', 1700000000, ?, 0, 'hello', '', 'cli')",
                       ((str(i), 1700000000 + i) for i in range(10000)))
connection.commit()
connection.close()
page = list_history(payload)
print(json.dumps(page))
`);
    expect(first.items).toHaveLength(200);
    // Separate processes for all subsequent pages; edits must not shift this traversal.
    run(`
connection = sqlite3.connect(database)
connection.execute("INSERT INTO threads VALUES ('new', '/work', 'new', 1800000000, 1800000000, 0, 'new', '', 'cli')")
connection.commit()
connection.close()
print("null")
`);
    const refs = first.items.map(item => item.ref);
    let cursor = first.nextCursor;
    let pages = 1;
    while (cursor) {
      const page = run(`
payload["cursor"] = ${JSON.stringify(cursor)}
page = list_history(payload)
print(json.dumps(page))
`);
      refs.push(...page.items.map(item => item.ref));
      cursor = page.nextCursor;
      pages++;
    }
    expect(pages).toBe(50);
    expect(refs).toEqual(Array.from({ length: 10000 }, (_, i) => `codex:${9999 - i}`));
    expect(readFileSync(path.join(home, ".codex/state_5.sqlite.count"), "utf8").replace(/\r/g, "")).toBe("10000\n");
    const fresh = run('print(json.dumps(list_history(payload)))');
    expect(fresh.items[0].ref).toBe("codex:new");
    expect(readFileSync(path.join(home, ".codex/state_5.sqlite.count"), "utf8").replace(/\r/g, "")).toBe("10000\n10001\n");
    run(`
payload["cursor"] = ${JSON.stringify(first.nextCursor)}
for field, value in [("cwd", "/other"), ("query", "hello"), ("providers", ["gemini"]), ("includeArchived", True), ("scope", "all")]:
    changed = {**payload, field: value}
    try: list_history(changed)
    except RuntimeError as error: assert str(error) == "Invalid history snapshot"
    else: raise AssertionError("mismatched filters accepted")
for invalid in ["../unsafe:200", "list-invalid:200", "-1"]:
    try: list_history({**payload, "cursor": invalid})
    except RuntimeError: pass
    else: raise AssertionError("invalid cursor accepted")
for name in glob.glob(os.path.join(snapshot_root(), "*.sqlite")): os.utime(name, (0, 0))
try: list_history(payload)
except RuntimeError as error: assert "expired" in str(error)
else: raise AssertionError("expired snapshot accepted")
print("null")
`);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30000);

it("reuses paged snapshots across processes and refreshes changed transcripts", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "history-snapshot-"));
  const script = readFileSync(new URL("./agent-conversation-history-remote.py", import.meta.url), "utf8").replace(/\nmain\(\)\s*$/, "");
  const run = code => {
    const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-"], {
      input: script + "\n" + code,
      env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  try {
    const setup = `
source = os.path.join(os.path.expanduser("~"), "transcript.jsonl")
count_file = source + ".count"
def load():
    with open(count_file, "a") as output: output.write("parse\\n")
    return parse_messages("codex", source)
payload = {"conversationRef": "codex:fixture", "limit": 200}
`;
    const result = run(setup + `
with open(source, "w", encoding="utf-8") as output:
    for index in range(10000):
        output.write(json.dumps({"type": "response_item", "timestamp": 1700000000000 + index,
            "payload": {"id": str(index), "type": "message", "role": "user",
            "content": [{"type": "input_text", "text": "x" * 2048}]}}) + "\\n")
started = time.perf_counter()
page = snapshot_page(payload, [source], load)
print(json.dumps({"cursor": page["nextCursor"], "ids": [m["id"] for m in page["messages"]],
    "seconds": time.perf_counter() - started, "bytes": os.path.getsize(source)}))
`);
    expect(result.ids).toHaveLength(200);
    const pages = run(setup + `
payload["cursor"] = ${JSON.stringify(result.cursor)}
started = time.perf_counter()
ids = []
while payload["cursor"]:
    page = snapshot_page(payload, [source], load)
    ids.extend(message["id"] for message in page["messages"])
    payload["cursor"] = page["nextCursor"]
with open(count_file) as source_count: parses = len(source_count.readlines())
print(json.dumps({"ids": ids, "parses": parses, "seconds": time.perf_counter() - started}))
`);
    expect(pages.parses).toBe(1);
    expect([...result.ids, ...pages.ids]).toEqual(Array.from({ length: 10000 }, (_, i) => String(9999 - i)));
    const refresh = run(setup + `
with open(source, "a") as output:
    output.write(json.dumps({"type": "response_item", "timestamp": 1800000000000,
        "payload": {"id": "new", "type": "message", "role": "user", "content": [{"type": "input_text", "text": "new"}]}}) + "\\n")
payload["cursor"] = ${JSON.stringify(result.cursor)}
old_page = snapshot_page(payload, [source], load)
payload["cursor"] = None
fresh = snapshot_page(payload, [source], load)
snapshot_page(payload, [source], load)
with open(count_file) as source_count: parses = len(source_count.readlines())
print(json.dumps({"old": old_page["messages"][0]["id"], "fresh": fresh["messages"][0]["id"], "parses": parses}))
`);
    expect(refresh).toEqual({ old: "9799", fresh: "new", parses: 2 });
    console.info(`Remote snapshot benchmark: ${result.bytes} bytes, first page ${result.seconds.toFixed(3)}s, remaining 49 pages ${pages.seconds.toFixed(3)}s, 1 full parse`);
    run(setup + `
root = snapshot_root()
for name in glob.glob(os.path.join(root, "*.sqlite")): os.utime(name, (0, 0))
prune_snapshots(root)
assert not glob.glob(os.path.join(root, "*.sqlite"))
for index in range(40):
    with open(os.path.join(root, str(index) + ".sqlite"), "wb") as output: output.write(b"x" * 100)
prune_snapshots(root)
assert len(glob.glob(os.path.join(root, "*.sqlite"))) == SNAPSHOT_MAX_COUNT
SNAPSHOT_MAX_BYTES = 250
prune_snapshots(root)
assert sum(os.path.getsize(name) for name in glob.glob(os.path.join(root, "*.sqlite"))) <= 250
for name in glob.glob(os.path.join(root, "*.sqlite")): os.unlink(name)
payload["cursor"] = None
large = snapshot_page(payload, [source], load)
assert large["messages"][0]["id"] == "new"
assert large["nextCursor"] == "200"
assert not glob.glob(os.path.join(root, "*.sqlite"))
assert not glob.glob(os.path.join(root, "snapshot-*"))
print("null")
`);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30000);

it("checks remote signatures without parsing messages and detects same-size edits", () => {
  const script = readFileSync(new URL("./agent-conversation-history-remote.py", import.meta.url), "utf8").replace(/\nmain\(\)\s*$/, "");
  const code = `
with tempfile.TemporaryDirectory() as root:
    source = os.path.join(root, "transcript.jsonl")
    with open(source, "w") as output: output.write("old")
    codex_rollout = lambda _: source
    def forbidden(*args): raise AssertionError("message parsing is forbidden")
    parse_messages = forbidden
    payload = {"conversationRef": "codex:fixture", "signatureOnly": True}
    first = history_messages(payload)
    assert history_messages(payload) == first
    with open(source, "w") as output: output.write("new")
    stat = os.stat(source)
    os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1000000000))
    assert history_messages(payload) != first
print("ok")
`;
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-"], { input: script + "\n" + code, encoding: "utf8" });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  expect(result.stdout.trim()).toBe("ok");
});
