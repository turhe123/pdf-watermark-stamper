// worker.js — reads and stamps the PDF off the main thread (classic worker, pdf-lib from vendor/).
// Messages in:  { id, type: 'inspect', bytes }                   -> { id, type: 'inspected', pages: [{ w, h, rot }] }
//               { id, type: 'stamp', bytes, opts, image, pages } -> progress events, then { id, type: 'done', bytes, stamped }
// Errors:       { id, type: 'error', kind: 'encrypted' | 'invalid' | 'encoding' | 'other', message }
importScripts('vendor/pdf-lib/pdf-lib.min.js', 'geometry.js');
const { PDFDocument, StandardFonts, rgb, degrees } = self.PDFLib;
const { normRotation, centers, toUser, origin } = self.WMGeometry;

const FONTS = { helvetica: StandardFonts.HelveticaBold, times: StandardFonts.TimesRomanBold, courier: StandardFonts.CourierBold };

const fail = (kind, message) => Object.assign(new Error(message), { kind });

async function load(bytes) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    const name = (err && (err.name || err.constructor?.name)) || '';
    if (/Encrypt/i.test(name) || /encrypt/i.test(String(err && err.message))) throw fail('encrypted', 'encrypted');
    throw fail('invalid', String((err && err.message) || err));
  }
}

// Visible page geometry: the crop box, with width and height swapped when the page is turned sideways.
function geometry(page) {
  const box = page.getCropBox();
  const rot = normRotation(page.getRotation().angle);
  const sideways = rot === 90 || rot === 270;
  return { box, rot, w: sideways ? box.height : box.width, h: sideways ? box.width : box.height };
}

function hexColor(hex) {
  const n = parseInt(String(hex || '#dc2626').slice(1), 16) || 0;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// pdf-lib appends the drawing as a new content stream at the end of /Contents (painted last, on top).
// For "under content" that stream moves to the front, so the original page paints over the stamp.
function moveStampUnder(page) {
  const ref = page.contentStreamRef;
  const contents = page.node.Contents();
  if (!ref || !contents || typeof contents.indexOf !== 'function') return;
  const i = contents.indexOf(ref);
  if (i <= 0) return;
  contents.remove(i);
  contents.insert(0, ref);
}

async function stamp({ bytes, opts, image, pages: targets }, progress) {
  const doc = await load(bytes);
  const all = doc.getPages();
  const opacity = Math.max(0, Math.min(1, opts.opacity));
  let font = null;
  let embedded = null;
  let textW = 0;
  let textH = 0;
  if (opts.mode === 'image') {
    if (!image) throw fail('other', 'Choose a PNG or JPG image first.');
    embedded = image.kind === 'png' ? await doc.embedPng(image.bytes) : await doc.embedJpg(image.bytes);
  } else {
    font = await doc.embedFont(FONTS[opts.font] || FONTS.helvetica);
    try { font.encodeText(opts.text); } catch { throw fail('encoding', 'The standard PDF fonts cannot draw some of these characters.'); }
    textW = font.widthOfTextAtSize(opts.text, opts.size);
    textH = font.heightAtSize(opts.size, { descender: false });
  }
  const color = hexColor(opts.color);
  let done = 0;
  for (const index of targets) {
    const page = all[index];
    if (!page) continue;
    const geo = geometry(page);
    let w = textW;
    let h = textH;
    if (embedded) {
      w = (geo.w * opts.scale) / 100;
      h = (w * embedded.height) / embedded.width;
    }
    const angle = opts.rotation + geo.rot; // the page turns its content clockwise by /Rotate on screen
    for (const c of centers({ W: geo.w, H: geo.h, w, h, angle: opts.rotation, tiled: opts.position === 'tiled' })) {
      const o = origin(toUser(c, geo.box, geo.rot), w, h, angle);
      if (embedded) page.drawImage(embedded, { x: o.x, y: o.y, width: w, height: h, opacity, rotate: degrees(angle) });
      else page.drawText(opts.text, { x: o.x, y: o.y, size: opts.size, font, color, opacity, rotate: degrees(angle) });
    }
    if (opts.layer === 'under') moveStampUnder(page);
    done += 1;
    progress(done / targets.length);
  }
  const out = await doc.save();
  return { bytes: out, stamped: done, total: all.length };
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === 'inspect') {
      const doc = await load(e.data.bytes);
      const pages = doc.getPages().map((p) => { const g = geometry(p); return { w: g.w, h: g.h, rot: g.rot }; });
      if (!pages.length) throw fail('invalid', 'This PDF has no pages.');
      self.postMessage({ id, type: 'inspected', pages });
    } else if (type === 'stamp') {
      const res = await stamp(e.data, (ratio) => self.postMessage({ id, type: 'progress', ratio }));
      self.postMessage({ id, type: 'done', ...res }, [res.bytes.buffer]);
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', kind: err.kind || 'other', message: String((err && err.message) || err) });
  }
};
