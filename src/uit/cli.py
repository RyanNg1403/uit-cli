#!/usr/bin/env python3
"""uit — CLI for courses.uit.edu.vn"""

import argparse
import html as html_mod
import json
import os
import re
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
        for i, (key, _, w) in enumerate(columns):
            val = str(row.get(key, ""))
            is_last = i == len(columns) - 1
            if not is_last and len(val) > w:
                val = val[:w - 1] + "…"
            parts.append(val.ljust(w))
        print("  ".join(parts))


def clean(text: str) -> str:
    """Decode HTML entities (Moodle returns &amp; etc.)."""
    return html_mod.unescape(text)


def html_to_text(html_str: str) -> str:
    """Convert HTML to readable plain text. Preserves line breaks and list items."""
    if not html_str:
        return ""
    s = html_str
    # Block-level elements -> newlines
    s = re.sub(r'<br\s*/?>', '\n', s)
    s = re.sub(r'</p>', '\n', s)
    s = re.sub(r'</div>', '\n', s)
    s = re.sub(r'</h[1-6]>', '\n', s)
    s = re.sub(r'<li[^>]*>', '  - ', s)
    s = re.sub(r'</li>', '\n', s)
    # Strip remaining tags
    s = re.sub(r'<[^>]+>', '', s)
    s = html_mod.unescape(s)
    # Collapse excessive blank lines
    s = re.sub(r'\n{3,}', '\n\n', s)
    return s.strip()


def extract_urls(html_str: str) -> list[str]:
    """Extract href URLs from HTML."""
    if not html_str:
        return []
    return re.findall(r'href="([^"]+)"', html_str)


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
            mid = mod["id"]
            print(f"  {mid:<8} [{modtype:<10}] {clean(mod['name'])}")
            for f in mod.get("contents", []):
                size = f.get("filesize", 0)
                size_str = f"{size/1024:.0f}KB" if size < 1_048_576 else f"{size/1_048_576:.1f}MB"
                print(f"                          -> {f['filename']}  ({size_str})")


def _resolve_assign_to_module(assign_id):
    """Try to find the module ID (cmid) for an assign_id."""
    courses = call("core_enrol_get_users_courses", userid=get("user_id"))
    course_ids = [c["id"] for c in courses]
    params = {f"courseids[{i}]": cid for i, cid in enumerate(course_ids)}
    result = call("mod_assign_get_assignments", **params)
    for course in result.get("courses", []):
        for a in course.get("assignments", []):
            if a["id"] == assign_id:
                return a["cmid"]
    return None


def cmd_view(args):
    """Inspect any module by its ID. Also accepts assign_id from 'uit deadlines'."""
    module_id = args.module_id
    # Resolve module type and instance
    try:
        info = call("core_course_get_course_module", cmid=module_id)
    except RuntimeError:
        # Maybe it's an assign_id — try to resolve to module_id
        cmid = _resolve_assign_to_module(module_id)
        if cmid:
            module_id = cmid
            info = call("core_course_get_course_module", cmid=module_id)
        else:
            die(f"ID {args.module_id} is not a valid module ID or assignment ID.",
                "Use 'uit contents <course_id>' for module IDs, 'uit deadlines' for assignment IDs.")
    cm = info.get("cm", {})
    modname = cm.get("modname", "")
    instance = cm.get("instance")
    course_id = cm.get("course")
    name = clean(cm.get("name", ""))

    handler = {
        "assign": _view_assign,
        "forum": _view_forum,
        "resource": _view_resource,
        "folder": _view_resource,
        "lesson": _view_lesson,
        "url": _view_url,
        "quiz": _view_quiz,
        "page": _view_page,
        "book": _view_book,
    }.get(modname)

    if handler:
        handler(module_id, instance, course_id, name)
    else:
        # Generic fallback: show what we know
        result = {"module_id": module_id, "type": modname, "name": name, "instance": instance, "course_id": course_id}
        # Try to get files from contents
        sections = call("core_course_get_contents", courseid=course_id)
        files = _find_module_files(sections, module_id)
        if files:
            result["files"] = files
        out(result)


def _find_module_files(sections, module_id):
    """Find files for a specific module from course contents."""
    for section in sections:
        for mod in section.get("modules", []):
            if mod["id"] == module_id and mod.get("contents"):
                return [
                    {"filename": f["filename"], "fileurl": f["fileurl"], "filesize": f.get("filesize", 0)}
                    for f in mod["contents"] if f.get("type") == "file"
                ]
    return []


def _view_assign(module_id, instance, course_id, name):
    # Get assignment details
    params = {f"courseids[0]": course_id}
    result = call("mod_assign_get_assignments", **params)
    assign = None
    for c in result.get("courses", []):
        for a in c.get("assignments", []):
            if a["id"] == instance:
                assign = a
                break

    if not assign:
        die(f"Assignment instance {instance} not found in course {course_id}")

    intro_html = assign.get("intro", "")
    intro_text = html_to_text(intro_html)
    urls = extract_urls(intro_html)

    # Get submission status
    sub_status = call("mod_assign_get_submission_status", assignid=instance)
    sub = sub_status.get("lastattempt", {}).get("submission", {})

    data = {
        "module_id": module_id,
        "assign_id": instance,
        "type": "assign",
        "name": clean(assign["name"]),
        "due": ts(assign["duedate"]),
        "cutoff": ts(assign.get("cutoffdate", 0)),
        "description": intro_text,
        "submission_status": sub.get("status", "none"),
    }

    if urls:
        data["urls"] = urls
    if sub.get("timemodified"):
        data["submitted_at"] = ts(sub["timemodified"])

    # Files attached to assignment description
    attach = assign.get("introattachments", [])
    if attach:
        data["attachments"] = [{"filename": f["filename"], "fileurl": f.get("fileurl", ""), "filesize": f.get("filesize", 0)} for f in attach]

    # Submission config
    file_enabled = any(
        c.get("plugin") == "file" and c.get("subtype") == "assignsubmission" and c.get("name") == "enabled" and c.get("value") == "1"
        for c in assign.get("configs", [])
    )
    text_enabled = any(
        c.get("plugin") == "onlinetext" and c.get("subtype") == "assignsubmission" and c.get("name") == "enabled" and c.get("value") == "1"
        for c in assign.get("configs", [])
    )
    submission_types = []
    if file_enabled:
        submission_types.append("file")
    if text_enabled:
        submission_types.append("onlinetext")
    if submission_types:
        data["submission_types"] = submission_types

    if _json_mode:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(f"[assign] {data['name']}")
        print(f"assign_id:   {data['assign_id']}  (use with 'uit submit' / 'uit status')")
        print(f"due:         {data['due']}")
        if data["cutoff"]:
            print(f"cutoff:      {data['cutoff']}")
        print(f"status:      {data['submission_status']}")
        if data.get("submitted_at"):
            print(f"submitted:   {data['submitted_at']}")
        if submission_types:
            print(f"accepts:     {', '.join(submission_types)}")
        if data.get("attachments"):
            print(f"\nAttachments:")
            for f in data["attachments"]:
                print(f"  {f['filename']}")
        if intro_text:
            print(f"\nDescription:\n{intro_text}")
        if urls:
            print(f"\nURLs:")
            for u in urls:
                print(f"  {u}")


def _view_forum(module_id, instance, course_id, name):
    discussions = call("mod_forum_get_forum_discussions", forumid=instance)
    discs = discussions.get("discussions", [])

    rows = []
    for d in discs:
        rows.append({
            "id": d["discussion"],
            "subject": clean(d.get("subject", "")),
            "author": d.get("userfullname", ""),
            "replies": d.get("numreplies", 0),
            "date": ts(d.get("timemodified", 0)),
        })

    if _json_mode:
        print(json.dumps({"module_id": module_id, "type": "forum", "name": name, "discussions": rows}, ensure_ascii=False, indent=2))
    else:
        print(f"[forum] {name}")
        print(f"module_id: {module_id}\n")
        table(rows, [("id", "ID", 8), ("subject", "SUBJECT", 50), ("author", "AUTHOR", 20), ("replies", "RE", 4), ("date", "DATE", 18)])
        if rows:
            print(f"\nTip: uit view-discussion <discussion_id> to read posts")


def _view_resource(module_id, instance, course_id, name):
    sections = call("core_course_get_contents", courseid=course_id)
    files = _find_module_files(sections, module_id)
    data = {"module_id": module_id, "type": "resource", "name": name, "files": files}

    if _json_mode:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(f"[resource] {name}")
        print(f"module_id: {module_id}\n")
        for f in files:
            size = f["filesize"]
            size_str = f"{size/1024:.0f}KB" if size < 1_048_576 else f"{size/1_048_576:.1f}MB"
            print(f"  {f['filename']}  ({size_str})")
        if files:
            print(f"\nTip: uit download {course_id} --module {module_id}")


def _view_lesson(module_id, instance, course_id, name):
    lesson = call("mod_lesson_get_lesson", lessonid=instance)
    info = lesson.get("lesson", {})
    intro_html = info.get("intro", "")
    intro_text = html_to_text(intro_html)
    urls = extract_urls(intro_html)

    data = {
        "module_id": module_id,
        "type": "lesson",
        "name": clean(info.get("name", name)),
        "description": intro_text,
    }
    if urls:
        data["urls"] = urls

    if _json_mode:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(f"[lesson] {data['name']}")
        print(f"module_id: {module_id}")
        if intro_text:
            print(f"\nDescription:\n{intro_text}")
        if urls:
            print(f"\nURLs:")
            for u in urls:
                print(f"  {u}")


def _view_url(module_id, instance, course_id, name):
    sections = call("core_course_get_contents", courseid=course_id)
    target_url = ""
    for section in sections:
        for mod in section.get("modules", []):
            if mod["id"] == module_id and mod.get("contents"):
                target_url = mod["contents"][0].get("fileurl", "")
                break

    data = {"module_id": module_id, "type": "url", "name": name, "url": target_url}
    if _json_mode:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(f"[url] {name}")
        print(f"module_id: {module_id}")
        print(f"url: {target_url}")


def _view_quiz(module_id, instance, course_id, name):
    quizzes = call("mod_quiz_get_quizzes_by_courses", **{f"courseids[0]": course_id})
    quiz = None
    for q in quizzes.get("quizzes", []):
        if q["id"] == instance:
            quiz = q
            break

    if not quiz:
        out({"module_id": module_id, "type": "quiz", "name": name, "error": "quiz not found"})
        return

    intro_text = html_to_text(quiz.get("intro", ""))
    attempts = call("mod_quiz_get_user_attempts", quizid=instance, userid=get("user_id"), status="all")
    att_list = attempts.get("attempts", [])

    data = {
        "module_id": module_id,
        "type": "quiz",
        "name": clean(quiz.get("name", name)),
        "time_open": ts(quiz.get("timeopen", 0)),
        "time_close": ts(quiz.get("timeclose", 0)),
        "time_limit": quiz.get("timelimit", 0),
        "grade": quiz.get("grade", 0),
        "attempts": len(att_list),
        "description": intro_text,
    }

    if _json_mode:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(f"[quiz] {data['name']}")
        print(f"module_id: {module_id}")
        print(f"opens:     {data['time_open']}")
        print(f"closes:    {data['time_close']}")
        if data["time_limit"]:
            print(f"limit:     {data['time_limit']}s")
        print(f"max grade: {data['grade']}")
        print(f"attempts:  {data['attempts']}")
        if intro_text:
            print(f"\nDescription:\n{intro_text}")


def _view_page(module_id, instance, course_id, name):
    pages = call("mod_page_get_pages_by_courses", **{f"courseids[0]": course_id})
    page = None
    for p in pages.get("pages", []):
        if p["id"] == instance:
            page = p
            break

    if not page:
        out({"module_id": module_id, "type": "page", "name": name})
        return

    content_html = page.get("content", "")
    content_text = html_to_text(content_html)
    urls = extract_urls(content_html)

    data = {"module_id": module_id, "type": "page", "name": clean(page.get("name", name)), "content": content_text}
    if urls:
        data["urls"] = urls

    if _json_mode:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(f"[page] {data['name']}")
        print(f"module_id: {module_id}")
        if content_text:
            print(f"\n{content_text}")
        if urls:
            print(f"\nURLs:")
            for u in urls:
                print(f"  {u}")


def _view_book(module_id, instance, course_id, name):
    books = call("mod_book_get_books_by_courses", **{f"courseids[0]": course_id})
    book = None
    for b in books.get("books", []):
        if b["id"] == instance:
            book = b
            break

    intro_text = html_to_text(book.get("intro", "")) if book else ""
    data = {"module_id": module_id, "type": "book", "name": name, "description": intro_text}

    sections = call("core_course_get_contents", courseid=course_id)
    files = _find_module_files(sections, module_id)
    if files:
        data["files"] = files

    if _json_mode:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(f"[book] {name}")
        print(f"module_id: {module_id}")
        if intro_text:
            print(f"\n{intro_text}")
        if files:
            print(f"\nFiles:")
            for f in files:
                print(f"  {f['filename']}")


def cmd_view_discussion(args):
    """Read all posts in a forum discussion."""
    disc_id = args.discussion_id
    result = call("mod_forum_get_discussion_posts", discussionid=disc_id)
    posts = result.get("posts", [])

    if _json_mode:
        rows = []
        for p in posts:
            msg_html = p.get("message", "")
            rows.append({
                "id": p.get("id"),
                "author": p.get("author", {}).get("fullname", ""),
                "date": ts(p.get("timecreated", 0)),
                "subject": clean(p.get("subject", "")),
                "message": html_to_text(msg_html),
                "urls": extract_urls(msg_html),
                "attachments": [
                    {"filename": a["filename"], "fileurl": a.get("fileurl", ""), "filesize": a.get("filesize", 0)}
                    for a in p.get("attachments", [])
                ] if p.get("attachments") else [],
            })
        print(json.dumps({"discussion_id": disc_id, "posts": rows}, ensure_ascii=False, indent=2))
    else:
        for p in posts:
            author = p.get("author", {}).get("fullname", "?")
            date = ts(p.get("timecreated", 0))
            subject = clean(p.get("subject", ""))
            msg = html_to_text(p.get("message", ""))
            urls = extract_urls(p.get("message", ""))

            post_id = p.get("id", "")
            print(f"\n{'─'*60}")
            print(f"  {subject}")
            print(f"  {author}  |  {date}  |  post_id: {post_id}")
            print(f"{'─'*60}")
            if msg:
                print(msg)
            if urls:
                print(f"\n  URLs:")
                for u in urls:
                    print(f"    {u}")
            for a in p.get("attachments", []):
                print(f"  Attachment: {a['filename']}")


def cmd_announcements(args):
    """Show announcements (Cac thong bao) for a course."""
    course_id = args.course_id
    sections = call("core_course_get_contents", courseid=course_id)

    # Find the announcements forum — usually the first forum module
    forum_id = None
    forum_module_id = None
    for section in sections:
        for mod in section.get("modules", []):
            if mod.get("modname") == "forum":
                forum_module_id = mod["id"]
                # Get instance ID from course module info
                cm_info = call("core_course_get_course_module", cmid=mod["id"])
                forum_id = cm_info.get("cm", {}).get("instance")
                break
        if forum_id:
            break

    if not forum_id:
        die("No forum found in this course")

    discussions = call("mod_forum_get_forum_discussions", forumid=forum_id)
    discs = discussions.get("discussions", [])

    limit = args.limit
    if limit:
        discs = discs[:limit]

    if args.full and discs:
        # Show full content of each discussion's first post
        if _json_mode:
            rows = []
            for d in discs:
                msg_html = d.get("message", "")
                rows.append({
                    "discussion_id": d["discussion"],
                    "subject": clean(d.get("subject", "")),
                    "author": d.get("userfullname", ""),
                    "date": ts(d.get("timemodified", 0)),
                    "message": html_to_text(msg_html),
                    "urls": extract_urls(msg_html),
                    "replies": d.get("numreplies", 0),
                })
            print(json.dumps(rows, ensure_ascii=False, indent=2))
        else:
            for d in discs:
                subject = clean(d.get("subject", ""))
                author = d.get("userfullname", "")
                date = ts(d.get("timemodified", 0))
                msg = html_to_text(d.get("message", ""))
                urls = extract_urls(d.get("message", ""))
                replies = d.get("numreplies", 0)

                print(f"\n{'─'*60}")
                print(f"  {subject}")
                print(f"  {author}  |  {date}  |  {replies} replies")
                print(f"  discussion_id: {d['discussion']}")
                print(f"{'─'*60}")
                if msg:
                    print(msg)
                if urls:
                    print(f"\n  URLs:")
                    for u in urls:
                        print(f"    {u}")
    else:
        rows = []
        for d in discs:
            rows.append({
                "id": d["discussion"],
                "subject": clean(d.get("subject", "")),
                "author": d.get("userfullname", ""),
                "replies": d.get("numreplies", 0),
                "date": ts(d.get("timemodified", 0)),
            })
        if _json_mode:
            print(json.dumps(rows, ensure_ascii=False, indent=2))
        else:
            table(rows, [("id", "ID", 8), ("subject", "SUBJECT", 50), ("author", "AUTHOR", 20), ("replies", "RE", 4), ("date", "DATE", 18)])
            if rows:
                print(f"\nTip: uit announcements {course_id} --full  to read content")
                print(f"     uit view-discussion <id>  to read a specific thread")


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
            # Filter by module if specified
            if args.module and mod["id"] != args.module:
                continue
            for f in mod.get("contents", []):
                if f.get("type") != "file":
                    continue
                # Filter by filename if specified
                if args.file and args.file.lower() not in f["filename"].lower():
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


def cmd_functions(args):
    """List and search available Moodle API functions."""
    info = call("core_webservice_get_site_info")
    fns = info.get("functions", [])

    query = args.query
    if query:
        fns = [f for f in fns if query.lower() in f["name"].lower()]

    if _json_mode:
        rows = [{"name": f["name"], "version": f.get("version", "")} for f in fns]
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return

    if not fns:
        print(f'(no functions matching "{query}")')
        return

    groups: dict[str, list[str]] = {}
    for f in fns:
        parts = f["name"].split("_", 2)
        prefix = "_".join(parts[:2]) if len(parts) >= 2 else parts[0]
        groups.setdefault(prefix, []).append(f["name"])

    for prefix in sorted(groups):
        names = sorted(groups[prefix])
        print(f"\n{prefix} ({len(names)})")
        for name in names:
            print(f"  {name}")

    print(f"\nTotal: {len(fns)} functions")
    if not query:
        print("Tip: uit functions <keyword> to filter, e.g. 'uit functions assign'")
    print("Tip: uit raw <function_name> key=value ... to call any function")


def cmd_reply(args):
    """Reply to a forum post."""
    post_id = args.post_id
    message = args.message
    subject = args.subject

    # Get the parent post to auto-fill subject if not provided
    if not subject:
        parent = call("mod_forum_get_discussion_post", postid=post_id)
        parent_subject = parent.get("post", {}).get("subject", "")
        subject = f"Re: {parent_subject}" if parent_subject else "Re:"

    result = call(
        "mod_forum_add_discussion_post",
        postid=post_id,
        subject=subject,
        message=message,
    )

    data = {
        "status": "posted",
        "post_id": result.get("postid", ""),
        "parent_post_id": post_id,
        "subject": subject,
    }
    out(data)


def cmd_raw(args):
    """Call any Moodle API function directly."""
    params = {}
    for p in (args.params or []):
        k, _, v = p.partition("=")
        params[k] = v
    try:
        result = call(args.function, **params)
    except RuntimeError as e:
        msg = str(e)
        hint = (
            "Moodle error messages reveal required parameters. "
            "Try calling with no params to see what's needed, "
            "or check: https://docs.moodle.org/dev/Web_service_API_functions"
        )
        die(msg, hint)
    print(json.dumps(result, ensure_ascii=False, indent=2))


# ── Branding ─────────────────────────────────────────────────────────────

LOGO = r"""
  \033[1;34m       ▄▄███▄▄  ▄▄▄███▄\033[0m
  \033[1;34m     ▄█▀██▀█▄█▀▀▀▄  ▀▀▀█▄\033[0m
  \033[1;34m   ▄███▀▄██▀      ▀▄    █\033[0m    \033[1;36m██╗   ██╗██╗████████╗\033[0m
  \033[1;34m   ▄█▀▄█▀▄   ▄     █    ▀\033[0m    \033[1;36m██║   ██║██║╚══██╔══╝\033[0m
  \033[1;34m   ▀▄█▀ ███▄███     ▄  ▄▀\033[0m    \033[1;36m██║   ██║██║   ██║\033[0m
  \033[1;34m  ▄██▄▄ ▀▀███▀▀▄▄▄  ▀  ▀\033[0m     \033[1;36m██║   ██║██║   ██║\033[0m
  \033[1;34m ██▀ ▀█ ██▀ ▀██▀██ █\033[0m         \033[1;36m╚██████╔╝██║   ██║\033[0m
  \033[1;34m ███ ▄▄█▀██   ██▀█▄▄\033[0m          \033[1;36m╚═════╝ ╚═╝   ╚═╝\033[0m  \033[2mv0.1.0\033[0m
  \033[1;34m ███  ▀██▄██▄██▄██▀\033[0m
  \033[1;34m ███▄    ▀▀▀▀▀█▀▀\033[0m
  \033[1;34m  ▀███████▀▀▀\033[0m
""".replace(r"\033", "\033")


# ── CLI ──────────────────────────────────────────────────────────────────

WORKFLOW = """
workflow:
  uit courses --current                -> get course IDs
  uit contents  <course_id>            -> browse modules (shows module IDs)
  uit view      <id>                   -> inspect any module (accepts module_id or assign_id)
  uit download  <course_id>            -> download files (whole course or targeted)
  uit announcements <course_id>        -> read course announcements
  uit deadlines                        -> assignment IDs and due dates
  uit grades    <course_id>            -> view grades
  uit submit    <assign_id> <file>     -> submit to assignment
  uit status    <assign_id>            -> check submission result
  uit view-discussion <discussion_id>  -> read forum thread (shows post IDs)
  uit reply     <post_id> <message>    -> reply to a forum post
  uit functions [keyword]              -> discover 420+ raw API functions
  uit raw <function> key=value         -> call any Moodle API function

  ID chain: courses   -> course_id  -> contents / download / announcements / deadlines / grades
            contents  -> module_id  -> view
            view      -> assign_id  -> submit / status
                      -> discussion_id -> view-discussion
            view-discussion -> post_id -> reply
            deadlines -> assign_id  -> view / submit / status

  Use --json before any command for structured JSON output.
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
    p = sub.add_parser("contents", help="Browse course tree — sections, modules, files (outputs module IDs)")
    p.add_argument("course_id", type=int, help="Course ID from 'uit courses'")

    # view
    p = sub.add_parser("view", help="Inspect any module: assignment, forum, resource, lesson, quiz, ...")
    p.add_argument("module_id", type=int, help="Module ID from 'uit contents', or assignment ID from 'uit deadlines'")

    # view-discussion
    p = sub.add_parser("view-discussion", help="Read all posts in a forum discussion")
    p.add_argument("discussion_id", type=int, help="Discussion ID from 'uit view' on a forum or 'uit announcements'")

    # announcements
    p = sub.add_parser("announcements", help="Read course announcements (Cac thong bao)")
    p.add_argument("course_id", type=int, help="Course ID from 'uit courses'")
    p.add_argument("-n", "--limit", type=int, help="Show only the N most recent")
    p.add_argument("--full", action="store_true", help="Show full message content, not just subjects")

    # download
    p = sub.add_parser("download", help="Download files from a course (all, or filtered)")
    p.add_argument("course_id", type=int, help="Course ID from 'uit courses'")
    p.add_argument("-o", "--output", default=".", help="Output directory (default: .)")
    p.add_argument("--module", type=int, help="Only download from this module ID (from 'uit contents')")
    p.add_argument("--file", help="Only download files matching this name (substring match)")
    p.add_argument("--force", action="store_true", help="Re-download existing files")

    # deadlines
    p = sub.add_parser("deadlines", help="List assignment deadlines (outputs assign IDs)")
    p.add_argument("--course-id", type=int, help="Course ID to filter (from 'uit courses')")
    p.add_argument("--all", action="store_true", help="Include past deadlines")

    # submit
    p = sub.add_parser("submit", help="Upload and submit a file to an assignment")
    p.add_argument("assign_id", type=int, help="Assignment ID from 'uit deadlines' or 'uit view'")
    p.add_argument("file", help="Path to file to submit")

    # status
    p = sub.add_parser("status", help="Check submission status and grade for an assignment")
    p.add_argument("assign_id", type=int, help="Assignment ID from 'uit deadlines' or 'uit view'")

    # reply
    p = sub.add_parser("reply", help="Reply to a forum post")
    p.add_argument("post_id", type=int, help="Post ID from 'uit view-discussion'")
    p.add_argument("message", help="Reply message text")
    p.add_argument("-s", "--subject", help="Subject line (default: Re: <original subject>)")

    # grades
    p = sub.add_parser("grades", help="Show grade report for a course")
    p.add_argument("course_id", type=int, help="Course ID from 'uit courses'")

    # functions
    p = sub.add_parser("functions", help="List/search available Moodle API functions (420+)")
    p.add_argument("query", nargs="?", default="", help="Filter by keyword, e.g. 'assign', 'quiz', 'forum'")

    # raw
    p = sub.add_parser("raw", help="Call any Moodle API function (use 'uit functions' to discover)")
    p.add_argument("function", help="API function name (from 'uit functions')")
    p.add_argument("params", nargs="*", help="Parameters as key=value, e.g. courseid=19589")

    args = parser.parse_args()
    if not args.command:
        if args.json:
            parser.print_help()
        else:
            print(LOGO)
            print("  CLI for courses.uit.edu.vn — Moodle LMS at UIT")
            print()
            print("  \033[1mGet started:\033[0m    uit courses --current")
            print("  \033[1mBrowse:\033[0m         uit contents <course_id>")
            print("  \033[1mInspect:\033[0m        uit view <module_id>")
            print("  \033[1mAnnouncements:\033[0m  uit announcements <course_id>")
            print("  \033[1mDownload:\033[0m       uit download <course_id>")
            print("  \033[1mDeadlines:\033[0m      uit deadlines")
            print()
            print("  \033[2muit --help for all commands and the full workflow diagram\033[0m")
            print()
        sys.exit(0)

    global _json_mode
    _json_mode = args.json

    cmd = {
        "init": cmd_init,
        "courses": cmd_courses,
        "contents": cmd_contents,
        "view": cmd_view,
        "view-discussion": cmd_view_discussion,
        "announcements": cmd_announcements,
        "download": cmd_download,
        "deadlines": cmd_deadlines,
        "submit": cmd_submit,
        "status": cmd_status,
        "reply": cmd_reply,
        "grades": cmd_grades,
        "functions": cmd_functions,
        "raw": cmd_raw,
    }[args.command]
    try:
        cmd(args)
    except RuntimeError as e:
        msg = str(e)
        hint = ""
        if "không truy cập" in msg or "not accessible" in msg.lower():
            hint = "Check if the ID is correct. Use 'uit courses' for course IDs, 'uit contents' for module IDs, 'uit deadlines' for assignment IDs."
        die(msg, hint)
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
