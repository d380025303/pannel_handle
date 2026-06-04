#!/usr/bin/env bash
set -u

PANNEL_HANDLE_HOOK_INPUT="$(cat)"
export PANNEL_HANDLE_HOOK_INPUT

python3 - "$PANNEL_HANDLE_HOOK_URL" "$PANNEL_HANDLE_SESSION_ID" <<'PY'
import json
import os
import sys
import urllib.parse
import urllib.request

hook_url = sys.argv[1] if len(sys.argv) > 1 else ""
panel_session_id = sys.argv[2] if len(sys.argv) > 2 else ""
if not hook_url:
    raise SystemExit(0)

parsed = urllib.parse.urlparse(hook_url)
codex_hook_url = urllib.parse.urlunparse(parsed._replace(path="/codex-hook"))
raw = os.environ.get("PANNEL_HANDLE_HOOK_INPUT", "")

try:
    payload = json.loads(raw) if raw.strip() else {}
except Exception as exc:
    payload = {
        "parse_error": str(exc),
        "raw_input": raw,
    }

if not isinstance(payload, dict):
    payload = {"raw_input": payload}

payload["cwd"] = os.getcwd()
payload["pannel_handle_session_id"] = panel_session_id

try:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        codex_hook_url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(request, timeout=2).read()
except Exception as exc:
    print(str(exc), file=sys.stderr)
PY
