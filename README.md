# Canvas MCP Server

[![npm version](https://img.shields.io/npm/v/@r-huijts/canvas-mcp)](https://www.npmjs.com/package/@r-huijts/canvas-mcp)
[![license](https://img.shields.io/npm/l/@r-huijts/canvas-mcp)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-stdio-blue)](https://modelcontextprotocol.io)

> Connect AI assistants to Canvas LMS — manage courses, grade submissions, edit pages, and analyze rubrics through natural conversation.

## Quick Start

1. **Get a Canvas API token** — Canvas → Account → Settings → Approved Integrations → [New Access Token](https://community.canvaslms.com/t5/Student-Guide/How-do-I-manage-API-access-tokens-as-a-student/ta-p/273)
2. **Install** via [Claude Desktop Extension](#option-1-desktop-extension-easiest) or `npx @r-huijts/canvas-mcp`
3. **Try a prompt** — *"List all my active Canvas courses"*

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Claude Desktop Integration](#claude-desktop-integration)
- [Other MCP Clients](#other-mcp-clients)
- [Usage Examples](#usage-examples)
- [Student Data Privacy](#student-data-privacy)
- [Tool Reference](#tool-reference)
  - [Grading an assignment efficiently](#grading-an-assignment-efficiently)
- [Available Prompts](#available-prompts)
- [Troubleshooting](#troubleshooting)
- [Performance & Caching](#performance--caching)
- [Development](#development)
- [Contributing](#contributing)
- [Security Notes](#security-notes)
- [Related Documentation](#related-documentation)
- [License](#license)

## Features

- **Courses** — list courses (including unpublished shells and past terms, with name/code search), look up a course by ID, post announcements
- **Assignments** — create, update, delete assignments and assignment groups; bulk date updates
- **Grading** — grading packets (instructions, rubric IDs, linked handouts, queue) read once, then work-only calls per student; student work as text and images (PDF, Word, photos, scans, OCR on macOS); roster-aware name scrubbing that catches partners typed onto a worksheet; partner detection; dry-run grades with a letter-grade preview; dates in the course time zone; validated rubric grading, feedback only with teacher approval
- **Rubrics** — read a rubric's full criteria and ratings, draft and edit rubrics, align criteria to outcomes, analyze statistics, attach rubrics to assignments
- **Outcomes** — create, edit, organise, and link learning outcomes (standards)
- **Students** — enrollment lists with privacy-first anonymization
- **Sections** — list sections and section-filtered submissions
- **Modules** — full module and module-item CRUD
- **Pages** — edit content, manage revisions, and use the styleguide system (`generate-styleguide`, `patch-page-content`)
- **Quizzes** — full quiz, question, and question-group CRUD (Classic Quizzes)
- **Quiz results** — per-student answers, item analysis, report generation, answer-change logs and regrading (Classic Quizzes)
- **New Quizzes** — authoring and item analysis on the separate `/api/quiz/v1` API, with a question builder that generates answer IDs and scoring rules for you
- **Grading queue** — `list-grading-todo` answers "what do I need to grade?" across every course
- **Grades & intervention** — course-wide gradebook, missing-work report, and engagement analytics for planning outreach
- **Overrides** — differentiated due dates and date accommodations, per student or per section, with `extend-due-date` for the everyday case
- **Late policy** — the course-wide rule for missing and late work (`get-late-policy`, `set-late-policy`). The API stores a *deduction* while the Canvas UI asks for the *resulting grade*, so these tools take the UI's framing and convert; passing the UI's number straight to the API would award full marks for work never handed in
- **Assignment attempt extensions** — another try at an assignment for one student or a section (`extend-assignment-attempts`), the third accommodation shape alongside a later due date and a longer quiz clock
- **Quiz time extensions** — extra *minutes* on a timed quiz, the clock accommodation that a due date can't express, for both quiz engines (`extend-quiz-time`), plus a course-wide standing accommodation for New Quizzes
- **Course settings & syllabus** — edit the syllabus (a course attribute the page tools cannot reach, backed up to an unpublished page before each replace), publish or conclude a course, set the landing page and front page
- **Calendar** — meetings, exam dates and recurring office hours on the course calendar, with series-aware edits and deletes
- **Course copy** — pull last term's course into this term's shell and shift every date onto the new calendar, with the migration's dropped-content report surfaced rather than buried
- **Files** — upload local files into a course's Files area (syllabi, handouts, images), publish or unpublish them, and browse what's already there
- **Conversations** — read-only inbox triage (sending is intentionally not exposed)
- **ePortfolios** — list and read student ePortfolios
- **Prompts** — `grade-assignment` for a guided grading session; `analyze-rubric-statistics` for multi-assignment rubric visualizations
- **Performance** — ETag-based response caching to reduce API load and token use

**134 tools** and **2 prompts** in total, plus **8 opt-in tools** for New Quizzes item banks and stimuli (see [below](#new-quizzes-item-banks-opt-in)). See [docs/TOOLS.md](docs/TOOLS.md) for the full parameter reference.

## Prerequisites

- Node.js v16 or higher (for npm/source installs; not required for the Desktop Extension)
- A Canvas API token with access to the courses you intend to manage
- Your Canvas instance URL (e.g. `https://yourschool.instructure.com`)

> **Note:** The server defaults to `https://fhict.instructure.com` if `CANVAS_BASE_URL` is not set. Set this variable to your own institution's Canvas URL.

## Installation

### Option 1: Desktop Extension (Easiest)

One-click installation with Claude Desktop Extensions:

1. **Download** the latest extension from [GitHub Releases](https://github.com/agessaman/canvas-mcp/releases) (`.mcpb` file)
2. **Open** the file with Claude Desktop (double-click or drag-and-drop)
3. **Click "Install"**
4. **Configure** your Canvas API token and base URL through the Claude Desktop UI

Benefits: no terminal required, secure token storage in the OS keychain, bundled dependencies, cross-platform (macOS and Windows).

To build the extension yourself, see [DESKTOP_EXTENSION.md](DESKTOP_EXTENSION.md).

### Option 2: NPM Package (Recommended)

```bash
npm install -g @r-huijts/canvas-mcp
```

Or run directly without installing:

```bash
npx @r-huijts/canvas-mcp
```

### Option 3: From Source

```bash
git clone -b feat/instructor-tools https://github.com/agessaman/canvas-mcp
cd canvas-mcp
npm install
cp .env.example .env   # then edit with your credentials
npm run build
npm start
```

`npm install` also brings in [`@napi-rs/canvas`](https://www.npmjs.com/package/@napi-rs/canvas), a prebuilt native renderer that is needed to turn scanned PDF pages into images and to downscale large phone photos — the usual shape of handwritten work. It is declared as an `optionalDependency`, so an install that skips it (a platform with no prebuilt binary, or `--no-optional`) still works: text extraction is unaffected, and a submission that actually needed rendering says so in its warnings. To add it later:

```bash
npm install @napi-rs/canvas
```

For development with auto-reload:

```bash
npm run dev
```

## Configuration

Set these environment variables (via `.env` file, MCP client config, or shell):

| Variable | Required | Description |
|----------|----------|-------------|
| `CANVAS_API_TOKEN` | Yes | Personal access token from Canvas |
| `CANVAS_BASE_URL` | No | Your Canvas instance URL (default: `https://fhict.instructure.com`) |
| `CANVAS_ENABLE_ITEM_BANKS` | No | Set to `true` to add the six New Quizzes item bank tools and the two stimulus tools, which use a **private** Instructure API. Off by default — see [New Quizzes item banks](#new-quizzes-item-banks-opt-in) |
| `CANVAS_MAX_GRADING_BATCH` | No | How many students `get-grading-packet`'s `userIds` may read in one call (default: `5`) |

See [.env.example](.env.example) for a template.

### Getting a Canvas API Token

1. Log in to your Canvas instance
2. Go to **Account → Settings → Approved Integrations**
3. Click **+ New Access Token**
4. Copy the token — you won't be able to see it again

Your token must belong to a user with teacher (or equivalent) access to the courses you want to manage. Canvas personal access tokens inherit the permissions of the account that created them.

## Claude Desktop Integration

1. Open Claude Desktop's configuration file:

   **macOS:**
   ```bash
   code ~/Library/Application\ Support/Claude/claude_desktop_config.json
   ```

   **Windows:**
   ```bash
   code %AppData%\Claude\claude_desktop_config.json
   ```

2. Add the Canvas MCP server:

   **NPM package (recommended):**
   ```json
   {
     "mcpServers": {
       "canvas": {
         "command": "npx",
         "args": ["-y", "@r-huijts/canvas-mcp"],
         "env": {
           "CANVAS_API_TOKEN": "your_token_here",
           "CANVAS_BASE_URL": "https://your-canvas-instance.com"
         }
       }
     }
   }
   ```

   **From source:**
   ```json
   {
     "mcpServers": {
       "canvas": {
         "command": "node",
         "args": ["/absolute/path/to/canvas-mcp/dist/index.js"],
         "env": {
           "CANVAS_API_TOKEN": "your_token_here",
           "CANVAS_BASE_URL": "https://your-canvas-instance.com"
         }
       }
     }
   }
   ```

3. Restart Claude Desktop

The `-y` flag tells npx to accept the package installation prompt automatically.

## Other MCP Clients

Any MCP client that supports stdio transport can use the same configuration pattern. Replace the config file path with your client's equivalent:

```json
{
  "mcpServers": {
    "canvas": {
      "command": "npx",
      "args": ["-y", "@r-huijts/canvas-mcp"],
      "env": {
        "CANVAS_API_TOKEN": "your_token_here",
        "CANVAS_BASE_URL": "https://your-canvas-instance.com"
      }
    }
  }
}
```

This works with [Cursor](https://docs.cursor.com/context/mcp), VS Code MCP extensions, and other stdio-based clients. Consult your client's MCP documentation for where to place the config file.

### ChatGPT and Codex

The same stdio server can be maintained alongside the Claude Desktop extension and connected privately to ChatGPT through OpenAI Secure MCP Tunnel. The repository includes an OpenAI plugin scaffold, a tunnel runbook, and a vendor-neutral MCP compatibility test in [`openai/README.md`](openai/README.md).

## Usage Examples

Copy-paste these prompts into your AI assistant after connecting the server:

```
List all my active Canvas courses
```

```
Post an announcement to course 12345 titled "Week 3 Update" with a summary of this week's topics
```

```
Show rubric statistics for assignment 67890 in course 12345
```

```
Help me grade assignment 67890 in course 12345
```

```
List all folders and files in the Files section of course 12345
```

```
Which questions on quiz 456 in course 12345 did the class find hardest, and which wrong answer drew the most students?
```

```
Generate a styleguide for course 12345, then patch the syllabus page to match it
```

```
List all students in course 12345 with their actual names and emails
```

## Student Data Privacy

This server includes **privacy-first anonymization** for student data. By default, student names and emails are pseudonymized; you can request real identities using natural language.

**Default behavior:**
- Names become `Student 1`, `Student 2`, etc.
- Emails become `student1@example.com`, `student2@example.com`
- The same student always gets the same pseudonym across calls
- Teacher and admin names are never anonymized

**Requesting real data:**
```
List all students in course 123, but show their actual names and emails
```

**Affected tools:** `list-students`, `list-assignments` (with submission data), `list-assignment-submissions`, `list-section-submissions`, `list-rubric-assessments`, `get-submission-documents`, `get-submission-content`, `get-grading-packet`

Each affected tool accepts an `anonymous` parameter (default: `true`). Your AI assistant sets `anonymous: false` when you ask for real names.

### Names typed into the work itself

Canvas knows how it spells a student's name. A worksheet's "Names:" line knows nothing of the sort, and that is where anonymization used to leak: a partner's first name, a lowercase name wedged into a row of underscores, a name joined by "and". `get-submission-content`, `get-grading-packet` and `get-submission-documents` therefore run two different passes over extracted document text when `anonymous` is on.

**On a name line** — anything whose label matches `Name:`, `Names:`, `Student Name:` or `Partner:` — every token is treated as a name. In the first 1,500 characters the label is matched *anywhere* on the line, because PDF text extractors reflow a worksheet header into a single line (`17.1 Worksheet Title Names: Jordan T Period: 4`); anchoring to the start of a line found nothing at all on a PDF. Past that point the label must start a line or a table cell, so a sentence like "the crew names: Diaz, Cabral and Magellan" stays prose. A label whose own cell is empty takes the next line as its value, which is how a `.docx` table arrives once its cells are flattened. Underscores are stripped, and each name is matched against the whole course roster (first, last, preferred and sortable name parts, case-insensitively), so a partner comes back as *their own* pseudonym rather than a blank. The line runs until the next label (`Period`, `Date`, `Class`, `Hour`) or the end of the line, so `Name: ____ Period: 3` keeps its period. A name-like token that matches nobody becomes `[name]` and is counted, because a blank you don't know about is worse than one you do.

**In body text**, only full first-and-last matches from the roster are redacted, plus every part of the submitting student's own name. Bare first names are left alone by default: course content is full of words that are also somebody's first name, and a student called Henry must not erase "Prince Henry" or "Henry Hudson" from a history passage. Pass `scrubFirstNamesInBody: true` to redact roster first names in body text too, when the assignment makes that the greater risk.

Each file reports what happened, so the scrubbing is auditable rather than a matter of trust:

```json
"redactions": { "nameLine": 2, "body": 0, "unmatched": 1 }
```

`unmatched` above zero also raises a warning on the submission — usually a partner enrolled in another section, or a nickname. A `Student 12` already in the text counts as matched, never as unmatched.

This is still best effort. Names inside images, misspellings and nicknames are not caught, and `download-submission-file` takes only a file ID, so it has no course to look a roster up in and does not anonymize at all.

> **Exception — intervention tools default to real names.** `get-course-grades`, `list-missing-submissions`, and `get-student-engagement` default to `anonymous: false`, because "Student 7 is failing" is not something you can act on. They still accept `anonymous: true` when you want to reason about the class in aggregate or share output. Note also that pseudonyms are assigned from an in-memory counter that resets when the server restarts — `Student 3` in one session is not necessarily `Student 3` in the next, so don't carry those labels across conversations.

<details>
<summary>Why teachers and admins are not anonymized</summary>

The anonymization system targets **student privacy** while preserving educational context:

- Students are the protected population whose privacy needs safeguarding
- Knowing which instructor provided feedback is pedagogically valuable
- Comments include an `author.role` field — only `role === 'student'` authors are anonymized

Example with anonymization enabled:
```
✅ "Excellent analysis! - Prof. Johnson"
❌ "I found this confusing - Student 1"
```

If you need full anonymization including staff, you can modify the logic in [`src/anonymizer.ts`](src/anonymizer.ts).
</details>

## Tool Reference

| Category | Count | Tools |
|----------|-------|-------|
| Courses | 3 | `list-courses`, `get-course`, `post-announcement` |
| Students | 1 | `list-students` |
| Assignments | 6 | `list-assignments`, `get-assignment`, `create-assignment`, `update-assignment`, `delete-assignment`, `duplicate-assignment` |
| Assignment Groups | 3 | `list-assignment-groups`, `create-assignment-group`, `bulk-update-assignment-dates` |
| Grading | 1 | `get-grading-packet` |
| Submissions | 7 | `list-assignment-submissions`, `grade-submission`, `post-submission-comment`, `get-submission-content`, `get-submission-documents`, `get-submission-file-info`, `download-submission-file` |
| Sections | 2 | `list-sections`, `list-section-submissions` |
| Rubrics | 8 | `list-rubrics`, `get-rubric`, `create-rubric`, `update-rubric`, `set-rubric-criterion-outcome`, `get-rubric-statistics`, `list-rubric-assessments`, `attach-rubric-to-assignment` |
| Outcomes | 7 | `list-outcomes`, `get-outcome`, `create-outcome`, `update-outcome`, `create-outcome-group`, `link-outcome`, `unlink-outcome` |
| Modules | 10 | `list-modules`, `list-module-items`, `toggle-module-publish`, `create-module`, `update-module`, `delete-module`, `get-module-item`, `create-module-item`, `update-module-item`, `delete-module-item` |
| Pages | 9 | `list-pages`, `get-page-content`, `update-page-content`, `list-page-revisions`, `revert-page-revision`, `patch-page-content`, `apply-page-changes`, `generate-styleguide`, `get-styleguide` |
| Quizzes | 15 | `list-quizzes`, `get-quiz`, `create-quiz`, `update-quiz`, `delete-quiz`, `list-quiz-questions`, `get-quiz-question`, `create-quiz-question`, `update-quiz-question`, `delete-quiz-question`, `list-quiz-question-groups`, `get-quiz-question-group`, `create-quiz-question-group`, `update-quiz-question-group`, `delete-quiz-question-group` |
| Quiz Results | 6 | `list-quiz-submissions`, `get-quiz-statistics`, `get-quiz-submission-answers`, `get-quiz-report`, `get-quiz-submission-events`, `update-quiz-submission-score` |
| New Quizzes | 11 | `list-new-quizzes`, `get-new-quiz`, `create-new-quiz`, `update-new-quiz`, `delete-new-quiz`, `list-new-quiz-items`, `get-new-quiz-item`, `create-new-quiz-item`, `update-new-quiz-item`, `delete-new-quiz-item`, `get-new-quiz-report` |
| Grading Queue | 2 | `list-grading-todo`, `get-todo-counts` |
| Grades & Intervention | 3 | `get-course-grades`, `list-missing-submissions`, `get-student-engagement` |
| Conversations (read-only) | 3 | `list-conversations`, `get-conversation`, `get-unread-message-count` |
| Overrides & Accommodations | 5 | `list-assignment-overrides`, `create-assignment-override`, `update-assignment-override`, `delete-assignment-override`, `extend-due-date` |
| Course Settings & Syllabus | 5 | `get-syllabus`, `update-syllabus`, `update-course-settings`, `set-course-publish-state`, `set-front-page` |
| Calendar | 4 | `list-calendar-events`, `create-calendar-event`, `update-calendar-event`, `delete-calendar-event` |
| Course Copy | 3 | `copy-course-content`, `get-content-migration`, `list-content-migrations` |
| Quiz Time Extensions | 3 | `extend-quiz-time`, `list-quiz-extensions`, `set-course-quiz-accommodations` |
| Assignment Extensions | 1 | `extend-assignment-attempts` |
| Late Policy | 2 | `get-late-policy`, `set-late-policy` |
| Files | 4 | `upload-course-file`, `set-file-availability`, `list-course-files`, `list-course-folders` |
| ePortfolios | 3 | `list-eportfolios`, `get-eportfolio`, `get-eportfolio-pages` |

**Full parameter reference:** [docs/TOOLS.md](docs/TOOLS.md)

### Grading an assignment efficiently

`get-grading-packet` is two tools in one shape. Call it **once** with no student to get the grading instructions, the assignment, its linked handouts, the rubric with the criterion IDs `grade-submission` needs, and the queue. Then call it **per student** with `userId`, which returns only that student's work plus a one-line header naming the assignment, its points and the criterion IDs. None of the first call's content changes between students, and resending it was costing four to five thousand tokens each time — over 100k of pure duplication across a class of thirty.

| Parameter | Default | What it does |
|-----------|---------|--------------|
| `include` | everything but `work`; `["work"]` when a student is named | Pick sections explicitly: `"instructions"`, `"assignment"`, `"rubric"`, `"queue"`, `"work"` |
| `userIds` | — | Read several students in one call, in the order given (max 5, see `CANVAS_MAX_GRADING_BATCH`). One unreadable student does not take the rest down |
| `queueLimit` | `50` | How many students the queue lists; `queue_truncated: true` when there are more |
| `scrubFirstNamesInBody` | `false` | Redact roster first names in body text too (see [Names typed into the work itself](#names-typed-into-the-work-itself)) |
| `includePartners` | `true` | Report classmates named on the work's name line |
| `scanTemplates` | `false` | With the queue, read one file per student to report which worksheet version each had |

**Partners.** Where an assignment allows partners and both are meant to submit, the name line is the only record of who worked with whom. Students named there and enrolled in the course come back on the per-student output:

```json
"partners": [
  { "student": "Student 12", "user_id": 1234, "submitted": true, "same_file_hash": true }
]
```

`same_file_hash` compares the two uploads. Canvas exposes no content hash, so it compares extracted text — length plus the first 500 characters — and settles the common case for free, since files of different sizes cannot be the same file. In anonymous mode only the pseudonym and the user ID are given. Pass `comparePartnerFiles: false` to skip the comparison, or `includePartners: false` to skip partner lookups entirely.

**Dates.** `due_at: "2026-10-27T05:00:00Z"` is 10pm Pacific on the 26th, which is easy to misread as the 27th — and the day is what decides whether work was late or a revision window has closed. Every `due_at`, `lock_at`, `unlock_at` and `submitted_at` therefore comes back with a `_local` twin formatted in the course's own time zone (falling back to the account's): `"due_at_local": "2026-10-26 22:00 PDT"`.

**Drafting a grade.** `grade-submission` takes `dryRun: true`, which validates the rubric exactly as a real write does, computes the total and the letter grade from the assignment's or course's grading standard, and reports whether students would see it immediately — without sending anything to Canvas:

```json
{ "dry_run": true, "would_write": { ... }, "total": 20, "letter_grade": "C", "visible_immediately": true }
```

A course's `grading_standard_id` is usually an **account** standard the course inherited, and the course-scoped API path 404s on exactly those — so the standard is looked up under the course, then the course's account, then `/accounts/self`. Reading that 404 as "no standard" meant grading against Canvas's built-in scheme (A at 94%) instead of the school's (A at 93%), which is a wrong letter on every borderline grade. The result names the standard and where it came from, and when the built-in default really is in use, `fell_back_because` says what was tried.

**Reading files directly.** `get-submission-documents` and `download-submission-file` return extracted text by default for PDFs, Word (`.docx`), HTML and plain-text files, truncated at 60,000 characters with `truncated: true` (override with `maxChars`). Base64 comes back only for images, media and formats with no extractor, or when `forceBase64: true` is passed — with a 5 MB limit, above which the tool says so rather than returning a placeholder. A 192 KB PDF used to come back as `[FILE_TOO_LARGE_FOR_DISPLAY]`, leaving the caller nothing to grade from.

### Signals worth a second look

Each extracted file can carry `integrity_signals`: short excerpts a teacher might want to open the work over. They are **prompts, never findings** — not evidence of copying, and not grounds for a lower score. The heuristics fire on artefacts of how text was produced rather than on how it reads, so they stay quiet on ordinary student writing: a footnote number left mid-sentence (`France.12 Now`), wiki page furniture (`[edit]`, `[citation needed]`, `Retrieved from`, `^ `), and an answer to "which X is most like …" that names the same thing the question asked about.

Documents also carry `template_fingerprint` and `template_headers`, taken from the first table's header row. HTML and `.docx` have table markup to read it from. A PDF has none, so the header is inferred: from the row Google Docs repeats at the top of every page a table spans, or — on a one-page sheet, where there is nothing to repeat — by rebuilding the first table row from pdf.js's positioned text. Fingerprints are comparable within one assignment, where every student's file comes from the same export, rather than across formats. Teachers revise worksheet templates between class periods, and the rubric's meaning depends on which version a student had. `get-grading-packet` with `include: ["queue"]` summarises the versions as `template_variants`, covering the students read so far in the session. Pass `scanTemplates: true` to fingerprint the rest of the queue as well; that costs one download per student, so it is off by default, and results are cached per attempt (a student already read in this session is not fetched again).

### Classic vs. New Quizzes

Canvas runs two quiz engines on different APIs. `list-quizzes` and friends cover **Classic Quizzes** (`/api/v1/courses/:id/quizzes`); `list-new-quizzes` and friends cover **New Quizzes** (`/api/quiz/v1/courses/:id/quizzes`). If your institution has migrated, use the New Quizzes tools. A New Quiz's ID is also its assignment ID, so grading flows through the existing `list-assignment-submissions` and `grade-submission` tools.

The two engines also express **extra time** completely differently — Classic posts a `quiz_extensions` array to `/api/v1`, New Quizzes posts accommodations to `/api/quiz/v1` — so `extend-quiz-time` works out which engine an ID belongs to and sends the right shape. Because the ID spaces are independent, an ID that names a real quiz under *both* engines is reported as ambiguous rather than guessed at; pass `engine` to resolve it. Only New Quizzes has a course-wide accommodation (`set-course-quiz-accommodations`), and only Classic lets you read existing extensions back (`list-quiz-extensions`).

One Canvas behaviour is worth knowing before exam day: **New Quizzes refuses a per-quiz accommodation for a student who has not yet opened that quiz** — which is exactly the situation when you are setting extra time up in advance. `set-course-quiz-accommodations` has no such restriction and is the way to grant it beforehand. Classic Quizzes lets you extend at any time.

The two New Quizzes accommodations also **add together** rather than one overriding the other: a student with a standing course-wide 45 minutes who is then given 30 on a particular quiz ends up with 75. Canvas offers no way to read either value back, so both tools say this on every grant.

### Question banks

`list-question-banks`, `get-question-bank` and `list-question-bank-questions` read the **Classic** `AssessmentQuestionBank` store — the pool a Classic quiz's question group draws from.

**New Quizzes item banks are a different store, and no Canvas API token reaches them.** They live in a separate Instructure service (AMS) that Canvas only enters through an LTI launch; the Item Banks page in course navigation is an empty container Canvas hands that service's own URL to. Every plausible endpoint spelling was probed against a live instance on 2026-09-17 and returns a 404. The [opt-in item bank tools](#new-quizzes-item-banks-opt-in) reach them a different way — by replaying that LTI launch rather than by finding a Canvas endpoint, which is why they are gated behind a flag.

Either way, you can see how a New Quiz uses them. `list-new-quiz-items` distinguishes the two bank-backed item types instead of blanking both out:

- **`BankEntry`** — one question that happens to live in a bank, linked into the quiz. The question and its answer key are in the payload, so it is shown in full, with the `bank_id` it came from.
- **`Bank`** — a random draw. The item reports which bank, the pool size, and how many it pulls (`item 9624 draws 8 of 12 from bank 290`), followed by a note pointing at the pool — at `list-item-bank-questions` when the item bank tools are on, and at the Canvas UI when they are not. Which questions a given student sees is decided at attempt time regardless.

A course whose quizzes were imported from QTI usually has **both** kinds of bank. They have separate ID spaces and do not cross-reference, so a Classic bank whose title matches is not the pool the New Quiz is drawing from.

### New Quizzes item banks (opt-in)

Six further tools — `list-item-banks`, `get-item-bank`, `list-item-bank-questions`, `create-item-bank-question`, `update-item-bank-question` and `delete-item-bank-question` — read and edit New Quizzes item banks. **They are off unless you switch them on**, with `CANVAS_ENABLE_ITEM_BANKS=true` or the "Enable New Quizzes item bank tools" checkbox in the desktop extension's settings. With the flag off they are not registered at all, so a stock install never contacts the hosts they use.

The same switch adds `create-new-quiz-stimulus` and `update-new-quiz-stimulus`, and lets `create-new-quiz-item` and `update-new-quiz-item` attach questions to a stimulus (shared reading passages). Canvas's public API can't do either; these use the same private service the Canvas quiz editor does, through a launch scoped to the one quiz being edited.

They are gated because **they do not use the Canvas API**. There is no Canvas endpoint for a New Quizzes item bank, public or otherwise: the banks live in a separate Instructure service that Canvas only enters through an LTI launch, and the Item Banks page in course navigation is an empty container Canvas hands that service's own URL to. These tools work by replaying that launch headlessly — Canvas signs it, the server never forges anything — and then calling the bank service directly. What that buys and what it costs:

- **It is undocumented and unversioned.** Instructure can change or withdraw any of it without notice, and when they do these tools break while the rest of the server keeps working. Every error they raise says "private API" so a failure is not mistaken for a bug in your own call.
- **It holds more than a Bearer token.** Rendering the launch means a short-lived Canvas web session cookie and two minted JWTs, all kept in memory, never written to disk or logged, and never sent anywhere but the host that issued them. Your `CANVAS_API_TOKEN` itself never leaves Canvas. This is a heavier auth posture than the rest of the server, which is the main reason for the switch.
- **The host is derived, not assumed.** The bank service's region comes from the installed Quizzes 2 tool, so instances outside `iad-prod` work — but this has only been verified against one instance.

Two things about item banks that are easy to get wrong:

**The bank list is scoped to you, not to the course.** These tools take a `courseId` because the launch needs a context, not because it filters anything: launching from two different courses returns the same banks. Use `search` to narrow by title.

**A question has two IDs and they are not interchangeable.** `list-item-bank-questions` reports both. `entryId` is the question's membership in this bank and is what `delete-item-bank-question` takes; `itemId` is the question itself and is what `update-item-bank-question` takes. A question a student has already seen becomes immutable and can no longer be edited.

Bank questions are templates: a quiz built from a bank holds its own copy, so editing the bank does not change quizzes already built from it.

### A note on messaging

This server reads the Canvas inbox but will not send messages. Canvas exposes `POST /api/v1/conversations`, and it is deliberately not wired up: the intended workflow is to triage messages and draft action items, then write the reply to a student yourself.

## Available Prompts

### grade-assignment

Guided grading session for one assignment, done with the teacher.

- Required: `course` (name or ID), `assignment` (name or ID)
- Starts with `get-grading-packet`, then asks once whether materials are missing, whether resubmissions are accepted, and whether feedback is wanted (off by default)
- Calibrates on two students, then works through the queue in batches with per-criterion evidence
- Writes grades and feedback only after the teacher approves them

### analyze-rubric-statistics

Analyzes rubric statistics for formative assignments in a course and creates visualizations.

- Required: `courseName` (string)
- Creates grouped stacked bar and grouped bar charts across assignments and criteria
- Includes progression analysis and trend identification

## Troubleshooting

### Server not appearing in Claude Desktop

- Verify JSON syntax in your config file
- Use absolute paths for source installs (`dist/index.js`, not `build/index.js`)
- Ensure your Canvas API token is valid
- Restart Claude Desktop

### Connection errors

- Confirm your token has access to the target courses
- Verify `CANVAS_BASE_URL` points to your institution's Canvas instance
- Check MCP logs:
  ```bash
  # macOS
  tail -f ~/Library/Logs/Claude/mcp*.log
  # Windows
  type %AppData%\Claude\Logs\mcp*.log
  ```

### NPX issues

- On Windows, ensure npm/npx are on your PATH
- For permission errors, try running Claude Desktop as administrator (Windows)
- Corporate networks may require npm proxy configuration

### Debug logging

The server logs errors to stderr. Redirect when running manually:

```bash
node dist/index.js 2> debug.log
```

## Performance & Caching

The server caches stable Canvas API responses to avoid redundant fetches and reduce token consumption.

**How it works:**

- First request stores the response body and any `ETag` or `Last-Modified` header
- Subsequent requests send conditional GETs (`If-None-Match` / `If-Modified-Since`); Canvas returns `304 Not Modified` when data is unchanged
- If Canvas omits validator headers, a 30-minute TTL is used as fallback
- Write operations (`POST`, `PUT`, `DELETE`) evict affected cache entries

**What is never cached:**

- Submission and grade data (`/submissions` endpoints) — always fetched live
- Paginated `fetchAllPages()` calls (students, submissions, ePortfolios) bypass the ETag cache and always hit the network — relevant for large courses

## Development

### Architecture

```
MCP Client → stdio → src/index.ts → src/tools/* → CanvasClient → Canvas REST API
```

Key modules:
- [`src/index.ts`](src/index.ts) — server bootstrap and tool registration
- [`src/canvasClient.ts`](src/canvasClient.ts) — HTTP client, ETag caching, pagination
- [`src/anonymizer.ts`](src/anonymizer.ts) — student data pseudonymization
- [`src/tools/`](src/tools/) — one file per domain, each exports `register*Tools()`

### Tool registration

This server uses the MCP TypeScript SDK (v1.29.0). Each tool is registered with `server.tool()` using a five-argument form:

1. Tool name (string)
2. Tool description (string)
3. Input schema (Zod schema)
4. Tool annotations (`{ readOnlyHint?, destructiveHint?, idempotentHint? }`)
5. Execute function

```typescript
server.tool(
  "list-courses",
  "List all active courses for the authenticated user. Returns course name, ID, course code, and term.",
  {},
  { readOnlyHint: true },
  async () => {
    return {
      content: [{ type: "text", text: "..." }]
    };
  }
);
```

### Local development

```bash
npm install
npm run build    # compile TypeScript to dist/
npm start        # run compiled server
npm run dev      # run from source with tsx (hot reload)
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Install dependencies: `npm install`
4. Build: `npm run build`
5. Submit a pull request

There is currently no automated test suite — manual verification via an MCP client is the primary testing approach.

## Security Notes

1. **API token security**
   - Never commit your Canvas API token to version control
   - Use environment variables or secure configuration
   - Rotate tokens periodically

2. **Permissions**
   - Use tokens with the minimum access needed for your use case
   - Review Canvas API access logs periodically

## Related Documentation

- [docs/TOOLS.md](docs/TOOLS.md) — full tool parameter reference
- [DESKTOP_EXTENSION.md](DESKTOP_EXTENSION.md) — building and packaging the Claude Desktop Extension
- [.env.example](.env.example) — environment variable template

## License

MIT — see [LICENSE](LICENSE).
