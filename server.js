// Discompress backend — API only
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();

// 🔒 CORS: allow your GitHub Pages only
const ALLOWED = ['https://owenk944.github.io'];
app.use(cors({
  origin: function (origin, cb) {
    // allow local tools too
    if (!origin || ALLOWED.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  }
}));

// No static site served from backend anymore.
const TMP_DIR = './tmp';
const TARGET_MB = parseFloat(process.env.TARGET_MB || '9.8');
const AUDIO_KBPS = parseInt(process.env.AUDIO_KBPS || '96', 10);
const MAX_WIDTH = parseInt(process.env.MAX_WIDTH || '1280', 10);

// Multer with big upload cap (500 MB). Adjust if you want more.
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 500 * 1024 * 1024 }
});

(async () => {
  if (!fs.existsSync(TMP_DIR)) await fsp.mkdir(TMP_DIR, { recursive: true });
})().catch(console.error);

// Health check (optional)
app.get('/health', (_, res) => res.status(200).send('OK'));

// Main API
app.post('/api/upload', upload.single('video'), async (req, res) => {
  const inputPath = req.file?.path;
  if (!inputPath) return res.status(400).send('No file uploaded');

  const originalName = (req.file.originalname || 'video').replace(/[^\w.\- ]+/g, '');
  const base = originalName.replace(/\.[^.]+$/, '');
  const outName = `discompress_${base}.mp4`; // FREE: branded filename
  const firstOut = path.join(TMP_DIR, `${Date.now()}_${outName}`);

  try {
    const meta = await probe(inputPath);
    const duration = Math.max(1, meta.format?.duration || 1); // seconds
    const targetBytes = Math.floor(TARGET_MB * 1024 * 1024);

    // Total target kbps (video + audio)
    const totalKbps = Math.max(200, Math.floor((targetBytes * 8) / duration / 1000));
    const initialVideoKbps = Math.max(64, totalKbps - AUDIO_KBPS);

    // Multi-pass shrink until under target (three tries)
    const passes = [1.00, 0.85, 0.72];
    let lastOut = firstOut;
    let videoKbpsNow = initialVideoKbps;

    for (let i = 0; i < passes.length; i++) {
      const out = i === 0 ? firstOut : path.join(TMP_DIR, `${Date.now()}_${i}_${outName}`);
      if (i > 0) videoKbpsNow = Math.max(48, Math.floor(initialVideoKbps * passes[i]));
      await encode(inputPath, out, videoKbpsNow, AUDIO_KBPS, MAX_WIDTH);

      const sizeNow = (await fsp.stat(out)).size;
      lastOut = out;
      if (sizeNow <= targetBytes) break;
    }

    await streamDownload(res, lastOut, outName);
    cleanupLater([inputPath, firstOut !== lastOut ? firstOut : null, lastOut]);
  } catch (e) {
    console.error(e);
    cleanupLater([inputPath, firstOut]);
    res.status(500).send('Compression failed. Try a shorter clip or lower source bitrate.');
  }
});

function probe(file) {
  return new Promise((res, rej) => ffmpeg.ffprobe(file, (e, d) => e ? rej(e) : res(d)));
}

function encode(input, output, videoKbps, audioKbps, maxWidth) {
  return new Promise((resolve, reject) => {
    const scaleFilter = `scale='min(${maxWidth},iw)':-2`;

    ffmpeg(input)
      .outputOptions([
        '-movflags', 'faststart',
        '-pix_fmt', 'yuv420p',
        '-vf', scaleFilter,
        '-preset', 'veryfast',
        '-profile:v', 'main',
        '-level', '4.0',
        // slightly steadier bitrate delivery
        '-maxrate', `${Math.floor(videoKbps * 1.2)}k`,
        '-bufsize', `${Math.floor(videoKbps * 2)}k`
      ])
      .videoCodec('libx264')
      .audioCodec('aac')
      .videoBitrate(`${videoKbps}k`)
      .audioBitrate(`${audioKbps}k`)
      .format('mp4')
      .on('error', reject)
      .on('end', resolve)
      .save(output);
  });
}

async function streamDownload(res, filePath, downloadName) {
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(filePath);
    s.on('error', reject);
    s.on('close', resolve);
    s.pipe(res);
  });
}

function cleanupLater(paths) {
  setTimeout(() => {
    for (const p of paths) if (p && fs.existsSync(p)) fs.unlink(p, () => {});
  }, 12_000);
}

// Root and everything else → 404 (no UI on backend)
app.get('/', (_, res) => res.status(404).send(''));
app.use((_, res) => res.status(404).send(''));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API ready on :${PORT}`));
