// app.js — PDF Watermark Stamper. Everything runs on this device: the PDF is read and stamped in worker.js
// with pdf-lib; the preview is a schematic page drawn on a canvas with the same placement math (geometry.js).
import { toast, downloadBlob, formatBytes, wireDropzone } from './site.js';
import './geometry.js';

const { centers, parseRange } = self.WMGeometry;
const $ = (id) => document.getElementById(id);

const zone = $('dropzone');
const input = $('file-input');
const results = $('results');
const workspace = $('workspace');
const progress = $('progress');
const canvas = $('preview');
const applyBtn = $('apply');
const ctl = {
  text: $('wm-text'), font: $('wm-font'), size: $('wm-size'), color: $('wm-color'),
  image: $('wm-image'), scale: $('wm-scale'), opacity: $('wm-opacity'), rotation: $('wm-rotation'),
  position: $('wm-position'), layer: $('wm-layer'), pages: $('wm-pages'),
};

const MAX_IMAGE_SIDE = 2000;
const CANVAS_FONTS = {
  helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  times: '"Times New Roman", Times, "Liberation Serif", serif',
  courier: '"Courier New", Courier, "Liberation Mono", monospace',
};

const state = {
  file: null, bytes: null, pages: [], view: 0,
  image: null, // { bytes, kind: 'png' | 'jpg', bitmap, width, height, name }
  output: null, // { blob, name }
  busy: false,
};

// ---------- worker ----------
let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker('worker.js');
  worker.onmessage = (e) => {
    const job = pending.get(e.data.id);
    if (!job) return;
    if (e.data.type === 'progress') { job.onProgress?.(e.data.ratio); return; }
    pending.delete(e.data.id);
    if (e.data.type === 'error') job.reject(Object.assign(new Error(e.data.message), { kind: e.data.kind }));
    else job.resolve(e.data);
  };
  worker.onerror = (e) => {
    e.preventDefault();
    for (const job of pending.values()) job.reject(new Error(e.message || 'The PDF worker stopped unexpectedly.'));
    pending.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

function run(message, onProgress, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, ...message }, transfer);
  });
}

// ---------- messages ----------
function clearAlerts() { results.querySelectorAll('.alert').forEach((el) => el.remove()); }

function showError(message) {
  const el = document.createElement('div');
  el.className = 'alert alert--error';
  el.setAttribute('role', 'alert');
  el.textContent = message;
  results.prepend(el);
  el.scrollIntoView({ block: 'nearest' });
}

function setProgress(ratio) {
  const pct = Math.floor(Math.max(0, Math.min(1, ratio)) * 100); // floor: 99.9% is not 100%
  progress.firstElementChild.style.width = `${pct}%`;
  progress.setAttribute('aria-valuenow', String(pct));
}

const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const baseName = (name) => name.replace(/\.pdf$/i, '') || 'document';
const outputName = () => `${baseName(state.file ? state.file.name : 'document.pdf')}_watermarked.pdf`;

// ---------- loading the PDF ----------
async function handleFiles(files) {
  results.replaceChildren();
  state.output = null;
  const pdfs = files.filter(isPdf);
  const others = files.filter((f) => !isPdf(f));
  if (!pdfs.length) {
    showError(`${others.map((f) => f.name).join(', ')} ${others.length === 1 ? 'is not a PDF' : 'are not PDFs'}. Choose a PDF file to stamp.`);
    return;
  }
  await loadPdf(pdfs[0]);
  if (others.length) showError(`Skipped ${others.map((f) => f.name).join(', ')}: only PDF files can be stamped.`);
  if (pdfs.length > 1) showError(`One PDF at a time: using ${pdfs[0].name}, skipped ${pdfs.slice(1).map((f) => f.name).join(', ')}.`);
}

async function loadPdf(file) {
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); } catch { showError(`${file.name} could not be read.`); return false; }
  try {
    const { pages } = await run({ type: 'inspect', bytes: bytes.slice() });
    state.file = file;
    state.bytes = bytes;
    state.pages = pages;
    state.view = 0;
  } catch (err) {
    if (err.kind === 'encrypted') showError(`${file.name} is encrypted or password protected, which is not supported. Remove the protection in the app that made it, then try again.`);
    else showError(`${file.name} could not be opened as a PDF. It may be damaged or not really a PDF.`);
    return false;
  }
  workspace.hidden = false;
  $('empty-state').hidden = true;
  zone.classList.add('dropzone--compact');
  $('dropzone-title').innerHTML = '';
  $('dropzone-title').append(`${file.name} · ${state.pages.length} page${state.pages.length === 1 ? '' : 's'} · ${formatBytes(file.size)} `);
  const change = document.createElement('span');
  change.className = 'link';
  change.textContent = 'choose another PDF';
  $('dropzone-title').append(change);
  updateRangeHint();
  schedulePreview();
  return true;
}

// ---------- options ----------
const mode = () => (document.querySelector('input[name="mode"]:checked') || {}).value || 'text';

function options() {
  return {
    mode: mode(),
    text: ctl.text.value.trim(),
    font: ctl.font.value,
    size: Math.max(6, Math.min(400, Number(ctl.size.value) || 64)),
    color: ctl.color.value,
    scale: Number(ctl.scale.value),
    opacity: Number(ctl.opacity.value) / 100,
    rotation: Number(ctl.rotation.value),
    position: ctl.position.value,
    layer: ctl.layer.value,
  };
}

// Characters the standard PDF fonts (WinAnsi encoding) can draw.
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const isLatin = (text) => [...text].every((ch) => { const c = ch.codePointAt(0); return (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || WIN_ANSI_EXTRA.includes(ch); });

function targetPages() {
  return parseRange(ctl.pages.value, state.pages.length);
}

function updateRangeHint() {
  const hint = $('wm-pages-hint');
  if (!state.pages.length) return;
  try {
    const list = targetPages();
    const n = state.pages.length;
    hint.textContent = list.length === n ? `All ${n} page${n === 1 ? '' : 's'}` : `${list.length} of ${n} pages: ${list.map((i) => i + 1).join(', ')}`;
    hint.classList.remove('wm-hint--error');
    ctl.pages.removeAttribute('aria-invalid');
  } catch (err) {
    hint.textContent = err.message;
    hint.classList.add('wm-hint--error');
    ctl.pages.setAttribute('aria-invalid', 'true');
  }
}

function syncOutputs() {
  $('wm-opacity-out').textContent = `${ctl.opacity.value}%`;
  $('wm-rotation-out').textContent = `${ctl.rotation.value}°`;
  $('wm-scale-out').textContent = `${ctl.scale.value}%`;
  const m = mode();
  $('text-opts').hidden = m !== 'text';
  $('image-opts').hidden = m !== 'image';
  $('latin-warning').hidden = m !== 'text' || isLatin(ctl.text.value);
}

// ---------- text measurement (same fonts as the PDF, so the preview matches the output) ----------
const measureFonts = {};
let measureDoc = null;
async function pdfFont(key) {
  if (!measureFonts[key]) {
    const { PDFDocument, StandardFonts } = window.PDFLib;
    measureDoc = measureDoc || PDFDocument.create();
    const names = { helvetica: StandardFonts.HelveticaBold, times: StandardFonts.TimesRomanBold, courier: StandardFonts.CourierBold };
    measureFonts[key] = measureDoc.then((doc) => doc.embedFont(names[key] || names.helvetica));
  }
  return measureFonts[key];
}

async function textBox(o) {
  const font = await pdfFont(o.font);
  let w;
  try { w = font.widthOfTextAtSize(o.text, o.size); } catch { w = o.text.length * o.size * 0.6; }
  return { w, h: font.heightAtSize(o.size, { descender: false }) };
}

// ---------- preview ----------
let previewQueued = false;
function schedulePreview() {
  syncOutputs();
  updateRangeHint();
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(() => { previewQueued = false; drawPreview(); });
}

// Pseudo text lines so the schematic page looks like a document.
function drawSchematic(ctx, x, y, w, h, s) {
  ctx.fillStyle = '#d5d8e0';
  const left = x + 50 * s;
  const width = w - 100 * s;
  let ly = y + 70 * s;
  ctx.fillRect(left + width * 0.2, ly, width * 0.6, 12 * s);
  ly += 40 * s;
  let k = 0;
  while (ly < y + h - 60 * s) {
    const para = k % 7 === 6;
    const lw = para ? width * 0.55 : width * (0.82 + ((k * 37) % 17) / 100);
    ctx.fillRect(left, ly, Math.min(width, lw), 6 * s);
    ly += (para ? 30 : 16) * s;
    k += 1;
  }
}

async function drawPreview() {
  if (!state.pages.length) return;
  const page = state.pages[state.view];
  const o = options();
  const wrap = canvas.parentElement;
  const maxW = Math.max(160, Math.min(wrap.clientWidth - 26, 440));
  const maxH = 520;
  const s = Math.min(maxW / page.w, maxH / page.h);
  const cssW = Math.round(page.w * s);
  const cssH = Math.round(page.h * s);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cssW, cssH);
  drawSchematic(ctx, 0, 0, cssW, cssH, s);

  let inRange = true;
  try { inRange = targetPages().includes(state.view); } catch { inRange = false; }
  $('page-indicator').textContent = `Page ${state.view + 1} / ${state.pages.length}`;
  $('prev-page').disabled = state.view === 0;
  $('next-page').disabled = state.view >= state.pages.length - 1;

  let stamp = null;
  if (o.mode === 'text' && o.text) {
    const { w, h } = await textBox(o);
    stamp = { w, h };
  } else if (o.mode === 'image' && state.image) {
    const w = (page.w * o.scale) / 100;
    stamp = { w, h: (w * state.image.height) / state.image.width };
  }

  const caption = $('preview-caption');
  canvas.dataset.stamped = String(Boolean(stamp && inRange));
  canvas.dataset.mode = o.mode;
  canvas.dataset.angle = String(o.rotation);
  canvas.dataset.opacity = String(o.opacity);
  if (!stamp) {
    caption.textContent = o.mode === 'image' ? 'Choose a PNG or JPG image to see it on the page.' : 'Type a watermark text to see it on the page.';
    return;
  }
  if (!inRange) {
    caption.textContent = `Page ${state.view + 1} is not in the page range, so it stays unmarked.`;
    return;
  }

  const spots = centers({ W: page.w, H: page.h, w: stamp.w, h: stamp.h, angle: o.rotation, tiled: o.position === 'tiled' });
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, cssW, cssH);
  ctx.clip();
  ctx.globalAlpha = o.opacity;
  for (const c of spots) {
    ctx.save();
    ctx.translate(c.x * s, cssH - c.y * s); // PDF y goes up, canvas y goes down
    ctx.rotate((-o.rotation * Math.PI) / 180);
    if (o.mode === 'image') {
      ctx.drawImage(state.image.bitmap, (-stamp.w / 2) * s, (-stamp.h / 2) * s, stamp.w * s, stamp.h * s);
    } else {
      ctx.font = `bold ${o.size * s}px ${CANVAS_FONTS[o.font]}`;
      ctx.fillStyle = o.color;
      ctx.textBaseline = 'alphabetic';
      const drawn = ctx.measureText(o.text).width || 1;
      ctx.scale((stamp.w * s) / drawn, 1); // match the PDF font's measured width
      ctx.fillText(o.text, (-drawn / 2), (stamp.h / 2) * s);
    }
    ctx.restore();
  }
  ctx.restore();
  const what = o.mode === 'image' ? 'Image' : `"${o.text}"`;
  const where = o.position === 'tiled' ? `tiled ${spots.length} times` : 'centered';
  caption.textContent = `${what} · ${o.rotation}° · ${Math.round(o.opacity * 100)}% opacity · ${where} · ${o.layer === 'under' ? 'under' : 'over'} the content`;
}

// ---------- image watermark ----------
const canvasToBlob = (c, type, quality) => new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('The image could not be encoded.'))), type, quality));

// Re-encodes through a canvas: applies EXIF orientation, normalises PNG variants, keeps alpha, caps at 2000 px.
async function prepareImage(source, name, kind) {
  const bitmap = await createImageBitmap(source);
  const big = Math.max(bitmap.width, bitmap.height);
  const k = big > MAX_IMAGE_SIDE ? MAX_IMAGE_SIDE / big : 1;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bitmap.width * k));
  c.height = Math.max(1, Math.round(bitmap.height * k));
  c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
  const blob = await canvasToBlob(c, kind === 'png' ? 'image/png' : 'image/jpeg', 0.92);
  const scaled = k < 1 ? await createImageBitmap(c) : bitmap;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), kind, bitmap: scaled, width: c.width, height: c.height, name, downscaled: k < 1, original: { w: bitmap.width, h: bitmap.height } };
}

async function useImageFile(file) {
  clearAlerts();
  const kind = /png$/i.test(file.type) || /\.png$/i.test(file.name) ? 'png' : /jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name) ? 'jpg' : null;
  if (!kind) { showError(`${file.name} is not a PNG or JPG image. Choose a .png or .jpg file for the image watermark.`); return; }
  try {
    state.image = await prepareImage(file, file.name, kind);
  } catch {
    showError(`${file.name} could not be read as an image.`);
    return;
  }
  const im = state.image;
  $('wm-image-info').textContent = im.downscaled
    ? `${file.name}: ${im.original.w} × ${im.original.h} px, downscaled to ${im.width} × ${im.height} px to keep the PDF small.`
    : `${file.name}: ${im.width} × ${im.height} px${kind === 'png' ? ', transparency kept' : ''}.`;
  schedulePreview();
}

// Draws the text with system fonts (any script) into a transparent PNG and switches to image mode.
async function textToImage() {
  const o = options();
  if (!o.text) return;
  const px = 160;
  const fontCss = `bold ${px}px ${CANVAS_FONTS[o.font]}, sans-serif`;
  const c = document.createElement('canvas');
  let ctx = c.getContext('2d');
  ctx.font = fontCss;
  const m = ctx.measureText(o.text);
  const asc = Math.ceil(m.actualBoundingBoxAscent || px * 0.8);
  const desc = Math.ceil(m.actualBoundingBoxDescent || px * 0.2);
  const pad = Math.round(px * 0.1);
  c.width = Math.min(MAX_IMAGE_SIDE, Math.ceil(m.width) + pad * 2);
  c.height = asc + desc + pad * 2;
  ctx = c.getContext('2d');
  ctx.font = fontCss;
  ctx.fillStyle = o.color;
  ctx.textBaseline = 'alphabetic';
  ctx.direction = 'inherit';
  const k = Math.min(1, (c.width - pad * 2) / Math.max(1, m.width));
  ctx.setTransform(k, 0, 0, 1, pad, 0);
  ctx.fillText(o.text, 0, pad + asc);
  const blob = await canvasToBlob(c, 'image/png');
  state.image = await prepareImage(blob, 'text-watermark.png', 'png');
  $('wm-image-info').textContent = `Text drawn as an image (${c.width} × ${c.height} px, transparent background).`;
  // Keep roughly the same size on the page as the text would have had.
  const page = state.pages[state.view] || { w: 612 };
  const widthPt = (m.width / px) * o.size;
  ctl.scale.value = String(Math.max(5, Math.min(100, Math.round((widthPt / page.w) * 100))));
  $('mode-image').checked = true;
  schedulePreview();
  toast('Text turned into an image watermark');
}

// ---------- apply ----------
async function apply({ download = true } = {}) {
  if (state.busy) return;
  clearAlerts();
  results.querySelectorAll('.result').forEach((el) => el.remove());
  if (!state.bytes) { showError('Choose a PDF first.'); return; }
  const o = options();
  let pages;
  try { pages = targetPages(); } catch (err) { showError(`Page range: ${err.message}`); ctl.pages.focus(); return; }
  if (o.mode === 'text') {
    if (!o.text) { showError('Type a watermark text first, for example CONFIDENTIAL or DRAFT.'); ctl.text.focus(); return; }
    if (!isLatin(o.text)) { showError('The standard PDF fonts cannot draw some of these characters. Use the "Use this text as an image" button to stamp them as an image.'); return; }
  } else if (!state.image) { showError('Choose a PNG or JPG image for the watermark first.'); ctl.image.focus(); return; }

  state.busy = true;
  applyBtn.disabled = true;
  applyBtn.textContent = 'Stamping…';
  progress.hidden = false;
  setProgress(0);
  try {
    const image = o.mode === 'image' ? { bytes: state.image.bytes.slice(), kind: state.image.kind } : null;
    const res = await run({ type: 'stamp', bytes: state.bytes.slice(), opts: o, image, pages }, setProgress);
    setProgress(1);
    const name = outputName();
    const blob = new Blob([res.bytes], { type: 'application/pdf' });
    state.output = { blob, name };
    showResult(res, blob, name);
    if (download) downloadBlob(blob, name);
  } catch (err) {
    if (err.kind === 'encrypted') showError('This PDF is encrypted, which is not supported.');
    else if (err.kind === 'encoding') showError('The standard PDF fonts cannot draw some of these characters. Use the "Use this text as an image" button instead.');
    else showError(`Stamping failed: ${err.message}`);
  } finally {
    state.busy = false;
    applyBtn.disabled = false;
    applyBtn.textContent = 'Apply and download';
    setTimeout(() => { if (!state.busy) progress.hidden = true; }, 600);
  }
}

function showResult(res, blob, name) {
  const card = document.createElement('div');
  card.className = 'result';
  card.id = 'result';
  card.innerHTML = `<div class="result__meta"><div class="result__name"></div><div class="result__info" id="result-line"></div></div>
    <button type="button" class="btn btn--primary" id="download"></button>`;
  card.querySelector('.result__name').textContent = name;
  const unmarked = res.total - res.stamped;
  card.querySelector('.result__info').textContent = `${res.stamped} of ${res.total} page${res.total === 1 ? '' : 's'} stamped${unmarked ? `, ${unmarked} left unmarked` : ''} · ${formatBytes(blob.size)}`;
  const btn = card.querySelector('#download');
  btn.textContent = `Download ${name}`;
  btn.addEventListener('click', () => downloadBlob(blob, name)); // a direct tap also works on mobile Safari
  results.append(card);
  card.scrollIntoView({ block: 'nearest' });
}

// ---------- wiring ----------
wireDropzone(zone, input, handleFiles);
for (const el of [ctl.text, ctl.size, ctl.color, ctl.scale, ctl.opacity, ctl.rotation, ctl.pages]) el.addEventListener('input', schedulePreview);
for (const el of [ctl.font, ctl.position, ctl.layer]) el.addEventListener('change', schedulePreview);
document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => { clearAlerts(); schedulePreview(); }));
ctl.text.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); schedulePreview(); } });
ctl.image.addEventListener('change', () => { const f = ctl.image.files[0]; if (f) useImageFile(f); });
$('text-to-image').addEventListener('click', () => textToImage().catch((err) => showError(`Could not draw the text as an image: ${err.message}`)));
$('prev-page').addEventListener('click', () => { if (state.view > 0) { state.view -= 1; schedulePreview(); } });
$('next-page').addEventListener('click', () => { if (state.view < state.pages.length - 1) { state.view += 1; schedulePreview(); } });
applyBtn.addEventListener('click', () => apply());
let resizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(schedulePreview, 120); });
syncOutputs();

// Called by the factory's screenshot script: the fictional agreement, stamped CONFIDENTIAL, with a finished result.
window.__demo = async () => {
  const res = await fetch('./tests/fixtures/draft-service-agreement.pdf');
  const file = new File([await res.blob()], 'draft-service-agreement.pdf', { type: 'application/pdf' });
  await handleFiles([file]);
  ctl.text.value = 'CONFIDENTIAL';
  schedulePreview();
  await apply({ download: false });
};

export { handleFiles, apply };
