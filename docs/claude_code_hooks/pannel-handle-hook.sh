#!/usr/bin/env bash
PANNEL_HANDLE_HOOK_INPUT="$(cat)"
export PANNEL_HANDLE_HOOK_INPUT

python3 - "$PANNEL_HANDLE_HOOK_URL" "$PANNEL_HANDLE_SESSION_ID" <<'PY'
import json, os, sys, urllib.request, urllib.parse

hook_url = sys.argv[1] if len(sys.argv) > 1 else ""
panel_session_id = sys.argv[2] if len(sys.argv) > 2 else ""
if not hook_url:
    sys.exit(0)

raw = os.environ.get("PANNEL_HANDLE_HOOK_INPUT", "")
try:
    payload = json.loads(raw) if raw.strip() else {}
except Exception as exc:
    payload = {"parse_error": str(exc), "raw_input": raw}

payload["cwd"] = os.getcwd()
payload["pannel_handle_session_id"] = panel_session_id

body = json.dumps(payload).encode("utf-8")

def post(url):
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=2) as res:
        res.read()

urls = [hook_url]

parsed = urllib.parse.urlparse(hook_url)
if parsed.hostname in ("127.0.0.1", "localhost"):
    try:
        with open("/etc/resolv.conf", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("nameserver "):
                    host = line.split()[1]
                    urls.append(parsed._replace(netloc=f"{host}:{parsed.port}").geturl())
                    break
    except Exception:
        pass

last_error = None
for url in urls:
    try:
        post(url)
        sys.exit(0)
    except Exception as exc:
        last_error = exc

print(last_error, file=sys.stderr)
PY
