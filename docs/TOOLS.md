# Canvas MCP Tool Reference

Full parameter reference for all **80 tools** exposed by the Canvas MCP server. For setup and usage, see the [README](../README.md).

## Courses

### list-courses
Lists the authenticated user's courses. Defaults to published, currently-active courses.
- No required parameters
- Optional parameters:
  - `includeUnpublished`: boolean (default: false) — include course shells you're still building
  - `includeConcluded`: boolean (default: false) — include past-term courses
  - `searchTerm`: string — case-insensitive filter on course name or code
  - `enrollmentType`: `teacher` | `ta` | `student` | `designer` | `observer`
- Returns course names, IDs, codes, term information, and published status
- Canvas has no server-side search on this endpoint, so `searchTerm` filters client-side

### get-course
Fetches a single course by ID, including unpublished courses that don't appear in `list-courses`.
- Required parameters:
  - `courseId`: string
- Optional parameters:
  - `includeSyllabus`: boolean (default: false)
- Useful when you have a course ID from a Canvas URL but the course isn't published

### post-announcement
Posts an announcement to a specific course.
- Required parameters:
  - `courseId`: string
  - `title`: string
  - `message`: string

## Students

### list-students
Gets a complete list of students enrolled in a course.
- Required parameters:
  - `courseId`: string
- Optional parameters:
  - `includeEmail`: boolean (default: false)
  - `anonymous`: boolean (default: true) — whether to anonymize student names/emails
- Returns student names, IDs, and optional email addresses
- **Privacy**: Student data is anonymized by default (use "with actual names" to override)

## Assignments

### list-assignments
Gets all assignments in a course with submission status.
- Required parameters:
  - `courseId`: string
- Optional parameters:
  - `studentId`: string
  - `includeSubmissionHistory`: boolean (default: false)
  - `anonymous`: boolean (default: true) — whether to anonymize student data in submissions
- Returns assignment details and submission status
- **Privacy**: Student submission data is anonymized by default

### get-assignment
Fetches metadata for a single assignment.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
- Returns due date, points, grading type, submission types, rubric presence, and publish state

### create-assignment
Creates a new assignment in a course.
- Required parameters:
  - `courseId`: string
- Optional parameters:
  - `name`, `description`, `due_at`, `points_possible`, `submission_types`, `published`, `grading_type`, `assignment_group_id`

### update-assignment
Updates an existing assignment.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
- Optional parameters: same as `create-assignment`

### delete-assignment
Deletes (archives) an assignment from a course.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string

## Assignment Groups

### list-assignment-groups
Lists all assignment groups (grade buckets) in a course.
- Required parameters:
  - `courseId`: string
- Returns group name, ID, position, weight, and drop rules

### create-assignment-group
Creates a new assignment group in a course.
- Required parameters:
  - `courseId`: string
- Optional parameters:
  - `name`, `position`, `group_weight`, `sis_source_id`, `rules`

### bulk-update-assignment-dates
Updates due/unlock/lock dates for multiple assignments in one call.
- Required parameters:
  - `courseId`: string
  - `assignmentDates`: array of `{ assignment_id, due_at?, unlock_at?, lock_at? }`

## Submissions

### grade-submission
Writes a score, grade, rubric assessment, or comment for a student's submission.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
  - `userId`: string
- Optional parameters:
  - `posted_grade`, `score`, `rubric_assessment`, `comment`

### list-assignment-submissions
Gets all student submissions for a specific assignment.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
- Optional parameters:
  - `anonymous`: boolean (default: true) — whether to anonymize student names/emails
- Returns submission details, grades, and comments
- **Privacy**: Student data is anonymized by default

### get-submission-documents
Retrieves a student's submission with attachment metadata and optional file content.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
  - `userId`: string
- Optional parameters:
  - `downloadFiles`: boolean (default: false)
  - `anonymous`: boolean (default: true)

### get-submission-file-info
Returns metadata for a specific file attached to a submission.
- Required parameters:
  - `fileId`: string

### download-submission-file
Downloads a submission file as text or base64.
- Required parameters:
  - `fileId`: string
- Optional parameters:
  - `forceBase64`: boolean (default: false)

### post-submission-comment
Posts a comment on a student's assignment submission.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
  - `studentId`: string
  - `comment`: string
- Returns confirmation of the posted comment

## Sections

### list-sections
Gets a list of all sections in a course.
- Required parameters:
  - `courseId`: string
- Optional parameters:
  - `includeStudentCount`: boolean (default: false)
- Returns section details with optional student count

### list-section-submissions
Gets all student submissions for a specific assignment filtered by section.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
  - `sectionId`: string
- Optional parameters:
  - `includeComments`: boolean (default: true)
  - `anonymous`: boolean (default: true) — whether to anonymize student names/emails
- Returns submission details filtered by the specified section
- **Privacy**: Student data is anonymized by default

## Rubrics

### list-rubrics
Lists all rubrics for a specific course.
- Required parameters:
  - `courseId`: string
- Returns rubric titles, IDs, and descriptions

### get-rubric-statistics
Gets statistics for rubric assessments on an assignment.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
- Optional parameters:
  - `includePointDistribution`: boolean (default: true)
- Returns overall and per-criterion statistics including average, median, min, max, and score distribution

### list-rubric-assessments
Lists all rubric assessments for an assignment.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
- Optional parameters:
  - `anonymous`: boolean (default: true)
- Returns per-submission rubric scores and criteria ratings

### attach-rubric-to-assignment
Attaches an existing rubric to an assignment.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
  - `rubricId`: string

## Modules

### list-modules
Lists all modules in a course, optionally including inline items.
- Required parameters:
  - `courseId`: string
- Optional parameters:
  - `includeItems`: boolean (default: false)
- Returns module names, IDs, positions, published state, and optionally item summaries

### list-module-items
Lists all items in a specific module.
- Required parameters:
  - `courseId`: string
  - `moduleId`: string
- Returns item type, title, ID, position, and published state

### toggle-module-publish
Toggles the published/unpublished state of a module.
- Required parameters:
  - `courseId`: string
  - `moduleId`: string
- Returns confirmation of the new published state

### create-module
Creates a new module in a course.
- Required parameters:
  - `courseId`: string
  - `name`: string
- Optional parameters:
  - `position`: number (1-based)
  - `unlock_at`: string (ISO 8601 date)
  - `require_sequential_progress`: boolean
  - `prerequisite_module_ids`: string[]
  - `publish_final_grade`: boolean
- Returns the created module's ID, name, position, and published state

### update-module
Updates an existing module's properties.
- Required parameters:
  - `courseId`: string
  - `moduleId`: string
- Optional parameters:
  - `name`, `position`, `unlock_at`, `require_sequential_progress`, `prerequisite_module_ids`, `publish_final_grade`, `published`
- Returns the updated module's ID, name, position, and published state

### delete-module
Permanently deletes a module and all its items from a course.
- Required parameters:
  - `courseId`: string
  - `moduleId`: string
- Returns confirmation of deletion

### get-module-item
Gets details for a single module item.
- Required parameters:
  - `courseId`: string
  - `moduleId`: string
  - `itemId`: string
- Returns item ID, type, title, position, content_id, published state, indent, external_url, page_url, and completion requirement

### create-module-item
Adds a new item to a module.
- Required parameters:
  - `courseId`: string
  - `moduleId`: string
  - `type`: one of `File`, `Page`, `Discussion`, `Assignment`, `Quiz`, `SubHeader`, `ExternalUrl`, `ExternalTool`
- Optional parameters:
  - `content_id`, `title`, `position`, `indent`, `page_url`, `external_url`, `new_tab`
  - `completion_requirement_type`: `must_view` | `must_contribute` | `must_submit` | `must_mark_done`
  - `completion_requirement_min_score`: number
- Returns the created item's ID, type, title, and position

### update-module-item
Updates an existing module item.
- Required parameters:
  - `courseId`: string
  - `moduleId`: string
  - `itemId`: string
- Optional parameters:
  - `title`, `position`, `indent`, `external_url`, `new_tab`, `published`
  - `move_to_module_id`: string (moves the item to a different module)
  - `completion_requirement_type`, `completion_requirement_min_score`
- Returns the updated item's ID, type, title, position, and published state

### delete-module-item
Removes an item from a module.
- Required parameters:
  - `courseId`: string
  - `moduleId`: string
  - `itemId`: string
- Returns confirmation of deletion

## Pages

### list-pages
Lists all pages in a course by URL slug.
- Required parameters:
  - `courseId`: string
- Returns page titles, URL slugs, IDs, and published state

### get-page-content
Gets the content (HTML/body) of a specific page by URL slug.
- Required parameters:
  - `courseId`: string
  - `pageUrl`: string (the page's URL slug, e.g. `syllabus`)
- Returns page title, slug, ID, published state, updated date, and HTML body

### update-page-content
Updates (or creates) a page by URL slug.
- Required parameters:
  - `courseId`: string
  - `pageUrl`: string
- Optional parameters:
  - `title`: string
  - `body`: string (HTML)
  - `editingRoles`: string (comma-separated roles)
- Returns confirmation and updated page info

### list-page-revisions
Lists all revisions for a page.
- Required parameters:
  - `courseId`: string
  - `pageUrl`: string
- Returns revision IDs, timestamps, and editor info

### revert-page-revision
Reverts a page to a previous revision.
- Required parameters:
  - `courseId`: string
  - `pageUrl`: string
  - `revisionId`: string
- Returns confirmation and new page state

### patch-page-content
Applies targeted edits to a page using find-and-replace or section-level instructions.
- Required parameters:
  - `courseId`: string
  - `pageUrl`: string
  - `instructions`: string
- Returns the updated page body

### apply-page-changes
Applies a set of structured diffs to a page (bulk patch).
- Required parameters:
  - `courseId`: string
  - `pageUrl`: string
  - `changes`: array of `{ find, replace }` pairs

### generate-styleguide
Generates a course styleguide page from existing page content.
- Required parameters:
  - `courseId`: string
- Analyzes existing pages and writes a `styleguide` page capturing fonts, colors, and layout conventions

### get-styleguide
Retrieves the styleguide page for a course.
- Required parameters:
  - `courseId`: string

## Quizzes

### list-quizzes
Lists all quizzes in a course.
- Required parameters:
  - `courseId`: string
- Returns a list of quizzes with their details

### get-quiz
Fetches metadata for a single quiz.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
- Returns the full quiz object

### create-quiz
Creates a new quiz in a course.
- Required parameters:
  - `courseId`: string
  - `title`: string
- Optional parameters:
  - `description`: string
  - `quiz_type`: `"practice_quiz"` | `"assignment"` | `"graded_survey"` | `"survey"`
  - `due_at`: string (ISO 8601 format)
  - `points_possible`: number
  - `published`: boolean
- Returns the newly created quiz object

### update-quiz
Updates an existing quiz.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
- Optional parameters: same as `create-quiz`
- Returns the updated quiz object

### delete-quiz
Deletes a quiz.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
- Returns confirmation of deletion

### list-quiz-questions
Lists all questions for a quiz.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
- Returns a list of question objects

### get-quiz-question
Fetches a single quiz question.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
  - `questionId`: string
- Returns the full question object

### create-quiz-question
Creates a new question for a quiz.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
  - `question`: object (containing `question_text`, `question_type`, `points_possible`, etc.)
- Returns the newly created question object

### update-quiz-question
Updates a quiz question.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
  - `questionId`: string
- Optional parameters:
  - `question`: object (with fields to update)
- Returns the updated question object

### delete-quiz-question
Deletes a quiz question.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
  - `questionId`: string
- Returns confirmation of deletion

### list-quiz-question-groups
Lists all question groups for a quiz.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
- Returns a list of question group objects

### get-quiz-question-group
Fetches a single quiz question group.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
  - `groupId`: string
- Returns the full question group object

### create-quiz-question-group
Creates a new question group for a quiz.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
  - `quizGroup`: object (containing `name`, `pick_count`, `question_points`)
- Returns the newly created question group object

### update-quiz-question-group
Updates a quiz question group.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
  - `groupId`: string
- Optional parameters:
  - `quizGroup`: object (with fields to update)
- Returns the updated question group object

### delete-quiz-question-group
Deletes a quiz question group.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
  - `groupId`: string
- Returns confirmation of deletion

## ePortfolios

### list-eportfolios
Lists all ePortfolios belonging to a user.
- Required parameters:
  - `userId`: string
- Returns ePortfolio ID, name, public flag, workflow state, and timestamps

### get-eportfolio
Gets details for a single ePortfolio.
- Required parameters:
  - `eportfolioId`: string
- Returns ID, user_id, name, public flag, workflow state, spam status, and timestamps

### get-eportfolio-pages
Lists all pages in an ePortfolio.
- Required parameters:
  - `eportfolioId`: string
- Returns page ID, eportfolio_id, position, name, content, and timestamps

## Grading Queue

### list-grading-todo
The instructor's grading queue across all courses — every assignment with submissions waiting to be graded.
- No required parameters
- Optional parameters:
  - `courseIds`: string[] — restrict to these courses
  - `includeUngradedQuizzes`: boolean (default: true)
  - `minNeedsGrading`: number (default: 1)
- Returns course, assignment, `needs_grading_count`, due date, and Canvas URL, sorted by backlog size

### get-todo-counts
Fast count of submissions needing grading, without listing them.
- No parameters
- Returns `needs_grading_count` and `assignments_needing_submitting`

## Grades & Intervention

### get-course-grades
Current grade for every student in a course, sorted lowest first.
- Required parameters:
  - `courseId`: string
- Optional parameters:
  - `belowScore`: number — only students under this percentage
  - `includeInactive`: boolean (default: false)
  - `anonymous`: boolean (default: **false**)
- Returns current/final score and grade, points, `unposted_current_score`, and `last_activity_at`

### list-missing-submissions
Every missing (and optionally late) submission in a course, grouped by student.
- Required parameters:
  - `courseId`: string
- Optional parameters:
  - `includeLate`: boolean (default: false)
  - `studentIds`: string[]
  - `anonymous`: boolean (default: **false**)
- Returns per-student missing/late counts and the specific assignments, sorted by most outstanding

### get-student-engagement
Per-student page views, participations, and on-time/late/missing breakdown from Canvas Analytics.
- Required parameters:
  - `courseId`: string
- Optional parameters:
  - `anonymous`: boolean (default: **false**)
- Returns engagement rows sorted least-engaged first
- Requires Analytics to be enabled by your Canvas admin

## New Quizzes

New Quizzes use a separate API root (`/api/quiz/v1`) from Classic Quizzes. A New Quiz's ID **is** its assignment ID — pass it to `list-assignment-submissions` and `grade-submission` to grade essay responses.

### list-new-quizzes
Lists New Quizzes in a course.
- Required parameters:
  - `courseId`: string

### get-new-quiz
Fetches a single New Quiz including its settings.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string

### create-new-quiz
Creates a New Quiz. Returns the assignment ID used to add questions.
- Required parameters:
  - `courseId`: string
  - `title`: string
- Optional parameters:
  - `instructions`, `assignmentGroupId`, `dueAt`, `unlockAt`, `lockAt`: string
  - `pointsPossible`, `timeLimitMinutes`, `maxAttempts`: number
  - `gradingType`: `points` | `percent` | `letter_grade` | `gpa_scale` | `pass_fail`
  - `shuffleQuestions`, `shuffleAnswers`: boolean
  - `quizSettings`: object — raw `quiz_settings` escape hatch

### update-new-quiz
Updates an existing New Quiz. Only the fields you pass change.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string

### delete-new-quiz
Deletes a New Quiz and its underlying assignment.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string

### list-new-quiz-items
Lists questions in a New Quiz.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
- Optional parameters:
  - `full`: boolean (default: false) — include answer keys

### get-new-quiz-item
Fetches one question with its full payload and answer key.
- Required parameters:
  - `courseId`, `assignmentId`, `itemId`: string

### create-new-quiz-item
Adds a question. Answer IDs and scoring rules are generated for you.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
  - `interactionType`: `choice` | `multi-answer` | `true-false` | `essay` | `numeric` (unless using `rawEntry`)
  - `body`: string (unless using `rawEntry`)
- Optional parameters:
  - `title`: string, `pointsPossible`: number (default: 1), `position`: number
  - `choices`: string[] — for `choice` and `multi-answer`
  - `correctChoiceIndex`: number — 0-based, for `choice`
  - `correctChoiceIndexes`: number[] — 0-based, for `multi-answer`
  - `partialCredit`: boolean — `multi-answer` scoring (default: all-or-nothing)
  - `correctBoolean`: boolean — for `true-false`
  - `numericAnswer`, `numericMargin`: number; `numericMarginType`: `absolute` | `percent`
  - `gradingNotes`: string — for `essay`
  - `feedback`: `{ neutral?, correct?, incorrect? }`
  - `rawEntry`: object — full `entry` payload for matching, categorization, ordering, formula, hot-spot, rich-fill-blank

### update-new-quiz-item
Updates a question's points, position, or full content.
- Required parameters:
  - `courseId`, `assignmentId`, `itemId`: string
- Optional parameters:
  - `pointsPossible`, `position`: number
  - `rawEntry`: object — complete replacement entry

### delete-new-quiz-item
Deletes a question from a New Quiz.
- Required parameters:
  - `courseId`, `assignmentId`, `itemId`: string

### get-new-quiz-report
Generates and retrieves a quiz report. Polls the async job until ready.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
- Optional parameters:
  - `reportType`: `item_analysis` (default) | `student_analysis`
  - `format`: `json` (default) | `csv`
  - `waitSeconds`: number (default: 30)

## Conversations (read-only)

These tools **read** the Canvas inbox only. Sending is deliberately not exposed — student messages deserve human-written replies.

### list-conversations
Lists inbox messages with participants, subject, preview, and read state.
- No required parameters
- Optional parameters:
  - `scope`: `inbox` (default) | `unread` | `starred` | `archived` | `sent`
  - `courseId`: string
  - `limit`: number (default: 25)

### get-conversation
Reads the full message thread of one conversation.
- Required parameters:
  - `conversationId`: string
- Optional parameters:
  - `markAsRead`: boolean (default: false) — leaves your inbox untouched unless set

### get-unread-message-count
Returns the number of unread inbox conversations.
- No parameters
