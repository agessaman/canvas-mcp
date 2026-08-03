import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { DataAnonymizer } from './anonymizer.js';
import { SimpleCache } from './cache.js';

// URL fragments whose responses must never be cached (live grade, roster-state,
// inbox, and grading-queue data — all of which change under the instructor's feet)
//
// /content_migrations is here because a migration record is polled, not read:
// the cache serves any entry without a network call for its first 60 seconds,
// which is exactly the cadence someone watching a course copy uses. Observed
// live — two consecutive status checks returned an identical workflow_state
// while the copy was demonstrably progressing. A status that can be a minute
// stale is a status you cannot act on.
const UNCACHED_PATTERNS = ['/submissions', '/enrollments', '/conversations', '/todo', '/progress', '/content_migrations'];

// Safety bound on Link-header following, so a malformed or self-referential
// `next` link can't loop indefinitely. At per_page=100 this is 50k records.
const MAX_PAGES = 500;

export class CanvasClient {
  private axios: AxiosInstance;
  private cache = new SimpleCache();

  private baseUrl: string;

  constructor(baseUrl: string, apiToken: string) {
    this.baseUrl = baseUrl;
    this.axios = axios.create({
      baseURL: baseUrl,
      headers: { Authorization: `Bearer ${apiToken}` }
    });
  }

  private isCacheable(url: string): boolean {
    return !UNCACHED_PATTERNS.some(p => url.includes(p));
  }

  private cacheKey(url: string, params: any): string {
    const sorted = Object.keys(params).sort().reduce((acc: any, k) => { acc[k] = params[k]; return acc; }, {});
    return `${url}\0${JSON.stringify(sorted)}`;
  }

  private invalidateForWrite(url: string): void {
    const basePath = url.split('?')[0];
    this.cache.invalidatePrefix(basePath);
    // Refresh the containing collection list (e.g. updating /pages/syllabus
    // should drop the cached /pages list), but never climb so high that a
    // single write wipes an entire course or the API root.
    const parent = basePath.replace(/\/[^/]+$/, '');
    const tooBroad = /^\/api\/v1\/courses\/\d+$/.test(parent) || /^\/api\/v1\/[^/]+$/.test(parent);
    if (parent !== basePath && !tooBroad) this.cache.invalidatePrefix(parent);
  }

  // Generic GET with ETag-based conditional requests and TTL fallback
  async get<T>(url: string, params: any = {}): Promise<T> {
    const cacheable = this.isCacheable(url);
    const key = this.cacheKey(url, params);
    const cached = cacheable ? this.cache.get(key) : undefined;

    // Serve without a network call when still fresh, or when there's no
    // validator (the TTL-only path, already bounded by the cache's expiry)
    if (cached && (this.cache.isFresh(cached) || !(cached.etag || cached.lastModified))) {
      return cached.value as T;
    }

    // Build conditional GET headers when we have a stored validator
    const headers: Record<string, string> = {};
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    else if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

    try {
      const response = await this.axios.get(url, {
        params,
        headers,
        validateStatus: s => (s >= 200 && s < 300) || s === 304,
      });

      if (response.status === 304) {
        return cached!.value as T;
      }

      if (cacheable) {
        this.cache.set(key, response.data, response.headers['etag'], response.headers['last-modified']);
      }
      return response.data;
    } catch (error: any) {
      this.handleError(error);
    }
  }

  // Generic POST with error handling and cache invalidation
  async post<T>(url: string, data: any = {}, params: any = {}): Promise<T> {
    try {
      const response = await this.axios.post(url, data, { params });
      this.invalidateForWrite(url);
      return response.data;
    } catch (error: any) {
      this.handleError(error);
    }
  }

  // Generic PUT with error handling and cache invalidation
  async put<T>(url: string, data: any = {}, params: any = {}): Promise<T> {
    try {
      const response = await this.axios.put(url, data, { params });
      this.invalidateForWrite(url);
      return response.data;
    } catch (error: any) {
      this.handleError(error);
    }
  }

  // Generic PATCH with error handling and cache invalidation
  // (the New Quizzes API uses PATCH where the v1 API uses PUT)
  async patch<T>(url: string, data: any = {}, params: any = {}): Promise<T> {
    try {
      const response = await this.axios.patch(url, data, { params });
      this.invalidateForWrite(url);
      return response.data;
    } catch (error: any) {
      this.handleError(error);
    }
  }

  // Generic DELETE with error handling and cache invalidation
  async delete<T>(url: string, params: any = {}): Promise<T> {
    try {
      const response = await this.axios.delete(url, { params });
      this.invalidateForWrite(url);
      return response.data;
    } catch (error: any) {
      this.handleError(error);
    }
  }

  private parseLinkHeader(header: string): Record<string, string> {
    const links: Record<string, string> = {};
    for (const part of header.split(',')) {
      const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
      if (match) links[match[2]] = match[1];
    }
    return links;
  }

  // Fetch all pages for paginated endpoints using Link header.
  // The assembled result is cached (TTL-based) for cacheable URLs so repeated
  // list calls don't re-download every page.
  async fetchAllPages<T>(url: string, params: any = {}): Promise<T[]> {
    const cacheable = this.isCacheable(url);
    const key = this.cacheKey(url, { ...params, __all: true });
    if (cacheable) {
      const cached = this.cache.get(key);
      if (cached && (this.cache.isFresh(cached) || !(cached.etag || cached.lastModified))) {
        return cached.value as T[];
      }
    }
    const results: T[] = [];
    const per_page = params.per_page || 100;
    // Follow the Link header's `next` URL rather than incrementing page=N.
    // Not all Canvas collections are numerically paginated: bookmark-paginated
    // endpoints such as /courses/:id/students/submissions reject a page number
    // outright with "Invalid page; please restart iteration and follow `next`
    // links". Following `next` is correct for both styles.
    //
    // Errors must route through handleError like every other verb, or a failed
    // paginated call surfaces as a bare "Request failed with status code 400"
    // with no indication of which request failed or why.
    try {
      let response = await this.axios.get(url, { params: { ...params, per_page } });
      // Bounded so a malformed or self-referential Link header can't spin forever.
      for (let hop = 0; hop < MAX_PAGES; hop++) {
        const data: T[] = response.data;
        if (!Array.isArray(data) || data.length === 0) break;
        results.push(...data);
        const linkHeader = response.headers['link'] as string | undefined;
        const next = linkHeader ? this.parseLinkHeader(linkHeader).next : undefined;
        if (!next) break;
        // `next` is an absolute URL and already carries its own query string,
        // so it is requested verbatim — axios bypasses baseURL for absolute URLs.
        response = await this.axios.get(next);
      }
    } catch (error: any) {
      this.handleError(error);
    }
    if (cacheable) this.cache.set(key, results);
    return results;
  }

  // Centralized error handler.
  // Canvas puts the useful detail in several different shapes depending on the
  // endpoint, and a bare "Request failed with status code 400" is undebuggable,
  // so surface the status, the path, and whatever body came back.
  private handleError(error: any): never {
    const status = error.response?.status;
    const data = error.response?.data;
    const method = error.config?.method?.toUpperCase();
    const url = error.config?.url;
    const where = method && url ? ` on ${method} ${url}` : '';

    if (data !== undefined && data !== null && data !== '') {
      let detail: string;
      if (data.errors) detail = JSON.stringify(data.errors);
      else if (data.message) detail = String(data.message);
      else if (typeof data === 'string') detail = data;
      else detail = JSON.stringify(data);
      throw new Error(`Canvas API ${status ?? 'error'}${where}: ${detail.slice(0, 800)}`);
    }
    if (status) {
      throw new Error(`Canvas API ${status}${where} (no response body)`);
    }
    if (error instanceof Error) {
      throw new Error(error.message);
    }
    throw new Error('Unknown error occurred in CanvasClient');
  }

  // --- Courses ---
  async listCourses(params: any = {}) {
    return this.fetchAllPages<any>('/api/v1/courses', params);
  }
  // Works for unpublished courses too, which never appear in the course list
  // under the default filters.
  async getCourse(courseId: string, params: any = {}) {
    return this.get(`/api/v1/courses/${courseId}`, params);
  }
  // Course attributes: syllabus, settings, and publish state all live here.
  // The syllabus is a course attribute, NOT a wiki page, so the page tools
  // cannot reach it — and unlike a page it has no revision history.
  async updateCourse(courseId: string, data: any) {
    return this.put(`/api/v1/courses/${courseId}`, { course: data });
  }
  // --- Content migrations (course copy) ---
  // Asynchronous: the POST returns a migration whose workflow_state is still
  // pre_processing, plus a progress_url to watch.
  async createContentMigration(courseId: string, data: any) {
    return this.post(`/api/v1/courses/${courseId}/content_migrations`, data);
  }
  async getContentMigration(courseId: string, migrationId: string) {
    return this.get(`/api/v1/courses/${courseId}/content_migrations/${migrationId}`);
  }
  async listContentMigrations(courseId: string) {
    return this.fetchAllPages<any>(`/api/v1/courses/${courseId}/content_migrations`, { per_page: 100 });
  }
  // What Canvas could not bring across. A migration can complete and still have
  // dropped content, and this is the only place that is recorded.
  async listMigrationIssues(courseId: string, migrationId: string) {
    return this.fetchAllPages<any>(
      `/api/v1/courses/${courseId}/content_migrations/${migrationId}/migration_issues`,
      { per_page: 100 }
    );
  }
  // progress_url is absolute; axios bypasses baseURL for absolute URLs, so it
  // can be requested verbatim rather than picked apart for an ID.
  async getProgressByUrl(progressUrl: string) {
    return this.get(progressUrl);
  }

  async postAnnouncement(courseId: string, data: any) {
    return this.post(`/api/v1/courses/${courseId}/discussion_topics`, data);
  }

  // --- Assignments ---
  async listCourseAssignments(courseId: string, params: any = {}, options: { anonymous?: boolean } = {}) {
    const data = await this.get(`/api/v1/courses/${courseId}/assignments`, params) as any[];
    return options.anonymous !== false ? DataAnonymizer.anonymizeAssignments(data) : data;
  }
  async getAssignment(courseId: string, assignmentId: string, params: any = {}) {
    return this.get(`/api/v1/courses/${courseId}/assignments/${assignmentId}`, params);
  }
  // Assignment overrides — differentiated due dates. A New Quiz is backed by an
  // assignment, so its overrides live here too, not under /quizzes.
  async listAssignmentOverrides(courseId: string, assignmentId: string) {
    return this.fetchAllPages<any>(`/api/v1/courses/${courseId}/assignments/${assignmentId}/overrides`);
  }
  async createAssignmentOverride(courseId: string, assignmentId: string, data: any) {
    return this.post(`/api/v1/courses/${courseId}/assignments/${assignmentId}/overrides`, { assignment_override: data });
  }
  async updateAssignmentOverride(courseId: string, assignmentId: string, overrideId: string, data: any) {
    return this.put(`/api/v1/courses/${courseId}/assignments/${assignmentId}/overrides/${overrideId}`, { assignment_override: data });
  }
  async deleteAssignmentOverride(courseId: string, assignmentId: string, overrideId: string) {
    return this.delete(`/api/v1/courses/${courseId}/assignments/${assignmentId}/overrides/${overrideId}`);
  }

  // --- Quiz time extensions / accommodations ---
  //
  // Extra *minutes* on a timed quiz is not a date override, and the two quiz
  // engines express it through completely different endpoints and payloads:
  // Classic posts a quiz_extensions array under /api/v1, New Quizzes posts a
  // bare array of accommodations under /api/quiz/v1.
  async setQuizExtensions(courseId: string, quizId: string, extensions: any[]) {
    return this.post(`/api/v1/courses/${courseId}/quizzes/${quizId}/extensions`, { quiz_extensions: extensions });
  }
  // The body here is a bare JSON array, not an object with a wrapper key —
  // unlike every other write on this server.
  async setNewQuizAccommodations(courseId: string, assignmentId: string, accommodations: any[]) {
    return this.post(`/api/quiz/v1/courses/${courseId}/quizzes/${assignmentId}/accommodations`, accommodations);
  }
  async setCourseQuizAccommodations(courseId: string, accommodations: any[]) {
    return this.post(`/api/quiz/v1/courses/${courseId}/accommodations`, accommodations);
  }
  // Classic quiz submissions carry the granted extra_time/extra_attempts, which
  // is the only way to read back who already has an extension. New Quizzes has
  // no equivalent — its accommodations API is write-only.
  async listQuizSubmissions(courseId: string, quizId: string, params: any = {}) {
    return this.get<any>(`/api/v1/courses/${courseId}/quizzes/${quizId}/submissions`, params);
  }
  async getClassicQuiz(courseId: string, quizId: string) {
    return this.get(`/api/v1/courses/${courseId}/quizzes/${quizId}`);
  }

  /**
   * Work out which quiz engine an ID belongs to, by probing both.
   *
   * Both are probed rather than one, because a Classic quiz ID and a New Quiz's
   * assignment ID come from different tables and can collide: the same number
   * can name a real quiz under each engine, and posting an extension to the
   * wrong one would silently extend the wrong quiz. The caller decides what to
   * do when both answer.
   *
   * Failures are swallowed so a 404 reads as "not this engine", but both
   * failures are kept: when neither answers, the underlying error (a 401 on a
   * bad token looks nothing like a missing quiz) is what the caller needs.
   */
  async probeQuizEngines(courseId: string, quizId: string): Promise<{
    classic: any | null;
    newQuiz: any | null;
    errors: { classic?: string; newQuiz?: string };
  }> {
    const [classicResult, newResult] = await Promise.allSettled([
      this.getClassicQuiz(courseId, quizId),
      this.getNewQuiz(courseId, quizId),
    ]);
    const errors: { classic?: string; newQuiz?: string } = {};
    if (classicResult.status === 'rejected') errors.classic = classicResult.reason?.message ?? String(classicResult.reason);
    if (newResult.status === 'rejected') errors.newQuiz = newResult.reason?.message ?? String(newResult.reason);
    return {
      classic: classicResult.status === 'fulfilled' ? classicResult.value : null,
      newQuiz: newResult.status === 'fulfilled' ? newResult.value : null,
      errors,
    };
  }

  // Student enrollments in one section. Extensions are per-student in both
  // engines — Canvas has no section-level extension — so a section-wide
  // accommodation has to be expanded to user IDs here.
  async listSectionEnrollments(sectionId: string, params: any = {}) {
    return this.fetchAllPages<any>(`/api/v1/sections/${sectionId}/enrollments`, params);
  }

  async createAssignment(courseId: string, data: any) {
    return this.post(`/api/v1/courses/${courseId}/assignments`, data);
  }
  async updateAssignment(courseId: string, assignmentId: string, data: any) {
    return this.put(`/api/v1/courses/${courseId}/assignments/${assignmentId}`, data);
  }
  // result_type=Quiz asks Canvas to serialize the copy as a quiz, which it needs
  // for New Quizzes. Duplication can also be asynchronous: the copy comes back
  // with workflow_state 'duplicating' and finishes later.
  async duplicateAssignment(courseId: string, assignmentId: string, params: any = {}) {
    return this.post(`/api/v1/courses/${courseId}/assignments/${assignmentId}/duplicate`, {}, params);
  }

  // --- Calendar events ---
  async listCalendarEvents(params: any = {}) {
    return this.fetchAllPages<any>('/api/v1/calendar_events', params);
  }
  async createCalendarEvent(data: any) {
    const created = await this.post('/api/v1/calendar_events', data);
    this.invalidateCalendarListings();
    return created;
  }
  async updateCalendarEvent(eventId: string, data: any, params: any = {}) {
    const updated = await this.put(`/api/v1/calendar_events/${eventId}`, data, params);
    this.invalidateCalendarListings();
    return updated;
  }
  async deleteCalendarEvent(eventId: string, params: any = {}) {
    const deleted = await this.delete(`/api/v1/calendar_events/${eventId}`, params);
    this.invalidateCalendarListings();
    return deleted;
  }

  /**
   * An event is written at /calendar_events/:id but listed at
   * /calendar_events — and the parent of the write path is exactly the case
   * invalidateForWrite refuses to touch, since climbing there would be too
   * broad for most collections. Without this, editing or deleting an event
   * leaves the listing showing it unchanged, which is indistinguishable from
   * Canvas having ignored the write. Same failure the file tools hit.
   */
  private invalidateCalendarListings(): void {
    this.cache.invalidateContaining('/calendar_events');
  }

  // --- Assignment Groups ---
  async listAssignmentGroups(courseId: string) {
    return this.get(`/api/v1/courses/${courseId}/assignment_groups`, { per_page: 100 });
  }
  async createAssignmentGroup(courseId: string, data: any) {
    return this.post(`/api/v1/courses/${courseId}/assignment_groups`, data);
  }

  // --- Modules ---
  async listModules(courseId: string, params: any = {}) {
    return this.get(`/api/v1/courses/${courseId}/modules`, { per_page: 100, ...params });
  }
  async listModuleItems(courseId: string, moduleId: string, params: any = {}) {
    return this.get(`/api/v1/courses/${courseId}/modules/${moduleId}/items`, { per_page: 100, ...params });
  }
  async getModule(courseId: string, moduleId: string) {
    return this.get(`/api/v1/courses/${courseId}/modules/${moduleId}`);
  }
  async updateModulePublish(courseId: string, moduleId: string, data: any) {
    return this.put(`/api/v1/courses/${courseId}/modules/${moduleId}`, data);
  }
  async createModule(courseId: string, data: any) {
    return this.post(`/api/v1/courses/${courseId}/modules`, data);
  }
  async updateModule(courseId: string, moduleId: string, data: any) {
    return this.put(`/api/v1/courses/${courseId}/modules/${moduleId}`, data);
  }
  async getModuleItem(courseId: string, moduleId: string, itemId: string) {
    return this.get(`/api/v1/courses/${courseId}/modules/${moduleId}/items/${itemId}`);
  }
  async createModuleItem(courseId: string, moduleId: string, data: any) {
    return this.post(`/api/v1/courses/${courseId}/modules/${moduleId}/items`, data);
  }
  async updateModuleItem(courseId: string, moduleId: string, itemId: string, data: any) {
    return this.put(`/api/v1/courses/${courseId}/modules/${moduleId}/items/${itemId}`, data);
  }

  // --- Pages ---
  async listPages(courseId: string, params: any = {}) {
    return this.get(`/api/v1/courses/${courseId}/pages`, { per_page: 100, ...params });
  }
  async getPage(courseId: string, pageUrl: string) {
    return this.get(`/api/v1/courses/${courseId}/pages/${encodeURIComponent(pageUrl)}`);
  }
  async listPageRevisions(courseId: string, pageUrl: string) {
    return this.get(`/api/v1/courses/${courseId}/pages/${encodeURIComponent(pageUrl)}/revisions`);
  }
  async revertPageRevision(courseId: string, pageUrl: string, revisionId: string) {
    return this.post(`/api/v1/courses/${courseId}/pages/${encodeURIComponent(pageUrl)}/revisions/${revisionId}/revert`);
  }
  async updateOrCreatePage(courseId: string, pageUrl: string, data: any) {
    return this.put(`/api/v1/courses/${courseId}/pages/${encodeURIComponent(pageUrl)}`, data);
  }

  // --- Rubrics ---
  async listRubrics(courseId: string) {
    return this.get(`/api/v1/courses/${courseId}/rubrics`);
  }
  async getRubricStatistics(courseId: string, assignmentId: string, params: any = {}) {
    return this.get(`/api/v1/courses/${courseId}/assignments/${assignmentId}`, params);
  }
  async listRubricAssessments(courseId: string, assignmentId: string, params: any = {}, options: { anonymous?: boolean } = {}) {
    const data = await this.fetchAllPages<any>(`/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`, params);
    return options.anonymous !== false ? DataAnonymizer.anonymizeSubmissions(data) : data;
  }
  async attachRubricToAssignment(courseId: string, assignmentId: string, rubricId: string) {
    return this.put(`/api/v1/courses/${courseId}/assignments/${assignmentId}`, {}, { rubric_id: rubricId });
  }

  // --- Students ---
  async listStudents(courseId: string, params: any = {}, options: { anonymous?: boolean } = {}) {
    const data = await this.fetchAllPages<any>(`/api/v1/courses/${courseId}/users`, params);
    return options.anonymous !== false ? DataAnonymizer.anonymizeUsers(data) : data;
  }

  // --- Sections ---
  async listSections(courseId: string, params: any = {}) {
    return this.get(`/api/v1/courses/${courseId}/sections`, params);
  }
  async getSection(courseId: string, sectionId: string) {
    return this.get(`/api/v1/courses/${courseId}/sections/${sectionId}`);
  }
  async listSectionAssignmentSubmissions(sectionId: string, assignmentId: string, params: any = {}, options: { anonymous?: boolean } = {}) {
    const data = await this.fetchAllPages<any>(`/api/v1/sections/${sectionId}/assignments/${assignmentId}/submissions`, params);
    return options.anonymous !== false ? DataAnonymizer.anonymizeSubmissions(data) : data;
  }

  // --- Submissions ---
  async listAssignmentSubmissions(courseId: string, assignmentId: string, params: any = {}, options: { anonymous?: boolean } = {}) {
    const data = await this.fetchAllPages<any>(`/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`, params);
    return options.anonymous !== false ? DataAnonymizer.anonymizeSubmissions(data) : data;
  }
  async gradeSubmission(courseId: string, assignmentId: string, userId: string, data: any) {
    return this.put(`/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`, data);
  }

  // --- Submission Documents ---
  async getSubmission(courseId: string, assignmentId: string, userId: string, params: any = {}) {
    return this.get(`/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`, params);
  }

  async getSubmissionWithAttachments(courseId: string, assignmentId: string, userId: string, options: { anonymous?: boolean } = {}) {
    const params = { include: ['attachments', 'submission_comments'] };
    const data = await this.get(`/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`, params);
    return options.anonymous !== false ? DataAnonymizer.anonymizeSubmissions([data])[0] : data;
  }

  /**
   * Upload a file into a course. Canvas does not accept file bytes on a normal
   * API call — this is a three-step handshake, and two steps of it are easy to
   * get subtly wrong:
   *
   *   1. POST the metadata to Canvas, which answers with an upload_url and a
   *      bag of upload_params.
   *   2. POST the bytes as multipart/form-data to that upload_url. The URL
   *      usually points at S3 or inst-fs, NOT at Canvas, so the Canvas bearer
   *      token must not be attached — hence a bare axios client here. The
   *      upload_params must also be written before the file field; S3 ignores
   *      form fields that arrive after the file content.
   *   3. The upload answers either 201 with the file object, or a redirect that
   *      has to be followed to finalize. Redirect-following is disabled so the
   *      Location can be inspected before anything is sent to it.
   */
  async uploadCourseFile(
    courseId: string,
    file: {
      name: string;
      size: number;
      contentType: string;
      parentFolderPath?: string;
      parentFolderId?: string;
      onDuplicate?: 'overwrite' | 'rename';
    },
    contents: Buffer | Uint8Array
  ): Promise<any> {
    const metadata: Record<string, any> = {
      name: file.name,
      size: file.size,
      content_type: file.contentType,
      on_duplicate: file.onDuplicate ?? 'rename',
    };
    // parent_folder_id and parent_folder_path are mutually exclusive; sending
    // both makes Canvas reject the request outright.
    if (file.parentFolderId) metadata.parent_folder_id = file.parentFolderId;
    else metadata.parent_folder_path = file.parentFolderPath ?? '/';

    const init: any = await this.post(`/api/v1/courses/${courseId}/files`, metadata);
    if (!init?.upload_url) {
      throw new Error(
        `Canvas did not return an upload_url for "${file.name}"; got ${JSON.stringify(init).slice(0, 300)}`
      );
    }

    const form = new FormData();
    for (const [key, value] of Object.entries(init.upload_params ?? {})) {
      form.append(key, String(value));
    }
    form.append('file', new Blob([contents], { type: file.contentType }), file.name);

    let uploaded;
    try {
      uploaded = await axios.post(init.upload_url, form, {
        maxRedirects: 0,
        validateStatus: status => status < 400,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
    } catch (error: any) {
      this.handleError(error);
    }

    // 201 means the store already created the file and handed it back.
    if (uploaded.status === 201 && uploaded.data?.id) {
      this.invalidateFileListings();
      return uploaded.data;
    }

    const location = uploaded.headers?.location;
    if (!location) {
      this.invalidateFileListings();
      return uploaded.data;
    }

    // The confirmation step goes back to Canvas and needs the bearer token, but
    // only send it if the redirect really is pointing at this Canvas instance —
    // never hand the token to whatever host a Location header names.
    const confirmed = this.isSameHostAsCanvas(location)
      ? await this.axios.get(location)
      : await axios.get(location);
    this.invalidateFileListings();
    return confirmed.data;
  }

  private isSameHostAsCanvas(url: string): boolean {
    try {
      return new URL(url).host === new URL(this.baseUrl).host;
    } catch {
      return false;
    }
  }

  async listCourseFiles(courseId: string, params: any = {}): Promise<any[]> {
    return this.fetchAllPages<any>(`/api/v1/courses/${courseId}/files`, params);
  }

  /**
   * Files in one folder. This needs its own endpoint: /courses/:id/files takes
   * no folder_id, and passing one is silently ignored rather than rejected —
   * you get every file in the course back and nothing says the filter was
   * dropped. Confirmed live against course 18473.
   */
  async listFolderFiles(folderId: string, params: any = {}): Promise<any[]> {
    return this.fetchAllPages<any>(`/api/v1/folders/${folderId}/files`, params);
  }

  async listCourseFolders(courseId: string): Promise<any[]> {
    return this.fetchAllPages<any>(`/api/v1/courses/${courseId}/folders`);
  }

  async updateFile(fileId: string, payload: any): Promise<any> {
    const updated = await this.put(`/api/v1/files/${fileId}`, payload);
    this.invalidateFileListings();
    return updated;
  }

  /**
   * A file is written at /files/:id but listed under /courses/:id/files and
   * /folders/:id/files, so the usual prefix invalidation misses both listings.
   * Observed live: publishing a file and immediately listing its folder still
   * reported the old state, which reads as the write having failed.
   */
  private invalidateFileListings(): void {
    this.cache.invalidateContaining('/files');
  }

  async getFileInfo(fileId: string): Promise<any> {
    return this.get(`/api/v1/files/${fileId}`);
  }

  // Download file content (returns the file data as binary or text depending on type)
  async downloadFile(fileId: string): Promise<{ data: any; contentType: string; filename: string }> {
    try {
      // First get the file metadata to get the download URL
      const fileInfo = await this.getFileInfo(fileId);
      
      // Download the actual file content
      const response = await this.axios.get(fileInfo.url, { 
        responseType: 'arraybuffer',
        // Follow redirects as Canvas often returns redirect URLs
        maxRedirects: 5
      });
      
      return {
        data: response.data,
        contentType: response.headers['content-type'] || fileInfo['content-type'] || 'application/octet-stream',
        filename: fileInfo.filename || `file_${fileId}`
      };
    } catch (error: any) {
      this.handleError(error);
    }
  }

  // --- Instructor to-do / grading queue ---
  async listTodo(params: any = {}) {
    return this.get('/api/v1/users/self/todo', params);
  }
  async getTodoItemCount(params: any = {}) {
    return this.get('/api/v1/users/self/todo_item_count', params);
  }

  // --- Grades & intervention ---
  async listCourseEnrollments(courseId: string, params: any = {}, options: { anonymous?: boolean } = {}) {
    const data = await this.fetchAllPages<any>(`/api/v1/courses/${courseId}/enrollments`, params);
    if (options.anonymous !== true) return data;
    return data.map(e => (e.user ? { ...e, user: DataAnonymizer.anonymizeUser(e.user) } : e));
  }
  // Submissions across every assignment in one call (student_ids[]=all).
  async listCourseStudentSubmissions(courseId: string, params: any = {}, options: { anonymous?: boolean } = {}) {
    const data = await this.fetchAllPages<any>(`/api/v1/courses/${courseId}/students/submissions`, params);
    return options.anonymous === true ? DataAnonymizer.anonymizeSubmissions(data) : data;
  }
  async getStudentSummaries(courseId: string, params: any = {}) {
    return this.fetchAllPages<any>(`/api/v1/courses/${courseId}/analytics/student_summaries`, params);
  }

  // --- Conversations (read-only by design) ---
  // Single page by design: the inbox can be very long and the caller slices to
  // a limit anyway, so walking every page would be wasted requests.
  async listConversations(params: any = {}) {
    return this.get<any[]>('/api/v1/conversations', params);
  }
  async getConversation(conversationId: string, params: any = {}) {
    return this.get(`/api/v1/conversations/${conversationId}`, params);
  }
  async getConversationsUnreadCount() {
    return this.get('/api/v1/conversations/unread_count');
  }

  // --- New Quizzes (separate API root from Classic Quizzes) ---
  async listNewQuizzes(courseId: string) {
    return this.fetchAllPages<any>(`/api/quiz/v1/courses/${courseId}/quizzes`, { per_page: 100 });
  }
  async getNewQuiz(courseId: string, assignmentId: string) {
    return this.get(`/api/quiz/v1/courses/${courseId}/quizzes/${assignmentId}`);
  }
  async createNewQuiz(courseId: string, quiz: any) {
    return this.post(`/api/quiz/v1/courses/${courseId}/quizzes`, { quiz });
  }
  async updateNewQuiz(courseId: string, assignmentId: string, quiz: any) {
    return this.patch(`/api/quiz/v1/courses/${courseId}/quizzes/${assignmentId}`, { quiz });
  }
  async deleteNewQuiz(courseId: string, assignmentId: string) {
    return this.delete(`/api/quiz/v1/courses/${courseId}/quizzes/${assignmentId}`);
  }
  async listNewQuizItems(courseId: string, assignmentId: string) {
    return this.fetchAllPages<any>(`/api/quiz/v1/courses/${courseId}/quizzes/${assignmentId}/items`, { per_page: 100 });
  }
  async getNewQuizItem(courseId: string, assignmentId: string, itemId: string) {
    return this.get(`/api/quiz/v1/courses/${courseId}/quizzes/${assignmentId}/items/${itemId}`);
  }
  async createNewQuizItem(courseId: string, assignmentId: string, item: any) {
    return this.post(`/api/quiz/v1/courses/${courseId}/quizzes/${assignmentId}/items`, { item });
  }
  async updateNewQuizItem(courseId: string, assignmentId: string, itemId: string, item: any) {
    return this.patch(`/api/quiz/v1/courses/${courseId}/quizzes/${assignmentId}/items/${itemId}`, { item });
  }
  async deleteNewQuizItem(courseId: string, assignmentId: string, itemId: string) {
    return this.delete(`/api/quiz/v1/courses/${courseId}/quizzes/${assignmentId}/items/${itemId}`);
  }
  async createNewQuizReport(courseId: string, assignmentId: string, reportType: string, format: string) {
    return this.post(`/api/quiz/v1/courses/${courseId}/quizzes/${assignmentId}/reports`, {
      quiz_report: { report_type: reportType, format }
    });
  }
  async getProgress(progressId: string) {
    return this.get(`/api/v1/progress/${progressId}`);
  }

  // Get submission documents with file download capability
  async getSubmissionDocuments(courseId: string, assignmentId: string, userId: string, options: { 
    downloadFiles?: boolean; 
    anonymous?: boolean 
  } = {}) {
    try {
      const submission = await this.getSubmissionWithAttachments(courseId, assignmentId, userId, { anonymous: options.anonymous });
      
      const result: any = {
        submission: submission,
        attachments: submission.attachments || [],
        textSubmission: submission.body || null,
        submissionType: submission.submission_type,
        downloadedFiles: []
      };

      // If downloadFiles is true, download all attached files
      if (options.downloadFiles && submission.attachments && submission.attachments.length > 0) {
        for (const attachment of submission.attachments) {
          try {
            const fileData = await this.downloadFile(attachment.id);
            result.downloadedFiles.push({
              id: attachment.id,
              filename: attachment.filename || attachment.display_name,
              contentType: fileData.contentType,
              size: attachment.size,
              data: fileData.data,
              // Convert binary data to base64 for JSON serialization if needed
              dataBase64: Buffer.from(fileData.data).toString('base64')
            });
          } catch (error) {
            console.warn(`Failed to download file ${attachment.id}:`, error);
            result.downloadedFiles.push({
              id: attachment.id,
              filename: attachment.filename || attachment.display_name,
              error: `Failed to download: ${error instanceof Error ? error.message : 'Unknown error'}`
            });
          }
        }
      }

      return result;
    } catch (error: any) {
      this.handleError(error);
    }
  }
} 