#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import type { ApiClient } from "./types.js";
import { defaultApiClient } from "./api.js";
import { CliError, idOrUrl, setJsonMode, writeError } from "./output.js";
import {
  cmdAnnouncements,
  cmdContents,
  cmdCourses,
  cmdDeadlines,
  cmdDownload,
  cmdEvents,
  cmdFunctions,
  cmdGrades,
  cmdInit,
  cmdOpen,
  cmdRaw,
  cmdReply,
  cmdStatus,
  cmdSubmit,
  cmdView,
  cmdViewDiscussion,
  createContext
} from "./commands.js";
import { runMcpServer, installMcpServer } from "./mcp-server.js";

export const WORKFLOW = `
workflow:
  uit courses --current                -> get course IDs
  uit contents  <course_id>            -> browse modules (shows module IDs)
  uit view      <id>                   -> inspect any module (accepts module_id or assign_id)
  uit download  <course_id>            -> download files (whole course or targeted)
  uit announcements <course_id>        -> read course announcements
  uit deadlines                        -> assignment IDs and due dates
  uit events                           -> upcoming events: assignments, quizzes, more
  uit grades    <course_id>            -> view grades
  uit submit    <assign_id> <file>     -> submit to assignment
  uit status    <assign_id>            -> check submission result
  uit view-discussion <discussion_id>  -> read forum thread (shows post IDs)
  uit reply     <post_id> <message>    -> reply to a forum post
  uit open      <id>                   -> open in browser (module, course, or URL)
  uit functions [keyword]              -> discover 420+ raw API functions
  uit raw <function> key=value         -> call any Moodle API function

  ID chain: courses   -> course_id  -> contents / download / announcements / deadlines / grades
            contents  -> module_id  -> view
            view      -> assign_id  -> submit / status
                      -> discussion_id -> view-discussion
            view-discussion -> post_id -> reply
            deadlines -> assign_id  -> view / submit / status

  Use --json before any command for structured JSON output.
`;

const LOGO = String.raw`
  \u001b[1;34m       ▄▄███▄▄  ▄▄▄███▄\u001b[0m
  \u001b[1;34m     ▄█▀██▀█▄█▀▀▀▄  ▀▀▀█▄\u001b[0m
  \u001b[1;34m   ▄███▀▄██▀      ▀▄    █\u001b[0m    \u001b[1;36m██╗   ██╗██╗████████╗\u001b[0m
  \u001b[1;34m   ▄█▀▄█▀▄   ▄     █    ▀\u001b[0m    \u001b[1;36m██║   ██║██║╚══██╔══╝\u001b[0m
  \u001b[1;34m   ▀▄█▀ ███▄███     ▄  ▄▀\u001b[0m    \u001b[1;36m██║   ██║██║   ██║\u001b[0m
  \u001b[1;34m  ▄██▄▄ ▀▀███▀▀▄▄▄  ▀  ▀\u001b[0m     \u001b[1;36m██║   ██║██║   ██║\u001b[0m
  \u001b[1;34m ██▀ ▀█ ██▀ ▀██▀██ █\u001b[0m         \u001b[1;36m╚██████╔╝██║   ██║\u001b[0m
  \u001b[1;34m ███ ▄▄█▀██   ██▀█▄▄\u001b[0m          \u001b[1;36m╚═════╝ ╚═╝   ╚═╝\u001b[0m
  \u001b[1;34m ███  ▀██▄██▄██▄██▀\u001b[0m
  \u001b[1;34m ███▄    ▀▀▀▀▀█▀▀\u001b[0m
  \u001b[1;34m  ▀███████▀▀▀\u001b[0m
`.replaceAll("\\u001b", "\u001b");

function parseId(value: string): number {
  try {
    return idOrUrl(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

function parseInteger(value: string): number {
  if (!/^-?\d+$/.test(value)) throw new InvalidArgumentError(`expected an integer, got: ${value}`);
  return Number.parseInt(value, 10);
}

// Moodle reports a wrong/inaccessible course (e.g. a module ID passed as a course ID)
// with these error codes. Detect them by code so the hint works in any UI language.
const WRONG_ID_ERRORCODES = new Set(["invalidrecord", "errorcoursecontextnotvalid"]);

function isWrongIdError(error: Error & { errorcode?: string }): boolean {
  if (error.errorcode && WRONG_ID_ERRORCODES.has(error.errorcode)) return true;
  return error.message.includes("không truy cập") || error.message.toLowerCase().includes("not accessible");
}

function printLanding(): void {
  console.log(LOGO);
  console.log("  CLI for courses.uit.edu.vn — Moodle LMS at UIT");
  console.log();
  console.log("  \u001b[1mGet started:\u001b[0m    uit courses --current");
  console.log("  \u001b[1mBrowse:\u001b[0m         uit contents <course_id>");
  console.log("  \u001b[1mInspect:\u001b[0m        uit view <module_id>");
  console.log("  \u001b[1mAnnouncements:\u001b[0m  uit announcements <course_id>");
  console.log("  \u001b[1mDownload:\u001b[0m       uit download <course_id>");
  console.log("  \u001b[1mDeadlines:\u001b[0m      uit deadlines");
  console.log("  \u001b[1mUpcoming:\u001b[0m       uit events");
  console.log("  \u001b[1mOpen:\u001b[0m           uit open <id>");
  console.log();
  console.log("  \u001b[2muit --help for all commands and the full workflow diagram\u001b[0m");
  console.log();
}

export function createProgram(api: ApiClient = defaultApiClient, options: { openBrowser?: boolean } = {}): Command {
  const ctx = createContext(api);
  const program = new Command();

  program
    .name("uit")
    .description("CLI for courses.uit.edu.vn (Moodle LMS at UIT).")
    .addHelpText("after", WORKFLOW)
    .option("--json", "JSON output for scripts and agents")
    .exitOverride();

  program.hook("preAction", () => setJsonMode(Boolean(program.opts().json)));

  program
    .command("init")
    .description("Set up credentials (~/.uit/.env)")
    .argument("[token]", "Moodle API token from /login/token.php")
    .option("--url <url>", "Moodle base URL", "https://courses.uit.edu.vn")
    .option("--token <token>", "Use an existing Moodle API token instead of prompting for login")
    .option("-u, --username <username>", "Student ID for interactive token setup")
    .option("-p, --password <password>", "Password for non-interactive token setup")
    .action((token, opts) =>
      cmdInit({ token: opts.token || token, url: opts.url, username: opts.username, password: opts.password })
    );

  program
    .command("courses")
    .description("List enrolled courses (outputs course IDs)")
    .option("--current", "Current semester only")
    .action((opts) => cmdCourses({ current: opts.current }, ctx));

  program
    .command("contents")
    .description("Browse course tree — sections, modules, files (outputs module IDs)")
    .argument("<course_id>", "Course ID or course URL", parseId)
    .action((courseId) => cmdContents({ course_id: courseId }, ctx));

  program
    .command("view")
    .description("Inspect any module: assignment, forum, resource, lesson, quiz, ...")
    .argument("<module_id>", "Module ID, assignment ID, or Moodle URL", parseId)
    .action((moduleId) => cmdView({ module_id: moduleId }, ctx));

  program
    .command("view-discussion")
    .description("Read all posts in a forum discussion")
    .argument("<discussion_id>", "Discussion ID or discuss.php URL", parseId)
    .action((discussionId) => cmdViewDiscussion({ discussion_id: discussionId }, ctx));

  program
    .command("announcements")
    .description("Read course announcements (Cac thong bao)")
    .argument("<course_id>", "Course ID or course URL", parseId)
    .option("-n, --limit <number>", "Show only the N most recent", parseInteger)
    .option("--full", "Show full message content, not just subjects")
    .action((courseId, opts) => cmdAnnouncements({ course_id: courseId, limit: opts.limit, full: opts.full }, ctx));

  program
    .command("download")
    .description("Download files from a course (all, or filtered) — includes H5P activity packages")
    .argument("<course_id>", "Course ID or course URL", parseId)
    .option("-o, --output <dir>", "Output directory (default: .)", ".")
    .option("--module <module_id>", "Only download from this module ID or URL", parseId)
    .option("--file <name>", "Only download files matching this name (substring match)")
    .option("--extract", "Unpack downloaded .h5p packages into their media (slides, images, video)")
    .option("--force", "Re-download existing files")
    .action((courseId, opts) =>
      cmdDownload(
        { course_id: courseId, output: opts.output, module: opts.module, file: opts.file, extract: opts.extract, force: opts.force },
        ctx
      )
    );

  program
    .command("deadlines")
    .description("List assignment deadlines (outputs assign IDs)")
    .option("--course-id <course_id>", "Course ID or URL to filter", parseId)
    .option("--all", "Include past deadlines")
    .action((opts) => cmdDeadlines({ course_id: opts.courseId, all: opts.all }, ctx));

  program
    .command("submit")
    .description("Upload and submit a file to an assignment")
    .argument("<assign_id>", "Assignment ID from 'uit deadlines' or 'uit view'", parseInteger)
    .argument("<file>", "Path to file to submit")
    .action((assignId, file) => cmdSubmit({ assign_id: assignId, file }, ctx));

  program
    .command("status")
    .description("Check submission status and grade for an assignment")
    .argument("<assign_id>", "Assignment ID from 'uit deadlines' or 'uit view'", parseInteger)
    .action((assignId) => cmdStatus({ assign_id: assignId }, ctx));

  program
    .command("reply")
    .description("Reply to a forum post")
    .argument("<post_id>", "Post ID from 'uit view-discussion'", parseInteger)
    .argument("<message>", "Reply message text")
    .option("-s, --subject <subject>", "Subject line (default: Re: <original subject>)")
    .action((postId, message, opts) => cmdReply({ post_id: postId, message, subject: opts.subject }, ctx));

  program
    .command("grades")
    .description("Show grade report for a course")
    .argument("<course_id>", "Course ID or course URL", parseId)
    .action((courseId) => cmdGrades({ course_id: courseId }, ctx));

  program
    .command("events")
    .description("Upcoming events — assignments, quizzes, calendar (superset of deadlines)")
    .option("-n, --limit <number>", "Max events to show (default: 20)", parseInteger, 20)
    .option("--course-id <course_id>", "Filter to one course", parseId)
    .action((opts) => cmdEvents({ limit: opts.limit, course_id: opts.courseId }, ctx));

  program
    .command("open")
    .description("Open a Moodle page in the default browser")
    .argument("<id>", "Module ID, assignment ID, or Moodle URL")
    .option("--course", "Treat ID as a course ID")
    .option("--discussion", "Treat ID as a discussion ID")
    .action((id, opts) =>
      cmdOpen({ id, course: opts.course, discussion: opts.discussion, browser: options.openBrowser !== false }, ctx)
    );

  program
    .command("functions")
    .description("List/search available Moodle API functions (420+)")
    .argument("[query]", "Filter by keyword, e.g. 'assign', 'quiz', 'forum'", "")
    .action((query) => cmdFunctions({ query }, ctx));

  program
    .command("raw")
    .description("Call any Moodle API function (use 'uit functions' to discover)")
    .argument("<function>", "API function name (from 'uit functions')")
    .argument("[params...]", "Parameters as key=value, e.g. courseid=19589")
    .action((fn, params) => cmdRaw({ function: fn, params }, ctx));

  const mcpCmd = program
    .command("mcp")
    .description("Run or configure the UIT Model Context Protocol (MCP) server for Codex")
    .action(() => {
      runMcpServer();
    });

  mcpCmd
    .command("install")
    .description("Register UIT MCP server into ~/.codex/config.toml")
    .action(() => {
      installMcpServer();
    });

  return program;
}

export async function main(argv = process.argv, api: ApiClient = defaultApiClient): Promise<number> {
  const program = createProgram(api);
  try {
    if (argv.length <= 2) {
      setJsonMode(false);
      printLanding();
      return 0;
    }
    if (argv.length === 3 && argv[2] === "--json") {
      setJsonMode(true);
      program.outputHelp();
      return 0;
    }
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as any).code === "commander.helpDisplayed") {
      return 0;
    }
    if (error && typeof error === "object" && "exitCode" in error && "message" in error && !(error instanceof CliError)) {
      const exitCode = Number((error as any).exitCode || 1);
      if ((error as any).code !== "commander.helpDisplayed") return exitCode;
      return 0;
    }
    if (error instanceof Error && isWrongIdError(error)) {
      return writeError(
        new CliError(
          error.message,
          "No record found for that ID — make sure it's the kind this command expects (see the ID chain in 'uit --help')."
        )
      );
    }
    return writeError(error);
  }
}

function isCliEntrypoint(): boolean {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isCliEntrypoint()) {
  main().then((code) => {
    process.exitCode = code;
  });
}
