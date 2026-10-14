import base64
import datetime
import glob
import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
import time

PROVIDERS = {"codex", "codebuddy", "opencode", "gemini", "grok"}


def decode_payload():
    return json.loads(base64.b64decode(sys.argv[2]).decode("utf-8"))


def timestamp_ms(value):
    if isinstance(value, (int, float)):
        return int(value * 1000 if 0 < value < 10_000_000_000 else value)
    if isinstance(value, str):
        try:
            return int(datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return 0
    return 0


def get_text(content):
    if not isinstance(content, list):
        return ""
    parts = []
    for item in content:
        if not isinstance(item, dict) or item.get("type") not in {"input_text", "output_text", "text"}:
            continue
        text = item.get("text")
        if isinstance(text, str) and text.strip():
            parts.append(text.strip())
    return "\n\n".join(parts).strip()


def get_grok_chunk_text(content):
    # Match getGrokChunkText: trim only after assembling the complete message.
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(item["text"] for item in content
                       if isinstance(item, dict) and item.get("type") in {"input_text", "output_text", "text"}
                       and isinstance(item.get("text"), str))
    if isinstance(content, dict) and isinstance(content.get("text"), str):
        return content["text"]
    return ""


def iter_jsonl(file_name, include_record_index=False):
    try:
        with open(file_name, "r", encoding="utf-8") as source:
            record_index = 0
            for line in source:
                if not line.strip():
                    continue
                record_index += 1
                try:
                    item = json.loads(line)
                    yield (record_index, item) if include_record_index else item
                except (json.JSONDecodeError, TypeError):
                    continue
    except OSError:
        return


def list_codex(payload):
    database_file = os.path.expanduser("~/.codex/state_5.sqlite")
    if not os.path.isfile(database_file):
        return []
    connection = sqlite3.connect(f"file:{database_file}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(threads)")}
        required = {"id", "cwd", "title", "created_at", "updated_at", "archived", "first_user_message", "preview", "source"}
        if not required.issubset(columns):
            raise RuntimeError("Unsupported Codex history schema")
        order = "recency_at_ms DESC, updated_at_ms DESC, updated_at DESC" if {"recency_at_ms", "updated_at_ms"}.issubset(columns) else "updated_at DESC"
        archived = "" if payload.get("includeArchived") else "AND archived = 0"
        cwd_filter = "" if payload.get("scope") == "all" else "AND rtrim(cwd, '/') = ?"
        parameters = () if payload.get("scope") == "all" else (str(payload.get("cwd") or "").rstrip("/"),)
        rows = connection.execute(
            f"""SELECT id, cwd, title, created_at, updated_at, archived, first_user_message, preview
                FROM threads
                WHERE source IN ('cli', 'vscode') AND first_user_message <> '' {archived} {cwd_filter}
                ORDER BY {order}""",
            parameters
        ).fetchall()
    finally:
        connection.close()
    items = []
    for row in rows:
        cwd = str(row["cwd"] or "")
        preview = str(row["first_user_message"] or row["preview"] or "")
        items.append({
            "ref": f"codex:{row['id']}",
            "provider": "codex",
            "title": str(row["title"] or preview or "Codex conversation"),
            "preview": preview,
            "cwd": cwd,
            "createdAt": timestamp_ms(row["created_at"]),
            "updatedAt": timestamp_ms(row["updated_at"]),
            "archived": bool(row["archived"]),
        })
    return items


def codebuddy_files():
    return glob.glob(os.path.expanduser("~/.codebuddy/projects/*/*.jsonl"))


def codebuddy_metadata(file_name):
    session_id = os.path.splitext(os.path.basename(file_name))[0]
    cwd = ""
    title = ""
    preview = ""
    created_at = 0
    updated_at = 0
    for item in iter_jsonl(file_name):
        stamp = timestamp_ms(item.get("timestamp"))
        if stamp:
            created_at = stamp if not created_at else min(created_at, stamp)
            updated_at = max(updated_at, stamp)
        if not cwd and isinstance(item.get("cwd"), str):
            cwd = item["cwd"]
        if item.get("type") == "ai-title" and isinstance(item.get("aiTitle"), str) and item["aiTitle"].strip():
            title = item["aiTitle"].strip()
        if not preview and item.get("type") == "message" and item.get("role") == "user":
            preview = get_text(item.get("content"))
    return {
        "ref": f"codebuddy:{session_id}",
        "provider": "codebuddy",
        "title": title or preview or "CodeBuddy conversation",
        "preview": preview,
        "cwd": cwd,
        "createdAt": created_at,
        "updatedAt": updated_at or created_at,
        "archived": False,
    }


def cached_codebuddy_metadata(files):
    # Requests run in separate Python processes; keep metadata outside message snapshots.
    connection = None
    try:
        root = os.path.expanduser("~/.cache/pannel-handle/codebuddy-metadata-v1")
        os.makedirs(root, mode=0o700, exist_ok=True)
        connection = sqlite3.connect(os.path.join(root, "metadata.sqlite"), timeout=1)
        connection.execute("CREATE TABLE IF NOT EXISTS metadata (path TEXT PRIMARY KEY, signature TEXT, data TEXT)")
        connection.execute("BEGIN IMMEDIATE")
        cached = {row[0]: row[1:] for row in connection.execute("SELECT path, signature, data FROM metadata")}
        live = set()
        items = []
        for file_name in files:
            name = os.path.abspath(file_name)
            live.add(name)
            try:
                signature = json.dumps(source_signature([name]))
                previous = cached.get(name)
                if previous and previous[0] == signature:
                    items.append(json.loads(previous[1]))
                    continue
                item = codebuddy_metadata(name)
                # Never save a partial read under a stable-looking newer signature.
                after = source_signature([name])
                if after[0][1] is not None and json.dumps(after) == signature:
                    connection.execute("INSERT OR REPLACE INTO metadata VALUES (?, ?, ?)",
                                       (name, signature, json.dumps(item, ensure_ascii=False)))
                else:
                    connection.execute("DELETE FROM metadata WHERE path = ?", (name,))
                items.append(item)
            except OSError:
                connection.execute("DELETE FROM metadata WHERE path = ?", (name,))
        connection.executemany("DELETE FROM metadata WHERE path = ?", ((name,) for name in cached if name not in live))
        connection.commit()
        return items
    except (OSError, sqlite3.Error, ValueError, TypeError):
        # Read-only homes, busy or damaged caches must not make history unavailable.
        return [codebuddy_metadata(name) for name in files]
    finally:
        if connection is not None:
            connection.close()


def list_codebuddy(payload):
    expected_cwd = str(payload.get("cwd") or "").rstrip("/")
    items = []
    for item in cached_codebuddy_metadata(codebuddy_files()):
        if payload.get("scope") != "all" and item["cwd"].rstrip("/") != expected_cwd:
            continue
        items.append(item)
    return items


def gemini_files(payload):
    root = os.environ.get("GEMINI_CLI_HOME") or os.path.expanduser("~")
    tmp = os.path.join(root, ".gemini", "tmp")
    if payload.get("scope") == "all":
        return glob.glob(os.path.join(tmp, "*", "chats", "*.json*"))
    project_hash = hashlib.sha256(str(payload.get("cwd") or "").encode()).hexdigest()
    return glob.glob(os.path.join(tmp, project_hash, "chats", "*.json*"))


def gemini_records(file_name):
    if file_name.endswith(".json"):
        try:
            value = json.load(open(file_name, encoding="utf-8"))
            return value if isinstance(value, list) else [value] + (value.get("messages") or [])
        except (OSError, ValueError):
            return []
    return list(iter_jsonl(file_name))


def gemini_messages(records):
    messages = {}
    for item in records:
        checkpoint = (item.get("$set") or {}).get("messages") if isinstance(item, dict) else None
        if isinstance(checkpoint, list):
            messages = {str(message["id"]): message for message in checkpoint if isinstance(message, dict) and message.get("id")}
            continue
        rewind = item.get("$rewindTo") if isinstance(item, dict) else None
        if rewind:
            rewind_id = str(rewind.get("id") if isinstance(rewind, dict) else rewind)
            remove = False
            for message_id in list(messages):
                remove = remove or message_id == rewind_id
                if remove:
                    messages.pop(message_id, None)
            continue
        if isinstance(item, dict) and item.get("type") in {"user", "gemini"} and item.get("id"):
            messages[str(item["id"])] = item
    return list(messages.values())


def list_gemini(payload):
    items = []
    for file_name in gemini_files(payload):
        records = gemini_records(file_name)
        metadata = next((item for item in records if isinstance(item, dict) and (item.get("sessionId") or item.get("projectHash"))), {})
        messages = gemini_messages(records)
        first_user = next((item for item in messages if item.get("type") == "user"), {})
        preview = first_user.get("content") if isinstance(first_user.get("content"), str) else ""
        project_hash = os.path.basename(os.path.dirname(os.path.dirname(file_name)))
        session_id = os.path.splitext(os.path.basename(file_name))[0]
        items.append({"ref": f"gemini:{project_hash}:{session_id}", "acpSessionId": metadata.get("sessionId") if isinstance(metadata.get("sessionId"), str) else None, "provider": "gemini", "title": preview or "Gemini conversation", "preview": preview,
                      "cwd": str(payload.get("cwd") or "") if payload.get("scope") != "all" else "", "createdAt": timestamp_ms(metadata.get("startTime") or (messages[0].get("timestamp") if messages else 0)),
                      "updatedAt": timestamp_ms(metadata.get("lastUpdated") or (messages[-1].get("timestamp") if messages else 0)) or int(os.path.getmtime(file_name) * 1000), "archived": False})
    return items


def grok_session_dirs():
    root = os.environ.get("GROK_HOME") or os.path.expanduser("~/.grok")
    return [directory for directory in glob.glob(os.path.join(root, "sessions", "*", "*"))
            if os.path.isdir(directory) and re.fullmatch(r"[0-9a-fA-F-]{36}", os.path.basename(directory))]


def grok_messages(directory):
    messages = {}
    for item in iter_jsonl(os.path.join(directory, "updates.jsonl")):
        params = item.get("params") or {}
        update = params.get("update") or {}
        update_type = update.get("sessionUpdate")
        if update_type not in {"user_message_chunk", "agent_message_chunk"}:
            continue
        content = update.get("content")
        text = get_grok_chunk_text(content)
        if not text:
            continue
        meta = params.get("_meta") or {}
        kind = "user" if update_type == "user_message_chunk" else "reply"
        prompt_id = str(meta.get("promptId") or update.get("prompt_id") or meta.get("eventId") or item.get("timestamp") or len(messages))
        key = f"{prompt_id}:{kind}"
        if key in messages:
            messages[key]["text"] += text
            messages[key]["timestamp"] = min(messages[key]["timestamp"], timestamp_ms(item.get("timestamp")))
        else:
            messages[key] = {"id": key, "provider": "grok", "kind": kind, "text": text, "timestamp": timestamp_ms(item.get("timestamp"))}
    return [{**message, "text": message["text"].strip()} for message in messages.values() if message["text"].strip()]


def list_grok(payload):
    expected_cwd = str(payload.get("cwd") or "").rstrip("/")
    items = []
    for directory in grok_session_dirs():
        summary_file = os.path.join(directory, "summary.json")
        try:
            with open(summary_file, encoding="utf-8") as source:
                summary = json.load(source)
        except (OSError, ValueError):
            continue
        cwd = str((summary.get("info") or {}).get("cwd") or "")
        if payload.get("scope") != "all" and cwd.rstrip("/") != expected_cwd:
            continue
        preview = str(summary.get("session_summary") or "").strip()
        session_id = os.path.basename(directory)
        items.append({
            "ref": f"grok:{session_id}", "provider": "grok",
            "title": str(summary.get("generated_title") or preview or "Grok conversation").strip(),
            "preview": preview, "cwd": cwd,
            "createdAt": timestamp_ms(summary.get("created_at")),
            "updatedAt": timestamp_ms(summary.get("last_active_at") or summary.get("updated_at")) or int(os.path.getmtime(summary_file) * 1000),
            "archived": False,
        })
    return items


def parse_messages(provider, file_name):
    messages = []
    seen = set()
    for record_index, item in iter_jsonl(file_name, include_record_index=True):
        message_id = None
        kind = None
        text = ""
        if provider == "codex" and item.get("type") == "compacted":
            value = (item.get("payload") or {}).get("message")
            text = value.strip() if isinstance(value, str) else ""
            kind = "summary"
            message_id = item.get("id") or f"summary:{item.get('timestamp') or ''}:{text}"
        elif provider == "codebuddy" and item.get("type") == "summary":
            value = item.get("summary")
            text = value.strip() if isinstance(value, str) else ""
            kind = "summary"
            message_id = item.get("id") or f"summary:{item.get('timestamp') or ''}:{text}"
        elif provider == "codex" and item.get("type") == "response_item":
            data = item.get("payload") or {}
            if data.get("type") != "message":
                continue
            if data.get("role") == "user":
                kind = "user"
            elif data.get("role") == "assistant" and data.get("phase") in {"commentary", "final", "final_answer"}:
                kind = "final" if data.get("phase") == "final_answer" else data.get("phase")
            else:
                continue
            text = get_text(data.get("content"))
            timestamp = item.get("timestamp")
            message_id = data.get("id") or item.get("id") or f"{kind}:{timestamp if timestamp is not None else ''}:{record_index}:{text}"
        elif provider == "codebuddy" and item.get("type") == "message":
            if item.get("role") == "user":
                kind = "user"
            elif item.get("role") == "assistant":
                kind = "reply"
            else:
                continue
            text = get_text(item.get("content"))
            provider_data = item.get("providerData") or {}
            message_id = provider_data.get("messageId") or item.get("id")
        if not text:
            continue
        message_id = str(message_id or f"{kind}:{text}")
        if message_id in seen:
            continue
        seen.add(message_id)
        messages.append({
            "id": message_id,
            "provider": provider,
            "kind": kind,
            "text": text,
            "timestamp": timestamp_ms(item.get("timestamp")),
        })
    return messages


def codex_rollout(session_id):
    database_file = os.path.expanduser("~/.codex/state_5.sqlite")
    if not os.path.isfile(database_file):
        raise RuntimeError("Codex history is unavailable")
    connection = sqlite3.connect(f"file:{database_file}?mode=ro", uri=True)
    try:
        row = connection.execute("SELECT rollout_path FROM threads WHERE id = ? AND source IN ('cli', 'vscode') AND first_user_message <> ''", (session_id,)).fetchone()
    finally:
        connection.close()
    if not row or not os.path.isfile(row[0]):
        raise RuntimeError("Codex conversation is unavailable")
    return row[0]


def codebuddy_transcript(session_id):
    for file_name in codebuddy_files():
        if os.path.splitext(os.path.basename(file_name))[0] == session_id:
            return file_name
    raise RuntimeError("CodeBuddy conversation is unavailable")


def opencode_database():
    data_home = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    database_file = os.path.join(data_home, "opencode", "opencode.db")
    if not os.path.isfile(database_file):
        return None
    connection = sqlite3.connect(f"file:{database_file}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    for table, required in {
        "session": {"id", "directory", "title", "parent_id", "time_created", "time_updated", "time_archived"},
        "message": {"id", "session_id", "time_created", "data"},
        "part": {"id", "message_id", "session_id", "time_created", "data"},
    }.items():
        columns = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
        if not required.issubset(columns):
            connection.close()
            raise RuntimeError("Unsupported OpenCode history schema")
    return connection


def list_opencode(payload):
    connection = opencode_database()
    if connection is None:
        return []
    try:
        archived_filter = "" if payload.get("includeArchived") else "AND (s.time_archived IS NULL OR s.time_archived = 0)"
        cwd_filter = "" if payload.get("scope") == "all" else "AND rtrim(s.directory, '/') = ?"
        parameters = () if payload.get("scope") == "all" else (str(payload.get("cwd") or "").rstrip("/"),)
        rows = connection.execute(f"""SELECT s.id, s.directory, s.title, s.time_created, s.time_updated, s.time_archived,
             (SELECT json_extract(p.data, '$.text') FROM message m JOIN part p ON p.message_id = m.id
              WHERE m.session_id = s.id AND json_extract(m.data, '$.role') = 'user'
                AND json_extract(p.data, '$.type') = 'text' AND trim(json_extract(p.data, '$.text')) <> ''
              ORDER BY m.time_created, p.time_created LIMIT 1) AS preview
             FROM session s WHERE s.parent_id IS NULL {archived_filter} {cwd_filter}""", parameters).fetchall()
        return [{"ref": f"opencode:{row['id']}", "provider": "opencode",
                 "title": row["title"] or row["preview"] or "OpenCode conversation",
                 "preview": row["preview"] or "", "cwd": row["directory"] or "",
                 "createdAt": timestamp_ms(row["time_created"]), "updatedAt": timestamp_ms(row["time_updated"]),
                 "archived": bool(row["time_archived"])}
                for row in rows]
    finally:
        connection.close()


def opencode_messages(session_id):
    connection = opencode_database()
    if connection is None:
        raise RuntimeError("OpenCode conversation is unavailable")
    try:
        if connection.execute("SELECT 1 FROM session WHERE id = ? AND parent_id IS NULL", (session_id,)).fetchone() is None:
            raise RuntimeError("OpenCode conversation is unavailable")
        rows = connection.execute("""SELECT m.id, m.time_created, json_extract(m.data, '$.role') AS role,
            json_extract(m.data, '$.summary') AS summary, p.data AS part_data
            FROM message m JOIN part p ON p.message_id = m.id WHERE m.session_id = ?
            ORDER BY m.time_created, m.id, p.time_created, p.id""", (session_id,)).fetchall()
        messages = {}
        for row in rows:
            if row["role"] not in {"user", "assistant"}:
                continue
            try:
                part = json.loads(row["part_data"])
            except (TypeError, ValueError):
                continue
            text = part.get("text") if part.get("type") == "text" else None
            if not isinstance(text, str) or not text.strip():
                continue
            message = messages.setdefault(row["id"], {"id": row["id"], "provider": "opencode",
                "kind": "user" if row["role"] == "user" else "summary" if row["summary"] == 1 else "reply", "text": "",
                "timestamp": timestamp_ms(row["time_created"])})
            message["text"] += ("\n\n" if message["text"] else "") + text.strip()
        return list(messages.values())
    finally:
        connection.close()


def gemini_transcript(session_id):
    project_hash, separator, file_id = session_id.partition(":")
    if not separator:
        raise RuntimeError("Invalid Gemini conversation reference")
    root = os.environ.get("GEMINI_CLI_HOME") or os.path.expanduser("~")
    for extension in ("jsonl", "json"):
        candidate = os.path.join(root, ".gemini", "tmp", project_hash, "chats", f"{file_id}.{extension}")
        if os.path.isfile(candidate):
            return candidate
    raise RuntimeError("Gemini conversation is unavailable")


def cursor(payload):
    value = payload.get("cursor")
    if value in {None, ""}:
        return 0
    if not re.fullmatch(r"\d+", str(value)):
        raise RuntimeError("Invalid history cursor")
    return int(value)


def list_history(payload):
    providers = payload.get("providers") or ["codex", "codebuddy", "opencode", "gemini", "grok"]
    if any(provider not in PROVIDERS for provider in providers):
        raise RuntimeError("Unsupported history provider")
    items = []
    errors = []
    for provider in providers:
        try:
            items.extend(list_codex(payload) if provider == "codex" else list_opencode(payload) if provider == "opencode" else list_gemini(payload) if provider == "gemini" else list_grok(payload) if provider == "grok" else list_codebuddy(payload))
        except Exception:
            errors.append({"provider": provider, "message": f"{'Codex' if provider == 'codex' else 'OpenCode' if provider == 'opencode' else 'Gemini' if provider == 'gemini' else 'Grok' if provider == 'grok' else 'CodeBuddy'} history is unavailable."})
    query = str(payload.get("query") or "").strip().lower()
    if query:
        items = [item for item in items if any(query in str(item.get(field) or "").lower() for field in ("title", "preview", "cwd"))]
    items.sort(key=lambda item: (-item["updatedAt"], item["ref"]))
    offset = cursor(payload)
    limit = max(1, min(200, int(payload.get("limit") or 50)))
    page = items[offset:offset + limit]
    return {"items": page, "nextCursor": str(offset + len(page)) if offset + len(page) < len(items) else None, "errors": errors}


# Versioned, private cross-process snapshots. Each page reads only its own rows.
SNAPSHOT_TTL = 3600
SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024
SNAPSHOT_MAX_COUNT = 32


def snapshot_root():
    root = os.path.join(os.path.expanduser("~"), ".cache", "pannel-handle", "history-v1")
    os.makedirs(root, mode=0o700, exist_ok=True)
    return root


def prune_snapshots(root):
    entries = []
    for name in glob.glob(os.path.join(root, "*.sqlite")):
        try:
            stat = os.stat(name)
            entries.append((stat.st_mtime, stat.st_size, name))
        except OSError:
            pass
    entries.sort(reverse=True)
    total = 0
    for index, (modified, size, name) in enumerate(entries):
        total += size
        if time.time() - modified > SNAPSHOT_TTL or index >= SNAPSHOT_MAX_COUNT or total > SNAPSHOT_MAX_BYTES:
            try:
                os.unlink(name)
            except OSError:
                pass


def source_signature(files):
    result = []
    for name in files:
        try:
            stat = os.stat(name)
            result.append((os.path.realpath(name), stat.st_dev, stat.st_ino, stat.st_size,
                           stat.st_mtime_ns, stat.st_ctime_ns))
        except FileNotFoundError:
            result.append((os.path.realpath(name), None))
    return result


def snapshot_page(payload, files, load, attempt=0):
    value = str(payload.get("cursor") or "")
    token = re.fullmatch(r"([0-9a-f]{64}):(\d+)", value)
    offset = int(token[2]) if token else cursor(payload)
    limit = max(1, min(200, int(payload.get("limit") or 100)))
    root = snapshot_root()
    prune_snapshots(root)
    signature = source_signature(files) if not token else None
    key = token[1] if token else hashlib.sha256(json.dumps(
        [payload["conversationRef"], signature], sort_keys=True).encode()).hexdigest()
    name = os.path.join(root, key + ".sqlite")
    if not os.path.isfile(name):
        if token:
            raise RuntimeError("History snapshot expired; reload the first page")
        messages = sorted(load(), key=lambda item: -item["timestamp"])
        # Do not associate a changing source with the signature captured before parsing.
        if source_signature(files) != signature:
            if attempt >= 2:
                raise RuntimeError("History source is changing; retry the first page")
            return snapshot_page(payload, files, load, attempt + 1)
        descriptor, temporary = tempfile.mkstemp(prefix="snapshot-", dir=root)
        os.close(descriptor)
        try:
            connection = sqlite3.connect(temporary)
            try:
                connection.execute("CREATE TABLE metadata (ref TEXT, count INTEGER)")
                connection.execute("INSERT INTO metadata VALUES (?, ?)", (payload["conversationRef"], len(messages)))
                connection.execute("CREATE TABLE messages (position INTEGER PRIMARY KEY, data TEXT)")
                connection.executemany("INSERT INTO messages VALUES (?, ?)",
                    ((index, json.dumps(message, ensure_ascii=False)) for index, message in enumerate(messages)))
                connection.commit()
            finally:
                connection.close()
            if os.path.getsize(temporary) > SNAPSHOT_MAX_BYTES:
                # Oversized histories remain readable without exceeding the disk budget.
                page = messages[offset:offset + limit]
                return {"conversationRef": payload["conversationRef"], "messages": page,
                        "nextCursor": str(offset + len(page)) if offset + len(page) < len(messages) else None}
            os.replace(temporary, name)
            prune_snapshots(root)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    connection = sqlite3.connect(f"file:{name}?mode=ro", uri=True)
    try:
        ref, count = connection.execute("SELECT ref, count FROM metadata").fetchone()
        if ref != payload["conversationRef"]:
            raise RuntimeError("Invalid history snapshot")
        page = [json.loads(row[0]) for row in connection.execute(
            "SELECT data FROM messages WHERE position >= ? AND position < ? ORDER BY position",
            (offset, offset + limit))]
    finally:
        connection.close()
    return {"conversationRef": payload["conversationRef"], "messages": page,
            "nextCursor": f"{key}:{offset + len(page)}" if offset + len(page) < count else None}


def history_messages(payload):
    match = re.fullmatch(r"(codex|codebuddy|opencode|gemini|grok):([A-Za-z0-9][A-Za-z0-9:_.-]{0,299})", str(payload.get("conversationRef") or ""))
    if not match:
        raise RuntimeError("Invalid conversation reference")
    provider, session_id = match.groups()
    if provider == "opencode":
        data_home = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
        database = os.path.join(data_home, "opencode", "opencode.db")
        files = [database, database + "-wal"]
        load = lambda: opencode_messages(session_id)
    elif provider == "grok":
        directory = next((candidate for candidate in grok_session_dirs() if os.path.basename(candidate) == session_id), None)
        if not directory:
            raise RuntimeError("Grok conversation is unavailable")
        files = [os.path.join(directory, "updates.jsonl")]
        load = lambda: grok_messages(directory)
    else:
        file_name = codex_rollout(session_id) if provider == "codex" else gemini_transcript(session_id) if provider == "gemini" else codebuddy_transcript(session_id)
        files = [file_name]
        if provider == "gemini":
            load = lambda: [{"id": str(item.get("id")), "provider": "gemini", "kind": "user" if item.get("type") == "user" else "reply", "text": item.get("content", ""), "timestamp": timestamp_ms(item.get("timestamp"))}
                           for item in gemini_messages(gemini_records(file_name)) if isinstance(item.get("content"), str) and item.get("content").strip()]
        else:
            load = lambda: parse_messages(provider, file_name)
    return snapshot_page(payload, files, load)


def main():
    action = sys.argv[1]
    payload = decode_payload()
    result = list_history(payload) if action == "list" else history_messages(payload) if action == "messages" else None
    if result is None:
        raise RuntimeError("Unsupported history action")
    print(json.dumps(result, ensure_ascii=False))


main()
