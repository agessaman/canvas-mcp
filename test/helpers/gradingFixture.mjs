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

export const ROSTER = [
  { id: 101, name: 'Avery Nolan', short_name: 'Avery', sortable_name: 'Nolan, Avery' },
  { id: 102, name: 'Jordan Tate', short_name: 'Jordan', sortable_name: 'Tate, Jordan' },
  { id: 103, name: 'Casey Lin', short_name: 'Casey', sortable_name: 'Lin, Casey' },
  { id: 104, name: 'Riley Okafor', short_name: 'Riley', sortable_name: 'Okafor, Riley' },
  { id: 105, name: 'Henry Bowen', short_name: 'Henry', sortable_name: 'Bowen, Henry' },
  { id: 106, name: 'Morgan Devi', short_name: 'Morgan', sortable_name: 'Devi, Morgan' },
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
