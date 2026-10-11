import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cs', '.go', '.rs', '.sql', '.toml', '.ini']);
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_PDF_PAGES = 100;
const MAX_EXTRACTED_CHARS = 80_000;
const PARSE_TIMEOUT_MS = 10_000;

export class AttachmentExtractor {
  constructor(workspace, { pdfjs = null, timeoutMs = PARSE_TIMEOUT_MS, readBytes = null } = {}) { this.workspace = workspace; this.pdfjs = pdfjs; this.timeoutMs = timeoutMs; this.readBytes = readBytes; }

  async read(relativePath) {
    const extension = path.extname(relativePath).toLowerCase();
    if (extension !== '.pdf') {
      if (!TEXT_EXTENSIONS.has(extension)) throw Object.assign(new Error('Unsupported attachment type; choose UTF-8 text or PDF'), { code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
      const attachment = await this.workspace.readTextAttachment(relativePath, { maxBytes: 512 * 1024, maxChars: MAX_EXTRACTED_CHARS });
      return { ...attachment, mediaType: 'text/plain', pages: null, partial: false };
    }
    return this.readPdf(relativePath);
  }

  async readBuffer(name, bytes) {
    if (typeof name !== 'string' || !name.trim() || name.length > 255) throw Object.assign(new Error('Attachment file name is invalid'), { code: 'ATTACHMENT_NAME_INVALID' });
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw Object.assign(new Error('Attachment data is invalid'), { code: 'ATTACHMENT_DATA_INVALID' });
    const safeName = path.basename(name.replace(/[\\/]+/g, path.sep));
    const extension = path.extname(safeName).toLowerCase();
    const data = Buffer.from(bytes);
    if (extension === '.pdf') return this.parsePdf(safeName, data);
    if (!TEXT_EXTENSIONS.has(extension)) throw Object.assign(new Error('Unsupported attachment type; choose UTF-8 text or PDF'), { code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
    if (data.length > 512 * 1024) throw Object.assign(new Error('Text attachment exceeds 512 KiB'), { code: 'ATTACHMENT_TOO_LARGE' });
    if (data.includes(0)) throw Object.assign(new Error('Binary data cannot be attached as text'), { code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { throw Object.assign(new Error('Text attachment must be valid UTF-8'), { code: 'ATTACHMENT_ENCODING_INVALID' }); }
    if (content.length > MAX_EXTRACTED_CHARS) throw Object.assign(new Error('Text attachment exceeds 80,000 characters'), { code: 'ATTACHMENT_TOO_LARGE' });
    return { path: safeName, sizeBytes: data.length, content, mediaType: 'text/plain', pages: null, partial: false };
  }

  async readPdf(relativePath) {
    const absolute = await this.workspace.resolve(relativePath);
    const info = await this.workspace.info(relativePath);
    if (info.type !== 'file') throw Object.assign(new Error('PDF attachment must be a regular file'), { code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
    if (info.sizeBytes > MAX_PDF_BYTES) throw Object.assign(new Error('PDF exceeds 10 MiB'), { code: 'ATTACHMENT_TOO_LARGE' });
    const bytes = this.readBytes ? await this.readBytes(absolute) : await import('node:fs/promises').then(fs => fs.readFile(absolute));
    return this.parsePdf(relativePath, bytes);
  }

  async parsePdf(displayName, bytes) {
    if (bytes.length > MAX_PDF_BYTES) throw Object.assign(new Error('PDF exceeds 10 MiB'), { code: 'ATTACHMENT_TOO_LARGE' });
    if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw Object.assign(new Error('File does not have a PDF signature'), { code: 'ATTACHMENT_FORMAT_INVALID' });
    const pdfjs = this.pdfjs ?? await import('pdfjs-dist/legacy/build/pdf.mjs');
    const packageRoot = path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
    const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, stopAtErrors: true,
      standardFontDataUrl: `${packageRoot}/standard_fonts/`, cMapUrl: `${packageRoot}/cmaps/`, cMapPacked: true });
    let timer;
    let document = null;
    try {
      const operation = (async () => {
        document = await loading.promise;
        if (!Number.isSafeInteger(document.numPages) || document.numPages < 1) throw Object.assign(new Error('PDF has no readable pages'), { code: 'ATTACHMENT_FORMAT_INVALID' });
        const pageCount = Math.min(document.numPages, MAX_PDF_PAGES); const parts = []; let total = 0; let partial = document.numPages > pageCount;
        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
          const page = await document.getPage(pageNumber); const content = await page.getTextContent();
          const text = content.items.map(item => typeof item.str === 'string' ? item.str : '').join(' ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
          const piece = `\n[Page ${pageNumber}]\n${text}`;
          if (total + piece.length > MAX_EXTRACTED_CHARS) { partial = true; break; }
          parts.push(piece); total += piece.length;
        }
        return { path: displayName, sizeBytes: bytes.length, content: parts.join('\n'), mediaType: 'application/pdf', pages: pageCount, partial };
      })();
      return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('PDF parsing timed out'), { code: 'ATTACHMENT_PARSE_TIMEOUT' })), this.timeoutMs); timer.unref?.(); })]);
    } catch (error) {
      await document?.destroy?.().catch(() => {}); await loading.destroy().catch(() => {});
      if (error.code) throw error;
      throw Object.assign(new Error('PDF could not be parsed as local text'), { code: 'ATTACHMENT_PARSE_FAILED' });
    } finally { clearTimeout(timer); }
  }
}

export const attachmentLimits = Object.freeze({ maxTextBytes: 512 * 1024, maxPdfBytes: MAX_PDF_BYTES, maxPdfPages: MAX_PDF_PAGES, maxExtractedChars: MAX_EXTRACTED_CHARS, timeoutMs: PARSE_TIMEOUT_MS, pdf: true, image: false, audio: false });
