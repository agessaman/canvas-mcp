import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "../canvasClient.js";
import { DataAnonymizer } from "../anonymizer.js";
import { ContentBlock, ImageBudget, extractFile, htmlToText } from "../submissionContent.js";
import {
  assignmentTerms,
  describeRubric,
  describeScheme,
  descriptionLinks,
  getCourseRoster,
  getSectionNames,
  gradingInstructions,
  needsGrading,
  readSubmissionContent,
  resolveGradingScheme,
  scanTemplateVariants,
  sectionsFor,
} from "../grading.js";
import { decisionOf, resolvePreferences } from "../gradingPreferences.js";
import { SOURCE_CHECK_NOTE, checkAgainstSources, fetchSources } from "../sourceCheck.js";
import { formatInZone, resolveCourseZone } from "../courseTime.js";
import { templateVariants } from "../documentSignals.js";

// What a packet can contain. The split exists because grading 30 students used
// to mean resending the instructions, the description, the whole rubric and the
// whole queue 30 times — four or five thousand tokens of identical text per
// student, before any of their work.
const PACKET_SECTIONS = ["instructions", "assignment", "rubric", "queue", "work"] as const;
type PacketSection = (typeof PACKET_SECTIONS)[number];

const FULL_PACKET: PacketSection[] = ["instructions", "assignment", "rubric", "queue"];
const WORK_ONLY: PacketSection[] = ["work"];

// Reading more than a handful of students in one call tends to blow the
// client's context before the grader has scored any of them.
const DEFAULT_MAX_USER_IDS = 5;
function maxUserIds(): number {
  const raw = Number(process.env.CANVAS_MAX_GRADING_BATCH);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_USER_IDS;
}

const DEFAULT_QUEUE_LIMIT = 50;

const MAX_LINKED_FILES = 5;

// Above this many students, a scan that downloads a file each is a long wait
// the caller did not ask for, so it stays opt-in rather than being turned on
// by the cross-check default.
const AUTO_SCAN_QUEUE_LIMIT = 60;

// Files and links the teacher put in the assignment description: handouts,
// readings, source documents. Canvas files are pulled in; other links are
// listed so the grader knows they exist.
async function linkedMaterials(canvas: CanvasClient, descriptionHtml: string, maxImages: number) {
  const blocks: ContentBlock[] = [];
  const materials: any[] = [];
  if (!descriptionHtml) return { blocks, materials };

  const fileIds = [...new Set([...descriptionHtml.matchAll(/\/files\/(\d+)/g)].map(m => m[1]))];
  const budget = new ImageBudget(maxImages);
  for (const id of fileIds.slice(0, MAX_LINKED_FILES)) {
    try {
      const info: any = await canvas.getFileInfo(id);
      const filename = info.display_name || info.filename || `file_${id}`;
      const { data, contentType } = await canvas.downloadUrl(info.url);
      const { summary, blocks: fileBlocks } = await extractFile(
        data, filename, info['content-type'] || contentType,
        { maxCharsPerFile: 30000, renderPdfPages: 'auto', maxPdfPagesToRender: 4, ocr: true }, budget
      );
      materials.push({ fileId: id, ...summary });
      if (fileBlocks.length) {
        blocks.push({ type: "text", text: `--- Assignment material · ${filename} ---` }, ...fileBlocks);
      }
    } catch (e: any) {
      materials.push({ fileId: id, status: "error", note: `Could not read linked file: ${e?.message ?? e}` });
    }
  }
  if (fileIds.length > MAX_LINKED_FILES) {
    materials.push({ note: `${fileIds.length - MAX_LINKED_FILES} more linked file(s) not read: ${fileIds.slice(MAX_LINKED_FILES).join(', ')}` });
  }

  const links = descriptionLinks(descriptionHtml);
  if (links.length) {
    materials.push({
      links,
      note: "Links in the description were not fetched. Pass sourceCheck: true to compare student work against them.",
    });
  }
  return { blocks, materials };
}

/**
 * What about this assignment bears on whether comparing classmates' work is
 * worth doing. Facts, not a recommendation: the teacher knows what they set,
 * and this exists so they are not asked blind.
 */
function crossCheckContext(assignment: any, queue: { late?: boolean }[]): string[] {
  const notes: string[] = [];
  const description = htmlToText(assignment?.description ?? '');
  if (assignment?.group_category_id) {
    notes.push('Canvas has this set up as a group assignment, so students sharing text may be the intended thing.');
  }
  if (/\b(partner|partners|group|groups|with a classmate|together|pair up)\b/i.test(description)) {
    notes.push('The description mentions working with a partner or a group, so shared text may be expected.');
  }
  if (/\b(your own words|individually|on your own|do not copy|no copying)\b/i.test(description)) {
    notes.push('The description asks for individual work or for students\' own words.');
  }
  if ((assignment?.submission_types ?? []).some((t: string) => t === 'online_quiz')) {
    notes.push('This is a quiz; shared answers to fixed questions are not evidence of anything.');
  }
  if (!notes.length) {
    notes.push('Nothing in the assignment says either way — whether matching text would mean anything here is the teacher\'s to judge.');
  }
  notes.push(`${queue.length} student(s) are waiting to be graded.`);
  return notes;
}

export function registerGradingTools(server: McpServer, canvas: CanvasClient) {
  // Tool: get-grading-packet
  server.tool(
    "get-grading-packet",
    "Start grading an assignment, then read each student's work. Call it ONCE with no userId to get the grading instructions, the teacher's recorded grading practices and the questions still open, the assignment with any rules it states, the course's letter-grade cutoffs and late policy, the rubric with the criterion and rating IDs grade-submission needs, and the queue of students to grade with the section each is in. After that, call it per student with userId (or userIds for up to 5 at once): those calls return only that student's work plus a one-line header, because the shared sections do not change between students and resending them costs thousands of tokens each time. Use `include` to override what comes back, scanTemplates to find out which version of a worksheet each student had, and sourceCheck to compare work against the pages the assignment links to. get-submission-content reads one student's work on its own, with more control over images and PDF rendering.",
    {
      courseId: z.string().describe("The ID of the course"),
      assignmentId: z.string().describe("The ID of the assignment"),
      userId: z.string().optional().describe("Read this student's submitted work (same output as get-submission-content)"),
      userIds: z.array(z.string()).optional().describe(`Read several students' work in one call, in the order given (max ${DEFAULT_MAX_USER_IDS})`),
      include: z.array(z.enum(PACKET_SECTIONS)).optional()
        .describe("Which sections to return. Default with no userId: instructions, assignment, rubric, queue. Default with a userId: work only, plus a one-line header naming the assignment, its points and the rubric criterion IDs."),
      queueLimit: z.number().int().min(1).max(500).default(DEFAULT_QUEUE_LIMIT).describe(`Maximum students listed in the grading queue (default: ${DEFAULT_QUEUE_LIMIT}); queue_truncated is set when there are more`),
      includeMaterials: z.boolean().default(true).describe("Read Canvas files linked in the assignment description, such as handouts and sources (default: true)"),
      anonymous: z.boolean().default(true).describe("Use pseudonyms for students. Pseudonyms are per course and stable across sessions: the same student keeps the same number. (default: true)"),
      scrubFirstNamesInBody: z.boolean().default(false).describe("Also redact bare first names from the roster in body text. Off by default, because course content is full of words that are also student names (a student whose name is also a historical figure's would erase that figure). Names on a \"Names:\" line are always redacted when anonymous."),
      includePartners: z.boolean().default(true).describe("Report classmates named on the work's \"Names:\"/\"Partner:\" line, with whether they submitted (default: true)"),
      crossCheck: z.boolean().optional().describe(`Look for whole passages that turn up in two students' work where neither named the other as a partner, with each student's section and submission time so same-class partners can be told from cross-section copying. Reported under integrity_signals as prompts for the teacher to look at, never as findings. Worksheet text and anything more than half the class wrote are excluded. Needs the submissions read, so it turns scanTemplates on by itself for queues of ${AUTO_SCAN_QUEUE_LIMIT} or fewer. LEAVE IT UNSET unless the teacher has said: whether it is worth running depends on what the assignment was, so an unset packet asks them for this assignment rather than deciding, and their answer is remembered against the assignment`),
      scanTemplates: z.boolean().optional().describe("With the queue, download one file per queued student to work out which version of the worksheet template each had, and return template_variants. Costs a download per student; results are cached per attempt, and students already read in this session are not refetched. Left unset, crossCheck turns this on for a queue that is not too long."),
      sourceCheck: z.boolean().default(false).describe("Fetch the web pages the assignment description links to and report the longest runs of consecutive words each student shares with them. Needs the submissions read (as scanTemplates does). Run lengths are reported; what counts as copying is the teacher's call (default: false)"),
      sourceUrls: z.array(z.string()).optional().describe("Extra pages to compare against, on top of the links in the description — the sources a worksheet names but does not link"),
      minMatchWords: z.number().int().min(8).max(100).optional().describe("Shortest run of consecutive words a source match has to reach to be reported. Leave it unset to report everything the detector can see and apply the teacher's own threshold when reading"),
    },
    { readOnlyHint: true },
    async ({ courseId, assignmentId, userId, userIds, include, queueLimit = DEFAULT_QUEUE_LIMIT, includeMaterials = true, anonymous = true, scrubFirstNamesInBody = false, includePartners = true, scanTemplates, crossCheck, sourceCheck = false, sourceUrls, minMatchWords }: {
      courseId: string;
      assignmentId: string;
      userId?: string;
      userIds?: string[];
      include?: PacketSection[];
      queueLimit?: number;
      includeMaterials?: boolean;
      anonymous?: boolean;
      scrubFirstNamesInBody?: boolean;
      includePartners?: boolean;
      scanTemplates?: boolean;
      crossCheck?: boolean;
      sourceCheck?: boolean;
      sourceUrls?: string[];
      minMatchWords?: number;
    }) => {
      try {
        const students = [...(userId ? [userId] : []), ...(userIds ?? [])]
          .filter((id, i, all) => all.indexOf(id) === i);
        const limit = maxUserIds();
        if (students.length > limit) {
          throw new Error(`Asked for ${students.length} students in one call; the limit is ${limit}. Split the batch, or raise CANVAS_MAX_GRADING_BATCH.`);
        }
        const wanted = new Set<PacketSection>(include ?? (students.length ? WORK_ONLY : FULL_PACKET));
        if (students.length === 0 && wanted.has("work")) {
          throw new Error("include asks for work, but no userId or userIds was given.");
        }

        const a: any = await canvas.getAssignment(courseId, assignmentId);
        const { timeZone, source: zoneSource } = await resolveCourseZone(canvas, courseId);
        const local = (iso: unknown) => formatInZone(iso, timeZone);
        const content: ContentBlock[] = [];

        if (wanted.has("instructions")) {
          content.push({ type: "text", text: gradingInstructions(resolvePreferences(courseId, assignmentId)) });
        }

        const summary: any = {};
        if (wanted.has("assignment")) {
          const descriptionText = htmlToText(a.description ?? '');
          summary.assignment = {
            id: a.id,
            name: a.name,
            points_possible: a.points_possible,
            grading_type: a.grading_type,
            due_at: a.due_at,
            ...(local(a.due_at) ? { due_at_local: local(a.due_at) } : {}),
            lock_at: a.lock_at,
            ...(local(a.lock_at) ? { lock_at_local: local(a.lock_at) } : {}),
            unlock_at: a.unlock_at,
            ...(local(a.unlock_at) ? { unlock_at_local: local(a.unlock_at) } : {}),
            submission_types: a.submission_types,
            // -1 means unlimited attempts in Canvas
            allowed_attempts: a.allowed_attempts,
            post_manually: !!a.post_manually,
            published: !!a.published,
          };
          summary.time_zone = { zone: timeZone, from: zoneSource };
          // What students were told, so a plan can be held against it.
          const terms = assignmentTerms(descriptionText);
          if (terms.length) {
            summary.assignment_terms = terms;
            summary.assignment_terms_note = "Rules the description states to students. Hold the plan against them, and say so before grading departs from what students were told.";
          }
          // The scale the letters in a plan must come from. Assuming a standard
          // one put a letter in a plan that the gradebook did not show.
          try {
            const scheme = await resolveGradingScheme(canvas, courseId, a);
            summary.grading_standard = describeScheme(scheme, a.points_possible);
          } catch {
            // A plan without cutoffs is still usable; a failed packet is not.
          }
          // The policy silently moves every score between the plan and Canvas.
          try {
            const policy: any = await canvas.getLatePolicy(courseId);
            summary.late_policy = policy?.late_policy ?? policy ?? null;
          } catch {
            summary.late_policy = null;
          }
          summary.late_policy_note = summary.late_policy?.late_submission_deduction_enabled
            ? "Late work is deducted automatically. grade-submission's dryRun shows what a score becomes after the deduction, and latePolicyStatus can clear or set the marker on one submission."
            : "No automatic late deduction is in force. If this changes mid-grading, a plan built now will price differently.";
          if (!a.published) {
            summary.warning = "This assignment is unpublished. Canvas won't accept grades until it's published; ask the teacher before publishing it.";
          }
        }
        if (wanted.has("rubric")) {
          summary.rubric = describeRubric(a);
          if (!a.rubric) {
            summary.rubric_note = "No rubric is attached. Grade with score/posted_grade, and ask the teacher for the criteria they want applied.";
          }
        }

        if (wanted.has("queue")) {
          const subs: any[] = await canvas.listAssignmentSubmissions(courseId, assignmentId, {}, { anonymous });
          const all = subs
            .filter(needsGrading)
            .sort((x, y) => String(x.submitted_at).localeCompare(String(y.submitted_at)));
          summary.counts = {
            students: subs.length,
            needs_grading: all.length,
            graded: subs.filter(s => s.workflow_state === 'graded' && s.grade_matches_current_submission !== false).length,
            not_submitted: subs.filter(s => !s.submitted_at && !s.excused).length,
            excused: subs.filter(s => s.excused).length,
          };
          // Sections come from Canvas, not from the period a student wrote on
          // the sheet: that was blank or written three different ways often
          // enough to be useless, and it decides how shared work is graded.
          const roster = await getCourseRoster(canvas, courseId);
          const sectionNames = await getSectionNames(canvas, courseId);
          const byUser = new Map(roster.map(m => [m.userId, m]));
          const sectionsOf = (id: unknown) => sectionsFor(byUser.get(String(id)), sectionNames);
          summary.queue = all.slice(0, queueLimit).map(s => {
            const sections = sectionsOf(s.user_id);
            return {
              user_id: s.user_id,
              student: anonymous ? DataAnonymizer.pseudonymFor(s.user_id, courseId) : undefined,
              ...(sections.length ? { sections } : {}),
              submitted_at: s.submitted_at,
              ...(local(s.submitted_at) ? { submitted_at_local: local(s.submitted_at) } : {}),
              attempt: s.attempt,
              late: s.late || false,
              ...(s.late_policy_status ? { late_policy_status: s.late_policy_status } : {}),
              ...(s.seconds_late ? { seconds_late: s.seconds_late } : {}),
              ...(s.grade_matches_current_submission === false ? { resubmitted_after_grading: true } : {}),
            };
          });
          if (all.length > queueLimit) {
            summary.queue_truncated = true;
            summary.queue_note = `Showing ${queueLimit} of ${all.length} students needing grading; raise queueLimit for the rest.`;
          }

          // Whether classmates' work should be compared turns on what the
          // assignment WAS. On partner research, matching text is the point.
          // On a worksheet with one right answer it means nothing. On an essay
          // it means everything. One answer cannot cover all three, so an
          // unset packet asks the teacher about THIS assignment instead of
          // deciding for them, and their answer is kept against the assignment
          // so they are asked once.
          const recorded = resolvePreferences(courseId, assignmentId).find(p => p.key === 'cross_check');
          const wantsCrossCheck = crossCheck ?? decisionOf(recorded?.answer);
          if (crossCheck === undefined && wantsCrossCheck === undefined) {
            summary.cross_check_decision = {
              question: "Compare these students' submissions against each other for passages they share?",
              asked_because: recorded?.answer
                ? `Nothing was decided: the answer on record for this assignment reads "${recorded.answer}", which is not a yes or a no — put it to the teacher again.`
                : 'Nothing is on record for this assignment, and it is not a decision this server makes on its own.',
              costs: `Reading ${summary.queue.length} submission(s), one download each.`,
              worth_weighing: crossCheckContext(a, summary.queue),
              examples: recorded?.examples ?? [],
              then: `Call this tool again with crossCheck: true or false, and save the answer with set-grading-preferences (courseId ${courseId}, assignmentId ${assignmentId}, answers: { cross_check: "<what the teacher said>" }) so this assignment does not ask twice.`,
            };
          }
          const needsRead = wantsCrossCheck === true || sourceCheck;
          let scan = scanTemplates;
          let autoScanNote: string | undefined;
          if (scan === undefined) {
            scan = needsRead && summary.queue.length <= AUTO_SCAN_QUEUE_LIMIT;
            if (needsRead && !scan) {
              autoScanNote = `The queue is longer than ${AUTO_SCAN_QUEUE_LIMIT} students, so the submissions were not read automatically. Pass scanTemplates: true to run the cross-check and source check over it.`;
            } else if (scan) {
              // A download per student is not free, and the caller asked for
              // the check rather than for the reading. Saying so is the
              // difference between a cost that was chosen and one that was
              // sprung.
              autoScanNote = `${summary.queue.length} submission(s) were read so the ${wantsCrossCheck === true ? 'cross-check' : 'source check'}${wantsCrossCheck === true && sourceCheck ? ' and source check' : ''} could run, which is a download each. Pass scanTemplates: false to skip it.`;
            }
          } else if (needsRead && !scan) {
            autoScanNote = "The cross-check and source check need the submissions read; scanTemplates: false turned that off, so neither ran.";
          }
          if (autoScanNote) summary.scan_note = autoScanNote;

          // The pages the assignment sends students to, fetched once for the
          // whole queue.
          let sources: Awaited<ReturnType<typeof fetchSources>> | undefined;
          if (sourceCheck && scan) {
            const links = [...descriptionLinks(a.description ?? ''), ...(sourceUrls ?? []).map(url => ({ url }))];
            if (links.length === 0) {
              summary.source_check_note = "sourceCheck was asked for, but the assignment description links to no web pages. Pass sourceUrls with the pages the worksheet names.";
            } else {
              sources = await fetchSources(links);
              summary.sources_read = sources.sources.map(s => ({ url: s.url, ...(s.label ? { label: s.label } : {}), chars: s.chars }));
              if (sources.failures.length) {
                summary.sources_failed = sources.failures;
                summary.sources_failed_note = "These pages were not compared against. A site that refuses an automated fetch often has the article at a different address than the one linked; the teacher can paste the right address into sourceUrls.";
              }
            }
          }

          if (scan) {
            const { shared_text, source_matches, ...rest } = await scanTemplateVariants(canvas, courseId, assignmentId, summary.queue, {
              anonymous,
              maxFileMB: 25,
              roster,
              crossCheck: wantsCrossCheck === true,
              sections: sectionNames,
              sources: sources?.sources,
              minMatchWords,
            });
            summary.template_scan = { ...rest, students: summary.queue.length };
            if (shared_text?.length) {
              summary.integrity_signals = shared_text;
              summary.integrity_signals_note = "Prompts to look closer, never findings. Each pair says whether the two share a section and who submitted first: two students in one class who did not name each other are usually partners who forgot, and two in different classes are a different conversation. A shared sentence most often means a shared web source; open the work before drawing any conclusion.";
            }
            if (source_matches?.length) {
              summary.source_matches = source_matches;
              summary.source_matches_note = SOURCE_CHECK_NOTE;
            }
          } else if (wantsCrossCheck === true && scanTemplates === false) {
            summary.cross_check_note = "The cross-check needs the submissions read, which scanTemplates: false turned off.";
          }

          const variants = templateVariants(String(a.id ?? assignmentId));
          if (variants) {
            summary.template_variants = variants;
            summary.template_variants_note = scan
              ? "Worksheet versions across the queued students scanned here, plus any read earlier in this session. A student with no readable document is counted in template_scan.skipped."
              : "Worksheet versions seen so far, from the students read in this session. Pass scanTemplates: true to read the rest of the queue.";
          }
        }

        if (Object.keys(summary).length) {
          content.push({ type: "text", text: JSON.stringify(summary) });
        }

        if (wanted.has("assignment")) {
          content.push({ type: "text", text: `--- Assignment description ---\n${htmlToText(a.description ?? '') || '(no description)'}` });
          if (includeMaterials) {
            const { blocks, materials } = await linkedMaterials(canvas, a.description ?? '', 6);
            if (materials.length) content.push({ type: "text", text: `--- Linked materials ---\n${JSON.stringify(materials)}` });
            content.push(...blocks);
          }
        }

        if (students.length) {
          // The header a work-only call still needs: which assignment, how many
          // points, and the criterion IDs grade-submission must be keyed by.
          if (!wanted.has("assignment") && !wanted.has("rubric")) {
            const criterionIds = (a.rubric ?? []).map((c: any) => `${c.id}=${c.description} (${c.points}pts)`).join('; ');
            content.push({
              type: "text",
              text: `Assignment ${a.id} "${a.name}" · ${a.points_possible} points · ${a.grading_type}`
                + (criterionIds ? ` · rubric criteria: ${criterionIds}` : ' · no rubric'),
            });
          }
          // Built once for the whole batch rather than per student.
          const roster = (anonymous || includePartners) ? await getCourseRoster(canvas, courseId) : [];
          const sectionNames = await getSectionNames(canvas, courseId);
          for (const id of students) {
            const sections = sectionsFor(roster.find(m => m.userId === String(id)), sectionNames);
            content.push({
              type: "text",
              text: `--- Student work · user ${id}${sections.length ? ` · ${sections.join(', ')}` : ''} ---`,
            });
            try {
              content.push(...await readSubmissionContent(canvas, courseId, assignmentId, id, {
                maxCharsPerFile: 60000, renderPdfPages: 'auto', maxPdfPagesToRender: 10, ocr: true,
                maxImages: 15, maxFileMB: 25, anonymous, scrubFirstNamesInBody, includePartners,
                roster, timeZone, sections: sectionNames,
              }));
            } catch (e: any) {
              // One unreadable student must not lose the rest of the batch.
              content.push({ type: "text", text: JSON.stringify({ user_id: id, error: e?.message ?? String(e) }) });
            }
          }
        }

        return { content };
      } catch (error: any) {
        if (error instanceof Error) {
          throw new Error(`Failed to build grading packet: ${error.message}`);
        }
        throw new Error('Failed to build grading packet: Unknown error');
      }
    }
  );
}
