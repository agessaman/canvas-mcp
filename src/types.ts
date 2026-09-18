export interface CanvasConfig {
  apiToken: string;
  baseUrl: string;
  // New Quizzes item bank tools reach a private Instructure service rather than
  // the Canvas API, so they are off unless the operator asks for them. See
  // src/newQuizzesLti.ts.
  enableItemBanks: boolean;
}

/**
 * Whether the New Quizzes item bank tools are switched on.
 *
 * Read from the environment in two places — index.ts, to decide whether to
 * register them, and newQuizzes.ts, so the note on a bank-backed quiz item can
 * point at `list-item-banks` when it exists and at the Canvas UI when it does
 * not. One function rather than two copies of the regex, because the two must
 * never disagree: a note telling a reader to call a tool that was never
 * registered is worse than no note.
 */
export function itemBanksEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.CANVAS_ENABLE_ITEM_BANKS ?? "");
}

export interface Term {
  id: number;
  name: string;
  start_at?: string;
  end_at?: string;
}

export interface Course {
  id: number;
  name: string;
  course_code: string;
  workflow_state: string;
  term?: Term;
}

export interface Rubric {
  id: string;
  title: string;
  description?: string;
}

export interface RubricStat {
  id: string;
  description: string;
  points_possible: number;
  total_assessments: number;
  average_score: number;
  median_score: number;
  min_score: number;
  max_score: number;
  point_distribution?: { [key: number]: number };
}

export interface CanvasFile {
  id: string;
  filename: string;
  display_name: string;
  content_type: string;
  size: number;
  url: string;
  created_at: string;
  updated_at: string;
}

export interface SubmissionAttachment extends CanvasFile {
  submission_id?: string;
}

export interface Submission {
  id: string;
  user_id: string;
  assignment_id: string;
  body?: string; // For text submissions
  submission_type: 'online_text_entry' | 'online_upload' | 'online_url' | 'media_recording' | null;
  workflow_state: string;
  grade?: string;
  score?: number;
  submitted_at?: string;
  attachments?: SubmissionAttachment[];
  submission_comments?: any[];
  attempt?: number;
}

export interface SubmissionDocumentResult {
  submission: Submission;
  attachments: SubmissionAttachment[];
  textSubmission: string | null;
  submissionType: string | null;
  downloadedFiles: DownloadedFile[];
}

export interface DownloadedFile {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  data?: any; // Raw binary data
  dataBase64?: string; // Base64 encoded data for JSON serialization
  error?: string; // If download failed
}
