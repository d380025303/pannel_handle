import base64
import datetime
import glob
import json
import os
import re
import sqlite3
import sys

PROVIDERS = {"codex", "codebuddy"}


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


def cursor(payload):
    value = payload.get("cursor")
    if value in {None, ""}:
        return 0
    if not re.fullmatch(r"\d+", str(value)):
        raise RuntimeError("Invalid history cursor")
    return int(value)


def list_history(payload):
    providers = payload.get("providers") or ["codex", "codebuddy"]
    if any(provider not in PROVIDERS for provider in providers):
        raise RuntimeError("Unsupported history provider")
    items = []
    errors = []
    for provider in providers:
        try:
            items.extend(list_codex(payload) if provider == "codex" else list_codebuddy(payload))
        except Exception:
            errors.append({"provider": provider, "message": f"{'Codex' if provider == 'codex' else 'CodeBuddy'} history is unavailable."})
    query = str(payload.get("query") or "").strip().lower()
    if query:
        items = [item for item in items if any(query in str(item.get(field) or "").lower() for field in ("title", "preview", "cwd"))]
    items.sort(key=lambda item: (-item["updatedAt"], item["ref"]))
    offset = cursor(payload)
    limit = max(1, min(200, int(payload.get("limit") or 50)))
    page = items[offset:offset + limit]
    return {"items": page, "nextCursor": str(offset + len(page)) if offset + len(page) < len(items) else None, "errors": errors}


def history_messages(payload):
    match = re.fullmatch(r"(codex|codebuddy):([A-Za-z0-9][A-Za-z0-9:_-]{0,199})", str(payload.get("conversationRef") or ""))
    if not match:
        raise RuntimeError("Invalid conversation reference")
    provider, session_id = match.groups()
    file_name = codex_rollout(session_id) if provider == "codex" else codebuddy_transcript(session_id)
    messages = sorted(parse_messages(provider, file_name), key=lambda item: -item["timestamp"])
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
