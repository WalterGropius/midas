// Render midas-explainer.html to MP4, frame-exact.
//
// The page draws every frame as a pure function of time, so instead of
// screen-recording we ask it for frame N, read the canvas back as PNG and
// pipe the stills into ffmpeg. Needs ffmpeg and a Playwright Chromium.
//
//   node docs/explainer/render.mjs                      # full video → midas-explainer.mp4
//   node docs/explainer/render.mjs --stills 3,20,60     # PNG stills at those seconds
//   node docs/explainer/render.mjs --fps 60 --from 100 --to 120 --out clip.mp4
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  ({ chromium } = await import('playwright'));
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--force-color-profile=srgb', '--disable-lcd-text'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(resolve(here, 'midas-explainer.html')).href + '?render=1');
await page.evaluate(() => window.__ready);
const total = await page.evaluate(() => window.__total);

const grab = t =>
  page.evaluate(t => {
    window.__frame(t);
    return document.getElementById('c').toDataURL('image/png').split(',')[1];
  }, t);

const stills = opt('stills');
if (stills) {
  const outDir = resolve(opt('dir', '.'));
  for (const s of stills.split(',').map(Number)) {
    const file = resolve(outDir, `still-${String(s).replace('.', '_')}.png`);
    writeFileSync(file, Buffer.from(await grab(s), 'base64'));
    console.log(file);
  }
  await browser.close();
  process.exit(0);
}

const fps = Number(opt('fps', 30));
const from = Number(opt('from', 0));
const to = Math.min(Number(opt('to', total)), total);
const out = resolve(opt('out', resolve(here, 'midas-explainer.mp4')));
const frames = Math.round((to - from) * fps);

const ff = spawn(
  process.env.FFMPEG || 'ffmpeg',
  ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(opt('crf', 18)), '-pix_fmt', 'yuv420p',
    '-profile:v', 'high', '-movflags', '+faststart', out],
  { stdio: ['pipe', 'inherit', 'inherit'] }
);
const done = new Promise((res, rej) => ff.on('close', code => (code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`)))));

const started = Date.now();
for (let i = 0; i < frames; i++) {
  const png = Buffer.from(await grab(from + i / fps), 'base64');
  if (!ff.stdin.write(png)) await new Promise(r => ff.stdin.once('drain', r));
  if (i % (fps * 5) === 0) process.stdout.write(`\r${(from + i / fps).toFixed(1)}s / ${to.toFixed(1)}s  (${((Date.now() - started) / 1000).toFixed(0)}s elapsed)`);
}
ff.stdin.end();
await done;
await browser.close();
console.log(`\nwrote ${out} — ${frames} frames at ${fps} fps`);
