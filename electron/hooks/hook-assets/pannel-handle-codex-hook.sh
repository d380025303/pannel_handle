#!/usr/bin/env bash
PANNEL_HANDLE_HOOK_INPUT="$(cat)"
export PANNEL_HANDLE_HOOK_INPUT

python3 - "$PANNEL_HANDLE_HOOK_URL" "$PANNEL_HANDLE_SESSION_ID" <<'PY'
import collections, json, os, sys, urllib.parse, urllib.request

hook_url = sys.argv[1] if len(sys.argv) > 1 else ""
panel_session_id = sys.argv[2] if len(sys.argv) > 2 else ""
if not hook_url:
    sys.exit(0)

parsed = urllib.parse.urlparse(hook_url)
codex_hook_url = urllib.parse.urlunparse(parsed._replace(path="/codex-hook"))
raw = os.environ.get("PANNEL_HANDLE_HOOK_INPUT", "")
try:
    payload = json.loads(raw) if raw.strip() else {}
except Exception as exc:
    payload = {"parse_error": str(exc), "raw_input": raw}

transcript_path = payload.get("transcript_path") or payload.get("transcriptPath")
transcript_items = []
transcript_bytes = 0
if isinstance(transcript_path, str) and transcript_path.endswith(".jsonl"):
    try:
        with open(transcript_path, "r", encoding="utf-8") as transcript:
            lines = collections.deque(transcript, maxlen=500)
        for line in lines:
            try:
                row = json.loads(line)
            except Exception:
                continue
            item = row.get("payload") if row.get("type") == "response_item" else None
            if not isinstance(item, dict) or item.get("type") != "message" or item.get("role") != "assistant":
                continue
            content = item.get("content")
            if isinstance(content, list):
                text = "\n".join(part.get("text", "") for part in content if isinstance(part, dict) and isinstance(part.get("text"), str)).strip()
            else:
                text = content.strip() if isinstance(content, str) else ""
            item_id = item.get("id")
            if not text or not isinstance(item_id, str):
                continue
            encoded_size = len(text.encode("utf-8"))
            if encoded_size > 128 * 1024 or transcript_bytes + encoded_size > 512 * 1024:
                continue
            transcript_bytes += encoded_size
            entry = {"id": item_id, "phase": "final" if item.get("phase") == "final" else "commentary", "content": text}
            timestamp = row.get("timestamp")
            if isinstance(timestamp, str):
                entry["timestamp"] = timestamp
            transcript_items.append(entry)
    except Exception:
        pass
if transcript_items:
    payload["pannel_handle_transcript_items"] = transcript_items

payload["cwd"] = os.getcwd()
payload["pannel_handle_session_id"] = panel_session_id
data = json.dumps(payload).encode("utf-8")

urls = [codex_hook_url]
if parsed.hostname in ("127.0.0.1", "localhost"):
    try:
        with open("/etc/resolv.conf", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("nameserver "):
                    urls.append(urllib.parse.urlparse(codex_hook_url)._replace(netloc=f"{line.split()[1]}:{parsed.port}").geturl())
                    break
    except Exception:
        pass

last_error = None
for url in urls:
    try:
        request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(request, timeout=2).read()
        sys.exit(0)
    except Exception as exc:
        last_error = exc

print(last_error, file=sys.stderr)
PY
