# Canvas MCP Tool Reference

Full parameter reference for all **113 tools** exposed by the Canvas MCP server. For setup and usage, see the [README](../README.md).

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
  - `includeInactive`: boolean (default: false) — include inactive/concluded enrollments
  - `anonymous`: boolean (default: true) — whether to anonymize student names/emails
- Returns student names, IDs, enrollment status, and optional email addresses
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

### duplicate-assignment
Copies an assignment within a course — the starting point for next week's version of a recurring task.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string (a New Quiz's ID is its assignment ID)
- Optional parameters:
  - `newName`: string — rename the copy instead of leaving it as "<original> Copy"
  - `dueAt`: string (ISO 8601) — otherwise it inherits the original's due date
  - `publish`: boolean (default: false) — a duplicate is usually a draft
- Works for New Quizzes: the tool reads the assignment first and adds `result_type=Quiz` when it is quiz-LTI backed, so the caller does not have to know which engine is involved
- Canvas sometimes duplicates **asynchronously**, returning the copy with `workflow_state: "duplicating"`. When that happens the rename, due date and publish are skipped rather than applied — editing an assignment mid-duplication races Canvas's own write — and the tool says so.

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
- Does **not** return criteria — use `get-rubric` for those

### get-rubric
Reads one rubric in full: every criterion, its ratings, and the points on each. Use this before grading against a rubric — it returns the criterion IDs that `grade-submission`'s `rubric_assessment` must be keyed by.
- Required parameters:
  - `courseId`: string
  - `rubricId`: string
- Returns title, points possible, free-form comment setting, and each criterion with its ratings, points, and IDs
- Canvas resolves this endpoint through the rubric's association with the course, so a rubric belonging to another course or to the account is reported as unreadable here rather than as missing

### create-rubric
Creates a rubric, either as a reusable course-level rubric or attached to a single assignment for grading.
- Required parameters:
  - `courseId`: string
  - `title`: string
  - `criteria`: list of `{ description, ratings: [{ description, points }] }`, each criterion also accepting `longDescription`, `criterionUseRange` and `id`. Canvas's own indexed-hash spelling (`{"0": {...}}`) and a JSON string containing either shape are both accepted.
- Optional parameters:
  - `assignmentId`: string — attach to this assignment for grading; omit for a course-level rubric
  - `useForGrading`: boolean — let rubric scores drive the grade (requires `assignmentId`)
  - `keepAssignmentPoints`: boolean — stop Canvas rewriting the assignment's `points_possible` to the rubric total (only meaningful with `useForGrading`)
  - `freeFormComments`: boolean — let graders type their own comment per criterion
- Canvas derives each criterion's points from its highest rating and the rubric total from the criteria; a `points` value that disagrees is refused rather than silently replaced
- Re-reads the rubric after writing and warns if what Canvas stored differs from what was sent, or if the new rubric cannot be read back at all

### update-rubric
Changes an existing rubric's title, criteria or comment style.
- Required parameters:
  - `courseId`: string
  - `rubricId`: string
- Optional parameters:
  - `title`: string — omit to keep the current one
  - `criteria`: same shape as `create-rubric` — **replaces** every existing criterion; omit to leave them alone
  - `freeFormComments`: boolean
- Canvas's rubric update is a full replace, not a patch: an omitted title renames the rubric and omitted criteria delete every one. This tool reads the rubric first and re-sends whatever it is not changing, and refuses to write at all if that read fails
- Keep each criterion's existing `id` (from `get-rubric`) on rows you are keeping, or grading already done against them stops lining up
- Warns if Canvas clones the rubric instead of editing it, which it does when the rubric is in use in more than one place

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
  - `published`: boolean — whether students can see the page
  - `notifyOfUpdate`: boolean — notify the class that the page changed
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
  - `time_limit`: number — minutes a student gets once they start, or `0` for no time limit. This is the clock, not the due date. Extra time from `extend-quiz-time` is added on top of it and does nothing without it.
  - `allowed_attempts`: number — how many times a student may take the quiz; `1` is Canvas's default, `-1` is unlimited
  - `access_code`: string — password required to start the quiz; `''` removes it
  - `one_question_at_a_time`: boolean — one question per page
  - `cant_go_back`: boolean — prevent returning to an answered question. **Requires `one_question_at_a_time`**; Canvas stores it either way and silently ignores it otherwise, so it is refused rather than sent when the pairing is missing
  - `one_time_results`: boolean — students see their results only once, right after submitting
  - `shuffle_answers`: boolean — randomize answer order per student
- Returns the newly created quiz object
- `create-quiz` and `update-quiz` take **exactly the same** settings, asserted by a test — a setting you can only choose at creation is one you would have to delete a quiz to fix

### update-quiz
Updates an existing quiz.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
- Optional parameters: same as `create-quiz`
- Returns the updated quiz object
- `cant_go_back: true` is accepted when the quiz **already** has `one_question_at_a_time` on — the tool reads the quiz to check, rather than judging on the call's arguments alone
- An omitted setting is never sent, so a rename cannot strip a quiz's clock or password

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
  - `includeInactive`: boolean (default: false) — include inactive/concluded enrollments
  - `limit`: number (default: 0 = all) — return only the N lowest-scoring students
  - `anonymous`: boolean (default: **false**)
- Returns current/final score and grade, points, `unposted_current_score`, `last_activity_at`, and enrollment `state`

### list-missing-submissions
Every missing (and optionally late) submission in a course, grouped by student.
- Required parameters:
  - `courseId`: string
- Optional parameters:
  - `includeLate`: boolean (default: false)
  - `studentIds`: string[]
  - `includeInactive`: boolean (default: false) — include inactive/concluded enrollments
  - `anonymous`: boolean (default: **false**)
- Returns per-student missing/late counts, enrollment `state`, and the specific assignments, sorted by most outstanding

### get-student-engagement
Per-student page views, participations, and on-time/late/missing breakdown from Canvas Analytics.
- Required parameters:
  - `courseId`: string
- Optional parameters:
  - `limit`: number (default: 0 = all) — return only the N least-engaged students
  - `includeInactive`: boolean (default: false) — include inactive/concluded enrollments
  - `anonymous`: boolean (default: **false**)
- Returns engagement rows with enrollment `state`, sorted least-engaged first
- Requires Analytics to be enabled by your Canvas admin

> **Enrollment status is consistent across the roster tools.** `list-students`, `get-course-grades`, `list-missing-submissions`, and `get-student-engagement` all default to currently-enrolled students only (`active` + `invited`), all accept `includeInactive` to widen to `inactive` + `completed`, and all label each row with its enrollment state. The default matters for intervention work: a student who dropped the course should not appear on an outreach list.

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
  - `interactionType`: `choice` | `multi-answer` | `true-false` | `essay` | `numeric` | `matching` | `rich-fill-blank` | `ordering` | `categorization` | `hot-spot` (unless using `rawEntry`)
  - `body`: string (unless using `rawEntry`)
- Optional parameters:
  - `title`: string, `pointsPossible`: number (default: 1), `position`: number
  - `entryType`: `Item` (default) | `Stimulus` | `Bank` | `BankEntry`
  - `stimulusQuizEntryId`: string — attach this question to an existing stimulus
  - `choices`: string[] — for `choice` and `multi-answer`
  - `correctChoiceIndex`: number — 0-based, for `choice`
  - `correctChoiceIndexes`: number[] — 0-based, for `multi-answer`
  - `partialCredit`: boolean — `multi-answer` scoring (default: all-or-nothing)
  - `correctBoolean`: boolean — for `true-false`
  - `numericAnswer`, `numericMargin`: number; `numericMarginType`: `absolute` | `percent`
  - `gradingNotes`: string — for `essay`
  - `matchPairs`: `{ left, right }[]` — correct pairings, for `matching`
  - `distractors`: string[] — extra unmatched answer options, for `matching`
  - `imageUrl`: string — for `hot-spot`, the image students click on
  - `imagePixelWidth`, `imagePixelHeight`: number — the image's pixel size; give both to specify the hotspot in pixels
  - `hotspotRect`: `{ x, y, width, height }` — for `hot-spot`, the correct region as a rectangle
  - `hotspotOval`: `{ x, y, width, height }` — for `hot-spot`, the correct region as an ellipse, given by its bounding box
  - `hotspotPolygon`: `{ x, y }[]` — for `hot-spot`, the correct region as 3+ points
  - `feedback`: `{ neutral?, correct?, incorrect? }`
  - `rawEntry`: object — full `entry` payload for formula and file-upload

> **Note on stimulus items — stimulus support is READ-ONLY.** Tested exhaustively against a live instance (2026-08-03) with a genuine UI-authored stimulus present. Neither half can be written:
>
> - **Creating a stimulus is refused.** Sending an entry as `entry_type: "Item"` gives a descriptive `422` naming the question fields it wants; sending the *same* entry as `"Stimulus"` (or `"BankEntry"`) gives a bare `400` with a plain-text `Bad Request` body. The Stimulus request never reaches field validation, so no payload can succeed. The Canvas UI does it in two steps against a **different service** (`quiz-api-*.instructure.com/api/quizzes/:internal_id/stimuli`, then `/quiz_entries`), on an internal quiz ID the public API never exposes — which is why the public endpoint has no way to express it.
> - **Attaching a question is refused.** `stimulus_quiz_entry_id` was rejected four ways — on create and on update, as JSON and as form-encoded params — using both of a stimulus's two IDs (its item/quiz_entry ID *and* its inner entry ID). Every attempt returned `200` and stored `""`. The field appears on the `QuizItem` response model but in neither the POST nor the PATCH parameter list.
>
> Both are therefore **refused up front** rather than attempted: `create-new-quiz-item` and `update-new-quiz-item` reject `stimulusQuizEntryId`, and `create-new-quiz-item` rejects any `entryType` other than `Item`. Forwarding them would return a cheerful success for a question that stands alone on the page.
>
> **Reading works and is the useful half.** `list-new-quiz-items` and `get-new-quiz-item` report `stimulus_quiz_entry_id`, so an attach made in the UI can be confirmed here. An attached question carries the stimulus's **item ID** (e.g. `"9307"`), not its inner entry ID.
>
> The working path: in the Canvas UI choose **Insert Content > Stimulus**, build the passage, then add the questions inside its block. Then confirm with `list-new-quiz-items`.
>
> *(Do not "fix" this by switching the client to form encoding. It was tried: Rails parses `interaction_data[choices][0][id]` into a string-keyed **hash** rather than an array, and turns numbers into strings, so a form-encoded item is stored malformed — and a malformed item can break the entire quiz editor page, not just itself.)*

> **Note on `hot-spot`:** the shape came from a UI-authored exemplar and was confirmed rendering in the Canvas editor (2026-08-04).
>
> - **Coordinates are measured from the top-left and stored as fractions of the image between 0 and 1.** Pass `imagePixelWidth` and `imagePixelHeight` (both, or neither) to give them in **pixels** instead and have them converted. Prefer this: every hotspot in the first live round rendered perfectly and sat in the wrong place, because fractions had been estimated by eye. Pixel positions can be read off any image viewer; fractions cannot be guessed.
> - A coordinate landing outside the image is refused either way. Canvas stores it happily and puts the hotspot where no answer can ever be correct — silent, and visible only to the student sitting the quiz.
> - The three shapes match the three tools in the Canvas editor and are mutually exclusive. `hotspotRect` writes `type: "square"` (the editor calls it *rectangle* in the UI and stores `square`), `hotspotOval` writes `"oval"`, `hotspotPolygon` writes `"polygon"`.
> - **A square or oval is stored as two points — opposite corners of its bounding box — not as an outline.** The oval's two corners come back from the editor in whatever order they were dragged, which reads convincingly as `[center, radii]`; it is not. Checking the numbers against a known landmark in the same image is what settled it, and under the wrong reading the hotspot would have been silently misplaced.
> - **The image can be an ordinary Canvas Files URL** (verified live), so `upload-course-file` then `create-new-quiz-item` automates the whole flow. The New Quizzes S3 `item_media` bucket is just where the UI puts its own uploads, not a requirement.
> - The image is fetched by the student's browser, so it **must be published and student-visible**. An unpublished or link-only file renders for a teacher and fails for students — see `set-file-availability`.
> - Only one hotspot region per item is supported; `hotspots_count` is always 1. Multiple regions are untested.

> **Note on `matching`:** the builder copies the shape the Canvas editor itself writes, captured from a UI-authored exemplar, after a version derived from the published appendix stored cleanly and then **broke the entire quiz page** in the UI (one bad item takes down the whole quiz, not just itself). If you hand-roll a matching item via `rawEntry`, match these exactly: `interaction_data.answers` are plain strings (distractors included); `interaction_data.questions` are `{ id, item_body }` where `item_body` is raw text, *not* `<p>`-wrapped, and `id` is a short numeric string like `"52556"`, not a UUID; `scoring_data.value` is a **map of question id → answer text**; `scoring_data.edit_data` is required (`{ matches: [{ answer_body, question_id, question_body }], distractors: [] }`) because the editor builds its match rows from it; and `scoring_algorithm` is `PartialDeep` or `DeepEquals`. There is no `answer_type: "match_string"` — the UI writes none.
>
> *(An earlier version of this note said `scoring_data.value` must be an array of `"questionId:answerId"` strings. That was wrong: the map is correct, and the `property '#/value/0' of type object did not match` error that prompted it came from sending an array of objects. Corrected 2026-08-03.)*

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

## Course Settings & Syllabus

### get-syllabus
Reads a course's syllabus. The syllabus is a course attribute (`course[syllabus_body]`), not a wiki page, so it never appears in `list-pages` and `get-page-content` cannot reach it.
- Required parameters:
  - `courseId`: string

### update-syllabus
Writes the course syllabus. Takes HTML.
- Required parameters:
  - `courseId`: string
  - `body`: string — HTML, rendered as-is by Canvas
- Optional parameters:
  - `mode`: `replace` (default) | `append` | `prepend`
  - `backup`: boolean (default: true) — copy the outgoing syllabus to an unpublished page before replacing it
- **The syllabus has no revision history of its own.** Wiki pages do, so a replace first copies the outgoing text to an unpublished page called **"Syllabus - Backup"** (`syllabus-backup`), which borrows that history: every backup is another revision of the same page, reachable with `list-page-revisions` and `revert-page-revision`.
- The backup is written *before* the overwrite, and a failed backup aborts the replacement — a backup that silently failed is worse than none, since the caller would believe the old text is recoverable
- If Canvas returns the backup page as published, the replacement is aborted rather than leave students looking at an outdated syllabus
- `append`/`prepend` destroy nothing, so they skip the backup
- Confirms the write from Canvas's own response rather than assuming a 200 means saved

### update-course-settings
Changes a course's name, landing page, dates, and visibility.
- Required parameters:
  - `courseId`: string
- Optional parameters:
  - `name`, `courseCode`: string
  - `defaultView`: `feed` | `wiki` | `modules` | `assignments` | `syllabus` — the page students land on
  - `isPublic`: boolean — visible to the public, including logged-out visitors
  - `publicSyllabus`: boolean — expose only the syllabus
  - `startAt`, `endAt`: string (ISO 8601)
  - `timeZone`: string — IANA zone, e.g. `America/Los_Angeles`
- Reports each field against what Canvas echoed back, and warns when a setting did not take — Canvas ignores settings it will not accept without erroring
- `defaultView: 'wiki'` shows the front page; with no front page set, students land on an error. Set one with `set-front-page`.

### set-course-publish-state
Publishes, unpublishes, or concludes a course.
- Required parameters:
  - `courseId`: string
  - `state`: `published` | `unpublished` | `concluded`
- Maps to `course[event]`: `offer`, `claim`, `conclude`
- **Cannot delete a course.** `course[event]` also accepts `delete`, which removes the course and every enrollment in it; it is deliberately not exposed, and a test asserts no tool reaches it.
- Canvas refuses to unpublish a course once students have submitted work, and signals that by leaving the state unchanged rather than by erroring — the tool checks `workflow_state` and warns

### set-front-page
Marks a page as the course's front page.
- Required parameters:
  - `courseId`: string
  - `pageUrl`: string — the page's URL slug, from `list-pages`
- Optional parameters:
  - `makeLandingPage`: boolean (default: false) — also set the course to open on it
- An unpublished page cannot be a front page; Canvas declines quietly, so the tool raises it as an error

## Calendar

### list-calendar-events
Lists a course's calendar events — meetings, exams, office hours; anything dated that is not an assignment.
- Required parameters:
  - `courseId`: string
- Optional parameters:
  - `startDate`, `endDate`: string (ISO 8601 date) — default today through 60 days out
  - `allEvents`: boolean (default: false) — ignore the date range entirely
  - `includeAssignments`: boolean (default: false) — also include assignment due dates, which Canvas serves as a separate event type (a second request)

### create-calendar-event
Puts an event on a course calendar, optionally as a recurring series.
- Required parameters:
  - `courseId`: string
  - `title`: string
  - `startAt`: string (ISO 8601)
- Optional parameters:
  - `endAt`: string (ISO 8601)
  - `description`: string — HTML
  - `locationName`: string — a room or a meeting link
  - `allDay`: boolean (default: false)
  - `repeatCount`: integer 0–200 — how many *additional* copies; 9 gives 10 events
  - `repeatFrequency`: `daily` | `weekly` | `monthly` — required with `repeatCount`
  - `repeatInterval`: integer — gap in units of the frequency; 2 with `weekly` is fortnightly
- **Calendar events have no draft state.** In a published course, students see the event as soon as it exists.
- `repeatCount` and `repeatFrequency` are refused unless both are present: a count with no frequency has no rhythm, and a frequency with no count silently creates a single event
- Canvas interprets a bare date in the *course's* time zone, so a stored start that differs from the one requested is reported rather than passed over

### update-calendar-event
Moves or edits an event.
- Required parameters:
  - `eventId`: string
- Optional parameters:
  - `title`, `startAt`, `endAt`, `description`, `locationName`
  - `which`: `one` (default) | `all` | `following` — for a recurring series, whether this touches one occurrence, the whole series, or this one and every later one
- Defaults to a single occurrence, so a series is never rewritten by accident
- Diffs what Canvas stored against what was asked for and warns on a mismatch

### delete-calendar-event
Removes an event.
- Required parameters:
  - `eventId`: string
- Optional parameters:
  - `which`: `one` (default) | `all` | `following`
  - `cancelReason`: string — shown to students who had it on their calendar
- `which: 'all'` deletes an entire recurring series and cannot be undone from here

## Course Copy

### copy-course-content
Copies an entire course into another — last term's assignments, pages, modules, quizzes and files into this term's shell.
- Required parameters:
  - `sourceCourseId`: string — the course to copy FROM
  - `destinationCourseId`: string — the course to copy INTO
- Optional parameters:
  - `allowExistingContent`: boolean (default: false) — proceed even though the destination is not empty
  - `shiftDates`: boolean (default: false) — move dates onto the new term's calendar
  - `oldStartDate`, `newStartDate`: string (ISO 8601) — **required** when `shiftDates` is on
  - `oldEndDate`, `newEndDate`: string (ISO 8601) — supply these too and the term is scaled, not just offset
  - `daySubstitutions`: object — remap weekdays, e.g. `{"1":"2"}` moves Monday's items to Tuesday (0=Sunday…6=Saturday)
  - `removeDates`: boolean (default: false) — strip all dates instead of shifting them; mutually exclusive with `shiftDates`
- **A copy adds to the destination rather than replacing it, and Canvas cannot undo one.** A non-empty destination is refused, naming what is already there, unless `allowExistingContent` is set.
- Copying a course into itself is refused
- `shiftDates` without both start dates is refused: Canvas would otherwise accept it and the copy would arrive carrying last term's due dates
- **Canvas keeps every item on its original day of the week**, rounding the shift to whole weeks rather than applying the literal offset between your two dates. Verified live: a 358-day request was applied as 357 (51 weeks), so a Friday assignment stayed on a Friday. Usually what a class schedule wants, but content can land a few days either side of the dates you name.
- Undated content stays undated; times of day are preserved exactly
- Asynchronous. Returns a migration ID; the copy keeps running in the background for minutes on a full course.

### get-content-migration
Checks how a copy is going and what it did or did not bring across.
- Required parameters:
  - `courseId`: string — the course being copied INTO
  - `migrationId`: string
- While running, reports the completion percentage from the migration's linked progress record
- **Once finished, reports Canvas's migration issues.** A migration can report `completed` and still have dropped content; that is recorded nowhere else.
- A migration parked in `waiting_for_select` is called out — selective import is not supported here and must be finished in the Canvas UI

### list-content-migrations
Lists the copies and imports run into a course, newest first.
- Required parameters:
  - `courseId`: string
- Useful for finding a migration ID, or checking whether a shell has already been copied into before copying again

## Files

### upload-course-file
Uploads a local file into a course's Files area via Canvas's three-step upload handshake.
- Required parameters:
  - `courseId`: string
  - `filePath`: string — absolute path to the file on this machine
- Optional parameters:
  - `fileName`: string — name to store it under (defaults to the local file name)
  - `folderPath`: string — destination folder path, e.g. `/Handouts` (defaults to the course root)
  - `folderId`: string — destination folder by ID; takes precedence over `folderPath`
  - `onDuplicate`: `rename` (default) | `overwrite` — `overwrite` cannot be undone
  - `contentType`: string — MIME type override; guessed from the extension when omitted
- Canvas renames rather than overwrites by default, so the tool reports the name the file actually landed under
- Whether an upload arrives published or unpublished varies by instance — check with `list-course-files`

### set-file-availability
Publishes, unpublishes, or hides a course file behind a link.
- Required parameters:
  - `fileId`: string (from `list-course-files`)
  - `state`: `published` | `unpublished` | `link-only`
- Optional parameters:
  - `availableFrom`: string (ISO 8601) — only meaningful with `published`
  - `availableUntil`: string (ISO 8601) — only meaningful with `published`

### list-course-files
Lists files in a course, or in one folder.
- Required parameters:
  - `courseId`: string
- Optional parameters:
  - `searchTerm`: string — Canvas requires at least 3 characters
  - `folderId`: string — lists that folder only
- `folderId` uses a different Canvas endpoint: `/courses/:id/files` silently ignores a folder filter and returns the whole course

### get-course-file
Fetches a file from a course's Files area so it can be looked at — the read-only counterpart to `upload-course-file`.
- Required parameters:
  - `fileId`: string (from `list-course-files`)
- Optional parameters:
  - `saveToPath`: string — absolute path to write the file to. Returns a summary instead of the file; use for large images
- **Reports an image's pixel dimensions**, read straight from the file header (PNG, JPEG and GIF). This is what hot-spot authoring needs: pass them to `create-new-quiz-item` as `imagePixelWidth` / `imagePixelHeight` and give the hotspot in pixels
- Returns the image itself, so a hotspot can be placed against the actual picture rather than a description of it. Placing one on an unseen image is how a well-formed hotspot ends up over the wrong part of the picture
- A file whose header cannot be read says so, rather than reporting a plausible guess
- Non-image files are summarised rather than dumped as base64; use `saveToPath` to get the bytes
- **A page Canvas creates is UNPUBLISHED**, so it is invisible to students while looking perfectly normal to a teacher. Pass `published: true` for anything students are meant to read. The tool warns when a write leaves a page unpublished, unless `published: false` was explicit
- **Canvas derives a new page's slug from its TITLE, not from `pageUrl`.** Creating `mcp-publish-probe` with the title "MCP Publish Probe (throwaway)" stored it at `mcp-publish-probe-throwaway`, and reading back the requested slug 404s. The tool reports the stored slug and says so when the two differ
- `notifyOfUpdate` sends a real notification to the class. It is never sent unless asked for
- **Adds a page-end spacer.** Canvas puts its Previous/Next module controls flush against the body — `div#module_navigation_target` has no spacing above it and `div#wiki_page_show` none below — so a page whose last element has no bottom margin ends hard against them. A `div.mcp-page-end` of fixed height is appended. Idempotent: the marker survives Canvas's sanitizer (verified live), so a read-edit-write round trip does not stack them up. Turn it off with `pageEndSpacing: false`
- A fixed height is used rather than a margin, because a margin on the last child can collapse away


---

### list-course-folders
Lists a course's file folders with their IDs and paths.
- Required parameters:
  - `courseId`: string

## Overrides & Accommodations

### list-assignment-overrides
Shows the differentiated due dates on an assignment or New Quiz — who has different dates from the rest of the class.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string (a New Quiz's ID is its assignment ID)
- Reports the base due date from `include[]=all_dates`, not the assignment's own `due_at`, which Canvas returns relative to the requesting user
- Warns when "only visible to overrides" is on, since students outside every override then cannot see the assignment at all

### create-assignment-override
Gives specific students or a whole section different dates.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
  - Exactly one of `studentIds` (string array) or `sectionId` (string)
  - At least one of `dueAt`, `unlockAt`, `lockAt` (ISO 8601)
- Optional parameters:
  - `title`: string — required by Canvas for student-targeted overrides; defaulted if omitted. Canvas overwrites the title of a section override with the section's own name.
- Reads back what Canvas stored and warns about anything that did not land, including students Canvas dropped

### update-assignment-override
Changes the dates or membership of an existing override.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
  - `overrideId`: string
- Optional parameters:
  - `studentIds`: string array — replaces the whole list; students left out lose the override
  - `title`, `dueAt`, `unlockAt`, `lockAt`

### delete-assignment-override
Removes an override, returning its students or section to the base dates.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
  - `overrideId`: string

### extend-due-date
Gives named students a later due date — the everyday accommodation.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
  - `studentIds`: string array
  - `dueAt`: string (ISO 8601)
- Optional parameters:
  - `title`: string — label for a newly created override (default: "Extended deadline")
- Reuses an override that already covers exactly those students instead of stacking a second one
- Refuses when a matching override also covers students who were not named, rather than moving their deadline as a side effect
- Moves the due date only; for extra minutes on a timed quiz see `extend-quiz-time`

## Quiz Time Extensions

### extend-quiz-time
Gives students extra **minutes** on a timed quiz — the clock accommodation, as opposed to the later deadline `extend-due-date` grants. Works with both quiz engines.
- Required parameters:
  - `courseId`: string
  - `quizId`: string — a Classic quiz ID, or a New Quiz's assignment ID
  - Exactly one of `studentIds` (string array) or `sectionId` (string)
  - `extraMinutes`: integer 0–10080 (Canvas's own ceiling, one week)
- Optional parameters:
  - `extraAttempts`: integer — extra attempts beyond the quiz's limit. **This is the only way to grant a quiz retake**; `extend-assignment-attempts` is refused by Canvas on a quiz's assignment. `0` removes the grant
  - `reduceChoices`: boolean — **New Quizzes only**: removes one wrong answer from multiple-choice questions with 4+ options
  - `manuallyUnlocked`: boolean — **Classic Quizzes only**: lets these students take the quiz while it is locked for everyone else
  - `engine`: `classic` | `new` — only needed when the ID is ambiguous
- `extraMinutes` is absolute *for this quiz*: calling again replaces that grant rather than adding to it, and `0` removes it (verified on both engines)
- **On New Quizzes it does not replace a student's course-wide accommodation — the two add together.** Verified in the UI: a course-wide 45 plus a per-quiz 30 reads as `+1 hr 15 min`. Neither value is readable through the API, so the tool states this on every grant rather than detecting it.
- The engine is detected by probing both APIs. Their ID spaces are independent, so an ID that names a quiz under each is refused as ambiguous rather than guessed
- An option belonging to the other engine is refused rather than sent, because Canvas ignores unsupported parameters silently
- Warns when the quiz has no time limit, where extra minutes change nothing
- A `sectionId` is expanded to its currently-enrolled students, since Canvas has no section-level extension. That is a snapshot: students added later do not inherit it.
- **New Quizzes only accepts a per-quiz accommodation for students who have already opened that quiz.** To grant extra time *before* an exam, use `set-course-quiz-accommodations`, which has no such restriction. Classic Quizzes does not restrict this. Canvas reports the refusal as a 404 it documents as a missing course or assignment; the tool translates it.

### list-quiz-extensions
Shows who already has extra time or attempts on a quiz.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
- Optional parameters:
  - `engine`: `classic` | `new` — only needed when the ID is ambiguous
- **Classic Quizzes only.** Canvas's New Quizzes accommodations API is write-only; for a New Quiz this says so rather than returning an empty list that would read as "nobody has an accommodation"
- Classic extensions live on a student's quiz submission, so a student who has never opened the quiz and has no extension does not appear at all

### set-course-quiz-accommodations
Gives students extra time on **every** New Quiz in a course — the standing IEP/504 accommodation rather than a per-quiz grant.
- Required parameters:
  - `courseId`: string
  - Exactly one of `studentIds` (string array) or `sectionId` (string)
  - `extraMinutes`: integer 0–10080
- Optional parameters:
  - `reduceChoices`: boolean
  - `applyToInProgressSessions`: boolean — also applies to attempts that are open right now
- **New Quizzes only.** Classic Quizzes has no course-level equivalent; those need `extend-quiz-time` per quiz.
- This is also the **only** way to grant New Quizzes extra time before a student has opened the quiz — verified working where a per-quiz grant on the same student and course was refused, and confirmed in the Canvas UI: the granted minutes show on the Moderate page of a quiz the student had never opened
- Canvas rejects the whole batch if any one user ID is unknown to the New Quizzes service, so nobody receives the accommodation rather than most people

---

### extend-assignment-attempts
Gives students extra **attempts** at an assignment — another try, for a retake or a technical failure.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
  - Exactly one of `studentIds` (string array) or `sectionId` (string)
  - `extraAttempts`: integer 0–100
- Absolute, not a top-up: calling it again replaces the grant, and `0` removes it
- **Only meaningful when the assignment limits attempts.** Canvas's default is unlimited (`allowed_attempts: -1`), where the grant is accepted, answers 200, and changes nothing — the tool reads the assignment and warns rather than reporting a granted accommodation
- Verified per student by re-reading the submission, which is where Canvas records `extra_attempts` — the write's own response does not say
- A `sectionId` is expanded to its currently-enrolled students, and that expansion is a snapshot: students added later get nothing
- Not a deadline and not a clock — see `extend-due-date` and `extend-quiz-time`
- **Does not work on a quiz.** Canvas only accepts extra attempts on `online_upload`, `online_url` or `online_text_entry` submissions, and refuses a quiz's assignment outright. Grant a quiz retake with `extend-quiz-time`'s `extraAttempts` instead — the two are spelled almost identically and live on different endpoints

---

### get-late-policy
Reads the course's policy for missing and late work.
- Required parameters:
  - `courseId`: string
- A course with no policy is reported as that state rather than as an error
- Renders the missing-submission setting as the **grade the student receives**, matching the Canvas UI, not the deduction the API stores

---

### set-late-policy
Sets the course's missing/late work policy, creating it if the course has none.
- Required parameters:
  - `courseId`: string
- Optional parameters:
  - `missingSubmissionGrade`: number 0–100 — the grade missing work automatically receives, as a percentage of the assignment's points (`0` means a zero)
  - `applyMissingPolicy`: boolean — only needed to turn the missing policy **off**
  - `lateDeductionPercent`: number 0–100 — deducted per late interval
  - `lateDeductionInterval`: `"day"` or `"hour"`
  - `lateMinimumPercent`: number 0–100 — floor below which late deductions stop
  - `applyLatePolicy`: boolean — only needed to turn the late policy **off**
- **The API field is a deduction; this parameter is the resulting grade.** `missingSubmissionGrade: 0` is sent as `missing_submission_deduction: 100`. Passing the UI's number to the raw API would invert the policy silently
- **A percentage without its `_enabled` flag is stored and ignored by Canvas**, so setting any percentage turns the matching policy on. A percentage combined with an explicit `false` switch is refused as a contradiction rather than resolved
- `lateDeductionInterval` alone is refused — it only says how often a deduction that is not happening would accrue
- **Changes grades across the entire course, including work already submitted.** Scores students have already seen can change
- Verified by re-reading the policy, not from the write's response

---

## Diagnostics

### get-server-version
Reports which build of this server the client has loaded. Use it to confirm an upgrade actually took effect — the MCP server is a child process and is not swapped out without a full restart of the host app.
- No parameters

---

### refresh-canvas-data
Discards every cached Canvas response, so the next read of each resource fetches fresh data.
- No parameters
- Reads are served from cache for 60 seconds with **no network call**, then revalidated with an ETag. Write tools invalidate what they touch, so changes made *through this server* are always reflected and need no refresh
- Use it when Canvas changed somewhere else: you edited a quiz or page in the Canvas UI, a co-teacher changed something, or a long-running job (course copy, assignment duplication) finished
- **This is the only way to defeat the cache.** No read tool can force a fresh fetch on its own — parameters that change only the formatting of a result, such as `list-new-quiz-items`' `full`, share a cache key with the plain call
- **Why it matters:** a stale read is indistinguishable from the resource not existing. A question attached to a stimulus in the Canvas UI kept not appearing in a cached item listing during development, and was nearly recorded as a Canvas API limitation that does not exist
- Harmless: it discards local copies only, never Canvas data, and makes no request to Canvas
