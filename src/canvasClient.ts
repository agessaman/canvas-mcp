import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { DataAnonymizer } from './anonymizer.js';
import { SimpleCache } from './cache.js';

// URL fragments whose responses must never be cached (live grade, roster-state,
// inbox, and grading-queue data — all of which change under the instructor's feet)
const UNCACHED_PATTERNS = ['/submissions', '/enrollments', '/conversations', '/todo', '/progress'];

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
  async postAnnouncement(courseId: string, data: any) {
    return this.post(`/api/v1/courses/${courseId}/discussion_topics`, data);
  }

  // --- Assignments ---
  async listCourseAssignments(courseId: string, params: any = {}, options: { anonymous?: boolean } = {}) {
    const data = await this.get(`/api/v1/courses/${courseId}/assignments`, params) as any[];
    return options.anonymous !== false ? DataAnonymizer.anonymizeAssignments(data) : data;
  }
  async getAssignment(courseId: string, assignmentId: string) {
    return this.get(`/api/v1/courses/${courseId}/assignments/${assignmentId}`);
  }
  async createAssignment(courseId: string, data: any) {
    return this.post(`/api/v1/courses/${courseId}/assignments`, data);
  }
  async updateAssignment(courseId: string, assignmentId: string, data: any) {
    return this.put(`/api/v1/courses/${courseId}/assignments/${assignmentId}`, data);
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
      this.invalidateForWrite(`/api/v1/courses/${courseId}/files`);
      return uploaded.data;
    }

    const location = uploaded.headers?.location;
    if (!location) {
      this.invalidateForWrite(`/api/v1/courses/${courseId}/files`);
      return uploaded.data;
    }

    // The confirmation step goes back to Canvas and needs the bearer token, but
    // only send it if the redirect really is pointing at this Canvas instance —
    // never hand the token to whatever host a Location header names.
    const confirmed = this.isSameHostAsCanvas(location)
      ? await this.axios.get(location)
      : await axios.get(location);
    this.invalidateForWrite(`/api/v1/courses/${courseId}/files`);
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
    return this.put(`/api/v1/files/${fileId}`, payload);
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