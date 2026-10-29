// A stand-in course for the grading tools: a roster with invented names, an
// assignment with a rubric, a queue, and submissions whose attachments the
// mock Canvas actually serves.
//
// Every name here is invented. Nothing in this repository's tests, fixtures or
// history may carry a real student's name.

/** Minimal single-page PDF with a real text layer, so no PDF writer is needed. */
export function makeTextPdf(lines, padBytes = 0) {
  const content = 'BT /F1 12 Tf 72 720 Td 14 TL\n'
    + lines.map(l => `(${l.replace(/[()\\]/g, '\\$&')}) Tj T*`).join('\n')
    + '\nET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  // Padding object: makes a file of a given size without touching its text.
  if (padBytes > 0) objects.push(`<< /Pad (${'x'.repeat(padBytes)}) >>`);

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/**
 * A PDF whose text is laid out in columns, so pdf.js reports distinct x
 * positions on a shared baseline — what a real worksheet's table looks like to
 * an extractor. `pages` repeats the header row on every page, the way Google
 * Docs exports a table that spans pages.
 */
export function makeTablePdf({ headers, rows = [], pages = 1, title = null, directions = null }) {
  const columnX = headers.map((_, i) => 72 + i * 140);
  const pageContent = [];
  for (let page = 0; page < pages; page++) {
    const ops = ['BT /F1 11 Tf'];
    let y = 720;
    if (title && page === 0) {
      ops.push(`1 0 0 1 72 ${y} Tm (${esc(title)}) Tj`);
      y -= 24;
    }
    // The teacher's instructions, on their own line as a real export has them.
    if (directions && page === 0) {
      ops.push(`1 0 0 1 72 ${y} Tm (${esc(directions)}) Tj`);
      y -= 24;
    }
    // The header row, repeated on every page.
    headers.forEach((h, i) => ops.push(`1 0 0 1 ${columnX[i]} ${y} Tm (${esc(h)}) Tj`));
    y -= 18;
    for (const row of (typeof rows === 'function' ? rows(page) : rows)) {
      row.forEach((cell, i) => ops.push(`1 0 0 1 ${columnX[i]} ${y} Tm (${esc(String(cell))}) Tj`));
      y -= 18;
    }
    ops.push('ET');
    pageContent.push(ops.join('\n'));
  }
  return buildPdf(pageContent);
}

function esc(s) {
  return String(s).replace(/[()\\]/g, '\\$&');
}

/** Assemble a PDF from one content stream per page. */
function buildPdf(pageStreams) {
  const pageCount = pageStreams.length;
  const objects = [];
  // 1 catalog, 2 pages, 3..(2+n) page objects, then one content stream each,
  // then the font.
  const pageIds = pageStreams.map((_, i) => 3 + i);
  const contentIds = pageStreams.map((_, i) => 3 + pageCount + i);
  const fontId = 3 + pageCount * 2;
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`);
  pageIds.forEach((_, i) => objects.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`
  ));
  pageStreams.forEach(stream => objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// Section 1 is the submitter's class; section 2 is another period, so a name
// that is unique in section 1 but shared across the course still resolves.
const inSection = (id, ...sections) => ({ enrollments: sections.map(s => ({ course_section_id: s, type: 'StudentEnrollment' })) });

export const ROSTER = [
  { id: 101, name: 'Avery Nolan', short_name: 'Avery', sortable_name: 'Nolan, Avery', ...inSection(101, 1) },
  { id: 102, name: 'Jordan Tate', short_name: 'Jordan', sortable_name: 'Tate, Jordan', ...inSection(102, 1) },
  { id: 103, name: 'Casey Lin', short_name: 'Casey', sortable_name: 'Lin, Casey', ...inSection(103, 1) },
  { id: 104, name: 'Riley Okafor', short_name: 'Riley', sortable_name: 'Okafor, Riley', ...inSection(104, 1) },
  { id: 105, name: 'Henry Bowen', short_name: 'Henry', sortable_name: 'Bowen, Henry', ...inSection(105, 1) },
  { id: 106, name: 'Morgan Devi', short_name: 'Morgan', sortable_name: 'Devi, Morgan', ...inSection(106, 2) },
];

/** Every real name in the roster, for "did anything leak?" assertions. */
export const REAL_NAMES = ROSTER.flatMap(u => u.name.split(' '));

export const RUBRIC = [
  {
    id: '_crit1', description: 'Evidence', points: 15,
    ratings: [
      { id: '_r1a', description: 'Full', points: 15 },
      { id: '_r1b', description: 'Partial', points: 8 },
      { id: '_r1c', description: 'None', points: 0 },
    ],
  },
  {
    id: '_crit2', description: 'Analysis', points: 10,
    ratings: [
      { id: '_r2a', description: 'Strong', points: 10 },
      { id: '_r2b', description: 'Thin', points: 5 },
    ],
  },
];

export function assignment(over = {}) {
  return {
    id: 777,
    name: 'Exploration Worksheet',
    points_possible: 25,
    grading_type: 'letter_grade',
    due_at: '2026-10-27T05:00:00Z',
    lock_at: '2026-11-03T07:59:00Z',
    unlock_at: '2026-10-20T07:00:00Z',
    submission_types: ['online_upload'],
    allowed_attempts: -1,
    post_manually: false,
    published: true,
    description: '<p>Answer every question on the worksheet.</p>',
    rubric: RUBRIC,
    rubric_settings: { title: 'Worksheet Rubric', points_possible: 25 },
    use_rubric_for_grading: true,
    ...over,
  };
}

export function course(over = {}) {
  return { id: 1, name: 'World History', time_zone: 'America/Los_Angeles', account_id: 9, ...over };
}

/**
 * A worksheet as an HTML upload: a header row that identifies the template
 * version, then the name line and the student's answers. HTML keeps the tests
 * off the system PDF frameworks, which are slow to warm up and have nothing to
 * do with what is being asserted.
 */
export function worksheetHtml(nameLine, body = [], headers = ['Question', 'Evidence', 'Analysis']) {
  return Buffer.from(
    '<html><body>'
    + `<table><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>`
    + '<tr><td>1</td><td>Ships sailed south.</td><td>Trade routes shifted.</td></tr></table>'
    + `<p>${nameLine}</p>`
    + body.map(line => `<p>${line}</p>`).join('')
    + '</body></html>',
    'utf-8',
  );
}

/** A submission with one attachment the mock will serve. */
export function submission(userId, over = {}) {
  const user = ROSTER.find(u => u.id === userId);
  return {
    id: 5000 + userId,
    user_id: userId,
    user,
    assignment_id: 777,
    workflow_state: 'submitted',
    submitted_at: '2026-10-26T21:14:00Z',
    attempt: 1,
    late: false,
    missing: false,
    excused: false,
    score: null,
    grade: null,
    submission_type: 'online_upload',
    attachments: [],
    ...over,
  };
}

export function attachment(baseUrl, id, filename, size, contentType = 'application/pdf') {
  return {
    id,
    display_name: filename,
    filename,
    'content-type': contentType,
    size,
    url: `${baseUrl}/download/${id}`,
    created_at: '2026-10-26T21:14:00Z',
  };
}

/**
 * Route one mock Canvas request. `files` maps an attachment id to its bytes.
 * Anything unrouted comes back as an empty object, which is what an unused
 * Canvas endpoint looks like to this server.
 */
export function router({ baseUrl, files = {}, assignment: a = assignment(), course: c = course(), submissions = {}, queue = null, gradingStandard = null, roster = ROSTER }) {
  return ({ url, method }) => {
    const path = url.split('?')[0];
    const download = /^\/download\/(\d+)$/.exec(path);
    if (download) {
      const file = files[download[1]];
      return file
        ? { __buffer: file.bytes, __contentType: file.contentType ?? 'application/pdf' }
        : { __status: 404, __body: { errors: [{ message: 'no such file' }] } };
    }
    if (/^\/api\/v1\/courses\/\d+\/users$/.test(path)) return roster;
    if (/^\/api\/v1\/courses\/\d+\/grading_standards\/\d+$/.test(path)) return gradingStandard ?? { __status: 404, __body: { errors: [] } };
    if (/^\/api\/v1\/courses\/\d+\/assignments\/\d+\/submissions\/\d+$/.test(path)) {
      const uid = path.split('/').pop();
      return submissions[uid] ?? { __status: 404, __body: { errors: [{ message: 'not found' }] } };
    }
    if (/^\/api\/v1\/courses\/\d+\/assignments\/\d+\/submissions$/.test(path)) {
      return queue ?? Object.values(submissions);
    }
    if (/^\/api\/v1\/courses\/\d+\/assignments\/\d+$/.test(path)) return a;
    if (/^\/api\/v1\/accounts\/\d+$/.test(path)) return { id: 9, default_time_zone: 'America/New_York' };
    if (/^\/api\/v1\/courses\/\d+$/.test(path)) return c;
    if (/^\/api\/v1\/files\/\d+$/.test(path)) {
      const id = path.split('/').pop();
      const file = files[id];
      return {
        id: Number(id),
        display_name: file?.filename ?? `file_${id}.pdf`,
        filename: file?.filename ?? `file_${id}.pdf`,
        'content-type': file?.contentType ?? 'application/pdf',
        size: file?.bytes?.length ?? 0,
        url: `${baseUrl}/download/${id}`,
      };
    }
    if (method !== 'GET') return { id: 1 };
    return {};
  };
}

/** The JSON header block readSubmissionContent puts first. */
export function headerOf(result) {
  return JSON.parse(result.content[0].text);
}

/** Every text block of a tool result, joined. */
export function textOf(result) {
  return (result.content ?? []).map(p => p.text ?? '').join('\n');
}
