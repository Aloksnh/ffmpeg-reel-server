const express = require("express");
const cors = require("cors");
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`ffmpeg-reel-server listening on :${PORT}`));
