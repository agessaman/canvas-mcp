// macOS-only extraction through the system frameworks, driven by JXA
// (`osascript -l JavaScript`) so nothing needs compiling or installing.
// PDFKit reflows wrapped lines better than pdf.js, and Vision OCR gives
// scanned pages a cheap text layer. Every function returns null off macOS
// or on failure, and callers fall back to the cross-platform path.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const PDF_TEXT_SCRIPT = `
ObjC.import('PDFKit');
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) return 'null';
  const pages = [];
  for (let i = 0; i < doc.pageCount; i++) {
    const s = doc.pageAtIndex(i).string;
    pages.push(s && !s.isNil() ? s.js : '');
  }
  return JSON.stringify(pages);
}`;

const OCR_SCRIPT = `
ObjC.import('Vision');
function run(argv) {
  const out = [];
  for (const p of argv) {
    const handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(p), $());
    const req = $.VNRecognizeTextRequest.alloc.init;
    req.recognitionLevel = 0; // accurate
    req.usesLanguageCorrection = true;
    if (!handler.performRequestsError($([req]), null)) { out.push(null); continue; }
    const lines = [];
    const results = req.results;
    for (let i = 0; i < results.count; i++) {
      const cand = results.objectAtIndex(i).topCandidates(1);
      if (cand.count) lines.push(cand.objectAtIndex(0).string.js);
    }
    out.push(lines.join('\\n'));
  }
  return JSON.stringify(out);
}`;

export const isMac = process.platform === 'darwin';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-mcp-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runJxa(script: string, args: string[], timeoutMs: number): Promise<any> {
  const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, ...args], {
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim());
}

/** Per-page text from PDFKit, or null if unavailable or unreadable. */
export async function macPdfText(pdf: Buffer): Promise<string[] | null> {
  if (!isMac) return null;
  try {
    return await withTempDir(async dir => {
      const path = join(dir, 'doc.pdf');
      await writeFile(path, pdf);
      const pages = await runJxa(PDF_TEXT_SCRIPT, [path], 60_000);
      return Array.isArray(pages) ? pages : null;
    });
  } catch {
    return null;
  }
}

/**
 * Vision OCR for a batch of images in one osascript call. Returns one entry
 * per image (null where recognition failed), or null if OCR is unavailable.
 */
export async function macOcr(images: Buffer[]): Promise<(string | null)[] | null> {
  if (!isMac || images.length === 0) return null;
  try {
    return await withTempDir(async dir => {
      const paths = await Promise.all(images.map(async (img, i) => {
        const path = join(dir, `img${i}.jpg`);
        await writeFile(path, img);
        return path;
      }));
      // The first call after boot loads Vision's models and can take ~1 min
      const results = await runJxa(OCR_SCRIPT, paths, 180_000);
      return Array.isArray(results) && results.length === images.length ? results : null;
    });
  } catch {
    return null;
  }
}

/** iPhone photos arrive as HEIC, which Skia can't decode; `sips` can. */
export async function macHeicToJpeg(heic: Buffer): Promise<Buffer | null> {
  if (!isMac) return null;
  try {
    return await withTempDir(async dir => {
      const input = join(dir, 'in.heic');
      const output = join(dir, 'out.jpg');
      await writeFile(input, heic);
      await run('/usr/bin/sips', ['-s', 'format', 'jpeg', input, '--out', output], { timeout: 60_000 });
      return await readFile(output);
    });
  } catch {
    return null;
  }
}
