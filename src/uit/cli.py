#!/usr/bin/env python3
"""uit — CLI for courses.uit.edu.vn"""

import argparse
import html
import json
import os
import sys
from datetime import datetime

from uit.config import get, save
from uit.api import call, upload_file, download_file


# ── Output helpers ───────────────────────────────────────────────────────

_json_mode = False


def die(msg: str, hint: str = ""):
    """Print error and exit. JSON-safe."""
    payload = {"error": msg}
    if hint:
        payload["hint"] = hint
    if _json_mode:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(f"Error: {msg}", file=sys.stderr)
        if hint:
            print(f"Hint:  {hint}", file=sys.stderr)
    sys.exit(1)


def out(data):
    """Print data. In --json mode prints JSON, otherwise human-readable."""
    if _json_mode:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        if isinstance(data, str):
            print(data)
        elif isinstance(data, list):
            for row in data:
                print(row)
        elif isinstance(data, dict):
            for k, v in data.items():
                print(f"{k}: {v}")


def table(rows: list[dict], columns: list[tuple[str, str, int]]):
    """Print a list of dicts as a table. columns = [(key, header, width), ...]"""
    if _json_mode:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return
    if not rows:
        print("(no results)")
        return
    header = "  ".join(h.ljust(w) for _, h, w in columns)
    print(header)
    print("-" * len(header))
    for row in rows:
        parts = []
        for key, _, w in columns:
            val = str(row.get(key, ""))
            parts.append(val.ljust(w))
        print("  ".join(parts))


def clean(text: str) -> str:
    """Decode HTML entities (Moodle returns &amp; etc.)."""
    return html.unescape(text)


def ts(epoch: int) -> str:
    if not epoch:
        return ""
    return datetime.fromtimestamp(epoch).strftime("%Y-%m-%d %H:%M")


def sanitize(name: str) -> str:
    return "".join(c if c.isalnum() or c in " ._-" else "_" for c in name).strip()


# ── Commands ─────────────────────────────────────────────────────────────

def cmd_init(args):
    token = args.token
    base_url = args.url.rstrip("/")

    import requests
    resp = requests.get(
        f"{base_url}/webservice/rest/server.php",
        params={
            "wstoken": token,
            "wsfunction": "core_webservice_get_site_info",
            "moodlewsrestformat": "json",
        },
        timeout=15,
    )
    data = resp.json()
    if "exception" in data:
        die(data.get("message", "invalid token"))

    user_id = data["userid"]
    save(token, user_id, base_url)
    out({"status": "ok", "user": data["fullname"], "user_id": user_id, "site": data["sitename"]})


def cmd_courses(args):
    courses = call("core_enrol_get_users_courses", userid=get("user_id"))
    if args.current:
        max_cat = max(c.get("category", 0) for c in courses)
        courses = [c for c in courses if c.get("category", 0) >= max_cat - 20]

    courses.sort(key=lambda x: x["id"], reverse=True)
    rows = [{"id": c["id"], "short": c["shortname"], "name": clean(c["fullname"])} for c in courses]
    table(rows, [("id", "ID", 8), ("short", "SHORT", 20), ("name", "COURSE", 50)])


def cmd_contents(args):
    sections = call("core_course_get_contents", courseid=args.course_id)
    if _json_mode:
        items = []
        for section in sections:
            for mod in section.get("modules", []):
                item = {
                    "section": clean(section["name"]),
                    "module_id": mod["id"],
                    "type": mod.get("modname", ""),
                    "name": clean(mod["name"]),
                }
                if mod.get("contents"):
                    item["files"] = [
                        {"filename": f["filename"], "fileurl": f["fileurl"], "filesize": f.get("filesize", 0)}
                        for f in mod["contents"]
                    ]
                items.append(item)
        print(json.dumps(items, ensure_ascii=False, indent=2))
        return

    for section in sections:
        if not section.get("modules"):
            continue
        print(f"\n{'='*60}")
        print(f"  {clean(section['name'])}")
        print(f"{'='*60}")
        for mod in section["modules"]:
            modtype = mod.get("modname", "?")
            print(f"  [{modtype:<10}] {clean(mod['name'])}")
            for f in mod.get("contents", []):
                size = f.get("filesize", 0)
                size_str = f"{size/1024:.0f}KB" if size < 1_048_576 else f"{size/1_048_576:.1f}MB"
                print(f"               -> {f['filename']}  ({size_str})")


def cmd_download(args):
    course_id = args.course_id
    courses = call("core_enrol_get_users_courses", userid=get("user_id"))
    course_name = next((c["shortname"] for c in courses if c["id"] == course_id), str(course_id))
    dest_root = os.path.join(args.output or ".", sanitize(course_name))
    sections = call("core_course_get_contents", courseid=course_id)

    results = []
    for section in sections:
        section_name = sanitize(section.get("name", "General"))
        for mod in section.get("modules", []):
            for f in mod.get("contents", []):
                if f.get("type") != "file":
                    continue
                filepath = f.get("filepath", "/").strip("/")
                dest = os.path.join(dest_root, section_name, filepath, f["filename"]) if filepath else os.path.join(dest_root, section_name, f["filename"])

                if os.path.exists(dest) and not args.force:
                    results.append({"file": f["filename"], "status": "skipped", "path": dest})
                    if not _json_mode:
                        print(f"  SKIP  {dest}")
                    continue

                try:
                    if not _json_mode:
                        print(f"  GET   {f['filename']}...", end="", flush=True)
                    download_file(f["fileurl"], dest)
                    results.append({"file": f["filename"], "status": "ok", "path": dest})
                    if not _json_mode:
                        print("  OK")
                except Exception as e:
                    results.append({"file": f["filename"], "status": "error", "error": str(e)})
                    if not _json_mode:
                        print(f"  FAIL: {e}")

    if _json_mode:
        print(json.dumps({"dest": dest_root, "files": results}, ensure_ascii=False, indent=2))
    else:
        ok = sum(1 for r in results if r["status"] == "ok")
        print(f"\nDownloaded {ok} file(s) to {dest_root}/")


def cmd_deadlines(args):
    if args.course_id:
        course_ids = [args.course_id]
    else:
        courses = call("core_enrol_get_users_courses", userid=get("user_id"))
        course_ids = [c["id"] for c in courses]

    params = {f"courseids[{i}]": cid for i, cid in enumerate(course_ids)}
    result = call("mod_assign_get_assignments", **params)

    rows = []
    for course in result.get("courses", []):
        for a in course.get("assignments", []):
            rows.append({
                "id": a["id"],
                "cmid": a["cmid"],
                "course": course["shortname"],
                "course_name": clean(course["fullname"]),
                "name": clean(a["name"]),
                "due": a["duedate"],
                "due_fmt": ts(a["duedate"]),
            })

    now = datetime.now().timestamp()
    if not args.all:
        rows = [r for r in rows if r["due"] == 0 or r["due"] > now]
    rows.sort(key=lambda r: r["due"] if r["due"] else float("inf"))

    if _json_mode:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        table(rows, [("due_fmt", "DUE", 18), ("course", "COURSE", 16), ("course_name", "COURSE NAME", 45), ("name", "ASSIGNMENT", 40), ("id", "ID", 8)])


def cmd_submit(args):
    filepath = args.file
    if not os.path.isfile(filepath):
        die(f"file not found: {filepath}")

    if not _json_mode:
        print(f"Uploading {filepath}...")
    upload_result = upload_file(filepath)
    item_id = upload_result.get("itemid")
    if not item_id:
        die("upload failed", f"response: {upload_result}")

    if not _json_mode:
        print(f"Submitting to assignment {args.assign_id}...")
    call(
        "mod_assign_save_submission",
        assignmentid=args.assign_id,
        **{"plugindata[files_filemanager]": item_id},
    )

    status = call("mod_assign_get_submission_status", assignid=args.assign_id)
    sub = status.get("lastattempt", {}).get("submission", {})
    result = {
        "status": "submitted",
        "assign_id": args.assign_id,
        "file": os.path.basename(filepath),
        "submission_status": sub.get("status", "unknown"),
        "time": ts(sub.get("timemodified", 0)),
    }
    out(result)


def cmd_status(args):
    status = call("mod_assign_get_submission_status", assignid=args.assign_id)
    sub = status.get("lastattempt", {}).get("submission", {})
    feedback = status.get("feedback", {})

    result = {"assign_id": args.assign_id}
    if sub:
        result["status"] = sub.get("status", "unknown")
        result["submitted"] = ts(sub.get("timemodified", 0))
        result["attempt"] = sub.get("attemptnumber", 0) + 1
        files = []
        for plugin in sub.get("plugins", []):
            if plugin.get("type") == "file":
                for area in plugin.get("fileareas", []):
                    for f in area.get("files", []):
                        files.append({"name": f["filename"], "size": f.get("filesize", 0)})
        if files:
            result["files"] = files
    else:
        result["status"] = "none"

    if feedback:
        grade = feedback.get("grade", {})
        if grade and grade.get("grade"):
            result["grade"] = grade["grade"]
            result["graded_on"] = ts(grade.get("timemodified", 0))

    out(result)


def cmd_grades(args):
    result = call("gradereport_user_get_grade_items", courseid=args.course_id, userid=get("user_id"))
    items = result.get("usergrades", [{}])[0].get("gradeitems", [])

    rows = []
    for item in items:
        rows.append({
            "item": clean(item.get("itemname") or item.get("itemtype", "?")),
            "grade": item.get("gradeformatted", "-"),
            "max": item.get("grademax", ""),
            "percentage": item.get("percentageformatted", ""),
        })

    if _json_mode:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        table(rows, [("item", "ITEM", 50), ("grade", "GRADE", 10), ("max", "MAX", 6), ("percentage", "%", 10)])


def cmd_raw(args):
    """Call any Moodle API function directly. Agent power tool."""
    params = {}
    for p in (args.params or []):
        k, _, v = p.partition("=")
        params[k] = v
    result = call(args.function, **params)
    print(json.dumps(result, ensure_ascii=False, indent=2))


# ── CLI ──────────────────────────────────────────────────────────────────

WORKFLOW = """
workflow:
  uit courses --current        -> get course IDs
  uit contents  <course_id>    -> browse modules and files
  uit download  <course_id>    -> download all course files
  uit deadlines                -> get assignment IDs and due dates
  uit grades    <course_id>    -> view grades
  uit submit    <assign_id> <file>  -> submit to assignment
  uit status    <assign_id>    -> check submission result

  ID chain: courses -> course_id -> contents/download/deadlines/grades
            deadlines -> assign_id -> submit/status
"""


def main():
    parser = argparse.ArgumentParser(
        prog="uit",
        description="CLI for courses.uit.edu.vn (Moodle LMS at UIT).",
        epilog=WORKFLOW,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--json", action="store_true", help="JSON output for scripts and agents")
    sub = parser.add_subparsers(dest="command")

    # init
    p = sub.add_parser("init", help="Set up credentials (~/.uit/.env)")
    p.add_argument("token", help="Moodle API token from /login/token.php")
    p.add_argument("--url", default="https://courses.uit.edu.vn", help="Moodle base URL")

    # courses
    p = sub.add_parser("courses", help="List enrolled courses (outputs course IDs)")
    p.add_argument("--current", action="store_true", help="Current semester only")

    # contents
    p = sub.add_parser("contents", help="Browse sections, modules, and files in a course")
    p.add_argument("course_id", type=int, help="Course ID from 'uit courses'")

    # download
    p = sub.add_parser("download", help="Download all files from a course")
    p.add_argument("course_id", type=int, help="Course ID from 'uit courses'")
    p.add_argument("-o", "--output", default=".", help="Output directory (default: .)")
    p.add_argument("--force", action="store_true", help="Re-download existing files")

    # deadlines
    p = sub.add_parser("deadlines", help="List assignment deadlines (outputs assign IDs)")
    p.add_argument("--course-id", type=int, help="Course ID to filter (from 'uit courses')")
    p.add_argument("--all", action="store_true", help="Include past deadlines")

    # submit
    p = sub.add_parser("submit", help="Upload and submit a file to an assignment")
    p.add_argument("assign_id", type=int, help="Assignment ID from 'uit deadlines'")
    p.add_argument("file", help="Path to file to submit")

    # status
    p = sub.add_parser("status", help="Check submission status and grade for an assignment")
    p.add_argument("assign_id", type=int, help="Assignment ID from 'uit deadlines'")

    # grades
    p = sub.add_parser("grades", help="Show grade report for a course")
    p.add_argument("course_id", type=int, help="Course ID from 'uit courses'")

    # raw
    p = sub.add_parser("raw", help="Call any Moodle API function directly")
    p.add_argument("function", help="API function name, e.g. core_course_get_contents")
    p.add_argument("params", nargs="*", help="Parameters as key=value, e.g. courseid=19589")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(0)

    global _json_mode
    _json_mode = args.json

    cmd = {
        "init": cmd_init,
        "courses": cmd_courses,
        "contents": cmd_contents,
        "download": cmd_download,
        "deadlines": cmd_deadlines,
        "submit": cmd_submit,
        "status": cmd_status,
        "grades": cmd_grades,
        "raw": cmd_raw,
    }[args.command]
    try:
        cmd(args)
    except RuntimeError as e:
        msg = str(e)
        hint = ""
        if "không truy cập" in msg or "not accessible" in msg.lower():
            hint = "Check if the ID is correct. Use 'uit courses' for course IDs, 'uit deadlines' for assignment IDs."
        die(msg, hint)
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
