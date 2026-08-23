#!/usr/bin/env bash
PANNEL_HANDLE_GEMINI_INPUT="$(cat)"
export PANNEL_HANDLE_GEMINI_INPUT

python3 - "$PANNEL_HANDLE_HOOK_URL" "$PANNEL_HANDLE_SESSION_ID" <<'PY'
import json, os, sys, urllib.parse, urllib.request

hook_url = sys.argv[1] if len(sys.argv) > 1 else ""
panel_session_id = sys.argv[2] if len(sys.argv) > 2 else ""
raw = os.environ.get("PANNEL_HANDLE_GEMINI_INPUT", "")
try:
    payload = json.loads(raw) if raw.strip() else {}
except Exception as exc:
    payload = {"parse_error": str(exc), "raw_input": raw}
payload["cwd"] = os.getcwd()
payload["pannel_handle_session_id"] = panel_session_id

if hook_url:
    parsed = urllib.parse.urlparse(hook_url)
    gemini_url = urllib.parse.urlunparse(parsed._replace(path="/gemini-hook"))
    urls = [gemini_url]
    if parsed.hostname in ("127.0.0.1", "localhost"):
        try:
            with open("/etc/resolv.conf", encoding="utf-8") as file:
                gateway = next(line.split()[1] for line in file if line.startswith("nameserver "))
            urls.append(urllib.parse.urlparse(gemini_url)._replace(netloc=f"{gateway}:{parsed.port}").geturl())
        except Exception:
            pass
    last_error = None
    for url in urls:
        try:
            request = urllib.request.Request(url, json.dumps(payload).encode(), {"Content-Type": "application/json"}, method="POST")
            urllib.request.urlopen(request, timeout=2).read()
            last_error = None
            break
        except Exception as exc:
            last_error = exc
    if last_error:
        print(last_error, file=sys.stderr)
print("{}")
PY
