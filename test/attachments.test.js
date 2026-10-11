import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../backend/workspace.js';
import { AttachmentExtractor, attachmentLimits } from '../backend/attachments/extract.js';

function tinyPdf(text = 'Hello local PDF') {
  const stream = `BT /F1 18 Tf 20 90 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (let index = 0; index < objects.length; index++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index++) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

test('text and PDF attachments are extracted locally with provenance and page bounds', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-attachments-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs', 'notes.md'), '# Notes\nLocal attachment text.');
  await writeFile(path.join(root, 'docs', 'tiny.pdf'), tinyPdf());
  const extractor = new AttachmentExtractor(new Workspace(root));
  const text = await extractor.read('docs/notes.md'); assert.match(text.content, /Local attachment text/); assert.equal(text.mediaType, 'text/plain');
  const pdf = await extractor.read('docs/tiny.pdf'); assert.match(pdf.content, /Hello local PDF/); assert.equal(pdf.mediaType, 'application/pdf'); assert.equal(pdf.pages, 1); assert.equal(pdf.partial, false);
  assert.equal(attachmentLimits.maxPdfPages, 100); assert.ok(attachmentLimits.maxPdfBytes <= 10 * 1024 * 1024);
});

test('attachment extraction rejects unsupported types, binary text, invalid PDF and size limits', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-attachments-deny-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'picture.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(path.join(root, 'binary.txt'), Buffer.from([0x00, 0x01, 0x02]));
  await writeFile(path.join(root, 'invalid-utf8.txt'), Buffer.from([0xc3, 0x28]));
  await writeFile(path.join(root, 'fake.pdf'), 'not a pdf');
  await writeFile(path.join(os.tmpdir(), `agent-attachment-outside-${process.pid}.txt`), 'outside');
  let linked = false;
  try { await import('node:fs/promises').then(fs => fs.symlink(path.join(os.tmpdir(), `agent-attachment-outside-${process.pid}.txt`), path.join(root, 'linked.txt'))); linked = true; }
  catch (error) { if (error.code !== 'EPERM') throw error; }
  t.after(() => import('node:fs/promises').then(fs => fs.unlink(path.join(os.tmpdir(), `agent-attachment-outside-${process.pid}.txt`)).catch(() => {})));
  const extractor = new AttachmentExtractor(new Workspace(root));
  await assert.rejects(extractor.read('picture.png'), { code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
  await assert.rejects(extractor.read('binary.txt'), { code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
  await assert.rejects(extractor.read('invalid-utf8.txt'), { code: 'ATTACHMENT_ENCODING_INVALID' });
  if (linked) await assert.rejects(extractor.read('linked.txt'), /Symlinks/);
  await assert.rejects(extractor.read('fake.pdf'), { code: 'ATTACHMENT_FORMAT_INVALID' });
  const oversized = new AttachmentExtractor({ async resolve() { return path.join(root, 'big.pdf'); }, async info() { return { type: 'file', sizeBytes: 11 * 1024 * 1024 }; } });
  await assert.rejects(oversized.readPdf('big.pdf'), { code: 'ATTACHMENT_TOO_LARGE' });
  await assert.rejects(extractor.read('../outside.txt'), { code: 'WORKSPACE_ACCESS_DENIED' });
});

test('PDF parser timeout is bounded and parser resources are destroyed', async () => {
  let destroyed = false;
  const extractor = new AttachmentExtractor({ async resolve() { return 'mock.pdf'; }, async info() { return { type: 'file', sizeBytes: 5 }; } }, {
    timeoutMs: 10,
    readBytes: async () => Buffer.from('%PDF-'),
    pdfjs: { getDocument() { return { promise: new Promise(() => {}), async destroy() { destroyed = true; } }; } },
  });
  await assert.rejects(extractor.readPdf('mock.pdf'), { code: 'ATTACHMENT_PARSE_TIMEOUT' });
  assert.equal(destroyed, true);
});
