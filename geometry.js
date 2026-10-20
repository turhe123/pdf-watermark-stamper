// geometry.js — stamp placement shared by the preview (app.js imports it for its side effect) and worker.js
// (importScripts). Plain script that sets self.WMGeometry, so it works both as a module and as a classic script.
// All coordinates are PDF points with the origin at the lower left and y going up; angles are degrees,
// counterclockwise, as seen on screen.
(function (g) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const MAX_TILES = 400;

  // Page /Rotate value folded into 0, 90, 180 or 270.
  function normRotation(angle) {
    return (((Math.round((angle || 0) / 90) * 90) % 360) + 360) % 360;
  }

  // Size of the axis-aligned box around a w x h stamp turned by `angle`.
  function rotatedBounds(w, h, angle) {
    const c = Math.abs(Math.cos(rad(angle)));
    const s = Math.abs(Math.sin(rad(angle)));
    return { bw: w * c + h * s, bh: w * s + h * c };
  }

  // Stamp centers on a visible page of W x H: one in the middle, or a staggered grid that covers the page.
  function centers({ W, H, w, h, angle, tiled }) {
    if (!tiled) return [{ x: W / 2, y: H / 2 }];
    const { bw, bh } = rotatedBounds(w, h, angle);
    const gap = Math.max(18, Math.min(bw, bh) * 0.35);
    const stepX = bw + gap;
    const stepY = Math.max(bh * 0.6, Math.min(bh, h * 2.2)) + gap; // diagonal stamps nest closer vertically
    const nx = Math.ceil((W / 2 + bw) / stepX) + 1;
    const ny = Math.ceil((H / 2 + bh) / stepY) + 1;
    const out = [];
    for (let j = -ny; j <= ny; j++) {
      const cy = H / 2 + j * stepY;
      if (cy < -bh / 2 || cy > H + bh / 2) continue;
      const shift = Math.abs(j) % 2 ? stepX / 2 : 0;
      for (let i = -nx; i <= nx; i++) {
        const cx = W / 2 + i * stepX + shift;
        if (cx < -bw / 2 || cx > W + bw / 2) continue;
        out.push({ x: cx, y: cy });
        if (out.length >= MAX_TILES) return out;
      }
    }
    return out;
  }

  // Maps a point on the visible (possibly rotated) page into the page's own user space.
  // box is the crop box {x, y, width, height}; rot is the page /Rotate value (clockwise on screen).
  function toUser(p, box, rot) {
    const W = box.width;
    const H = box.height;
    let x = p.x;
    let y = p.y;
    if (rot === 90) { x = W - p.y; y = p.x; } else if (rot === 180) { x = W - p.x; y = H - p.y; } else if (rot === 270) { x = p.y; y = H - p.x; }
    return { x: box.x + x, y: box.y + y };
  }

  // Lower-left origin for a w x h stamp turned by `angle` around that origin, so its center lands on c.
  function origin(c, w, h, angle) {
    const cos = Math.cos(rad(angle));
    const sin = Math.sin(rad(angle));
    return { x: c.x - ((w / 2) * cos - (h / 2) * sin), y: c.y - ((w / 2) * sin + (h / 2) * cos) };
  }

  // "1-3, 5, 8-" -> sorted zero-based indexes. Empty or "all" means every page. Throws a readable Error.
  function parseRange(text, count) {
    const src = String(text || '').trim().toLowerCase();
    if (!src || src === 'all') return Array.from({ length: count }, (_, i) => i);
    const picked = new Set();
    for (const raw of src.split(/[,;]+/)) {
      const part = raw.trim();
      if (!part) continue;
      const m = part.match(/^(\d*)\s*(?:-|–|to)\s*(\d*)$/) || part.match(/^(\d+)$/);
      if (!m) throw new Error(`"${part}" is not a page number or range like 2-3.`);
      let a;
      let b;
      if (m.length === 2) { a = b = Number(m[1]); } else {
        a = m[1] === '' ? 1 : Number(m[1]);
        b = m[2] === '' ? count : Number(m[2]);
      }
      if (!a || !b) throw new Error('Pages start at 1.');
      if (a > b) [a, b] = [b, a];
      if (a > count) throw new Error(`Page ${a} does not exist, this PDF has ${count} page${count === 1 ? '' : 's'}.`);
      for (let n = a; n <= Math.min(b, count); n++) picked.add(n - 1);
    }
    if (!picked.size) throw new Error('The page range is empty.');
    return [...picked].sort((x, y) => x - y);
  }

  g.WMGeometry = { normRotation, rotatedBounds, centers, toUser, origin, parseRange };
})(self);
