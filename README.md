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
- **Submissions** — grade work, post feedback, download submission files
- **Rubrics** — view rubrics, analyze statistics, attach rubrics to assignments
- **Students** — enrollment lists with privacy-first anonymization
- **Sections** — list sections and section-filtered submissions
- **Modules** — full module and module-item CRUD
- **Pages** — edit content, manage revisions, and use the styleguide system (`generate-styleguide`, `patch-page-content`)
- **Quizzes** — full quiz, question, and question-group CRUD (Classic Quizzes)
- **New Quizzes** — authoring and item analysis on the separate `/api/quiz/v1` API, with a question builder that generates answer IDs and scoring rules for you
- **Grading queue** — `list-grading-todo` answers "what do I need to grade?" across every course
- **Grades & intervention** — course-wide gradebook, missing-work report, and engagement analytics for planning outreach
- **Overrides** — differentiated due dates and date accommodations, per student or per section, with `extend-due-date` for the everyday case
- **Quiz time extensions** — extra *minutes* on a timed quiz, the clock accommodation that a due date can't express, for both quiz engines (`extend-quiz-time`), plus a course-wide standing accommodation for New Quizzes
- **Files** — upload local files into a course's Files area (syllabi, handouts, images), publish or unpublish them, and browse what's already there
- **Conversations** — read-only inbox triage (sending is intentionally not exposed)
- **ePortfolios** — list and read student ePortfolios
- **Prompts** — `analyze-rubric-statistics` for multi-assignment rubric visualizations
- **Performance** — ETag-based response caching to reduce API load and token use

**93 tools** and **1 prompt** in total. See [docs/TOOLS.md](docs/TOOLS.md) for the full parameter reference.

## Prerequisites

- Node.js v16 or higher (for npm/source installs; not required for the Desktop Extension)
- A Canvas API token with access to the courses you intend to manage
- Your Canvas instance URL (e.g. `https://yourschool.instructure.com`)

> **Note:** The server defaults to `https://fhict.instructure.com` if `CANVAS_BASE_URL` is not set. Set this variable to your own institution's Canvas URL.

## Installation

### Option 1: Desktop Extension (Easiest)

One-click installation with Claude Desktop Extensions:

1. **Download** the latest extension from [GitHub Releases](https://github.com/r-huijts/canvas-mcp/releases) (`.mcpb` or `.dxt` format, depending on the release)
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
git clone https://github.com/r-huijts/canvas-mcp
cd canvas-mcp
npm install
cp .env.example .env   # then edit with your credentials
npm run build
npm start
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

**Affected tools:** `list-students`, `list-assignments` (with submission data), `list-assignment-submissions`, `list-section-submissions`, `list-rubric-assessments`, `get-submission-documents`

Each affected tool accepts an `anonymous` parameter (default: `true`). Your AI assistant sets `anonymous: false` when you ask for real names.

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
| Assignments | 5 | `list-assignments`, `get-assignment`, `create-assignment`, `update-assignment`, `delete-assignment` |
| Assignment Groups | 3 | `list-assignment-groups`, `create-assignment-group`, `bulk-update-assignment-dates` |
| Submissions | 6 | `list-assignment-submissions`, `grade-submission`, `post-submission-comment`, `get-submission-documents`, `get-submission-file-info`, `download-submission-file` |
| Sections | 2 | `list-sections`, `list-section-submissions` |
| Rubrics | 4 | `list-rubrics`, `get-rubric-statistics`, `list-rubric-assessments`, `attach-rubric-to-assignment` |
| Modules | 10 | `list-modules`, `list-module-items`, `toggle-module-publish`, `create-module`, `update-module`, `delete-module`, `get-module-item`, `create-module-item`, `update-module-item`, `delete-module-item` |
| Pages | 9 | `list-pages`, `get-page-content`, `update-page-content`, `list-page-revisions`, `revert-page-revision`, `patch-page-content`, `apply-page-changes`, `generate-styleguide`, `get-styleguide` |
| Quizzes | 15 | `list-quizzes`, `get-quiz`, `create-quiz`, `update-quiz`, `delete-quiz`, `list-quiz-questions`, `get-quiz-question`, `create-quiz-question`, `update-quiz-question`, `delete-quiz-question`, `list-quiz-question-groups`, `get-quiz-question-group`, `create-quiz-question-group`, `update-quiz-question-group`, `delete-quiz-question-group` |
| New Quizzes | 11 | `list-new-quizzes`, `get-new-quiz`, `create-new-quiz`, `update-new-quiz`, `delete-new-quiz`, `list-new-quiz-items`, `get-new-quiz-item`, `create-new-quiz-item`, `update-new-quiz-item`, `delete-new-quiz-item`, `get-new-quiz-report` |
| Grading Queue | 2 | `list-grading-todo`, `get-todo-counts` |
| Grades & Intervention | 3 | `get-course-grades`, `list-missing-submissions`, `get-student-engagement` |
| Conversations (read-only) | 3 | `list-conversations`, `get-conversation`, `get-unread-message-count` |
| Overrides & Accommodations | 5 | `list-assignment-overrides`, `create-assignment-override`, `update-assignment-override`, `delete-assignment-override`, `extend-due-date` |
| Quiz Time Extensions | 3 | `extend-quiz-time`, `list-quiz-extensions`, `set-course-quiz-accommodations` |
| Files | 4 | `upload-course-file`, `set-file-availability`, `list-course-files`, `list-course-folders` |
| ePortfolios | 3 | `list-eportfolios`, `get-eportfolio`, `get-eportfolio-pages` |

**Full parameter reference:** [docs/TOOLS.md](docs/TOOLS.md)

### Classic vs. New Quizzes

Canvas runs two quiz engines on different APIs. `list-quizzes` and friends cover **Classic Quizzes** (`/api/v1/courses/:id/quizzes`); `list-new-quizzes` and friends cover **New Quizzes** (`/api/quiz/v1/courses/:id/quizzes`). If your institution has migrated, use the New Quizzes tools. A New Quiz's ID is also its assignment ID, so grading flows through the existing `list-assignment-submissions` and `grade-submission` tools.

The two engines also express **extra time** completely differently — Classic posts a `quiz_extensions` array to `/api/v1`, New Quizzes posts accommodations to `/api/quiz/v1` — so `extend-quiz-time` works out which engine an ID belongs to and sends the right shape. Because the ID spaces are independent, an ID that names a real quiz under *both* engines is reported as ambiguous rather than guessed at; pass `engine` to resolve it. Only New Quizzes has a course-wide accommodation (`set-course-quiz-accommodations`), and only Classic lets you read existing extensions back (`list-quiz-extensions`).

### A note on messaging

This server reads the Canvas inbox but will not send messages. Canvas exposes `POST /api/v1/conversations`, and it is deliberately not wired up: the intended workflow is to triage messages and draft action items, then write the reply to a student yourself.

## Available Prompts

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
