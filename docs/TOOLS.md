# Canvas MCP Tool Reference

Full parameter reference for all **80 tools** exposed by the Canvas MCP server. For setup and usage, see the [README](../README.md).

## Courses

### list-courses
Lists all active courses for the authenticated user.
- No required parameters
- Returns course names, IDs, and term information

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

### get-grading-packet
Starting point for grading an assignment. Read-only.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
- Optional parameters:
  - `userId`: string. Also include this student's work, in the same format as `get-submission-content`.
  - `includeMaterials`: boolean (default: true). Reads up to 5 Canvas files linked in the assignment description (handouts, sources). Other links are listed but not fetched.
  - `anonymous`: boolean (default: true)
- Returns:
  - Grading instructions the model follows: check for missing materials such as paper sources or handouts, ask once whether resubmissions are accepted ("Revise ..." vs "Next time ..."), keep feedback off by default, get the teacher's approval before writing any grade or feedback, and keep feedback brief, actionable, direct and supportive
  - The assignment's settings, including `allowed_attempts` and `post_manually`
  - The rubric, with the `criterionId` and `ratingId` values `grade-submission` needs
  - Submission counts, and a queue of students needing grading (oldest submission first, including resubmissions made after grading)
  - The assignment description as text, plus the linked materials

### grade-submission
Writes a score, grade, rubric assessment, or comment for a student's submission. The tool's instructions tell the model to call it only after the teacher approves, and to include comment text only when the teacher has approved those exact words.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
  - `userId`: string
- Optional parameters:
  - `posted_grade`: string. Points, percentage, letter grade, or complete/incomplete.
  - `score`: number. Shorthand for a points `posted_grade`.
  - `rubric`: array of `{ criterionId, ratingId?, points?, comments? }`. This is checked against the assignment's rubric (unknown IDs, out-of-range points, and points that don't match the chosen rating are rejected) before anything is written.
  - `rubric_assessment`: raw Canvas object (unvalidated; use `rubric` instead)
  - `comment`: string
- Returns the resulting score and grade, plus the rubric total. It also notes any criteria left unscored, and points out when the rubric isn't set to calculate the grade.

### list-assignment-submissions
Gets all student submissions for a specific assignment.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
- Optional parameters:
  - `anonymous`: boolean (default: true) — whether to anonymize student names/emails
- Returns submission details, grades, and comments
- **Privacy**: Student data is anonymized by default

### get-submission-content
Reads a student's submitted work in a form the model can grade from.
- Required parameters:
  - `courseId`: string
  - `assignmentId`: string
  - `userId`: string
- Optional parameters:
  - `attempt`: number | `"all"` (default: latest attempt)
  - `renderPdfPages`: `"auto"` | `"always"` | `"never"` (default: `"auto"`, which renders only pages with no text layer, such as scans and handwriting)
  - `maxPdfPagesToRender`: number (default: 10, per file)
  - `ocr`: boolean (default: true). On macOS, runs Apple Vision OCR on scanned PDF pages and photos.
  - `maxImages`: number (default: 15, per response)
  - `maxCharsPerFile`: number (default: 60000)
  - `maxFileMB`: number (default: 25)
  - `anonymous`: boolean (default: true)
- Returns a JSON summary (attempts, per-file extraction status, comments, warnings) followed by the content itself:
  - PDF, Word (`.docx`), HTML and text/code files come back as extracted text
  - Photos come back as images, downscaled to 1568px
  - Text-entry and discussion submissions are converted from HTML to plain text
  - Links, recordings, LTI and annotation submissions are reported in notes
- **Privacy**: With `anonymous`, the student's name is replaced by their pseudonym in filenames, document text and comments. This is best effort: names inside images are not removed.
- **macOS**: PDF text comes from Apple's PDFKit, which rejoins wrapped lines into paragraphs. Scanned pages and photos also get Vision OCR text next to the image, and iPhone HEIC photos are converted with `sips`. All three use built-in system tools through `osascript`. Other platforms use pdf.js and return images only. The first OCR call after a reboot loads Vision's models and can take up to a minute.
- **Optional dependency**: rendering scanned PDF pages and resizing photos uses `@napi-rs/canvas`. Without it, text extraction still works and the response says what was skipped.

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

### get-rubric
Gets a rubric's criteria, ratings, outcome alignments, and associations as JSON.
- Required parameters:
  - `courseId`: string
  - `rubricId`: string
- The returned `criteria` array can be edited and passed back to `update-rubric`

### create-rubric
Creates a rubric, optionally aligning criteria to outcomes and attaching it to an assignment.
- Required parameters:
  - `courseId`: string
  - `title`: string
  - `criteria`: array of criterion objects (see below)
- Optional parameters:
  - `freeFormCriterionComments`: boolean
  - `assignmentId`: string — attach to this assignment; otherwise the rubric is saved to the course's rubric list
  - `useForGrading`: boolean (default: false) — sets the assignment's points to the rubric total
  - `hideScoreTotal`: boolean
- Aligned outcomes must already be in the course (see `link-outcome`), and each outcome can be aligned to only one criterion per rubric

Criterion objects (used by `create-rubric` and `update-rubric`, and returned by `get-rubric`):
- `id`: string — existing criterion ID; keep it when editing so existing assessments stay attached
- `description`: string — optional when `learningOutcomeId` is set (defaults to the outcome title)
- `longDescription`: string
- `learningOutcomeId`: string | null — align the criterion to a course outcome
- `masteryPoints`: number — defaults to the outcome's mastery points
- `useForScoring`: boolean (default: true) — for outcome-aligned criteria
- `useRange`: boolean
- `ratings`: array of `{ id?, description, longDescription?, points }`, highest first — optional when `learningOutcomeId` is set (defaults to the outcome's scale)

### update-rubric
Updates a rubric's title, comment setting, or criteria.
- Required parameters:
  - `courseId`: string
  - `rubricId`: string
- Optional parameters:
  - `title`: string
  - `freeFormCriterionComments`: boolean
  - `criteria`: array of criterion objects — replaces the whole list; start from `get-rubric`
- If the rubric is shared or already assessed, Canvas may save the edit as a new rubric; the response says so and gives the new ID

### set-rubric-criterion-outcome
Aligns one rubric criterion to a learning outcome, or removes the alignment, leaving the rest of the rubric unchanged.
- Required parameters:
  - `courseId`: string
  - `rubricId`: string
  - `criterionId`: string — from `get-rubric`
  - `outcomeId`: string | null — null removes the alignment
- Optional parameters:
  - `useOutcomeRatings`: boolean (default: true) — replace the criterion's title, ratings, and mastery points with the outcome's
  - `useForScoring`: boolean (default: true)

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

## Outcomes

Account-level outcomes can't be edited from a course. When the account uses account-level mastery scales, the mastery scale and calculation come from the account: `masteryPoints`, `ratings`, `calculationMethod`, and `calculationInt` are ignored by `create-outcome` (the response says so) and rejected by `update-outcome`.

### list-outcomes
Lists every outcome in a course, grouped by outcome group, with group and outcome IDs.
- Required parameters:
  - `courseId`: string

### get-outcome
Gets an outcome's description, mastery points, rating scale, and calculation method as they apply in a course.
- Required parameters:
  - `courseId`: string — Canvas only reports the rating scale in a course's context
  - `outcomeId`: string

### create-outcome
Creates a learning outcome in a course outcome group.
- Required parameters:
  - `courseId`: string
  - `title`: string
- Optional parameters:
  - `groupId`: string — defaults to the course's root group
  - `displayName`: string
  - `description`: string
  - `vendorGuid`: string — e.g. a standard code
  - `masteryPoints`: number
  - `ratings`: array of `{ description, points }`, highest first
  - `calculationMethod`: `decaying_average` | `standard_decaying_average` | `n_mastery` | `latest` | `highest` | `average`
  - `calculationInt`: number

### update-outcome
Updates an outcome; only the fields provided change.
- Required parameters:
  - `courseId`: string
  - `outcomeId`: string
- Optional parameters: same fields as `create-outcome` (except `groupId`)
- Canvas may refuse scale changes once students have been assessed

### create-outcome-group
Creates an outcome group (folder).
- Required parameters:
  - `courseId`: string
  - `title`: string
- Optional parameters:
  - `parentGroupId`: string — defaults to the course's root group
  - `description`: string
  - `vendorGuid`: string

### link-outcome
Adds an existing outcome (e.g. account- or state-level) to a course outcome group.
- Required parameters:
  - `courseId`: string
  - `outcomeId`: string
- Optional parameters:
  - `groupId`: string — defaults to the course's root group

### unlink-outcome
Removes an outcome from a course outcome group. If it was the outcome's last link anywhere, the outcome is deleted; Canvas refuses that when the outcome is aligned to content.
- Required parameters:
  - `courseId`: string
  - `groupId`: string
  - `outcomeId`: string

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

## Files

### list-folders
Lists folders in a course Files section.
- Required parameters:
  - `courseId`: string
- Optional parameters:
  - `folderId`: string — if set, list only immediate subfolders of that folder
- Without `folderId`, returns the full folder tree with IDs, file/folder counts, and hidden/locked flags
- With `folderId`, returns only the children of that folder

### list-files
Lists files in a course Files section.
- Required parameters:
  - `courseId`: string
- Optional parameters:
  - `folderId`: string — if set, list only files in that folder
  - `searchTerm`: string — partial filename match
  - `contentTypes`: string[] — filter by content type, e.g. `["image"]` or `["application/pdf"]`
- Without `folderId`, returns all course files with folder paths
- Returns display name, file ID, folder path, content type, and size

### list-folder-contents
Browses one folder like the Canvas Files UI (subfolders and files together).
- Required parameters:
  - `courseId`: string
- Optional parameters:
  - `folderId`: string — folder ID; use `"root"` or omit for the course Files root
  - `path`: string — path relative to course files (e.g. `Workshops/Slides`); overrides `folderId` when set
- Returns folder metadata plus immediate subfolders and files

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

## Quiz Results

### list-quiz-submissions
Lists every student's quiz attempt with score, timing, and state. The starting point for quiz analysis.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
- Optional parameters:
  - `anonymous`: boolean (default: true) — replace student identity with a stable pseudonym
- Returns a class-level score summary plus per-attempt `score`, `kept_score`, `time_spent`, `workflow_state`, and `fudge_points`
- **Privacy**: Student data is anonymized by default

### get-quiz-statistics
Aggregate item analysis for a quiz.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
- Optional parameters:
  - `allVersions`: boolean (default: false) — include every attempt rather than the most recent per student
- Returns per-question response distribution across answer choices, `difficulty_index`, `alpha`, and point-biserial correlation per distractor, plus class mean/stdev/percentiles
- Aggregate only — contains no per-student data

### get-quiz-submission-answers
One student's actual answer to every question, joined against question text and the correct answer.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
  - `userId`: string
- Optional parameters:
  - `attempt`: number (default: most recent)
  - `anonymous`: boolean (default: true)
- Returns per-question `given_answer`, `correct_answers`, `points_earned`, and `correct`
- Requires a graded quiz (`quiz_type: assignment` or `graded_survey`); practice quizzes have no backing assignment
- **Privacy**: Student data is anonymized by default

### get-quiz-report
Generates (or reuses) a Canvas quiz report and returns its parsed contents. Polls until generation completes, up to 90 seconds.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
- Optional parameters:
  - `reportType`: `"student_analysis"` | `"item_analysis"` (default: `student_analysis`)
  - `allVersions`: boolean (default: false)
  - `format`: `"summary"` | `"full"` (default: `summary`) — `full` returns every cell of the answer matrix and can be large
  - `regenerate`: boolean (default: false) — force a fresh report instead of reusing an existing one
  - `anonymous`: boolean (default: true)
- `student_analysis` gives the whole-class student x question answer matrix; `item_analysis` gives per-question difficulty and discrimination
- If generation exceeds 90 seconds the tool returns a message; call it again to pick up the finished file
- **Privacy**: Names are pseudonymized and SIS/section columns are blanked by default

### get-quiz-submission-events
The event trail for a single quiz attempt.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
  - `submissionId`: string — the quiz submission ID from `list-quiz-submissions`, not the user ID
- Optional parameters:
  - `attempt`: number (default: most recent)
- Returns answer-change history and page focus/blur events, with a `page_left_count` summary

### update-quiz-submission-score
Regrades a quiz attempt.
- Required parameters:
  - `courseId`: string
  - `quizId`: string
  - `submissionId`: string — the quiz submission ID, not the user ID
  - `attempt`: number
- Optional parameters (at least one required):
  - `fudgePoints`: number — points added to or subtracted from the total
  - `questions`: object keyed by question ID, e.g. `{ "1234": { "score": 2, "comment": "Accepted alternative phrasing" } }`
- Returns the updated score, kept score, and fudge points

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
