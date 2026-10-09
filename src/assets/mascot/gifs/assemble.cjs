// Usage: node assemble.cjs <directory containing sharp, gifenc and omggif node_modules>
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const toolRequire = createRequire(path.resolve(process.argv[2], 'package.json'));
const sharp = toolRequire('sharp');
const { GIFEncoder, quantize, applyPalette } = toolRequire('gifenc');
const { GifReader } = toolRequire('omggif');
const root = __dirname;
const names = ['idle', 'wave', 'working', 'celebrate'];
const only = process.argv[3];
if (only && !names.includes(only)) throw new Error(`Unknown animation: ${only}`);

async function main() {
  const sets = [];
  for (const name of names) {
    const sheet = path.join(root, 'sheets', `panna-${name}.png`);
    const meta = await sharp(sheet).metadata();
    const frames = [];
    for (let i = 0; i < 8; i++) {
      const col = i % 4, row = Math.floor(i / 4);
      const left = Math.round(col * meta.width / 4), top = Math.round(row * meta.height / 2);
      const width = Math.round((col + 1) * meta.width / 4) - left;
      const height = Math.round((row + 1) * meta.height / 2) - top;
      const { data } = await sharp(sheet).extract({ left, top, width, height }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let x0 = width, y0 = height, x1 = 0, y1 = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] >= 128) {
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
      }
      frames.push({ data, width, height, bounds: { x0, y0, x1, y1 } });
    }
    sets.push({ name, frames });
  }
  // One scale for every animation. Anchor feet; retain vertical motion in celebration.
  const tallest = Math.max(...sets.flatMap(s => s.frames.map(f => f.bounds.y1 - f.bounds.y0 + 1)));
  const scale = 448 / tallest;
  const report = [];
  const contact = [];
  for (const { name, frames } of sets) {
    if (!only || only === name) {
    const frameScale = name === 'wave' ? 443 / (frames[0].bounds.y1 - frames[0].bounds.y0 + 1) : scale;
    const dir = path.join(root, 'frames', name);
    fs.mkdirSync(dir, { recursive: true });
    const normalized = [];
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i], b = f.bounds;
      const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1;
      const resized = await sharp(f.data, { raw: { width: f.width, height: f.height, channels: 4 } })
        .extract({ left: b.x0, top: b.y0, width: w, height: h })
        .resize(Math.round(w * frameScale), Math.round(h * frameScale)).png().toBuffer();
      const m = await sharp(resized).metadata();
      const lift = name === 'celebrate' ? [0, 3, 10, 20, 24, 16, 7, 0][i]
        : 0;
      // Wave hands change the silhouette width. Anchor the lower body instead
      // so the face and torso do not slide sideways with the moving hand.
      let centerX = (b.x0 + b.x1) / 2;
      if (name === 'wave') {
        let sumX = 0, weight = 0;
        for (let y = Math.round(b.y0 + h * 0.72); y <= b.y1; y++) {
          for (let x = b.x0; x <= b.x1; x++) {
            const alpha = f.data[(y * f.width + x) * 4 + 3];
            if (alpha >= 128) { sumX += x * alpha; weight += alpha; }
          }
        }
        if (weight) centerX = sumX / weight;
      }
      let png = await sharp({ create: { width: 512, height: 512, channels: 4, background: '#00000000' } })
        .composite([{ input: resized, left: name === 'wave' ? Math.round(256 - (centerX - b.x0) * frameScale) : Math.round((512 - m.width) / 2), top: 480 - m.height - lift }]).png().toBuffer();
      fs.writeFileSync(path.join(dir, `${String(i + 1).padStart(2, '0')}.png`), png);
      normalized.push(await sharp(png).ensureAlpha().raw().toBuffer());
    }
    // Quantize opaque samples only; reserve index zero exclusively for transparent pixels.
    const samples = [];
    for (const frame of normalized) for (let p = 0; p < frame.length; p += 16) {
      if (frame[p + 3] >= 128) samples.push(frame[p], frame[p + 1], frame[p + 2], 255);
    }
    const opaquePalette = quantize(Uint8Array.from(samples), 255);
    const palette = [[0, 0, 0], ...opaquePalette];
    const indexed = normalized.map(frame => {
      const indices = applyPalette(frame, opaquePalette);
      for (let p = 0; p < indices.length; p++) indices[p] = frame[p * 4 + 3] < 128 ? 0 : indices[p] + 1;
      return indices;
    });
    // Hold a stable open-eye pose, then close and reopen through the same
    // half-closed pose. Cycling all generated poses introduces drawing drift.
    const sequence = name === 'idle' ? [0, 2, 3, 2] : [0, 1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2, 1];
    const delays = name === 'idle' ? [2780, 60, 80, 80]
      : name === 'working' ? [400, 220, 180, 180, 180, 180, 180, 300, 180, 180, 180, 180, 220, 240]
      : [320, 120, 120, 120, 120, 120, 120, 320, 120, 120, 120, 120, 120, 120];
    const gif = GIFEncoder();
    sequence.forEach((frame, i) => gif.writeFrame(indexed[frame], 512, 512, { palette, transparent: true, transparentIndex: 0, delay: delays[i], repeat: 0, dispose: 2 }));
    gif.finish();
    const bytes = Buffer.from(gif.bytes());
    fs.writeFileSync(path.join(root, `panna-${name}.gif`), bytes);
    }
    const bytes = fs.readFileSync(path.join(root, `panna-${name}.gif`));
    const reader = new GifReader(bytes);
    if (reader.width !== 512 || reader.height !== 512 || reader.loopCount() !== 0) throw new Error(`${name}: invalid dimensions/loop`);
    let duration = 0;
    for (let i = 0; i < reader.numFrames(); i++) {
      const info = reader.frameInfo(i);
      if (info.transparent_index !== 0 || info.disposal !== 2) throw new Error(`${name}: invalid transparency/disposal`);
      duration += info.delay * 10;
      const rgba = Buffer.alloc(512 * 512 * 4);
      reader.decodeAndBlitFrameRGBA(i, rgba);
      if (rgba[3] !== 0) throw new Error(`${name}: opaque corner`);
      if (i === 0 || i === 3) {
        const thumb = await sharp(rgba, { raw: { width: 512, height: 512, channels: 4 } }).resize(256, 256).png().toBuffer();
        contact.push({ input: thumb, left: sets.findIndex(s => s.name === name) * 256, top: i === 0 ? 0 : 256 });
      }
    }
    report.push({ file: `panna-${name}.gif`, width: 512, height: 512, frames: reader.numFrames(), durationMs: duration, loop: 'infinite', transparent: true, bytes: bytes.length });
  }
  for (const [label, background] of [['light', '#f4f5fa'], ['dark', '#1b2230']]) {
    await sharp({ create: { width: 1024, height: 512, channels: 4, background } }).composite(contact).png().toFile(path.join(root, `contact-${label}.png`));
  }
  fs.writeFileSync(path.join(root, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
