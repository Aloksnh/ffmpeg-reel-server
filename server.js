const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const TMP = "/tmp/reel-work";
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

// Multer for file uploads (store in TMP)
const upload = multer({ dest: TMP, limits: { fileSize: 100 * 1024 * 1024 } });

// Health check
app.get("/", (_req, res) => res.json({ status: "ok", service: "ffmpeg-reel-server" }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Download a URL to a local file
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    const req = proto.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`Download failed: ${res.statusCode}`));
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    });
    req.on("error", reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error("Download timeout")); });
  });
}

// Run ffmpeg
function ffmpeg(args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const proc = execFile("ffmpeg", args, { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ffmpeg error: ${err.message}\n${stderr}`));
      resolve({ stdout, stderr });
    });
  });
}

// ── EXTRACT FIRST FRAME from a video URL ──
app.post("/extract-frame", async (req, res) => {
  const { video_url } = req.body;
  if (!video_url) return res.status(400).json({ error: "video_url required" });
  const id = crypto.randomBytes(8).toString("hex");
  const videoPath = path.join(TMP, `${id}_src.mp4`);
  const framePath = path.join(TMP, `${id}_frame.jpg`);
  try {
    await download(video_url, videoPath);
    await ffmpeg(["-i", videoPath, "-vframes", "1", "-q:v", "2", "-y", framePath]);
    if (!fs.existsSync(framePath)) throw new Error("Frame extraction failed");
    const frameData = fs.readFileSync(framePath);
    const b64 = frameData.toString("base64");
    res.json({ success: true, frame_base64: b64, content_type: "image/jpeg" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    [videoPath, framePath].forEach((f) => { try { fs.unlinkSync(f); } catch {} });
  }
});

// ── EXTRACT AUDIO from a video URL ──
app.post("/extract-audio", async (req, res) => {
  const { video_url } = req.body;
  if (!video_url) return res.status(400).json({ error: "video_url required" });
  const id = crypto.randomBytes(8).toString("hex");
  const videoPath = path.join(TMP, `${id}_src.mp4`);
  const audioPath = path.join(TMP, `${id}_audio.aac`);
  try {
    await download(video_url, videoPath);
    await ffmpeg(["-i", videoPath, "-vn", "-acodec", "aac", "-b:a", "128k", "-y", audioPath]);
    if (!fs.existsSync(audioPath)) throw new Error("Audio extraction failed");
    const audioData = fs.readFileSync(audioPath);
    const b64 = audioData.toString("base64");
    res.json({ success: true, audio_base64: b64, content_type: "audio/aac" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    [videoPath, audioPath].forEach((f) => { try { fs.unlinkSync(f); } catch {} });
  }
});

// ── MERGE: take generated video + original audio + hook text overlay → final reel ──
app.post("/merge-reel", async (req, res) => {
  const { generated_video_url, original_video_url, hook, hook_position, hook_style } = req.body;
  if (!generated_video_url) return res.status(400).json({ error: "generated_video_url required" });

  const id = crypto.randomBytes(8).toString("hex");
  const genPath = path.join(TMP, `${id}_gen.mp4`);
  const origPath = path.join(TMP, `${id}_orig.mp4`);
  const audioPath = path.join(TMP, `${id}_audio.aac`);
  const outPath = path.join(TMP, `${id}_final.mp4`);

  try {
    // Download generated video
    await download(generated_video_url, genPath);

    // Extract audio from original reel if provided
    let hasAudio = false;
    if (original_video_url) {
      try {
        await download(original_video_url, origPath);
        await ffmpeg(["-i", origPath, "-vn", "-acodec", "aac", "-b:a", "128k", "-y", audioPath]);
        if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 100) hasAudio = true;
      } catch { /* no audio track — continue without */ }
    }

    // Build ffmpeg filter for text overlay
    const filters = [];
    if (hook && hook.trim()) {
      const fontSize = hook_style?.fontSize || 28;
      const fontColor = (hook_style?.color || "#FFFFFF").replace("#", "");
      const bold = hook_style?.bold !== false;
      const outline = hook_style?.outline !== false;
      const pos = (hook_position || "top").toLowerCase();

      let yExpr = "h*0.08"; // top
      if (pos === "center" || pos === "middle") yExpr = "(h-th)/2";
      else if (pos === "bottom") yExpr = "h*0.85-th";

      // Escape special chars for ffmpeg drawtext
      const escapedText = hook.replace(/\\/g, "\\\\\\\\").replace(/'/g, "'\\\\\\''").replace(/:/g, "\\\\:").replace(/%/g, "\\\\%");

      let drawtext = `drawtext=text='${escapedText}'` +
        `:fontsize=${fontSize}` +
        `:fontcolor=0x${fontColor}` +
        `:x=(w-tw)/2` +
        `:y=${yExpr}` +
        `:shadowcolor=black:shadowx=2:shadowy=2`;

      if (outline) {
        drawtext += `:borderw=2:bordercolor=black`;
      }
      if (bold) {
        // Use the default bold-capable font
        drawtext += `:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`;
      }

      filters.push(drawtext);
    }

    // Build ffmpeg command
    const args = ["-i", genPath];
    if (hasAudio) {
      args.push("-i", audioPath);
    }

    if (filters.length > 0) {
      args.push("-vf", filters.join(","));
    }

    if (hasAudio) {
      // Map video from first input, audio from second
      args.push("-map", "0:v:0", "-map", "1:a:0");
      // Trim audio to video length
      args.push("-shortest");
    } else {
      args.push("-an"); // no audio
    }

    args.push(
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-y",
      outPath
    );

    await ffmpeg(args, 300000);

    if (!fs.existsSync(outPath)) throw new Error("Merge failed — no output");

    // Return as base64 (for small files) or stream
    const stat = fs.statSync(outPath);
    if (stat.size > 50 * 1024 * 1024) throw new Error("Output too large");

    const data = fs.readFileSync(outPath);
    const b64 = data.toString("base64");
    res.json({ success: true, video_base64: b64, content_type: "video/mp4", size_bytes: stat.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    [genPath, origPath, audioPath, outPath].forEach((f) => { try { fs.unlinkSync(f); } catch {} });
  }
});



// ── MERGE + UPLOAD: same as merge-reel but uploads result to WaveSpeed CDN ──
app.post("/merge-and-upload", async (req, res) => {
  const { generated_video_url, original_video_url, hook, hook_position, hook_style, ws_api_key } = req.body;
  if (!generated_video_url) return res.status(400).json({ error: "generated_video_url required" });

  const id = crypto.randomBytes(8).toString("hex");
  const genPath = path.join(TMP, `${id}_gen.mp4`);
  const origPath = path.join(TMP, `${id}_orig.mp4`);
  const audioPath = path.join(TMP, `${id}_audio.aac`);
  const outPath = path.join(TMP, `${id}_final.mp4`);

  try {
    await download(generated_video_url, genPath);

    let hasAudio = false;
    if (original_video_url) {
      try {
        await download(original_video_url, origPath);
        await ffmpeg(["-i", origPath, "-vn", "-acodec", "aac", "-b:a", "128k", "-y", audioPath]);
        if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 100) hasAudio = true;
      } catch { /* no audio */ }
    }

    const filters = [];
    if (hook && hook.trim()) {
      const fontSize = hook_style?.fontSize || 28;
      const fontColor = (hook_style?.color || "#FFFFFF").replace("#", "");
      const pos = (hook_position || "top").toLowerCase();
      let yExpr = "h*0.08";
      if (pos === "center" || pos === "middle") yExpr = "(h-th)/2";
      else if (pos === "bottom") yExpr = "h*0.85-th";
      const escapedText = hook.replace(/\\/g, "\\\\\\\\").replace(/'/g, "'\\\\\\''").replace(/:/g, "\\\\:").replace(/%/g, "\\\\%");
      let drawtext = "drawtext=text='" + escapedText + "'" +
        ":fontsize=" + fontSize +
        ":fontcolor=0x" + fontColor +
        ":x=(w-tw)/2" +
        ":y=" + yExpr +
        ":shadowcolor=black:shadowx=2:shadowy=2" +
        ":borderw=2:bordercolor=black";
      const fontPath = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
      if (fs.existsSync(fontPath)) drawtext += ":fontfile=" + fontPath;
      filters.push(drawtext);
    }

    const args = ["-i", genPath];
    if (hasAudio) args.push("-i", audioPath);
    if (filters.length > 0) args.push("-vf", filters.join(","));
    if (hasAudio) { args.push("-map", "0:v:0", "-map", "1:a:0", "-shortest"); }
    else { args.push("-an"); }
    args.push("-c:v", "libx264", "-preset", "fast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-y", outPath);

    await ffmpeg(args, 300000);
    if (!fs.existsSync(outPath)) throw new Error("Merge failed");

    // Upload to WaveSpeed CDN if key provided
    if (ws_api_key) {
      const FormData = (await import("form-data")).default;
      const form = new FormData();
      form.append("file", fs.createReadStream(outPath), { filename: "reel.mp4", contentType: "video/mp4" });
      
      const uploadRes = await new Promise((resolve, reject) => {
        const options = {
          hostname: "api.wavespeed.ai",
          path: "/api/v3/media/upload/binary",
          method: "POST",
          headers: { ...form.getHeaders(), Authorization: "Bearer " + ws_api_key },
        };
        const req = https.request(options, (r) => {
          let body = "";
          r.on("data", (c) => body += c);
          r.on("end", () => {
            try { resolve(JSON.parse(body)); } catch { resolve({ error: body }); }
          });
        });
        req.on("error", reject);
        form.pipe(req);
      });

      const cdnUrl = uploadRes?.data?.url || uploadRes?.url;
      if (cdnUrl) {
        res.json({ success: true, resultUrl: cdnUrl, size_bytes: fs.statSync(outPath).size });
      } else {
        res.json({ success: true, resultUrl: null, error: "Upload failed: " + JSON.stringify(uploadRes).slice(0, 200), size_bytes: fs.statSync(outPath).size });
      }
    } else {
      // Fallback to base64
      const data = fs.readFileSync(outPath);
      res.json({ success: true, video_base64: data.toString("base64"), size_bytes: data.length });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    [genPath, origPath, audioPath, outPath].forEach((f) => { try { fs.unlinkSync(f); } catch {} });
  }
});

// ── BURN TEXT: upload a video file + text → returns video with text burned on top ──
app.post("/burn-text", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "video file required" });
  const text = req.body.text;
  if (!text || !text.trim()) return res.status(400).json({ error: "text required" });

  const id = crypto.randomBytes(8).toString("hex");
  const inputPath = req.file.path;
  const outPath = path.join(TMP, `${id}_burned.mp4`);

  try {
    const fontSize = parseInt(req.body.fontSize) || 38;
    const fontColor = (req.body.fontColor || "white").replace("#", "");
    const position = (req.body.position || "top").toLowerCase();
    const marginTop = parseInt(req.body.marginTop) || 60;

    let yExpr = `${marginTop}`;
    if (position === "center" || position === "middle") yExpr = "(h-th)/2";
    else if (position === "bottom") yExpr = "h-th-60";

    // Escape text for ffmpeg drawtext filter
    const escaped = text
      .replace(/\\/g, "\\\\\\\\")
      .replace(/'/g, "'\\\\\\''")
      .replace(/:/g, "\\\\:")
      .replace(/%/g, "\\\\%")
      .replace(/\[/g, "\\\\[")
      .replace(/\]/g, "\\\\]");

    // Build drawtext filter with background box for readability
    const bgColor = req.body.bgColor || "black@0.6";
    const drawtext =
      `drawtext=text='${escaped}'` +
      `:fontsize=${fontSize}` +
      `:fontcolor=${fontColor}` +
      `:x=(w-tw)/2` +
      `:y=${yExpr}` +
      `:box=1:boxcolor=${bgColor}:boxborderw=12` +
      `:shadowcolor=black:shadowx=1:shadowy=1` +
      `:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`;

    const args = [
      "-i", inputPath,
      "-vf", drawtext,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-c:a", "copy",
      "-movflags", "+faststart",
      "-y",
      outPath,
    ];

    await ffmpeg(args, 300000);
    if (!fs.existsSync(outPath)) throw new Error("Burn text failed — no output");

    // Stream file back as download
    const stat = fs.statSync(outPath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", `attachment; filename="hook_reel_${id}.mp4"`);
    const stream = fs.createReadStream(outPath);
    stream.pipe(res);
    stream.on("end", () => {
      try { fs.unlinkSync(outPath); } catch {}
      try { fs.unlinkSync(inputPath); } catch {}
    });
  } catch (e) {
    try { fs.unlinkSync(outPath); } catch {}
    try { fs.unlinkSync(inputPath); } catch {}
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`ffmpeg-reel-server listening on :${PORT}`));


