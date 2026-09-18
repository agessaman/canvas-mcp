import axios from 'axios';
import { CanvasClient } from './canvasClient.js';

/**
 * New Quizzes item banks — the pools a New Quiz draws random questions from.
 *
 * THIS FILE TALKS TO A PRIVATE INSTRUCTURE API. Nothing here is documented or
 * versioned, and it is quarantined from CanvasClient for that reason: a break
 * in Instructure's quiz service must not be able to take the rest of the server
 * with it.
 *
 * The banks are NOT in Canvas. `ItemBanksController#show` renders an empty
 * `<div id="ams_container">` and hands the browser an LTI launch; the data
 * lives on `quiz-api-<region>-prod.instructure.com`, a host the public Canvas
 * API never names. So there is no `/api/v1` or `/api/quiz/v1` route to call —
 * reaching a bank means replaying, headlessly, the same launch the browser does:
 *
 *   0. GET /api/v1/courses/:id/external_tools     -> the Quizzes 2 tool, whose
 *      url gives the quiz-lti host (and therefore the region — do NOT hardcode
 *      `iad-prod`, other instances differ).
 *   1. GET /login/session_token?return_to=<banks page>, then follow the
 *      redirects with a cookie jar. The page embeds `ENV.NEW_QUIZZES`, which is
 *      Canvas's OWN signed LTI launch: 64 params plus an HMAC it computed with
 *      the tool's shared secret. Nothing is forged here; the signature is
 *      Canvas's, which is the only reason this is possible at all.
 *   2. POST /api/v1/jwts with workflows[]=new_quizzes_native_launch -> a Canvas
 *      JWT scoped to the launch.
 *   3. POST <quiz-lti>/api/native/launch with that JWT and the signed params
 *      -> an access_token for quiz-lti.
 *   4. GET <quiz-lti>/api/sdk_tokens/banks.build with that access_token -> the
 *      bearer quiz-api accepts, plus `host` (use it; don't derive the quiz-api
 *      hostname by string surgery when the server will tell you).
 *
 * Every token stays in memory. None is logged, and CANVAS_API_TOKEN is never
 * sent to a quiz-* host.
 *
 * QUIRK, and it costs an hour if you miss it: quiz-api wants
 * `Authorization: <token>` with NO `Bearer ` prefix. With the prefix it answers
 * 401 `JWT::DecodeError: Invalid segment encoding`, which reads like a bad
 * token rather than a bad header.
 *
 * Verified end to end against a live instance on 2026-09-17.
 */

// The sdk token's own `exp` is ~24h out, but it is re-minted cheaply, so retire
// it early rather than racing the clock on a long-running server.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

// Bound on redirect-following while rendering the banks page, so a redirect
// loop can't spin forever.
const MAX_REDIRECTS = 10;

interface BankSession {
  quizApiBase: string;   // full origin, e.g. https://x.quiz-api-iad-prod.instructure.com
  token: string;
  expiresAt: number;     // ms epoch
  courseUuid: string;    // the launch context's uuid, for shared_banks queries
}

interface ToolHosts {
  toolId: string;
  quizLtiBase: string;
}

export class NewQuizzesLtiClient {
  private hosts = new Map<string, ToolHosts>();
  private sessions = new Map<string, BankSession>();
  private interactionTypes?: Promise<any[]>;

  constructor(
    private canvas: CanvasClient,
    private baseUrl: string,
    private apiToken: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  // --- step 0: which tool, and therefore which region's quiz-lti host ---
  private async resolveHosts(courseId: string): Promise<ToolHosts> {
    const cached = this.hosts.get(courseId);
    if (cached) return cached;

    const tools: any[] = await this.canvas.fetchAllPages(
      `/api/v1/courses/${courseId}/external_tools`,
      { per_page: 100, include_parents: true },
    );
    const urlOf = (url: any) => { try { return new URL(String(url)); } catch { return undefined; } };
    const tool = tools.find(t => urlOf(t.url)?.host.includes('quiz-lti'));
    if (!tool) {
      throw new Error(
        `Course ${courseId} has no Quizzes 2 (New Quizzes) LTI tool installed, so it has no item banks to read. `
        + `Item banks are reached through that tool's launch; without it there is no endpoint to call.`
      );
    }
    // The tool's own origin, scheme included — not `https://` + host. Canvas
    // reports the scheme it will actually launch with, and assuming https makes
    // the client unusable against any instance that does not use it.
    const resolved = { toolId: String(tool.id), quizLtiBase: urlOf(tool.url)!.origin };
    this.hosts.set(courseId, resolved);
    return resolved;
  }

  // --- step 1: render the banks page as the user and lift Canvas's signed launch ---
  //
  // Deliberately NOT routed through CanvasClient: a session_token is single-use,
  // and CanvasClient caches GETs. Serving a spent token from cache would fail in
  // a way that looks like a permissions problem.
  private async signedLaunch(courseId: string, toolId: string): Promise<{ params: any; signature: string }> {
    const returnTo = `${this.baseUrl}/courses/${courseId}/banks/${toolId}`;
    const res = await axios.get(`${this.baseUrl}/login/session_token`, {
      params: { return_to: returnTo },
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });
    const sessionUrl: string | undefined = res.data?.session_url;
    if (!sessionUrl) {
      throw new Error('Canvas did not return a session_url for the item banks page.');
    }

    // A small cookie jar: Canvas sets canvas_session on the way in, and the
    // final page only renders for a request that carries it.
    //
    // The jar is bound to Canvas's own origin and the chase refuses to leave
    // it. A session cookie is a live credential for the user's Canvas account,
    // and a redirect is attacker-influenceable in a way the original URL is
    // not — following one off-origin would hand that cookie to whoever the
    // Location header named.
    const canvasOrigin = new URL(this.baseUrl).origin;
    const jar = new Map<string, string>();
    const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let url = sessionUrl;
    let html: string | undefined;
    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      if (new URL(url).origin !== canvasOrigin) {
        throw new Error(
          `Opening the item banks page redirected off Canvas, to ${new URL(url).origin}. Refusing to follow it: `
          + `the request carries a Canvas session cookie.`
        );
      }
      const page = await fetch(url, {
        redirect: 'manual',
        headers: { Cookie: cookieHeader(), Accept: 'text/html' },
      });
      for (const raw of page.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      if (page.status >= 300 && page.status < 400) {
        const location = page.headers.get('location');
        if (!location) throw new Error(`Canvas redirected to nowhere while opening the item banks page (${page.status}).`);
        url = new URL(location, url).toString();
        continue;
      }
      if (!page.ok) {
        throw new Error(`Canvas returned ${page.status} for the item banks page (${url.split('?')[0]}).`);
      }
      html = await page.text();
      break;
    }
    if (html === undefined) {
      throw new Error(`The item banks page kept redirecting (more than ${MAX_REDIRECTS} hops) and never rendered.`);
    }

    const match = html.match(/"NEW_QUIZZES":\s*(\{.*?"launchType":"[^"]*"\})/s);
    if (!match) {
      throw new Error(
        'The Canvas item banks page did not carry a New Quizzes launch (ENV.NEW_QUIZZES). This is the private '
        + 'surface these tools depend on; Canvas may have changed it, or this account may not have New Quizzes enabled.'
      );
    }
    const parsed = JSON.parse(match[1]);
    if (!parsed?.params || !parsed?.signature) {
      throw new Error('The New Quizzes launch on the item banks page was missing its params or signature.');
    }
    return { params: parsed.params, signature: parsed.signature };
  }

  // --- step 2: the root account, which the JWT is scoped to ---
  private async rootAccountId(courseId: string): Promise<string> {
    const course: any = await this.canvas.get(`/api/v1/courses/${courseId}`, { 'include[]': 'account' });
    const account = course?.account;
    // A sub-account names its root; a root account's own root_account_id is null.
    const id = account?.root_account_id ?? account?.id ?? course?.root_account_id;
    if (id === undefined || id === null) {
      throw new Error(`Could not determine the root account for course ${courseId}, which the New Quizzes launch needs.`);
    }
    return String(id);
  }

  // --- steps 1-4, cached per course ---
  private async session(courseId: string, force = false): Promise<BankSession> {
    const cached = this.sessions.get(courseId);
    if (!force && cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) return cached;

    const { toolId, quizLtiBase } = await this.resolveHosts(courseId);
    const [launch, rootId] = await Promise.all([
      this.signedLaunch(courseId, toolId),
      this.rootAccountId(courseId),
    ]);

    // Canvas signs this JWT itself; it is only good for the native launch below.
    const jwt = await axios.post(`${this.baseUrl}/api/v1/jwts`, null, {
      params: {
        canvas_audience: false,
        'workflows[]': 'new_quizzes_native_launch',
        context_id: rootId,
        context_type: 'account',
      },
      headers: { Authorization: `Bearer ${this.apiToken}` },
    }).catch((e: any) => { throw this.normalise(e, 'minting the New Quizzes launch JWT'); });

    const native = await axios.post(
      `${quizLtiBase}/api/native/launch`,
      { params: launch.params, signature: launch.signature },
      { headers: { Authorization: `Bearer ${jwt.data.token}`, 'Content-Type': 'application/json' } },
    ).catch((e: any) => { throw this.normalise(e, 'launching the New Quizzes tool'); });

    const sdk = await axios.get(`${quizLtiBase}/api/sdk_tokens/banks.build`, {
      headers: { Authorization: `Bearer ${native.data.access_token}`, Accept: 'application/json' },
    }).catch((e: any) => { throw this.normalise(e, 'exchanging the launch for an item bank token'); });

    if (!sdk.data?.token || !sdk.data?.host) {
      throw new Error('The New Quizzes launch returned no item bank token; the private API may have changed.');
    }

    // Prefer the exp the token itself carries over anything assumed.
    let expiresAt = Date.now() + 60 * 60 * 1000;
    try {
      const payload = JSON.parse(Buffer.from(String(sdk.data.token).split('.')[1], 'base64url').toString());
      if (typeof payload?.exp === 'number') expiresAt = payload.exp * 1000;
    } catch { /* keep the conservative default */ }

    const session: BankSession = {
      quizApiBase: String(sdk.data.host).replace(/\/$/, ''),
      token: sdk.data.token,
      expiresAt,
      courseUuid: native.data?.item_banks_scope?.uuid ?? '',
    };
    this.sessions.set(courseId, session);
    return session;
  }

  /** Drop cached launches and tokens. Used by refresh-canvas-data. */
  clearSessions(): number {
    const dropped = this.sessions.size;
    this.sessions.clear();
    this.hosts.clear();
    this.interactionTypes = undefined;
    return dropped;
  }

  // --- quiz-api requests ---
  //
  // One retry on 401 and no more: the sdk token expiring mid-call is ordinary,
  // but a token that is refused twice is a real failure and must surface as one
  // rather than becoming a relaunch loop against a private service.
  private async request<T>(
    courseId: string,
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    body?: any,
    params?: any,
  ): Promise<{ data: T; headers: any }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const session = await this.session(courseId, attempt > 0);
      try {
        const res = await axios.request({
          method,
          url: `${session.quizApiBase}${path}`,
          data: body,
          params,
          // No "Bearer" — quiz-api reads the raw JWT. See the file header.
          headers: {
            Authorization: session.token,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
        });
        return { data: res.data as T, headers: res.headers };
      } catch (error: any) {
        if (error?.response?.status === 401 && attempt === 0) continue;
        throw this.normalise(error, `${method.toUpperCase()} ${path}`);
      }
    }
    /* c8 ignore next */
    throw new Error('Unreachable: item bank request retry exhausted');
  }

  async get<T>(courseId: string, path: string, params?: any): Promise<T> {
    return (await this.request<T>(courseId, 'get', path, undefined, params)).data;
  }

  async post<T>(courseId: string, path: string, body: any): Promise<T> {
    return (await this.request<T>(courseId, 'post', path, body)).data;
  }

  async patch<T>(courseId: string, path: string, body: any): Promise<T> {
    return (await this.request<T>(courseId, 'patch', path, body)).data;
  }

  async delete<T>(courseId: string, path: string): Promise<T> {
    return (await this.request<T>(courseId, 'delete', path)).data;
  }

  /**
   * A collection page plus the `total` header quiz-api sends. The count is the
   * whole collection's, not the page's, which is the only way to tell a caller
   * whether there is more without walking every page.
   */
  async getPage<T>(courseId: string, path: string, params?: any): Promise<{ items: T[]; total?: number }> {
    const { data, headers } = await this.request<T[]>(courseId, 'get', path, undefined, params);
    const total = Number(headers?.total);
    return { items: data, total: Number.isFinite(total) ? total : undefined };
  }

  /**
   * slug -> { id, userResponseType }. quiz-api takes a NUMERIC
   * interaction_type_id where the New Quizzes `/api/quiz/v1` item API takes an
   * interaction_type_slug, so an item built for one needs translating for the
   * other. The ids are fetched rather than hardcoded — they are per-instance
   * data, not constants.
   */
  async interactionTypeMap(courseId: string): Promise<Map<string, { id: string; userResponseType?: string }>> {
    if (!this.interactionTypes) {
      this.interactionTypes = this.get<any[]>(courseId, '/api/interaction_types')
        .catch(e => { this.interactionTypes = undefined; throw e; });
    }
    const types = await this.interactionTypes;
    return new Map(types.map(t => [t.slug, { id: String(t.id), userResponseType: t.user_response_type_options?.[0] }]));
  }

  /**
   * Error messages say "New Quizzes item bank API (private)" on purpose: when
   * this breaks, the reader needs to know immediately that they are looking at
   * an undocumented surface Instructure can change without notice, not at a bug
   * in their own call.
   */
  private normalise(error: any, where: string): Error {
    const status = error?.response?.status;
    const data = error?.response?.data;
    let detail = '';
    if (data) {
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        detail = data.errors.map((e: any) => e.message ?? JSON.stringify(e)).join('; ');
      } else if (data.error) detail = String(data.error);
      else if (typeof data === 'string') detail = data;
      else detail = JSON.stringify(data);
    } else if (error instanceof Error) {
      detail = error.message;
    }
    const prefix = `New Quizzes item bank API (private) ${status ?? 'error'} while ${where}`;
    return new Error(detail ? `${prefix}: ${detail.slice(0, 800)}` : prefix);
  }
}
