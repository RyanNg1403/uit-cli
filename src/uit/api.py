"""Moodle REST API client."""

import os
import requests
from uit.config import get


def _api_url():
    return f"{get('base_url')}/webservice/rest/server.php"


def call(function: str, **params) -> dict | list:
    """Call a Moodle web service function. Returns parsed JSON."""
    params["wstoken"] = get("token")
    params["wsfunction"] = function
    params["moodlewsrestformat"] = "json"
    resp = requests.get(_api_url(), params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, dict) and "exception" in data:
        raise RuntimeError(data.get("message", data.get("error", str(data))))
    return data


def upload_file(filepath: str) -> dict:
    """Upload a file to the user's draft area. Returns dict with itemid."""
    filename = os.path.basename(filepath)
    with open(filepath, "rb") as f:
        resp = requests.post(
            f"{get('base_url')}/webservice/upload.php",
            data={"token": get("token"), "filearea": "draft", "itemid": 0},
            files={"file": (filename, f)},
            timeout=120,
        )
    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, list) and len(data) > 0:
        return data[0]
    if isinstance(data, dict) and "error" in data:
        raise RuntimeError(data["error"])
    return data


def download_file(file_url: str, dest_path: str):
    """Download a Moodle file, authenticating with token."""
    sep = "&" if "?" in file_url else "?"
    url = f"{file_url}{sep}token={get('token')}"
    resp = requests.get(url, stream=True, timeout=60)
    resp.raise_for_status()
    os.makedirs(os.path.dirname(dest_path) or ".", exist_ok=True)
    with open(dest_path, "wb") as f:
        for chunk in resp.iter_content(8192):
            f.write(chunk)
