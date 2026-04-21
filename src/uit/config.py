"""Configuration — reads from .env file."""

import os
import sys

_cfg = None


def _find_env_file() -> str | None:
    """Walk up from cwd looking for .env, fall back to ~/.uit/.env"""
    # Check cwd and parents
    d = os.getcwd()
    for _ in range(10):
        candidate = os.path.join(d, ".env")
        if os.path.isfile(candidate):
            return candidate
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    # Fall back to home dir
    candidate = os.path.expanduser("~/.uit/.env")
    if os.path.isfile(candidate):
        return candidate
    return None


def _parse_env(path: str) -> dict[str, str]:
    """Minimal .env parser — handles KEY=VALUE and KEY="VALUE"."""
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            env[key] = val
    return env


def _load():
    global _cfg
    if _cfg is not None:
        return _cfg

    path = _find_env_file()
    if not path:
        print("No .env file found. Run:  uit init", file=sys.stderr)
        sys.exit(1)

    env = _parse_env(path)

    token = env.get("UIT_TOKEN")
    base_url = env.get("UIT_BASE_URL", "https://courses.uit.edu.vn")
    user_id = env.get("UIT_USER_ID")

    if not token:
        print("UIT_TOKEN not set in .env. Run:  uit init", file=sys.stderr)
        sys.exit(1)

    _cfg = {
        "token": token,
        "base_url": base_url.rstrip("/"),
        "user_id": int(user_id) if user_id else None,
    }
    return _cfg


def get(key: str):
    return _load()[key]


def save(token: str, user_id: int, base_url: str):
    path = os.path.expanduser("~/.uit/.env")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(f'UIT_TOKEN="{token}"\n')
        f.write(f'UIT_BASE_URL="{base_url}"\n')
        f.write(f"UIT_USER_ID={user_id}\n")
    os.chmod(path, 0o600)
    print(f"Saved to {path}", file=sys.stderr)
