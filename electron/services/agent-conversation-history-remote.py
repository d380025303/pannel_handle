import base64
import datetime
import glob
import hashlib
import json
import os
import re
import sqlite3
import sys

PROVIDERS = {"codex", "codebuddy", "gemini", "grok"}


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


def iter_jsonl(file_name):
    try:
        with open(file_name, "r", encoding="utf-8") as source:
            for line in source:
                try:
                    yield json.loads(line)
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
        rows = connection.execute(
            f"""SELECT id, cwd, title, created_at, updated_at, archived, first_user_message, preview
                FROM threads
                WHERE source IN ('cli', 'vscode') AND first_user_message <> '' {archived}
                ORDER BY {order} LIMIT 5000"""
        ).fetchall()
    finally:
        connection.close()
    expected_cwd = str(payload.get("cwd") or "").rstrip("/")
    items = []
    for row in rows:
        cwd = str(row["cwd"] or "")
        if payload.get("scope") != "all" and cwd.rstrip("/") != expected_cwd:
            continue
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


def list_codebuddy(payload):
    expected_cwd = str(payload.get("cwd") or "").rstrip("/")
    items = []
    for file_name in codebuddy_files():
        item = codebuddy_metadata(file_name)
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


def gemini_messages(file_name):
    messages = {}
    for item in gemini_records(file_name):
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
        messages = gemini_messages(file_name)
        first_user = next((item for item in messages if item.get("type") == "user"), {})
        preview = first_user.get("content") if isinstance(first_user.get("content"), str) else ""
        project_hash = os.path.basename(os.path.dirname(os.path.dirname(file_name)))
        session_id = os.path.splitext(os.path.basename(file_name))[0]
        items.append({"ref": f"gemini:{project_hash}:{session_id}", "provider": "gemini", "title": preview or "Gemini conversation", "preview": preview,
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
        text = content if isinstance(content, str) else get_text(content) if isinstance(content, list) else str((content or {}).get("text") or "")
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
    for item in iter_jsonl(file_name):
        message_id = None
        kind = None
        text = ""
        if provider == "codex" and item.get("type") == "response_item":
            data = item.get("payload") or {}
            if data.get("type") != "message":
                continue
            if data.get("role") == "user":
                kind = "user"
            elif data.get("role") == "assistant" and data.get("phase") in {"commentary", "final"}:
                kind = data.get("phase")
            else:
                continue
            text = get_text(data.get("content"))
            message_id = data.get("id") or item.get("id")
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
    providers = payload.get("providers") or ["codex", "codebuddy", "gemini", "grok"]
    if any(provider not in PROVIDERS for provider in providers):
        raise RuntimeError("Unsupported history provider")
    items = []
    errors = []
    for provider in providers:
        try:
            items.extend(list_codex(payload) if provider == "codex" else list_gemini(payload) if provider == "gemini" else list_grok(payload) if provider == "grok" else list_codebuddy(payload))
        except Exception:
            errors.append({"provider": provider, "message": f"{'Codex' if provider == 'codex' else 'Gemini' if provider == 'gemini' else 'Grok' if provider == 'grok' else 'CodeBuddy'} history is unavailable."})
    query = str(payload.get("query") or "").strip().lower()
    if query:
        items = [item for item in items if any(query in str(item.get(field) or "").lower() for field in ("title", "preview", "cwd"))]
    items.sort(key=lambda item: (-item["updatedAt"], item["ref"]))
    offset = cursor(payload)
    limit = max(1, min(200, int(payload.get("limit") or 50)))
    page = items[offset:offset + limit]
    return {"items": page, "nextCursor": str(offset + len(page)) if offset + len(page) < len(items) else None, "errors": errors}


def history_messages(payload):
    match = re.fullmatch(r"(codex|codebuddy|gemini|grok):([A-Za-z0-9][A-Za-z0-9:_.-]{0,299})", str(payload.get("conversationRef") or ""))
    if not match:
        raise RuntimeError("Invalid conversation reference")
    provider, session_id = match.groups()
    if provider == "grok":
        directory = next((candidate for candidate in grok_session_dirs() if os.path.basename(candidate) == session_id), None)
        if not directory:
            raise RuntimeError("Grok conversation is unavailable")
        messages = grok_messages(directory)
        file_name = None
    else:
        file_name = codex_rollout(session_id) if provider == "codex" else gemini_transcript(session_id) if provider == "gemini" else codebuddy_transcript(session_id)
    if provider == "gemini":
        messages = [{"id": str(item.get("id")), "provider": "gemini", "kind": "user" if item.get("type") == "user" else "reply", "text": item.get("content", ""), "timestamp": timestamp_ms(item.get("timestamp"))}
                    for item in gemini_messages(file_name) if isinstance(item.get("content"), str) and item.get("content").strip()]
    elif provider != "grok":
        messages = parse_messages(provider, file_name)
    messages = sorted(messages, key=lambda item: -item["timestamp"])
    offset = cursor(payload)
    limit = max(1, min(200, int(payload.get("limit") or 100)))
    page = messages[offset:offset + limit]
    return {
        "conversationRef": payload["conversationRef"],
        "messages": page,
        "nextCursor": str(offset + len(page)) if offset + len(page) < len(messages) else None,
    }


def main():
    action = sys.argv[1]
    payload = decode_payload()
    result = list_history(payload) if action == "list" else history_messages(payload) if action == "messages" else None
    if result is None:
        raise RuntimeError("Unsupported history action")
    print(json.dumps(result, ensure_ascii=False))


main()
