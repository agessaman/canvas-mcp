import { pseudonymFor, resetPseudonyms } from './pseudonyms.js';

export class DataAnonymizer {

  /**
   * Anonymize a user object (student only, preserves teacher/admin data)
   */
  static anonymizeUser(user: any, courseId?: unknown): any {
    if (!user || !user.id) return user;

    // Only anonymize if this is a student (no role specified means student context)
    // Teachers/admins typically have explicit roles in the data
    const userId = user.id.toString();
    const anonymizedName = pseudonymFor(courseId, userId);

    const anonymized: any = {
      ...user,
      name: anonymizedName,
      display_name: anonymizedName,
      short_name: anonymizedName,
      sortable_name: anonymizedName,
      email: user.email ? `student${userId}@example.com` : undefined,
    };
    // Strip fields that would re-identify an otherwise anonymized student.
    // (user.id / user_id are kept — they're needed to grade or comment.)
    delete anonymized.sis_user_id;
    delete anonymized.integration_id;
    delete anonymized.login_id;
    delete anonymized.avatar_url;
    delete anonymized.pronouns;
    return anonymized;
  }

  /**
   * Anonymize an array of users
   */
  static anonymizeUsers(users: any[], courseId?: unknown): any[] {
    if (!Array.isArray(users)) return users;
    return users.map(user => this.anonymizeUser(user, courseId));
  }

  /**
   * Anonymize submission data including user and comment authors
   */
  static anonymizeSubmission(submission: any, courseId?: unknown): any {
    if (!submission) return submission;

    const anonymized = { ...submission };

    // Anonymize the main user
    if (submission.user) {
      anonymized.user = this.anonymizeUser(submission.user, courseId);
    }

    // Anonymize comment authors (only students, preserve teacher comments)
    if (submission.submission_comments && Array.isArray(submission.submission_comments)) {
      anonymized.submission_comments = submission.submission_comments.map((comment: any) => {
        const commentCopy = { ...comment };
        
        // Only anonymize if the author is a student (not teacher/admin)
        if (comment.author && comment.author.role === 'student') {
          commentCopy.author = this.anonymizeUser(comment.author, courseId);
        }
        
        return commentCopy;
      });
    }

    return anonymized;
  }

  /**
   * Anonymize an array of submissions
   */
  static anonymizeSubmissions(submissions: any[], courseId?: unknown): any[] {
    if (!Array.isArray(submissions)) return submissions;
    return submissions.map(submission => this.anonymizeSubmission(submission, courseId));
  }

  /**
   * Anonymize assignment data that may include submission info
   */
  static anonymizeAssignment(assignment: any, courseId?: unknown): any {
    if (!assignment) return assignment;

    const anonymized = { ...assignment };

    // If assignment includes submission data
    if (assignment.submission) {
      anonymized.submission = this.anonymizeSubmission(assignment.submission, courseId);
    }

    return anonymized;
  }

  /**
   * Anonymize an array of assignments
   */
  static anonymizeAssignments(assignments: any[], courseId?: unknown): any[] {
    if (!Array.isArray(assignments)) return assignments;
    return assignments.map(assignment => this.anonymizeAssignment(assignment, courseId));
  }

  /**
   * The stable pseudonym for a user id, allocating one on first use.
   * Quiz results carry a bare user_id with no name to overwrite, so callers
   * need to look the label up rather than rewrite an object.
   *
   * Pass courseId wherever it is known: numbering is per course and persisted,
   * so the same student keeps the same label between runs.
   */
  static pseudonymFor(userId: any, courseId?: unknown): string {
    return pseudonymFor(courseId, userId);
  }

  /**
   * Anonymize quiz submissions. These carry user_id rather than a nested user,
   * and when include[]=user is requested the users arrive in a sibling array,
   * so anonymizeSubmission would leave both untouched.
   */
  static anonymizeQuizSubmissions(quizSubmissions: any[], courseId?: unknown): any[] {
    if (!Array.isArray(quizSubmissions)) return quizSubmissions;
    return quizSubmissions.map(qs => {
      if (!qs || qs.user_id === undefined || qs.user_id === null) return qs;
      return { ...qs, student: this.pseudonymFor(qs.user_id, courseId) };
    });
  }

  /**
   * Reset the anonymization state (useful for testing)
   */
  static reset(): void {
    resetPseudonyms();
  }
} 