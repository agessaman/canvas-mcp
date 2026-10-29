// Turns submitted files into content an LLM can actually read: text for
// PDFs, Word documents, HTML and plain-text files, and image blocks for
// photos and for PDF pages with no text layer (scans, handwriting).
import { extractText, getDocumentProxy, renderPageAsImage } from 'unpdf';
import mammoth from 'mammoth';
import { isMac, macHeicToJpeg, macOcr, macPdfText } from './macNative.js';
import {
  IntegritySignal,
  findIntegritySignals,
  fingerprintFromHtml,
  fingerprintFromRepeatedLines,
  makeFingerprint,
} from './documentSignals.js';
import type { RedactionCounts } from './nameRedaction.js';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ExtractOptions {
  maxCharsPerFile: number;
  // 'auto' renders only PDF pages that have (almost) no text layer
  renderPdfPages: 'auto' | 'always' | 'never';
  maxPdfPagesToRender: number;
  // Run Vision OCR on scanned pages and photos (macOS only)
  ocr: boolean;
  // Read the first table's header row, to tell worksheet versions apart
  templateFingerprint?: boolean;
  // Flag copy/paste and chatbot artefacts worth a second look
  integritySignals?: boolean;
}

export interface FileSummary {
  filename: string;
  kind: string;
  status: 'extracted' | 'partial' | 'unsupported' | 'error';
  pages?: number;
  chars?: number;
  truncated?: boolean;
  images?: number;
  text_source?: 'pdfkit' | 'pdf.js';
  ocr_pages?: number[];
  note?: string;
  // Set when a file needed @napi-rs/canvas and it wasn't installed, so the
  // warning reaches the grader only on the calls it actually affected.
  needs_canvas?: boolean;
  // Prompts to look closer, never findings. See documentSignals.ts.
  integrity_signals?: IntegritySignal[];
  template_fingerprint?: string;
  template_headers?: string;
  // How much anonymization this file needed, and what it couldn't resolve.
  redactions?: RedactionCounts;
}

// Shared across every file in one response so a stack of photos can't
// blow the client's context.
export class ImageBudget {
  constructor(public remaining: number) {}
  take(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining--;
    return true;
  }
}

// Long edge Claude downsamples to anyway; larger images only cost tokens.
const MAX_IMAGE_EDGE = 1568;
// MCP clients commonly reject image blocks over ~5 MB.
const MAX_RAW_IMAGE_BYTES = 4.5 * 1024 * 1024;
// Fewer characters than this on a PDF page means it's a scan or handwriting.
const SCANNED_PAGE_CHARS = 40;

const DIRECT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'csv', 'tsv', 'json', 'xml', 'rtf', 'py', 'js', 'ts', 'java', 'c', 'cpp', 'h',
  'cs', 'rb', 'go', 'rs', 'swift', 'kt', 'sql', 'r', 'm', 'sh', 'css', 'yml', 'yaml',
]);

let canvasModule: Promise<any | null> | undefined;
// @napi-rs/canvas is an optional native dependency; everything degrades to
// text-only when it isn't installed.
function loadCanvas(): Promise<any | null> {
  if (!canvasModule) {
    canvasModule = import('@napi-rs/canvas').catch(() => null);
  }
  return canvasModule;
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

export function classifyFile(filename: string, contentType: string = ''): string {
  const ext = extensionOf(filename);
  const ct = contentType.toLowerCase().split(';')[0].trim();
  if (ext === 'pdf' || ct === 'application/pdf') return 'pdf';
  if (ext === 'docx' || ct === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (ext === 'html' || ext === 'htm' || ct === 'text/html') return 'html';
  if (ct.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'tif', 'tiff', 'bmp'].includes(ext)) return 'image';
  if (ct.startsWith('text/') || TEXT_EXTENSIONS.has(ext)) return 'text';
  if (ext === 'doc') return 'doc';
  if (ext === 'pptx' || ext === 'ppt') return 'presentation';
  if (ext === 'xlsx' || ext === 'xls') return 'spreadsheet';
  if (ct.startsWith('audio/') || ct.startsWith('video/')) return 'media';
  return 'other';
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + `\n[... truncated ${text.length - max} characters ...]`, truncated: true };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', deg: '°',
};

export function htmlToText(html: string): string {
  if (!html) return '';
  let s = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<img\b[^>]*>/gi, tag => {
      const alt = /\balt="([^"]*)"/i.exec(tag)?.[1];
      return `[image${alt ? `: ${alt}` : ''}]`;
    })
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
      const label = inner.replace(/<[^>]+>/g, '').trim();
      return label && label !== href ? `${label} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<\/(p|div|h[1-6]|tr|table|blockquote|pre|section|ul|ol)>/gi, '\n')
    .replace(/<(p|div|h[1-6]|tr|table|blockquote|pre|section)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = s
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
  return s
    .split('\n')
    .map(line => line.replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\|\s*$/, '').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Downscale (and convert HEIC/TIFF/BMP where the decoder allows) to a JPEG
// Claude can read. Returns null when the image can't be made usable.
async function prepareImage(
  buf: Buffer,
  contentType: string,
  filename = '',
  flags?: { needsCanvas: boolean },
): Promise<{ data: Buffer; mimeType: string } | null> {
  let ct = contentType.toLowerCase().split(';')[0].trim();
  if (ct === 'image/heic' || ct === 'image/heif' || /\.hei[cf]$/i.test(filename)) {
    const jpeg = await macHeicToJpeg(buf);
    if (!jpeg) return null;
    buf = jpeg;
    ct = 'image/jpeg';
  }
  const canvasLib = await loadCanvas();
  if (canvasLib) {
    try {
      const img = await canvasLib.loadImage(buf);
      const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.width, img.height));
      if (scale === 1 && DIRECT_IMAGE_TYPES.has(ct) && buf.length <= MAX_RAW_IMAGE_BYTES) {
        return { data: buf, mimeType: ct };
      }
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = canvasLib.createCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      return { data: await c.encode('jpeg', 85), mimeType: 'image/jpeg' };
    } catch {
      // Fall through: the decoder couldn't read it (e.g. HEIC)
    }
  }
  if (DIRECT_IMAGE_TYPES.has(ct) && buf.length <= MAX_RAW_IMAGE_BYTES) {
    return { data: buf, mimeType: ct };
  }
  // Too large to send as-is, or in a format only the decoder can open.
  if (flags && !canvasLib) flags.needsCanvas = true;
  return null;
}

// Two text runs further apart than this sit in different table cells. PDF
// points, so roughly a wide character at 12pt.
const CELL_GAP = 12;
// A header row needs this many cells before it is one rather than a sentence
// the extractor happened to split.
const MIN_HEADER_CELLS = 3;

/**
 * The first table row on page 1, rebuilt from positioned text.
 *
 * Used when a PDF is a single page, where there is no second page for a
 * repeated header to be compared against. pdf.js gives each run of text an
 * x/y, so a row is the runs sharing a baseline and a cell is a group of runs
 * with no wide gap between them. A title or a sentence comes back as one or
 * two cells and is rejected; a worksheet's header row comes back as three or
 * more.
 */
async function firstTableRowFromLayout(proxy: any): Promise<string | undefined> {
  try {
    const page = await proxy.getPage(1);
    const content = await page.getTextContent();
    type Run = { x: number; y: number; width: number; str: string };
    const runs: Run[] = (content.items ?? [])
      .filter((it: any) => typeof it.str === 'string' && it.str.trim())
      .map((it: any) => ({ x: it.transform[4], y: it.transform[5], width: it.width ?? 0, str: it.str.trim() }));
    if (runs.length === 0) return undefined;

    // Group into rows by baseline, top of the page first.
    const rows = new Map<number, Run[]>();
    for (const run of runs) {
      const key = Math.round(run.y);
      const row = rows.get(key);
      if (row) row.push(run);
      else rows.set(key, [run]);
    }

    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      const row = rows.get(y)!.sort((a: Run, b: Run) => a.x - b.x);
      const cells: string[] = [];
      let current = '';
      let cursor = -Infinity;
      for (const run of row) {
        if (current && run.x - cursor > CELL_GAP) {
          cells.push(current.trim());
          current = '';
        }
        current += (current ? ' ' : '') + run.str;
        cursor = run.x + run.width;
      }
      if (current.trim()) cells.push(current.trim());
      if (cells.length >= MIN_HEADER_CELLS) return cells.join(' | ');
    }
  } catch {
    // A PDF whose layout can't be read still has its text; no fingerprint.
  }
  return undefined;
}

/** Attach the optional "look closer" fields, when the caller asked for them. */
function addSignals(summary: FileSummary, text: string, opts: ExtractOptions, html?: string): void {
  if (opts.integritySignals !== false) {
    const signals = findIntegritySignals(text);
    if (signals.length) summary.integrity_signals = signals;
  }
  if (opts.templateFingerprint !== false && html) {
    const fp = fingerprintFromHtml(html);
    if (fp) Object.assign(summary, fp);
  }
}

async function extractPdf(buf: Buffer, filename: string, opts: ExtractOptions, budget: ImageBudget) {
  const blocks: ContentBlock[] = [];
  const notes: string[] = [];
  // pdf.js gets its own copy because it detaches the buffer it is handed
  let proxy: any;
  const pdfjs = async () => (proxy ??= await getDocumentProxy(new Uint8Array(buf)));

  // PDFKit reflows wrapped lines into paragraphs; pdf.js keeps visual breaks
  let pages = await macPdfText(buf);
  const textSource = pages ? 'pdfkit' : 'pdf.js';
  if (!pages) pages = (await extractText(await pdfjs(), { mergePages: false })).text;
  const totalPages = pages.length;

  const sparse = new Set<number>();
  pages.forEach((t, i) => {
    if (t.replace(/\s+/g, '').length < SCANNED_PAGE_CHARS) sparse.add(i + 1);
  });
  const toRender = pages
    .map((_t, i) => i + 1)
    .filter(page => opts.renderPdfPages === 'always' || (opts.renderPdfPages === 'auto' && sparse.has(page)));

  const rendered: { page: number; data: Buffer; mimeType: string }[] = [];
  let needsCanvas = false;
  if (toRender.length > 0) {
    const canvasLib = await loadCanvas();
    if (!canvasLib) {
      needsCanvas = true;
      notes.push(`Pages ${toRender.join(', ')} were not rendered as images: install @napi-rs/canvas to enable page rendering.`);
    } else {
      for (const [idx, page] of toRender.entries()) {
        if (rendered.length >= opts.maxPdfPagesToRender) {
          notes.push(`Rendered ${rendered.length} page(s); stopped at maxPdfPagesToRender. Unrendered: ${toRender.slice(idx).join(', ')}.`);
          break;
        }
        if (!budget.take()) {
          notes.push(`Image limit for this response reached; pages not rendered from ${page} on.`);
          break;
        }
        try {
          const png = await renderPageAsImage(await pdfjs(), page, {
            canvasImport: () => import('@napi-rs/canvas'),
            width: 1400,
          });
          const img = await prepareImage(Buffer.from(png), 'image/png');
          if (img) rendered.push({ page, ...img });
          else budget.remaining++;
        } catch (e: any) {
          budget.remaining++;
          notes.push(`Page ${page} could not be rendered: ${e?.message ?? e}`);
        }
      }
    }
  }

  // OCR only the pages that had no text layer of their own
  const ocrByPage = new Map<number, string>();
  const ocrTargets = opts.ocr ? rendered.filter(r => sparse.has(r.page)) : [];
  if (ocrTargets.length > 0) {
    const results = await macOcr(ocrTargets.map(r => r.data));
    if (results) {
      ocrTargets.forEach((r, i) => {
        const text = results[i]?.trim();
        if (text) ocrByPage.set(r.page, text);
      });
    } else if (isMac) {
      notes.push('Vision OCR failed; scanned pages are available as images only.');
    }
  }

  const body = pages
    .map((t, i) => {
      const page = i + 1;
      const ocr = ocrByPage.get(page);
      if (ocr) return `[Page ${page}] (scanned; OCR text, check it against the page image)\n${ocr}`;
      return `[Page ${page}]\n${t.trim() || '(no text layer on this page)'}`;
    })
    .join('\n\n');
  const { text, truncated } = truncate(body, opts.maxCharsPerFile);
  blocks.push({ type: 'text', text });
  for (const r of rendered) {
    blocks.push({ type: 'text', text: `[Image of ${filename}, page ${r.page}]` });
    blocks.push({ type: 'image', data: r.data.toString('base64'), mimeType: r.mimeType });
  }

  const unreadable = [...sparse].filter(p => !ocrByPage.has(p) && !rendered.some(r => r.page === p));
  const summary: FileSummary = {
    filename,
    kind: 'pdf',
    status: unreadable.length ? 'partial' : 'extracted',
    pages: totalPages,
    chars: body.length,
    truncated,
    images: rendered.length,
    text_source: textSource,
    ...(ocrByPage.size ? { ocr_pages: [...ocrByPage.keys()] } : {}),
    ...(needsCanvas ? { needs_canvas: true } : {}),
    ...(notes.length ? { note: notes.join(' ') } : {}),
  };
  addSignals(summary, body, opts);
  // A PDF has no table markup, so the worksheet version is inferred: from the
  // header row Google Docs repeats on every page, or — on a one-page sheet,
  // where there is nothing to repeat — from the laid-out first table row.
  if (opts.templateFingerprint !== false) {
    const fp = fingerprintFromRepeatedLines(pages)
      ?? makeFingerprint((await firstTableRowFromLayout(await pdfjs()).catch(() => undefined)) ?? '');
    if (fp) Object.assign(summary, fp);
  }
  return { summary, blocks };
}

/**
 * Convert one downloaded file into readable content blocks.
 */
export async function extractFile(
  buf: Buffer,
  filename: string,
  contentType: string,
  opts: ExtractOptions,
  budget: ImageBudget,
): Promise<{ summary: FileSummary; blocks: ContentBlock[] }> {
  const kind = classifyFile(filename, contentType);
  try {
    switch (kind) {
      case 'pdf':
        return await extractPdf(buf, filename, opts, budget);
      case 'docx': {
        const result = await mammoth.extractRawText({ buffer: buf });
        const raw = result.value.replace(/\n{3,}/g, '\n\n').trim();
        const { text, truncated } = truncate(raw, opts.maxCharsPerFile);
        // extractRawText flattens tables, so the header row that identifies a
        // worksheet version needs the HTML conversion. Only the first table is
        // read, and only when fingerprinting is on.
        let html: string | undefined;
        if (opts.templateFingerprint !== false) {
          html = await mammoth.convertToHtml({ buffer: buf }).then(r => r.value).catch(() => undefined);
        }
        const summary: FileSummary = { filename, kind, status: 'extracted', chars: raw.length, truncated, note: 'Images, drawings and comments inside the document are not included.' };
        addSignals(summary, raw, opts, html);
        return { summary, blocks: [{ type: 'text', text }] };
      }
      case 'html':
      case 'text': {
        const decoded = buf.toString('utf-8');
        const raw = kind === 'html' ? htmlToText(decoded) : decoded;
        const { text, truncated } = truncate(raw, opts.maxCharsPerFile);
        const summary: FileSummary = { filename, kind, status: 'extracted', chars: raw.length, truncated };
        addSignals(summary, raw, opts, kind === 'html' ? decoded : undefined);
        return { summary, blocks: [{ type: 'text', text }] };
      }
      case 'image': {
        if (!budget.take()) {
          return { summary: { filename, kind, status: 'unsupported', note: 'Image limit for this response reached; request this attempt or file separately.' }, blocks: [] };
        }
        const flags = { needsCanvas: false };
        const img = await prepareImage(buf, contentType, filename, flags);
        if (!img) {
          budget.remaining++;
          return {
            summary: {
              filename, kind, status: 'unsupported',
              ...(flags.needsCanvas ? { needs_canvas: true } : {}),
              note: 'Image format could not be decoded (HEIC needs macOS; TIFF/BMP need @napi-rs/canvas) or is too large.',
            },
            blocks: [],
          };
        }
        const blocks: ContentBlock[] = [];
        const ocr = opts.ocr ? (await macOcr([img.data]))?.[0]?.trim() : undefined;
        if (ocr) {
          blocks.push({ type: 'text', text: `[OCR text from photo; check it against the image]\n${truncate(ocr, opts.maxCharsPerFile).text}` });
        }
        blocks.push({ type: 'image', data: img.data.toString('base64'), mimeType: img.mimeType });
        return {
          summary: { filename, kind, status: 'extracted', images: 1, ...(ocr ? { chars: ocr.length } : {}) },
          blocks,
        };
      }
      case 'doc':
        return { summary: { filename, kind, status: 'unsupported', note: 'Legacy .doc files are not supported; ask the student for .docx or PDF.' }, blocks: [] };
      default:
        return { summary: { filename, kind, status: 'unsupported', note: `No text extractor for ${kind} files yet.` }, blocks: [] };
    }
  } catch (e: any) {
    return { summary: { filename, kind, status: 'error', note: `Extraction failed: ${e?.message ?? e}` }, blocks: [] };
  }
}

// --- Reading one file for the document tools ---

/** Extracted text is truncated here; the tool descriptions quote this number. */
export const TOOL_TEXT_LIMIT = 60000;
/** Above this, base64 is more context than any client can use. */
export const TOOL_BASE64_LIMIT_BYTES = 5 * 1024 * 1024;

export interface ToolFileContent {
  kind: string;
  content_encoding: 'text' | 'base64';
  content?: string;
  truncated?: boolean;
  chars?: number;
  pages?: number;
  note?: string;
  error?: string;
  integrity_signals?: IntegritySignal[];
  template_fingerprint?: string;
}

function asBase64(buf: Buffer, kind: string, note?: string): ToolFileContent {
  if (buf.length > TOOL_BASE64_LIMIT_BYTES) {
    return {
      kind,
      content_encoding: 'base64',
      error: `File is ${(buf.length / 1048576).toFixed(1)} MB, over the ${(TOOL_BASE64_LIMIT_BYTES / 1048576).toFixed(0)} MB base64 limit. Call again without forceBase64 to get extracted text instead.`,
      ...(note ? { note } : {}),
    };
  }
  return { kind, content_encoding: 'base64', content: buf.toString('base64'), ...(note ? { note } : {}) };
}

/**
 * What the document tools hand back for one file: extracted text by default,
 * base64 only when the caller asks for it or nothing can read the file.
 * Images are not returned here — get-submission-content renders those.
 */
export async function extractFileForTool(
  buf: Buffer,
  filename: string,
  contentType: string,
  options: { forceBase64?: boolean; maxChars?: number } = {},
): Promise<ToolFileContent> {
  const kind = classifyFile(filename, contentType);
  const maxChars = options.maxChars ?? TOOL_TEXT_LIMIT;
  if (options.forceBase64) return asBase64(buf, kind);

  // No text to extract: hand back the bytes rather than an empty answer.
  if (kind === 'image' || kind === 'media') {
    return asBase64(buf, kind, `${kind === 'image' ? 'Images' : 'Media'} are returned as bytes here; use get-submission-content to read them.`);
  }

  const { summary, blocks } = await extractFile(
    buf, filename, contentType,
    { maxCharsPerFile: maxChars, renderPdfPages: 'never', maxPdfPagesToRender: 0, ocr: false },
    new ImageBudget(0),
  );
  const text = blocks.filter(b => b.type === 'text').map(b => (b as any).text).join('\n\n');
  if (summary.status === 'unsupported' || summary.status === 'error' || !text.trim()) {
    // Nothing readable came out, so send the bytes and say why.
    return asBase64(buf, kind, summary.note ?? `No text could be extracted from this ${kind} file.`);
  }
  // A scan has a text layer in name only. These tools do not render or OCR,
  // so say where that work can be done rather than returning page headers.
  const note = summary.status === 'partial'
    ? `${summary.note ? `${summary.note} ` : ''}Some pages have no text layer (a scan or handwriting). Use get-submission-content to read them as images, with OCR on macOS.`
    : summary.note;
  return {
    kind,
    content_encoding: 'text',
    content: text,
    ...(summary.truncated ? { truncated: true } : {}),
    ...(summary.chars !== undefined ? { chars: summary.chars } : {}),
    ...(summary.pages !== undefined ? { pages: summary.pages } : {}),
    ...(note ? { note } : {}),
    ...(summary.integrity_signals ? { integrity_signals: summary.integrity_signals } : {}),
    // The fingerprint only; the header text itself is document text, and
    // these tools have no name redaction to put it through.
    ...(summary.template_fingerprint ? { template_fingerprint: summary.template_fingerprint } : {}),
  };
}
