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
        else resolve(parseFloat(stdout));
      }
    );
  });
};

const downloadFile = async (url, outputPath) => {
  const writer = fs.createWriteStream(outputPath);
  const response = await axios({ url, method: "GET", responseType: "stream" });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
};

const mergeAudioFiles = async (filePaths, musicPath, outputPath) => {
  const inputs = filePaths
    .map((file, i) => `-i "${file}"`)
    .concat([`-i "${musicPath}"`])
    .join(" ");

  const filterComplexParts = filePaths.map((_, i) => `[${i}:a]`).join("") + `concat=n=${filePaths.length}:v=0:a=1[aud]`;
  const filter = `${filterComplexParts}; [aud][${filePaths.length}:a]amix=inputs=2:duration=first:dropout_transition=3[aout]`;

  return new Promise((resolve, reject) => {
    exec(
      `ffmpeg ${inputs} -filter_complex "${filter}" -map "[aout]" -y "${outputPath}"`,
      (error) => {
        if (error) reject(error);
        else resolve();
      }
    );
  });
};

const uploadToCloudinary = (filePath, folder) => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(
      filePath,
      { resource_type: "video", folder },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url);
      }
    );
  });
};

// Main Route
router.post("/merge", async (req, res) => {
  try {
    const { audioUrls, musicUrl, outputName } = req.body;
    if (!Array.isArray(audioUrls) || audioUrls.length === 0 || !musicUrl || !outputName) {
      return res.status(400).json({ error: "Missing required input" });
    }

    const tempDir = path.join(__dirname, "temp", uuidv4());
    fs.mkdirSync(tempDir, { recursive: true });

    const audioPaths = [];
    for (let i = 0; i < audioUrls.length; i++) {
      const audioPath = path.join(tempDir, `clip-${i}.mp3`);
      await downloadFile(audioUrls[i], audioPath);
      audioPaths.push(audioPath);
    }

    const musicPath = path.join(tempDir, "background.mp3");
    await downloadFile(musicUrl, musicPath);

    const finalOutput = path.join(tempDir, outputName);
    await mergeAudioFiles(audioPaths, musicPath, finalOutput);

    const cloudUrl = await uploadToCloudinary(finalOutput, "audio-webflow");

    fs.rmSync(tempDir, { recursive: true, force: true });

    return res.json({ url: cloudUrl });
  } catch (err) {
    console.error("🔥 Merge Error:", err);
    res.status(500).json({ error: "Failed to merge audio" });
  }
});

module.exports = router;
