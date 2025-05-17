const express = require("express");
const axios = require("axios");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const cloudinary = require("cloudinary").v2;
const { exec } = require("child_process");
const path = require("path");
const router = express.Router();
const config = require("./settings.json");

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Helpers
const getAudioDuration = (filePath) => {
  return new Promise((resolve, reject) => {
    exec(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      (error, stdout) => {
        if (error) reject(error);
        else resolve(parseFloat(stdout.trim()));
      }
    );
  });
};

const getCompressorPreset = (presetName) => {
  switch ((presetName || "").toLowerCase()) {
    case "light":
      return "acompressor=threshold=-15dB:ratio=2:attack=20:release=300:makeup=2";
    case "radio":
      return "acompressor=threshold=-20dB:ratio=4:attack=10:release=250:makeup=4";
    case "crushed":
      return "acompressor=threshold=-40dB:ratio=20:attack=1:release=50:makeup=15";
    default:
      return "acompressor=threshold=-18dB:ratio=3:attack=15:release=200:makeup=3";
  }
};

router.post("/", async (req, res) => {
  console.log("🟡 Incoming merge request");
  console.log("📦 Body:", req.body);

  const { files, outputName } = req.body;

  if (!files || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: "Missing or invalid 'files' array" });
  }

  const silenceMs = config.silenceMs || 300;
  const fadeMs = config.fadeMs || 150;
  const preset = config.preset || "normal";
  const applyCompression = true;
  const compressor = applyCompression ? getCompressorPreset(preset) : "";
  const tempDir = `temp_${uuidv4()}`;
  const outputFile = outputName.endsWith(".mp3") ? outputName : `${outputName}.mp3`;
  const finalPath = path.join(tempDir, outputFile);

  let finalInputs = [];

  try {
    fs.mkdirSync(tempDir);

    for (let i = 0; i < files.length; i++) {
      const filePath = path.join(tempDir, `part${i}.mp3`);
      const fadePath = path.join(tempDir, `fade${i}.wav`);
      const silencePath = path.join(tempDir, `silence${i}.wav`);

      const response = await axios.get(files[i], { responseType: "stream" });
      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      const duration = await getAudioDuration(filePath);
      const fadeOutStart = Math.max(0, duration - fadeMs / 1000);

      const fadeCmd = `ffmpeg -i "${filePath}" -af "afade=t=in:st=0:d=${fadeMs / 1000},afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeMs / 1000}" -ar 44100 -ac 2 -y "${fadePath}"`;
      await new Promise((resolve, reject) => {
        exec(fadeCmd, (err) => (err ? reject(err) : resolve()));
      });

      finalInputs.push(fadePath);

      if (silenceMs > 0 && i < files.length - 1) {
        const silenceCmd = `ffmpeg -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -t ${silenceMs / 1000} -y "${silencePath}"`;
        await new Promise((resolve, reject) => {
          exec(silenceCmd, (err) => (err ? reject(err) : resolve()));
        });
        finalInputs.push(silencePath);
      }
    }

    const inputArgs = finalInputs.map((file) => `-i "${file}"`).join(" ");
    const concatFilter = `concat=n=${finalInputs.length}:v=0:a=1${compressor ? "," + compressor : ""}`;

    const ffmpegCmd = `ffmpeg ${inputArgs} -filter_complex "${concatFilter}" -acodec libmp3lame -b:a 192k -ar 24000 -y "${finalPath}"`;
    console.log("🎬 Running FFmpeg with:", ffmpegCmd);

    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (err) => (err ? reject(err) : resolve()));
    });

    // Upload final to Cloudinary
    const result = await cloudinary.uploader.upload(finalPath, {
      resource_type: "video",
      folder: "audio-webflow",
      public_id: outputFile.replace(".mp3", ""),
    });

    console.log("☁️ Uploaded final mix:", result.secure_url);

    // 🧹 Clean up chunked audio files from FFmpeg-converter folder
    try {
      const cleanup = await cloudinary.api.delete_resources_by_prefix("FFmpeg-converter/", {
        resource_type: "video",
        invalidate: true
      });
      console.log("🧹 Deleted source chunks:", cleanup);
    } catch (err) {
      console.warn("⚠️ Cloudinary cleanup failed:", err.message);
    }

    res.json({ finalUrl: result.secure_url });

  } catch (err) {
    console.error("🔥 Merge error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log("🧼 Temp directory cleaned up");
    } catch (cleanupErr) {
      console.warn("⚠️ Local cleanup failed:", cleanupErr.message);
    }
  }
});

module.exports = router;
