export interface CanvasConfig {
  apiToken: string;
  baseUrl: string;
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

export interface RubricRating {
  id?: string;
  description: string;
  long_description?: string;
  points: number;
}

// One entry of a rubric's `data` array as returned by the Rubrics API
export interface RubricCriterion {
  id: string;
  description: string;
  long_description?: string;
  points: number;
  criterion_use_range?: boolean;
  learning_outcome_id?: string | number;
  mastery_points?: number;
  ignore_for_scoring?: boolean;
  ratings: RubricRating[];
}

export interface OutcomeRating {
  description: string;
  points: number;
}

export interface Outcome {
  id: number;
  title: string;
  display_name?: string;
  description?: string;
  vendor_guid?: string;
  context_type?: string;
  context_id?: number;
  points_possible?: number;
  mastery_points?: number;
  calculation_method?: string;
  calculation_int?: number;
  ratings?: OutcomeRating[];
  // Set when an account or course mastery scale overrides the outcome's own
  // ratings and calculation (only present on course-scoped "full" listings)
  proficiency_context_type?: string;
  proficiency_context_id?: string;
  can_edit?: boolean;
  assessed?: boolean;
}

export interface OutcomeGroup {
  id: number;
  title: string;
  description?: string;
  parent_outcome_group?: { id: number; title: string };
}

export interface OutcomeLink {
  outcome_group: OutcomeGroup;
  outcome: Outcome;
  assessed?: boolean;
  can_unlink?: boolean;
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
  folder_id?: number;
  locked?: boolean;
  hidden?: boolean;
}

export interface CanvasFolder {
  id: number;
  name: string;
  full_name: string;
  parent_folder_id: number | null;
  files_count: number;
  folders_count: number;
  position?: number;
  locked?: boolean;
  hidden?: boolean;
  hidden_for_user?: boolean;
  locked_for_user?: boolean;
  for_submissions?: boolean;
  created_at?: string;
  updated_at?: string;
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
