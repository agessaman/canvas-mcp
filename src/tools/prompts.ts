import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";

export function registerPrompts(server: McpServer, _canvas: CanvasClient) {
  server.prompt(
    "analyze-rubric-statistics",
    "Analyze rubric statistics for formative assignments in a course",
    {
      courseName: z.string().describe("The name of the course to analyze")
    },
    ({ courseName }: { courseName: string }) => {
      const today = new Date().toISOString().split('T')[0];
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please analyze the rubric statistics for the course \"${courseName}\". Follow these steps:

1. First, use the list-courses tool to find the course ID for \"${courseName}\".

2. Then, use the list-assignments tool to get all assignments for this course.

3. For each formative assignment that has a due date before ${today}:
   - Use the get-rubric-statistics tool to get detailed statistics
   - Include the point distribution to create visualizations
   - Skip assignments with future due dates (after ${today})

4. Create and analyze two comprehensive visualizations that show all assignments together:
   a) Grouped Stacked Bar Chart:
      - X-axis: Criteria names
      - Y-axis: Percentage of students
      - Groups: One group of stacked bars per assignment
      - Bars: Stacked to show score distribution (0-4 points)
      - Colors: Consistent colors across assignments for each point value
      - Legend: Include both assignment names and point values
      
   b) Grouped Bar Chart:
      - X-axis: Criteria names
      - Y-axis: Average score
      - Groups: One bar per assignment for each criterion
      - Colors: Different color for each assignment
      - Include error bars showing standard deviation if available

5. Provide a summary of key insights based on:
   - Score distributions across criteria and assignments
   - Progression or patterns between assignments
   - Common areas of strength or difficulty across assignments
   - Notable trends or changes between assignments
   - Specific criteria that show consistent or varying performance

Please ensure all visualizations are clearly labeled with:
- Descriptive title (including analysis date: ${today})
- Axis labels
- Legend showing assignments and score levels
- Clear distinction between assignments
- Percentage or count indicators where appropriate`
            }
          }
        ]
      };
    }
  );

  server.prompt(
    "grade-assignment",
    "Grade an assignment's submissions with the teacher: read each student's work, draft rubric scores, and write grades and feedback only after approval",
    {
      course: z.string().describe("Course name or ID"),
      assignment: z.string().describe("Assignment name or ID")
    },
    ({ course, assignment }: { course: string; assignment: string }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Help me grade the assignment "${assignment}" in the course "${course}".

1. Find the IDs if I gave names: list-courses for the course, then list-assignments for the assignment.

2. Call get-grading-packet without a userId. Read its GRADING INSTRUCTIONS block and follow it for the whole session. Look over the description, the linked materials and the rubric.

3. Before reading any student work, ask me, together in one message:
   a. Whether anything the assignment depends on is missing (paper sources, a handout, a reading). Ask only if the packet suggests it.
   b. Whether I'll accept resubmissions for this assignment. Ask once; this decides "Revise ..." vs "Next time ..." in feedback.
   c. Whether I want feedback comments this time. The default is no feedback, just scores.
   Wait for my answers.

4. Calibrate on the first two students in the queue: read each with get-submission-content and show me your draft. For every criterion, give the rating, points and the evidence (a short quote or location in the work). Add the feedback text only if feedback is on. Adjust your approach to my corrections before going on.

5. Continue through the queue in batches of about five. For each student show: pseudonym, total, per-criterion ratings with one line of evidence, draft feedback if it's on, and any flag (unreadable file, link not fetched, possible missing materials, late). Ask me to approve, edit or skip each one.

6. Write only what I approved, with grade-submission: rubric scores via the rubric parameter, plus comment and rubric comments only when feedback is on and I approved that exact text. If the packet says post_manually is false, remind me before the first write that students will see grades right away.

7. Finish with a short summary: how many were graded, skipped and flagged, and the user_ids that still need attention.`
          }
        }
      ]
    })
  );
} 