import { fetchCourseFile, readCourseFile, writeCourseFile } from "./api.js";
import type { ApiClient, MoodleRecord } from "./types.js";

export interface BrowserSessionTransport {
  execute(script: string): Promise<unknown>;
  cookieHeader(): Promise<string>;
}

export interface CourseDiscoveryDiagnostics {
  sources: { source: string; status: "ok" | "unsupported" | "error"; count?: number; pages?: number; message?: string }[];
  total: number;
  checkedAt: string;
}

function normalizeArgs(params: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(params)) {
    const match = /^(.*)\[(\d+)\]$/.exec(key);
    if (!match) {
      result[key] = value;
      continue;
    }
    const [, name, indexText] = match;
    const index = Number(indexText);
    const values = Array.isArray(result[name]) ? result[name] : [];
    values[index] = value;
    result[name] = values;
  }
  return result;
}

export function buildAjaxInfo(name: string, params: Record<string, any>): string {
  return JSON.stringify([{ index: 0, methodname: name, args: normalizeArgs(params) }]);
}

export function unwrapAjaxResponse(data: unknown): any {
  if (Array.isArray(data) && data.length === 0) throw new Error("Moodle returned an empty AJAX response");
  // Moodle can also return a request-wide exception outside the batch array.
  const first = (Array.isArray(data) ? data[0] : data) as MoodleRecord;
  if (!first || typeof first !== "object") throw new Error("Moodle returned an invalid AJAX response");
  if (first.error || first.errorcode || first.exception) {
    const exception = first.exception;
    const message = (exception && typeof exception === "object" ? exception.message : undefined) || first.message || exception;
    const error = new Error(String(message || "Moodle AJAX request failed")) as Error & { errorcode?: string };
    error.errorcode = exception?.errorcode || first.errorcode || (typeof exception === "string" ? exception : undefined);
    throw error;
  }
  if (!Array.isArray(data)) throw new Error("Moodle returned an invalid AJAX response");
  if (!("data" in first)) throw new Error("Moodle returned an AJAX response without data");
  return first.data;
}

function unavailable(error: unknown): boolean {
  const code = (error as { errorcode?: string })?.errorcode || "";
  // An explicit code takes precedence over potentially misleading message text.
  if (code && !/^(?:moodle_exception|webservice_exception)$/i.test(code)) return /^(?:invalid_parameter_exception|invalidparameter|servicenotavailable|invalidfunction|cannotfindfunction|wsfunctionnotavailable)$/i.test(code);
  return /(?:unknown method|not available for ajax|not callable via ajax|cannot find.*function|web\s*service is not available)/i.test(String(error));
}

function safeAjaxMessage(error: unknown): string {
  const code = String((error as { errorcode?: string })?.errorcode || "").toLowerCase();
  // Only known codes and fixed descriptions may leave the session client as diagnostics.
  if (/^(?:invalid_parameter_exception|invalidparameter)$/.test(code)) return `${code}: Source rejected the request parameters.`;
  if (/^(?:servicenotavailable|invalidfunction|cannotfindfunction|wsfunctionnotavailable)$/.test(code)) return `${code}: Source is not available through session AJAX.`;
  if (/^(?:requireloginerror|servicerequireslogin|invalidsesskey|notloggedin)$/.test(code)) return `${code}: Session authentication failed; sign in again.`;
  if (/^(?:required_capability_exception|nopermissions|accessexception)$/.test(code)) return `${code}: Access to the source was denied.`;
  if (code === "ex_unabletolock") return "ex_unabletolock: Moodle cache is busy; retry later.";
  if (unavailable(error)) return "unsupported: Source is unavailable or rejected the request parameters.";
  return "requestfailed: Source could not be read; discovery may be incomplete.";
}

export class MoodleSessionApi implements ApiClient {
  private readonly baseUrl: string;
  private readonly sesskey: string;
  private readonly transport: BrowserSessionTransport;
  private readonly modules = new Map<number, MoodleRecord>();
  private courseDiscoveryDiagnostics: CourseDiscoveryDiagnostics = { sources: [], total: 0, checkedAt: "" };

  getCourseDiscoveryDiagnostics(): CourseDiscoveryDiagnostics {
    return structuredClone(this.courseDiscoveryDiagnostics);
  }

  constructor(baseUrl: string, sesskey: string, transport: BrowserSessionTransport) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.sesskey = sesskey;
    this.transport = transport;
  }

  private async callAjax<T = any>(name: string, params: Record<string, any> = {}): Promise<T> {
    const info = buildAjaxInfo(name, params);
    const endpoint = `${this.baseUrl}/lib/ajax/service.php?sesskey=${encodeURIComponent(this.sesskey)}`;
    const script = `(async()=>{const response=await fetch(${JSON.stringify(endpoint)},{method:"POST",credentials:"include",redirect:"error",signal:AbortSignal.timeout(30000),headers:{"Content-Type":"application/json"},body:JSON.stringify(${info})});if(!response.ok)throw new Error("HTTP "+response.status+": "+response.statusText);return await response.json();})()`;
    const raw = await this.transport.execute(script);
    try {
      return unwrapAjaxResponse(raw) as T;
    } catch (error) {
      // Unsupported methods are expected during capability discovery and fallback.
      if (!unavailable(error)) console.error(`[MoodleSessionApi] AJAX request failed: ${safeAjaxMessage(error)}`);
      throw error;
    }
  }

  private async pageQuery<T>(path: string, mapper: string): Promise<T> {
    const url = new URL(path, this.baseUrl).toString();
    if (new URL(url).origin !== new URL(this.baseUrl).origin) throw new Error("Course page belongs to another origin.");
    const script = `(async()=>{const pageUrl=${JSON.stringify(url)};const response=await fetch(pageUrl,{credentials:"include",redirect:"error",signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error("HTTP "+response.status+": "+response.statusText);if(!/^(text\\/html|application\\/xhtml\\+xml)(;|$)/i.test(response.headers.get('content-type')||'')||/attachment/i.test(response.headers.get('content-disposition')||'')){await response.body?.cancel();throw new Error('Expected a Moodle HTML page, not a download.');}const html=await response.text();const doc=new DOMParser().parseFromString(html,"text/html");if(doc.querySelector('input[name="logintoken"],input[type="password"]'))throw new Error("UIT session expired. Please sign in again.");if(doc.querySelector('.errorbox,[data-rel="fatalerror"]'))throw new Error('Moodle could not display this page.');return (${mapper})(doc,pageUrl);})()`;
    return await this.transport.execute(script) as T;
  }

  private async coursePageQuery<T>(courseId: number, mapper: string): Promise<T> {
    if (!Number.isSafeInteger(courseId) || courseId <= 0) throw new Error("Invalid course ID.");
    return this.pageQuery<T>(`/course/view.php?id=${courseId}`, String.raw`(doc,pageUrl)=>{
      if(doc.body.classList.contains('notloggedin')||doc.body.classList.contains('guestuser')||doc.querySelector('a[href*="/login/index.php"],form[action*="/login/"]'))throw new Error('UIT session is not authenticated. Please sign in again.');
      if(/^page-enrol-/.test(doc.body.id)||doc.querySelector('form[action*="/enrol/"]'))throw new Error('Course enrolment is required; course access was not verified.');
      if(doc.querySelector('.alert-danger,.notifyproblem,#notice'))throw new Error('Moodle denied access to this course.');
      const ids=[...Array.from(doc.body.classList),doc.body.id].filter((value)=>/^course-\d+$/.test(value)).map((value)=>Number(value.slice(7)));
      for(const node of doc.querySelectorAll('[data-courseid]'))ids.push(Number(node.getAttribute('data-courseid')));
      if(!ids.length||ids.some((id)=>id!==${courseId}))throw new Error('Moodle returned a different or unverified course.');
      if(!doc.querySelector('.course-content,[data-region="section"] li.activity,li.section li.activity'))throw new Error('Unable to verify accessible course contents.');
      return (${mapper})(doc,pageUrl);
    }`);
  }

  private async courseFallback(courseId: number): Promise<MoodleRecord> {
    const course = await this.coursePageQuery<MoodleRecord>(courseId, String.raw`(doc,pageUrl)=>{
      const fullname=(doc.querySelector('#page-header h1,.page-header-headings h1')?.textContent||'').trim();
      if(!fullname||/(?:\.{3}|\u2026)$/.test(fullname))throw new Error('Moodle did not return a complete course title.');
      const breadcrumb=Array.from(doc.querySelectorAll('.breadcrumb a[href]')).find((link)=>{
        const url=new URL(link.getAttribute('href'),pageUrl);
        return url.origin===new URL(pageUrl).origin&&url.pathname==='/course/view.php'&&url.searchParams.get('id')===String(${courseId});
      });
      return {id:${courseId},fullname,shortname:breadcrumb?.textContent?.trim()||''};
    }`);
    return { courses: [course], warnings: [] };
  }

  private async contentsFallback(courseId: number, enrich = true): Promise<MoodleRecord[]> {
    const sections = await this.coursePageQuery<MoodleRecord[]>(courseId, `(doc,pageUrl)=>{
      const sections=Array.from(doc.querySelectorAll('[data-region="section"],li.section'));
      const seen=new Set();
      const readSection=(section)=>({name:(section.querySelector('.sectionname,.section-title,h3')?.textContent||'').trim(),modules:Array.from(section.querySelectorAll('li.activity')).map((activity)=>{
        const link=activity.querySelector('a.aalink[href],.activityname a[href],a[href*="/mod/"]');
        const url=link?new URL(link.getAttribute('href'),pageUrl):null;
        const id=Number(activity.dataset.id)||Number((activity.id||'').replace(/^module-/,''))||Number(url?.pathname.includes('/mod/')?url.searchParams.get('id'):0);
        if(!id||seen.has(id))return null;
        seen.add(id);
        const modClass=Array.from(activity.classList).find((name)=>name.startsWith('modtype_'));
        const title=(link||activity.querySelector('.activityname'))?.cloneNode(true);title?.querySelectorAll('.accesshide,.sr-only').forEach((node)=>node.remove());
        return {id,course:${courseId},name:(title?.textContent||'').trim(),modname:modClass?modClass.slice(8):url?.pathname.split('/mod/')[1]?.split('/')[0]||'activity',url:url?.toString(),description:activity.querySelector('.contentwithoutlink,.activity-description')?.innerHTML||'',contents:Array.from(activity.querySelectorAll('a[href*="pluginfile.php"],a[href*="tokenpluginfile.php"]')).map((file)=>{const url=new URL(file.getAttribute('href'),pageUrl);return {type:'file',filename:url.pathname.split('/').pop()||'resource',fileurl:url.toString(),filesize:0};})};
      }).filter(Boolean)});
      const result=(sections.length?sections:[doc]).map(readSection).filter((section)=>section.modules.length);
      return result;
    }`);
    for (const module of sections.flatMap((section) => section.modules || [])) this.modules.set(Number(module.id), module);
    // Resource/folder files frequently appear only on the activity page, not the course page.
    const modules = sections.flatMap((section) => section.modules || []).filter((module) => enrich && ["resource", "folder", "url"].includes(module.modname));
    for (let start = 0; start < modules.length; start += 4) {
      await Promise.all(modules.slice(start, start + 4).map(async (module) => {
        try {
          module.contents = [...(module.contents || []), ...await this.pageQuery<MoodleRecord[]>(`/mod/${module.modname}/view.php?id=${Number(module.id)}&forceview=1`, `(doc,pageUrl)=>{
            const links=Array.from(doc.querySelectorAll('a[href*="pluginfile.php"],object[data],iframe[src],.urlworkaround a[href]'));
            return links.map((link)=>{const url=new URL(link.getAttribute('href')||link.getAttribute('data')||link.getAttribute('src'),pageUrl);return {type:url.pathname.includes('pluginfile.php')?'file':'url',filename:url.pathname.split('/').pop()||link.textContent||'resource',fileurl:url.toString(),filesize:0};}).filter((file)=>/^https?:/.test(file.fileurl));
          }`)];
        } catch (error) {
          module.unavailable = { contents: String(error) };
        }
      }));
    }
    return sections;
  }

  private async activityFallback(module: MoodleRecord): Promise<MoodleRecord> {
    if (!/^[a-z][a-z0-9_]*$/.test(module.modname)) throw new Error("Invalid activity type.");
    const path = `/mod/${module.modname}/view.php?id=${Number(module.id)}&forceview=1`;
    const details = await this.pageQuery<MoodleRecord>(path, String.raw`(doc,pageUrl)=>{
      const modname=${JSON.stringify(module.modname)};
      const cfgText=Array.from(doc.scripts).map((script)=>script.textContent).join('\n');
      const cfgMatch=/M\.cfg\s*=\s*(\{[^;]*?\})\s*;/.exec(cfgText);
      let cfg={};try{if(cfgMatch)cfg=JSON.parse(cfgMatch[1]);}catch{}
      // contextInstanceId is the cmid, never the activity instance id.
      const cmid=Number(cfg.contextInstanceId)||Number(doc.querySelector('[data-cmid]')?.dataset.cmid);
      if(cmid&&cmid!==${Number(module.id)})throw new Error('Moodle returned a different course module.');
      if(cfg.courseId&&Number(cfg.courseId)!==${Number(module.course)})throw new Error('Moodle returned a different course.');
      const bodyType=/^page-mod-([a-z0-9_]+)-/.exec(doc.body.id)?.[1];
      if(bodyType&&bodyType!==modname)throw new Error('Moodle returned a different activity type.');
      if(!bodyType&&!cmid&&!doc.querySelector('#intro,.activity-description'))throw new Error('Unable to read Moodle activity.');
      let instance=modname==='assign'?Number(doc.querySelector('[data-assignmentid]')?.dataset.assignmentid):modname==='forum'?Number(doc.querySelector('[data-forumid]')?.dataset.forumid):0;
      const inputs=Array.from(doc.querySelectorAll('input[type="hidden"]'));
      const names=modname==='assign'?['assignid','assignmentid']:modname==='forum'?['forum','forumid']:[];
      for(const input of inputs)if(names.includes(input.name)&&Number(input.value)>0)instance=Number(input.value);
      const links=Array.from(doc.querySelectorAll('a[href],form[action]')).map((link)=>new URL(link.getAttribute('href')||link.getAttribute('action'),pageUrl)).filter((url)=>url.origin===new URL(pageUrl).origin);
      for(const url of links){
        if(url.pathname.includes('/mod/'+modname+'/')){
          const key=modname==='forum'?'f':modname==='resource'?'r':modname==='url'?'u':null;
          const value=(key?Number(url.searchParams.get(key)):0)||(modname==='assign'?Number(url.searchParams.get('assignid')):modname==='forum'?Number(url.searchParams.get('forumid')):0);
          if(value>0)instance=value;
          if(modname==='forum'&&url.pathname.endsWith('/post.php')&&Number(url.searchParams.get('forum'))>0)instance=Number(url.searchParams.get('forum'));
          if(modname==='forum'&&url.pathname.endsWith('/subscribe.php')&&Number(url.searchParams.get('id'))>0)instance=Number(url.searchParams.get('id'));
        }
        if(modname==='assign'&&url.pathname.includes('/grade/')&&url.searchParams.get('itemmodule')==='assign'&&Number(url.searchParams.get('iteminstance'))>0)instance=Number(url.searchParams.get('iteminstance'));
      }
      const intro=doc.querySelector('#intro,.activity-description');
      const files=Array.from(doc.querySelectorAll('#intro a[href*="pluginfile.php"],.activity-description a[href*="pluginfile.php"],a[href*="/mod_assign/introattachment/"],a[href*="/mod_assign/activityattachment/"]')).map((link)=>{const url=new URL(link.getAttribute('href'),pageUrl);return {filename:url.pathname.split('/').pop(),fileurl:url.toString(),filesize:0};});
      const result={name:(doc.querySelector('.page-header-headings h1,[data-region="header"] h2,#region-main h2')?.textContent||${JSON.stringify(module.name)}).trim(),intro:intro?.innerHTML||${JSON.stringify(module.description || "")},introformat:1,introattachments:files,url:pageUrl};
      if(Number.isSafeInteger(instance)&&instance>0)result.instance=instance;
      else result.unavailable={instance:'The HTML page does not expose the activity instance ID.'};
      if(modname==='forum')result.type=Array.from(doc.body.classList).find((name)=>name.startsWith('forumtype-'))?.slice(10);
      for(const field of ['duedate','cutoffdate','allowsubmissionsfromdate']){
        const value=Number(doc.querySelector('[data-'+field+'],input[name="'+field+'"]')?.getAttribute('data-'+field)||doc.querySelector('input[name="'+field+'"]')?.value);
        if(value>0)result[field]=value;
      }
      const grader=links.find((url)=>url.pathname.endsWith('/mod/assign/view.php')&&Number(url.searchParams.get('id'))===${Number(module.id)}&&url.searchParams.get('action')==='grader');
      if(modname==='assign'&&!result.instance&&grader)result.graderUrl=new URL('/mod/assign/view.php?id='+${Number(module.id)}+'&action=grader',pageUrl).toString();
      return result;
    }`);
    // The grader app exposes data-assignmentid. Only visit an existing read-only
    // grader link, never guess an instance from the link's id (which is a cmid).
    if (details.graderUrl) {
      try {
        const instance = await this.pageQuery<number>(details.graderUrl, `(doc)=>Number(doc.querySelector('[data-assignmentid]')?.dataset.assignmentid)||0`);
        if (Number.isSafeInteger(instance) && instance > 0) { details.instance = instance; delete details.unavailable; }
      } catch { /* The module metadata remains usable without grader access. */ }
      delete details.graderUrl;
    }
    const result = { ...module, ...details };
    this.modules.set(Number(module.id), result);
    return result;
  }

  private async activitiesFallback(modname: "assign" | "forum", params: Record<string, any>): Promise<any> {
    let courseIds = normalizeArgs(params).courseids as number[] | undefined;
    if (!courseIds?.length) courseIds = (await this.call<MoodleRecord[]>("core_enrol_get_users_courses")).map((course) => Number(course.id));
    const courses: MoodleRecord[] = [];
    for (const courseId of [...new Set(courseIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))]) {
      const sections = await this.contentsFallback(courseId, false);
      const activities: MoodleRecord[] = [];
      for (const module of sections.flatMap((section) => section.modules || []).filter((module) => module.modname === modname)) {
        let activity: MoodleRecord;
        try { activity = await this.activityFallback(module); }
        catch (error) { activity = { ...module, intro: module.description, unavailable: { details: String(error), instance: "Activity instance ID unavailable." } }; }
        // Keep cmid-only records usable by module resolvers without inventing an
        // assignment/forum ID. Consumers must inspect unavailable before ID use.
        const { id: cmid, instance, ...details } = activity;
        activities.push({ ...details, cmid, ...(instance ? { id: instance } : {}), unavailable: activity.unavailable });
      }
      courses.push({ id: courseId, assignments: activities });
    }
    return modname === "assign" ? { courses, warnings: [] } : courses.flatMap((course) => course.assignments);
  }

  private async discussionsFallback(params: Record<string, any>): Promise<MoodleRecord> {
    const forumId = Number(params.forumid);
    const cmid = Number(params.cmid);
    const page = Number(params.page ?? 0);
    const perpage = Number(params.perpage ?? 100);
    // News forums often expose no instance ID to students (no posting links), so
    // the course-module page is a verified fallback: it lists the same discussions.
    // A present-but-invalid identity never falls through to the other key.
    const byId = params.forumid !== undefined;
    const byModule = !byId && params.cmid !== undefined;
    if (byId && !(Number.isSafeInteger(forumId) && forumId > 0)) throw new Error("Invalid forum pagination or instance ID.");
    if (byModule && !(Number.isSafeInteger(cmid) && cmid > 0)) throw new Error("Invalid forum pagination or instance ID.");
    if (!byId && !byModule) throw new Error("Invalid forum pagination or instance ID.");
    if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(perpage) || perpage <= 0 || perpage > 100) throw new Error("Invalid forum pagination or instance ID.");
    const path = byModule ? `/mod/forum/view.php?id=${cmid}&forceview=1&p=${page}&s=${perpage}` : `/mod/forum/view.php?f=${forumId}&p=${page}&s=${perpage}`;
    const discussions = await this.pageQuery<MoodleRecord[]>(path, String.raw`(doc,pageUrl)=>{
      if(!doc.querySelector('[id^="discussion-list-"],.discussion-list,.forumheaderlist,.forumnodiscuss,.forumpost'))throw new Error('Unable to read forum discussions.');
      ${byModule ? `const cfgText=Array.from(doc.scripts).map((script)=>script.textContent).join('\\n');const cfgMatch=/M\\.cfg\\s*=\\s*(\\{[^;]*?\\})\\s*;/.exec(cfgText);let cfgId=0;try{if(cfgMatch)cfgId=Number(JSON.parse(cfgMatch[1]).contextInstanceId)||0;}catch{}if(cfgId&&cfgId!==${cmid})throw new Error('Moodle returned a different course module.');` : ""}
      const seen=new Set();
      return Array.from(doc.querySelectorAll('[data-region="discussion-list-item"],tr.discussion,.forumpost')).map((row)=>{
        const link=row.querySelector('.topic a[href*="discuss.php"],a[href*="discuss.php?d="]');
        const url=link?new URL(link.getAttribute('href'),pageUrl):null;
        const discussion=Number(row.dataset.discussionid)||Number(url?.searchParams.get('d'));
        if(!discussion||seen.has(discussion))return null;seen.add(discussion);
        ${byModule ? "" : `if(row.dataset.forumid&&Number(row.dataset.forumid)!==${forumId})throw new Error('Moodle returned a different forum.');`}
        const times=Array.from(row.querySelectorAll('time[data-timestamp]')).map((time)=>Number(time.dataset.timestamp));
        const replies=row.querySelector('.replies a,.replies,td.text-center span');
        const count=Number(replies?.textContent?.trim());
        return {discussion,name:link?.getAttribute('title')||link?.textContent?.trim()||'',url:new URL('/mod/forum/discuss.php?d='+discussion,pageUrl).toString(),userfullname:row.querySelector('.author .author-info > div,.author a[href*="/user/"]')?.textContent?.trim(),...(times[0]?{created:times[0]}:{}),...(times.length?{timemodified:times[times.length-1]}:{}),...(replies&&Number.isFinite(count)?{numreplies:count}:{})};
      }).filter(Boolean);
    }`);
    for (let start = 0; start < discussions.length; start += 4) {
      await Promise.all(discussions.slice(start, start + 4).map(async (discussion) => {
        try {
          Object.assign(discussion, await this.pageQuery<MoodleRecord>(discussion.url, `(doc,pageUrl)=>{
            const post=doc.querySelector('.forumpost.firstpost,.forumpost.starter')||doc.querySelector('[data-region="post"],.forumpost');
            const message=post?.querySelector('[data-region="post-content"],.post-content-container,.posting,.content .fullpost');
            if(!post||!message)throw new Error('Unable to read the discussion opening post.');
            const time=post.querySelector('time[data-timestamp]');
            const files=(root,selector)=>Array.from(root.querySelectorAll(selector)).map((link)=>{const url=new URL(link.getAttribute('href')||link.getAttribute('src'),pageUrl);return {filename:url.pathname.split('/').pop(),fileurl:url.toString(),filesize:0};});
            return {subject:post.querySelector('[data-region="post-title"],[data-region-content="forum-post-core-subject"],.subject')?.textContent?.trim(),message:message.innerHTML,userfullname:post.querySelector('[data-region="author-name"],.author a[href*="/user/"],header a[href*="/user/"]')?.textContent?.trim()||${JSON.stringify(discussion.userfullname || "")},...(Number(time?.dataset.timestamp)?{created:Number(time.dataset.timestamp)}:{}),attachments:files(post,'.attachments a[href*="pluginfile.php"],[data-region="attachment"] a[href*="pluginfile.php"],a[href*="/mod_forum/attachment/"],.attachedimages img[src*="pluginfile.php"]'),messageinlinefiles:files(message,'a[href*="pluginfile.php"],img[src*="pluginfile.php"]')};
          }`));
        } catch (error) { discussion.unavailable = { message: String(error) }; }
      }));
    }
    return { discussions, warnings: [] };
  }

  private async submissionStatusFallback(params: Record<string, any>): Promise<any> {
    const assignId = Number(params.assignid ?? params.assignmentid);
    if (!Number.isSafeInteger(assignId) || assignId <= 0) throw new Error("Invalid assignment submission reference.");
    // listAssignments populates this map with cmid -> instance before any
    // submission read, so the assignment page URL is known without guessing.
    const cmid = [...this.modules.values()]
      .map((module) => ({ cmid: Number(module.id), instance: Number(module.instance) }))
      .find((module) => module.instance === assignId)?.cmid;
    if (!cmid) throw new Error("Assignment module unknown. Open the course first so the assignment page can be found.");
    return await this.pageQuery<MoodleRecord>(`/mod/assign/view.php?id=${cmid}&forceview=1`, String.raw`(doc,pageUrl)=>{
      const cfgText=Array.from(doc.scripts).map((script)=>script.textContent).join('\n');
      const cfgMatch=/M\.cfg\s*=\s*(\{[^;]*?\})\s*;/.exec(cfgText);
      let cfgId=0;try{if(cfgMatch)cfgId=Number(JSON.parse(cfgMatch[1]).contextInstanceId)||0;}catch{}
      if(cfgId&&cfgId!==${cmid})throw new Error('Moodle returned a different course module.');
      const table=doc.querySelector('.submissionstatustable');
      if(!table)throw new Error('Unable to read assignment submission.');
      let status='',grade='';
      for(const row of table.querySelectorAll('tr')){
        const label=row.querySelector('.c0,th')?.textContent?.trim().toLowerCase()||'';
        const value=row.querySelector('.c1,td:last-child')?.textContent?.trim()||'';
        if(label.includes('submission status'))status=value;
        else if(label==='grade'||label.startsWith('grade '))grade=value;
      }
      const files=Array.from(table.querySelectorAll('a[href*="pluginfile.php"],a[href*="/mod_assign/submission"]')).map((link)=>{const url=new URL(link.getAttribute('href'),pageUrl);return {filename:link.textContent?.trim()||url.pathname.split('/').pop(),fileurl:url.toString(),filesize:0};});
      return {lastattempt:{submission:{status:status||'unknown',plugins:files.length?[{type:'file',fileareas:[{area:'submission',files}]}]:[]}},feedback:{gradefordisplay:grade}};
    }`);
  }

  private async participantsFallback(courseId: number): Promise<MoodleRecord[]> {
    if (!Number.isSafeInteger(courseId) || courseId <= 0) throw new Error("Invalid course ID.");
    return await this.pageQuery<MoodleRecord[]>(`/user/index.php?id=${courseId}&perpage=5000`, String.raw`(doc,pageUrl)=>{
      const rows=Array.from(doc.querySelectorAll('table#participants tbody tr,table.generaltable tbody tr'));
      const seen=new Set();
      const users=[];
      for(const row of rows){
        const link=row.querySelector('a[href*="/user/view.php"],a[href*="id="]');
        let id=0;
        if(link){
          try{
            const url=new URL(link.getAttribute('href')||'',pageUrl);
            id=Number(url.searchParams.get('id'))||0;
          }catch{}
        }
        if(!id){
          const checkbox=row.querySelector('input[name^="user"],input[type="checkbox"][id^="user"]');
          if(checkbox){
            const match=/user(\d+)/.exec(checkbox.id||checkbox.name||'');
            if(match)id=Number(match[1])||0;
          }
        }
        const nameNode=link||row.querySelector('.cell.c1,[data-cell="username"]');
        if(!nameNode)continue;
        const clone=nameNode.cloneNode(true);
        clone.querySelectorAll('.userinitials,.userpicture,.sr-only,.accesshide').forEach((el)=>el.remove());
        const fullname=(clone.textContent||'').trim();
        if(!fullname)continue;
        if(id&&seen.has(id))continue;
        if(id)seen.add(id);
        const roleNode=row.querySelector('.cell.c2,[data-cell="roles"],.roles');
        const roleText=(roleNode?.textContent||'').trim();
        const roles=roleText?[{shortname:roleText.toLowerCase(),name:roleText}]:[{shortname:'student',name:'Học viên'}];
        const userObj={id:id||users.length+1,fullname,roles};
        const avatarImg=row.querySelector('img.userpicture');
        if(avatarImg&&avatarImg.getAttribute('src')){
          try{userObj.profileimageurl=new URL(avatarImg.getAttribute('src'),pageUrl).toString();}catch{}
        }
        const groupNode=row.querySelector('.cell.c3,[data-cell="groups"],.groups');
        const groupText=(groupNode?.textContent||'').trim();
        if(groupText&&groupText!=='Không phân nhóm'&&groupText!=='No groups'&&groupText!=='-'){
          userObj.groups=[{name:groupText}];
        }
        const accessNode=row.querySelector('.cell.c4,[data-cell="lastaccess"],.lastaccess');
        const accessText=(accessNode?.textContent||'').trim();
        if(accessText)userObj.lastaccess=accessText;
        users.push(userObj);
      }
      return users;
    }`);
  }

  private async gradesFallback(courseId: number): Promise<MoodleRecord> {
    if (!Number.isSafeInteger(courseId) || courseId <= 0) throw new Error("Invalid course ID.");
    const items = await this.pageQuery<MoodleRecord[]>(`/grade/report/user/index.php?id=${courseId}`, String.raw`(doc)=>{
      const table=doc.querySelector('table.user-grade,table.generaltable');
      const rows=Array.from(table?.querySelectorAll('tbody tr')||[]);
      const list=[];
      for(const tr of rows){
        const nameNode=tr.querySelector('.column-itemname,th');
        if(!nameNode)continue;
        const clone=nameNode.cloneNode(true);
        clone.querySelectorAll('.sr-only,.accesshide').forEach((el)=>el.remove());
        const itemname=(clone.textContent||'').trim();
        if(!itemname)continue;
        const grade=tr.querySelector('.column-grade')?.textContent?.trim()||'-';
        const range=tr.querySelector('.column-range')?.textContent?.trim()||'';
        const percentage=tr.querySelector('.column-percentage')?.textContent?.trim()||'-';
        const feedback=tr.querySelector('.column-feedback')?.textContent?.trim()||'';
        list.push({
          itemname,
          gradeformatted:grade!=='-'?grade:undefined,
          grademax:range||undefined,
          percentageformatted:percentage!=='-'?percentage:undefined,
          feedback:feedback||undefined
        });
      }
      return list;
    }`);
    return { usergrades: [{ courseid: courseId, gradeitems: items }] };
  }

  private async enrolledCourses(params: Record<string, any>): Promise<MoodleRecord[]> {
    const courses = new Map<number, MoodleRecord>();
    const diagnostics: CourseDiscoveryDiagnostics = { sources: [], total: 0, checkedAt: "" };
    const populated = (value: unknown): boolean => value != null &&
      (typeof value !== "string" || value.trim().length > 0) &&
      (typeof value !== "object" || Object.keys(value).length > 0);
    const merge = (entries: unknown, ids: Set<number>) => {
      if (!Array.isArray(entries)) throw new Error("Moodle returned an invalid course list.");
      for (const course of entries) {
        const id = typeof course?.id === "number" || typeof course?.id === "string" ? Number(course.id) : NaN;
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        ids.add(id);
        const record = courses.get(id) || { id };
        // Earlier sources keep populated fields; sparse duplicates only fill gaps.
        for (const [key, value] of Object.entries(course)) {
          if (key !== "id" && (!Object.hasOwn(record, key) || (!populated(record[key]) && populated(value)))) record[key] = value;
        }
        courses.set(id, record);
      }
    };
    let supported = false;
    try {
      for (const classification of ["primary", "allincludinghidden", "all", "inprogress", "future", "past", "hidden"]) {
        const source: CourseDiscoveryDiagnostics["sources"][number] = {
          source: classification === "primary" ? "core_enrol_get_users_courses" : `timeline:${classification}`,
          status: "ok", count: 0, pages: 0
        };
        diagnostics.sources.push(source);
        const ids = new Set<number>();
        let offset = 0;
        try {
          if (classification === "primary") {
            merge(await this.callAjax("core_enrol_get_users_courses", params), ids);
            source.count = ids.size;
            source.pages = 1;
            supported = true;
            continue;
          }
          for (let page = 0; page < 1000; page++) {
            const timeline = await this.callAjax("core_course_get_enrolled_courses_by_timeline_classification", { classification, limit: 100, offset });
            const entries = Array.isArray(timeline) ? timeline : timeline?.courses;
            merge(entries, ids);
            source.count = ids.size;
            source.pages = page + 1;
            supported = true;
            const cursor = timeline.nextoffset;
            let next: number;
            if (cursor == null) {
              if (entries.length < 100) break;
              next = offset + entries.length;
            } else {
              next = typeof cursor === "number" || (typeof cursor === "string" && /^-?\d+$/.test(cursor)) ? Number(cursor) : NaN;
              if (next === 0 || next === -1) break;
              // Moodle can echo the requested offset when the final page is empty.
              if (next === offset && entries.length === 0) break;
            }
            if (!Number.isSafeInteger(next) || next <= offset) throw new Error(`Invalid or non-advancing course pagination for ${classification}.`);
            if (page === 999) throw new Error(`Course pagination exceeded the safety limit for ${classification}.`);
            offset = next;
          }
        } catch (error) {
          source.status = unavailable(error) ? "unsupported" : "error";
          source.message = safeAjaxMessage(error);
          // Optional variants must not discard courses already found, even if a
          // later page rejects its parameters. Diagnostics retain the partial count.
          if (unavailable(error)) continue;
          if (classification === "primary") throw error;
          throw new Error(`Course discovery failed for ${classification} at offset ${offset}: ${String(error)}`, { cause: error });
        }
      }
      if (!supported) throw new Error("Course discovery is unavailable: neither enrolment nor timeline listing is supported.");
      return [...courses.values()];
    } finally {
      diagnostics.total = courses.size;
      diagnostics.checkedAt = new Date().toISOString();
      this.courseDiscoveryDiagnostics = diagnostics;
    }
  }

  async call<T = any>(name: string, params: Record<string, any> = {}): Promise<T> {
    if (name === "core_enrol_get_users_courses") return await this.enrolledCourses(params) as T;
    try {
      return await this.callAjax<T>(name, params);
    } catch (error) {
      if (!unavailable(error)) throw error;
      if (name === "core_course_get_courses_by_field" && params.field === "id" && typeof params.value === "string" && /^[1-9]\d*$/.test(params.value)) {
        return await this.courseFallback(Number(params.value)) as T;
      }
      if (name === "core_course_get_contents") return await this.contentsFallback(Number(params.courseid)) as T;
      if (name === "core_enrol_get_enrolled_users") return await this.participantsFallback(Number(params.courseid)) as T;
      if (name === "gradereport_user_get_grade_items") return await this.gradesFallback(Number(params.courseid)) as T;
      if (name === "mod_assign_get_assignments") return await this.activitiesFallback("assign", params) as T;
      if (name === "mod_forum_get_forums_by_courses") return await this.activitiesFallback("forum", params) as T;
      if (name === "mod_forum_get_forum_discussions") return await this.discussionsFallback(params) as T;
      if (name === "mod_assign_get_submission_status") return await this.submissionStatusFallback(params) as T;
      if (name === "core_course_get_course_module") {
        const cmid = Number(params.cmid);
        if (!Number.isSafeInteger(cmid) || cmid <= 0) throw new Error("Invalid course module ID.");
        if (!this.modules.has(cmid)) {
          const courses = params.courseid ? [{ id: Number(params.courseid) }] : await this.call<MoodleRecord[]>("core_enrol_get_users_courses");
          for (const course of courses) {
            await this.contentsFallback(Number(course.id), false);
            if (this.modules.has(cmid)) break;
          }
        }
        const module = this.modules.get(cmid);
        if (!module) throw new Error("Course module was not found in accessible courses.");
        let cm: MoodleRecord;
        try { cm = await this.activityFallback(module); }
        catch (error) { cm = { ...module, unavailable: { details: String(error) } }; }
        return { cm, warnings: [] } as T;
      }
      throw error;
    }
  }

  async uploadFile(_filepath: string): Promise<MoodleRecord> {
    throw new Error("SSO file uploads will be enabled with the assignment submission workflow.");
  }

  async downloadFile(fileUrl: string, destPath: string): Promise<void> {
    const cookie = await this.transport.cookieHeader();
    await writeCourseFile(await fetchCourseFile(this.baseUrl, fileUrl, { Cookie: cookie }), destPath);
  }

  async readFile(fileUrl: string): Promise<{ data: Uint8Array; mimeType: string }> {
    const cookie = await this.transport.cookieHeader();
    return readCourseFile(await fetchCourseFile(this.baseUrl, fileUrl, { Cookie: cookie }));
  }
}
