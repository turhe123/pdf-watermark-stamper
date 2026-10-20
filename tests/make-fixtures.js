// Generates the fictional fixtures used by __demo and smoke.spec.js:
//   tests/fixtures/draft-service-agreement.pdf  3 page agreement between Harbor Legal Demo and Cedar Works
//   tests/fixtures/blue-circle-logo.png         256x256 transparent PNG with a blue circle (image mode)
//   tests/fixtures/encrypted.pdf                tiny PDF with an /Encrypt entry (unsupported message)
// Run: node tests/make-fixtures.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PDFDocument, StandardFonts, rgb } = require('../vendor/pdf-lib/pdf-lib.min.js');

const out = (name) => path.join(__dirname, 'fixtures', name);
const LETTER = [612, 792];

function wrap(text, font, size, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && line) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

async function agreement() {
  const doc = await PDFDocument.create();
  doc.setTitle('Draft Service Agreement');
  doc.setAuthor('Harbor Legal Demo');
  doc.setProducer('fixture generator');
  doc.setCreator('fixture generator');
  const fixed = new Date('2026-03-02T09:00:00Z');
  doc.setCreationDate(fixed);
  doc.setModificationDate(fixed);
  const serif = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const ink = rgb(0.12, 0.12, 0.14);
  const left = 72;
  const width = LETTER[0] - left * 2;

  const page = (heading, sections, n) => {
    const p = doc.addPage(LETTER);
    let y = LETTER[1] - 80;
    if (n === 1) {
      const title = 'Draft Service Agreement';
      p.drawText(title, { x: (LETTER[0] - bold.widthOfTextAtSize(title, 24)) / 2, y, size: 24, font: bold, color: ink });
      y -= 30;
      const sub = 'between Harbor Legal Demo and Cedar Works';
      p.drawText(sub, { x: (LETTER[0] - serif.widthOfTextAtSize(sub, 14)) / 2, y, size: 14, font: serif, color: ink });
      y -= 44;
    }
    p.drawText(heading, { x: left, y, size: 15, font: bold, color: ink });
    y -= 26;
    for (const [h, text] of sections) {
      p.drawText(h, { x: left, y, size: 12, font: bold, color: ink });
      y -= 18;
      for (const line of wrap(text, serif, 11.5, width)) { p.drawText(line, { x: left, y, size: 11.5, font: serif, color: ink }); y -= 16; }
      y -= 12;
    }
    const foot = `Draft Service Agreement · page ${n} of 3`;
    p.drawText(foot.replace('·', '-'), { x: left, y: 40, size: 9, font: serif, color: rgb(0.45, 0.45, 0.5) });
  };

  const scope = 'Cedar Works will provide workshop design, joinery and installation services for the reception area described in the attached schedule. Work starts on a date agreed in writing and follows the plan approved by both parties.';
  const fees = 'Harbor Legal Demo will pay the fees listed in the schedule within thirty days of each invoice. Materials bought for the project are invoiced at cost with no markup, and any change to the plan is priced before work on it begins.';
  const care = 'Each party keeps the other party\'s business information private and uses it only for this agreement. This duty continues for two years after the agreement ends, except for information that is already public.';
  const end = 'Either party may end this agreement with fourteen days written notice. Work completed before the end date is paid in full, and Cedar Works returns any keys, plans and samples within seven days.';

  page('1. Scope of services', [['1.1 Services', scope], ['1.2 Schedule', fees], ['1.3 Changes', scope]], 1);
  page('2. Fees and confidentiality', [['2.1 Payment', fees], ['2.2 Confidential information', care], ['2.3 Records', care], ['2.4 Taxes', fees]], 2);
  page('3. Term and signatures', [['3.1 Ending the agreement', end], ['3.2 Notices', end], ['3.3 Signatures', 'Signed for Harbor Legal Demo: ____________________     Signed for Cedar Works: ____________________']], 3);
  fs.writeFileSync(out('draft-service-agreement.pdf'), await doc.save({ useObjectStreams: false }));
}

// Minimal PNG encoder (RGBA, 8 bit) so the logo has a real alpha channel.
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function logo() {
  const size = 256, r = 110, c = size / 2;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const a = Math.max(0, Math.min(1, r - d + 0.5));
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = 37; raw[i + 1] = 99; raw[i + 2] = 235; raw[i + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(out('blue-circle-logo.png'), png);
}

function encrypted() {
  const pad = '0'.repeat(64);
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
    `<< /Filter /Standard /V 1 /R 2 /O <${pad}> /U <${pad}> /P -4 >>`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Encrypt 4 0 R /ID [<${pad.slice(0, 32)}> <${pad.slice(0, 32)}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(out('encrypted.pdf'), pdf, 'latin1');
}

agreement().then(() => { logo(); encrypted(); console.log('fixtures written'); });
