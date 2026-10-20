// smoke.spec.js — PDF Watermark Stamper: the core action on the fictional 3 page agreement
// (tests/fixtures/draft-service-agreement.pdf and blue-circle-logo.png, made by tests/make-fixtures.js).
// Covers every acceptance check in SPEC.md, plus error and layer cases.
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const fixture = (name) => path.join(__dirname, 'fixtures', name);
const SAMPLE = fixture('draft-service-agreement.pdf');
const LOGO = fixture('blue-circle-logo.png');
const OUT_NAME = 'draft-service-agreement_watermarked.pdf';

async function load(page) {
  await page.goto('./');
  await page.setInputFiles('#file-input', SAMPLE);
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#page-indicator')).toHaveText('Page 1 / 3');
}

async function applyAndDownload(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#apply')]);
  expect(download.suggestedFilename()).toBe(OUT_NAME);
  const bytes = fs.readFileSync(await download.path());
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(1000);
  return bytes;
}

// Opens a PDF with the page's own pdf-lib and returns, per page, each decoded content stream and the
// images (with or without an alpha mask) in its resources.
async function inspect(page, bytes) {
  return page.evaluate(async (b64) => {
    const { PDFDocument, PDFArray, PDFDict, PDFName, PDFRawStream, decodePDFRawStream } = window.PDFLib;
    const doc = await PDFDocument.load(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const text = (s) => new TextDecoder('latin1').decode(decodePDFRawStream(s).decode());
    return doc.getPages().map((p) => {
      const c = p.node.Contents();
      const streams = (c instanceof PDFArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c]).map(text);
      const images = [];
      const xobjects = p.node.Resources().lookupMaybe(PDFName.of('XObject'), PDFDict);
      if (xobjects) {
        for (const [name, ref] of xobjects.entries()) {
          const obj = doc.context.lookup(ref);
          if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
            images.push({ name: name.asString().replace(/^\//, ''), width: obj.dict.get(PDFName.of('Width')).asNumber(), alpha: Boolean(obj.dict.get(PDFName.of('SMask'))) });
          }
        }
      }
      return { streams, content: streams.join('\n'), images };
    });
  }, Buffer.from(bytes).toString('base64'));
}

// pdf-lib writes standard-font text as hex strings: "DRAFT" -> <4452414654> Tj
const tj = (label) => `<${Buffer.from(label, 'latin1').toString('hex').toUpperCase()}> Tj`;

// Reads the preview canvas: colored (stamp) pixels, the main axis of their spread, and their blended color.
async function analysePreview(page) {
  return page.evaluate(() => {
    const c = document.getElementById('preview');
    const { data, width, height } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    const greens = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (r - g > 25 && r - b > 25) { n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; greens.push(g); }
      }
    }
    const mx = sx / n, my = sy / n;
    const cxx = sxx / n - mx * mx, cyy = syy / n - my * my, cxy = sxy / n - mx * my;
    const axis = (0.5 * Math.atan2(2 * cxy, cxx - cyy) * 180) / Math.PI; // canvas y points down
    greens.sort((a, b) => a - b);
    return { n, axis, medianGreen: greens[Math.floor(greens.length / 2)] || 0, center: { x: mx / width, y: my / height } };
  });
}

test.describe('PDF Watermark Stamper', () => {
  test('the bundled sample stamped with DRAFT keeps its 3 pages and every page carries the text', async ({ page }) => {
    await load(page);
    await expect(page.locator('#wm-text')).toHaveValue('CONFIDENTIAL');
    await page.fill('#wm-text', 'DRAFT');
    const bytes = await applyAndDownload(page);
    await expect(page.locator('#result-line')).toContainText('3 of 3 pages stamped');
    await expect(page.locator('#download')).toHaveText(`Download ${OUT_NAME}`);

    const before = await inspect(page, fs.readFileSync(SAMPLE));
    const after = await inspect(page, bytes);
    expect(after).toHaveLength(before.length);
    expect(after).toHaveLength(3);
    for (const p of after) {
      expect(p.content).toContain(tj('DRAFT'));
      expect(p.content).toMatch(/\/GS-\d+ gs/); // opacity via an ExtGState
      expect(p.content).toMatch(/0\.7071\d* 0\.7071\d* -0\.7071\d* 0\.7071\d* [-\d.]+ [-\d.]+ Tm/); // 45 degree text matrix
    }

    // The re-download button gives the same file.
    const [again] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
    expect(again.suggestedFilename()).toBe(OUT_NAME);
    expect(fs.readFileSync(await again.path()).length).toBe(bytes.length);
  });

  test('the preview shows the text rotated at 45 degrees with the chosen opacity', async ({ page }) => {
    await load(page);
    await expect(page.locator('#wm-rotation')).toHaveValue('45');
    await expect(page.locator('#wm-opacity')).toHaveValue('25');
    await expect(page.locator('#preview-caption')).toContainText('"CONFIDENTIAL" · 45° · 25% opacity');
    await expect(page.locator('#preview')).toHaveAttribute('data-stamped', 'true');

    let a = await analysePreview(page);
    expect(a.n).toBeGreaterThan(200);
    expect(Math.abs(a.axis + 45)).toBeLessThan(4); // rising to the right = 45 degrees counterclockwise
    expect(a.center.x).toBeGreaterThan(0.4); expect(a.center.x).toBeLessThan(0.6);
    expect(a.center.y).toBeGreaterThan(0.4); expect(a.center.y).toBeLessThan(0.6);
    // Red #dc2626 at 25% over white paper: green ≈ 255 - 0.25 * (255 - 38) ≈ 201
    expect(a.medianGreen).toBeGreaterThan(190); expect(a.medianGreen).toBeLessThan(212);

    await page.locator('#wm-opacity').fill('80');
    await expect(page.locator('#wm-opacity-out')).toHaveText('80%');
    await expect(page.locator('#preview-caption')).toContainText('80% opacity');
    a = await analysePreview(page);
    expect(a.medianGreen).toBeLessThan(100); // ≈ 81

    // Enter in the text field refreshes the preview.
    await page.fill('#wm-text', 'DRAFT');
    await page.locator('#wm-text').press('Enter');
    await expect(page.locator('#preview-caption')).toContainText('"DRAFT" · 45° · 80% opacity');
  });

  test('a PNG logo is embedded on every page with its transparency', async ({ page }) => {
    await load(page);
    await page.check('#mode-image', { force: true });
    await expect(page.locator('#image-opts')).toBeVisible();
    await expect(page.locator('#text-opts')).toBeHidden();
    await page.setInputFiles('#wm-image', LOGO);
    await expect(page.locator('#wm-image-info')).toContainText('256 × 256 px, transparency kept');
    await expect(page.locator('#preview-caption')).toContainText('Image · 45° · 25% opacity');
    const bytes = await applyAndDownload(page);
    await expect(page.locator('#result-line')).toContainText('3 of 3 pages stamped');
    const after = await inspect(page, bytes);
    expect(after).toHaveLength(3);
    for (const p of after) {
      expect(p.images).toHaveLength(1);
      expect(p.images[0]).toMatchObject({ width: 256, alpha: true });
      expect(p.content).toContain(`/${p.images[0].name} Do`);
    }
  });

  test('restricting to pages 2-3 leaves page 1 unmarked', async ({ page }) => {
    await load(page);
    await page.fill('#wm-pages', '2-3');
    await expect(page.locator('#wm-pages-hint')).toHaveText('2 of 3 pages: 2, 3');
    await expect(page.locator('#preview')).toHaveAttribute('data-stamped', 'false');
    await expect(page.locator('#preview-caption')).toContainText('Page 1 is not in the page range');
    await page.click('#next-page');
    await expect(page.locator('#page-indicator')).toHaveText('Page 2 / 3');
    await expect(page.locator('#preview')).toHaveAttribute('data-stamped', 'true');

    const bytes = await applyAndDownload(page);
    await expect(page.locator('#result-line')).toContainText('2 of 3 pages stamped, 1 left unmarked');
    const before = await inspect(page, fs.readFileSync(SAMPLE));
    const after = await inspect(page, bytes);
    expect(after).toHaveLength(3);
    expect(after[0].content).not.toContain(tj('CONFIDENTIAL'));
    expect(after[0].content).toBe(before[0].content);
    expect(after[1].content).toContain(tj('CONFIDENTIAL'));
    expect(after[2].content).toContain(tj('CONFIDENTIAL'));

    await page.fill('#wm-pages', '7');
    await expect(page.locator('#wm-pages-hint')).toContainText('Page 7 does not exist');
    await page.click('#apply');
    await expect(page.locator('#results .alert--error')).toContainText('Page 7 does not exist');
  });

  test('layout works at 390px wide, including a tiled stamp and its download', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await load(page);
    await page.selectOption('#wm-position', 'tiled');
    await expect(page.locator('#preview-caption')).toContainText(/tiled \d+ times/);
    const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
    expect(widths.doc).toBeLessThanOrEqual(widths.win + 1);
    for (const sel of ['#preview', '#apply', '#wm-text', '#wm-pages', '#next-page']) {
      const box = await page.locator(sel).boundingBox();
      expect(box.x, sel).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, sel).toBeLessThanOrEqual(391);
    }
    const bytes = await applyAndDownload(page);
    await expect(page.locator('#download')).toBeInViewport();
    const after = await inspect(page, bytes);
    expect(after[0].content.split(tj('CONFIDENTIAL')).length - 1).toBeGreaterThan(2);
    const widthsAfter = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(widthsAfter).toBeLessThanOrEqual(391);
  });

  test('under the content puts the stamp before the original page content', async ({ page }) => {
    await load(page);
    await page.selectOption('#wm-layer', 'under');
    const after = await inspect(page, await applyAndDownload(page));
    for (const p of after) {
      expect(p.streams[0]).toContain(tj('CONFIDENTIAL'));
      expect(p.streams.slice(1).join('\n')).not.toContain(tj('CONFIDENTIAL'));
    }
  });

  test('non Latin text offers to stamp it as an image', async ({ page }) => {
    await load(page);
    await page.fill('#wm-text', 'ΣΧΕΔΙΟ 草稿');
    await expect(page.locator('#latin-warning')).toBeVisible();
    await page.click('#apply');
    await expect(page.locator('#results .alert--error')).toContainText('Use this text as an image');
    await page.click('#text-to-image');
    await expect(page.locator('#mode-image')).toBeChecked();
    await expect(page.locator('#wm-image-info')).toContainText('Text drawn as an image');
    const after = await inspect(page, await applyAndDownload(page));
    for (const p of after) expect(p.images[0].alpha).toBe(true);
  });

  test('wrong file types and encrypted PDFs show clear inline errors', async ({ page }) => {
    await page.goto('./');
    await page.setInputFiles('#file-input', fixture('sample.txt'));
    await expect(page.locator('#results .alert--error')).toContainText('sample.txt is not a PDF');
    await expect(page.locator('#workspace')).toBeHidden();

    await page.setInputFiles('#file-input', fixture('encrypted.pdf'));
    await expect(page.locator('#results .alert--error')).toContainText('encrypted or password protected');

    // A mixed drop: the PDF loads, the other file is reported.
    const handle = await page.evaluateHandle(async () => {
      const dt = new DataTransfer();
      const pdf = await (await fetch('./tests/fixtures/draft-service-agreement.pdf')).blob();
      dt.items.add(new File([pdf], 'draft-service-agreement.pdf', { type: 'application/pdf' }));
      dt.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
      return dt;
    });
    await page.dispatchEvent('#dropzone', 'drop', { dataTransfer: handle });
    await expect(page.locator('#page-indicator')).toHaveText('Page 1 / 3');
    await expect(page.locator('#results .alert--error')).toContainText('Skipped notes.txt');

    await page.check('#mode-image', { force: true });
    await page.setInputFiles('#wm-image', fixture('sample.gif'));
    await expect(page.locator('#results .alert--error')).toContainText('sample.gif is not a PNG or JPG');
  });

  test('__demo shows a finished, stamped result', async ({ page }) => {
    await page.goto('./');
    await page.evaluate(() => window.__demo());
    await expect(page.locator('#result-line')).toContainText('3 of 3 pages stamped');
    await expect(page.locator('#preview')).toHaveAttribute('data-stamped', 'true');
  });
});
