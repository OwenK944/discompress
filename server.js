// Discompress backend: auto-compress any video to <10MB
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Use packaged ffmpeg/ffprobe so we DON'T need apt-get on Render
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
app.use(cors());              // later you can restrict to your domain
app.use(express.static('public'));

const TMP_DIR = './tmp';
const upload = multer({ dest: TMP_DIR });

const TARGET_MB = parseFloat(process.env.TARGET_MB || '9.8'); // aim just under 10MB
const AUDIO_KBPS = parseInt(process.env.AUDIO_KBPS || '96', 10); // small but OK for Discord
const MAX_WIDTH = parseInt(process.env.MAX_WIDTH || '1280', 10); // cap resolution

async function ensureDirs() {
  for (const d of [TMP_DIR]) {
    if (!fs.existsSync(d)) await fsp.mkdir(d, { recursive: true });
  }
}
ensureDirs().catch(console.error);

app.get('/health', (_, res) => res.send('OK'));

app.post('/api/upload', upload.single('video'), async (req, res) => {
  const inputPath = req.file.path; // e.g. tmp/abc123
  const originalName = (req.file.originalname || 'video').replace(/[^\w.\- ]+/g, '');
  const base = originalName.replace(/\.[^.]+$/, '');
  const outName = `discompress_${base}.mp4`; // FREE branding filename
  const outputPath = path.join(TMP_DIR, `${Date.now()}_${outName}`);

  try {
    const meta = await probe(inputPath);
    const duration = Math.max(1, meta.format.duration || 1); // seconds
    const targetBytes = Math.floor(TARGET_MB * 1024 * 1024);

    // total target bitrate (video+audio) in kbps
    const totalKbps = Math.max(200, Math.floor((targetBytes * 8) / duration / 1000));
    let videoKbps = Math.max(64, totalKbps - AUDIO_KBPS);

    // one-pass encode, then check; if oversize, a safety re-encode at 85% bitrate
    await encode(inputPath, outputPath, videoKbps, AUDIO_KBPS, MAX_WIDTH);
    let size = (await fsp.stat(outputPath)).size;

    if (size > targetBytes) {
      // retry once, a bit lower
      const retryOut = path.join(TMP_DIR, `${Date.now()}_retry_${outName}`);
      videoKbps = Math.max(48, Math.floor(videoKbps * 0.85));
      await encode(inputPath, retryOut, videoKbps, AUDIO_KBPS, MAX_WIDTH);
      await fsp.unlink(outputPath).catch(()=>{});
      size = (await fsp.stat(retryOut)).size;
      // finalize retry
      await streamDownload(res, retryOut, outName);
      // cleanup originals after send
      cleanupLater([inputPath, retryOut]);
      return;
    }

    await streamDownload(res, outputPath, outName);
    cleanupLater([inputPath, outputPath]);
  } catch (err) {
    console.error(err);
    // clean up temp input/output if present
    cleanupLater([inputPath, outputPath]);
    res.status(500).send('Compression failed. Try a shorter clip or smaller source.');
  }
});

function probe(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

function encode(input, output, videoKbps, audioKbps, maxWidth) {
  return new Promise((resolve, reject) => {
    // Scale to max width, keep aspect; yuv420p for compatibility; faststart for web
    const scaleFilter = `scale='min(${maxWidth},iw)':-2`;

    ffmpeg(input)
      .outputOptions([
        '-movflags', 'faststart',
        '-pix_fmt', 'yuv420p',
        '-vf', scaleFilter,
        '-preset', 'veryfast',
        '-profile:v', 'main',
        '-level', '4.0'
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
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  await new Promise((r) => stream.on('close', r));
}

function cleanupLater(paths) {
  setTimeout(() => {
    paths.forEach(p => p && fs.existsSync(p) && fs.unlink(p, () => {}));
  }, 10_000);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Discompress running on :${PORT}`));
