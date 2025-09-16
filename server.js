// Discompress backend — API only, memory-safe on Render Free
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
const FRONTEND = 'https://owenk944.github.io'; // whitelist your Pages origin
app.use(cors({ origin: (o, cb)=> (!o || o.startsWith(FRONTEND)) ? cb(null,true) : cb(new Error('CORS')) }));

const TMP_DIR = './tmp';
const TARGET_MB   = parseFloat(process.env.TARGET_MB   || '9.8');
const AUDIO_KBPS  = parseInt (process.env.AUDIO_KBPS  || '96', 10);
const MAX_WIDTH   = parseInt (process.env.MAX_WIDTH   || '1280', 10);
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '300', 10); // keep moderate for Render free
const CONCURRENCY = parseInt (process.env.CONCURRENCY || '1', 10);     // serialize to prevent OOM

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 }
});

(async () => { if (!fs.existsSync(TMP_DIR)) await fsp.mkdir(TMP_DIR, { recursive: true }); })().catch(console.error);

app.get('/health', (_, res) => res.status(200).send('OK'));

// simple FIFO queue to cap concurrent encodes
const queue = [];
let running = 0;
function enqueue(jobFn){
  return new Promise((resolve, reject)=>{
    queue.push({ jobFn, resolve, reject });
    pump();
  });
}
function pump(){
  if (running >= CONCURRENCY || queue.length === 0) return;
  const { jobFn, resolve, reject } = queue.shift();
  running++;
  Promise.resolve().then(jobFn)
    .then((v)=>{ running--; pump(); resolve(v); })
    .catch((e)=>{ running--; pump(); reject(e); });
}

app.post('/api/upload', upload.single('video'), async (req, res) => {
  const inputPath = req.file?.path;
  if (!inputPath) return res.status(400).send('No file uploaded');

  try {
    const { filePath, outName } = await enqueue(async ()=>{
      const originalName = (req.file.originalname || 'video').replace(/[^\w.\- ]+/g, '');
      const base = originalName.replace(/\.[^.]+$/, '');
      const outName = `discompress_${base}.mp4`;
      const firstOut = path.join(TMP_DIR, `${Date.now()}_${outName}`);

      const meta = await probe(inputPath);
      const duration = Math.max(1, meta.format?.duration || 1);
      const targetBytes = Math.floor(TARGET_MB * 1024 * 1024);
      const totalKbps = Math.max(180, Math.floor((targetBytes * 8) / duration / 1000));
      const initialVideoKbps = Math.max(56, totalKbps - AUDIO_KBPS);

      // multi-pass: try progressively lower bitrates
      const factors = [1.00, 0.82, 0.68, 0.56];
      let lastOut = firstOut;
      let vkbps = initialVideoKbps;

      for (let i=0; i<factors.length; i++){
        const out = i===0 ? firstOut : path.join(TMP_DIR, `${Date.now()}_${i}_${outName}`);
        if (i>0) vkbps = Math.max(48, Math.floor(initialVideoKbps * factors[i]));
        await encode(inputPath, out, vkbps, AUDIO_KBPS, MAX_WIDTH);
        const sz = (await fsp.stat(out)).size;
        lastOut = out;
        if (sz <= targetBytes) break;
      }
      return { filePath: lastOut, outName, firstOut };
    });

    await streamDownload(res, filePath, outName);
    // cleanup
    cleanupLater([inputPath, filePath]);
  } catch (e) {
    console.error('encode error:', e);
    cleanupLater([inputPath]);
    res.status(500).send('Compression failed. Try a shorter clip or lower source bitrate.');
  }
});

function probe(file){ return new Promise((res, rej)=> ffmpeg.ffprobe(file, (e,d)=> e?rej(e):res(d))); }
function encode(input, output, videoKbps, audioKbps, maxWidth){
  return new Promise((resolve, reject)=>{
    const scale = `scale='min(${maxWidth},iw)':-2`;
    ffmpeg(input)
      .outputOptions([
        // keep memory use low & deterministic
        '-threads','1',
        '-movflags','faststart',
        '-pix_fmt','yuv420p',
        '-vf', scale,
        '-preset','veryfast',
        '-profile:v','main',
        '-level','4.0',
        '-maxrate', `${Math.floor(videoKbps * 1.15)}k`,
        '-bufsize', `${Math.floor(videoKbps * 2)}k`
      ])
      .videoCodec('libx264').audioCodec('aac')
      .videoBitrate(`${videoKbps}k`).audioBitrate(`${audioKbps}k`)
      .format('mp4')
      .on('error', reject).on('end', resolve)
      .save(output);
  });
}
async function streamDownload(res, filePath, name){
  res.setHeader('Content-Type','video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  await new Promise((resolve, reject)=>{
    const s = fs.createReadStream(filePath);
    s.on('error', reject); s.on('close', resolve); s.pipe(res);
  });
}
function cleanupLater(paths){
  setTimeout(()=>{ for (const p of paths) if (p && fs.existsSync(p)) fs.unlink(p,()=>{}); }, 12_000);
}

// root → 404 (no UI on backend)
app.get('/', (_, res)=> res.status(404).send(''));
app.use((_, res)=> res.status(404).send(''));

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('API ready on :'+PORT));
