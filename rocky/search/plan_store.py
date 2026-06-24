from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any


class PlanNotFoundError(KeyError):
    pass


class JsonPlanStore:
    def __init__(self, root: str | Path, ttl_seconds: int = 7200) -> None:
        self.root = Path(root).expanduser().resolve()
        self.ttl_seconds = ttl_seconds
        self.root.mkdir(parents=True, exist_ok=True)

    def put(self, plan: dict[str, Any]) -> None:
        plan_id = str(plan["plan_id"])
        now = time.time()
        stored = {
            **plan,
            "stored_at": plan.get("stored_at", now),
            "expires_at": plan.get("expires_at", now + self.ttl_seconds),
        }
        self._path(plan_id).write_text(json.dumps(stored, ensure_ascii=False, indent=2), encoding="utf-8")

    def get(self, plan_id: str) -> dict[str, Any]:
        path = self._path(plan_id)
        if not path.exists():
            raise PlanNotFoundError(plan_id)
        plan = json.loads(path.read_text(encoding="utf-8"))
        if float(plan.get("expires_at", 0)) < time.time():
            path.unlink(missing_ok=True)
            raise PlanNotFoundError(plan_id)
        return plan

    def delete(self, plan_id: str) -> bool:
        path = self._path(plan_id)
        existed = path.exists()
        path.unlink(missing_ok=True)
        return existed

    def stats(self) -> dict[str, Any]:
        self.cleanup()
        files = list(self.root.glob("*.json"))
        total_bytes = sum(path.stat().st_size for path in files if path.exists())
        return {"root": str(self.root), "count": len(files), "bytes": total_bytes, "ttl_seconds": self.ttl_seconds}

    def cleanup(self) -> int:
        removed = 0
        now = time.time()
        for path in self.root.glob("*.json"):
            try:
                plan = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                path.unlink(missing_ok=True)
                removed += 1
                continue
            if float(plan.get("expires_at", 0)) < now:
                path.unlink(missing_ok=True)
                removed += 1
        return removed

    def _path(self, plan_id: str) -> Path:
        safe = "".join(ch for ch in plan_id if ch.isalnum() or ch in {"_", "-"})
        if not safe:
            raise ValueError("invalid plan_id")
        return self.root / f"{safe}.json"
