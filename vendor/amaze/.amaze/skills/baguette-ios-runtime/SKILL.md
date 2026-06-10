---
name: baguette-ios-runtime
description: Use Baguette/app.clab.one as the only browser-accessible iOS Simulator runtime for Amaze iOS app development. Use when monitoring, controlling, or proving an iOS Simulator through a browser, and avoid starting serve-sim or any second simulator mirror.
---

# Baguette iOS Runtime

## Policy

Use Baguette as the only browser-accessible iOS Simulator runtime for this project.

- Do not start `serve-sim`, another simulator mirror, or another emulator/browser bridge for the same workflow.
- Do not vendor Baguette's Swift code into Amaze or into the user's app. Treat it as an external host-side runtime.
- Use exactly one Simulator UDID per task unless the user explicitly asks for multi-device testing.
- Reuse the running Baguette service before spawning anything new.

## Runtime Endpoint

Open:

```text
https://app.clab.one/simulators
```

This proxies to local Baguette on `127.0.0.1:8421` and intentionally has no Basic Auth.

## Start or Recover

Baguette is managed by launchd:

```bash
launchctl print gui/$(id -u)/one.clab.baguette
launchctl kickstart -k gui/$(id -u)/one.clab.baguette
```

Stable runtime location:

```text
/Users/steve/.amaze/runtimes/baguette
/Users/steve/.amaze/runtimes/baguette/.build/debug/Baguette
```

Service file:

```text
/Users/steve/Library/LaunchAgents/one.clab.baguette.plist
```

Logs:

```text
/Users/steve/.amaze/logs/baguette/stdout.log
/Users/steve/.amaze/logs/baguette/stderr.log
```

## Use

1. Check `https://app.clab.one/simulators` or `/simulators.json`.
2. Choose the existing booted simulator when possible.
3. If no simulator is booted, boot one through Baguette or the existing XcodeBuildMCP simulator workflow.
4. For low-latency input automation, use one persistent `baguette input --udid <simulator-udid>` process for the active workflow.
5. Verify with a real Baguette frame or WebSocket stream before claiming browser-visible simulator proof.

## Verification

Minimum checks before reporting success:

```bash
python3 - <<'PY'
import json, urllib.request
with urllib.request.urlopen('https://app.clab.one/simulators.json', timeout=8) as r:
    data = json.loads(r.read().decode())
    print(r.status, len(data.get('available', [])), len(data.get('running', [])))
PY
```

For streaming, verify WebSocket upgrade returns `101 Switching Protocols` for `/simulators/<udid>/stream?format=mjpeg`.
