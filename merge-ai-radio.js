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

// Download helper
const downloadFile = async (url, outputPath) => {
  const writer = fs.createWriteStream(outputPath);
  const response = await axios({ url, method: "GET", responseType: "stream" });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
};

// Merge helper
const mergeAudioFiles = async (filePaths, musicPath, outputPath) => {
  const tempDir = path.dirname(outputPath);
  const convertedDir = path.join(tempDir, "converted");
  fs.mkdirSync(convertedDir, { recursive: true });

  const convertedFiles = [];

  // Convert each clip to stereo, 44.1kHz
  for (let i = 0; i < filePaths.length; i++) {
    const input = filePaths[i];
    const output = path.join(convertedDir, `converted-${i}.mp3`);

    await new Promise((resolve, reject) => {
      exec(
        `ffmpeg -i "${input}" -ac 2 -ar 44100 -y "${output}"`,
        (err) => (err ? reject(err) : resolve())
      );
    });

    convertedFiles.push(output);
  }

  // Concatenate speech into single track
  const speechConcat = path.join(tempDir, "speech.mp3");
  const concatList = convertedFiles.map(fp => `file '${fp}'`).join("\n");
  const concatFile = path.join(tempDir, "concat.txt");
  fs.writeFileSync(concatFile, concatList);

  await new Promise((resolve, reject) => {
    exec(
      `ffmpeg -f concat -safe 0 -i "${concatFile}" -c:a libmp3lame -b:a 192k -ar 44100 -ac 2 -y "${speechConcat}"`,
      (err) => (err ? reject(err) : resolve())
    );
  });

  // Fade music (optional, but we’ll include it)
  const fadedMusic = path.join(tempDir, "music-faded.mp3");
  await new Promise((resolve, reject) => {
    exec(
      `ffmpeg -i "${musicPath}" -af "afade=t=in:ss=0:d=2,afade=t=out:st=18:d=2" -ar 44100 -ac 2 -y "${fadedMusic}"`,
      (err) => (err ? reject(err) : resolve())
    );
  });

  // Final concat of speech + music
  const finalList = `file '${speechConcat}'\nfile '${fadedMusic}'`;
  const finalListFile = path.join(tempDir, "final-list.txt");
  fs.writeFileSync(finalListFile, finalList);

  await new Promise((resolve, reject) => {
    exec(
      `ffmpeg -f concat -safe 0 -i "${finalListFile}" -c:a libmp3lame -b:a 256k -ar 44100 -ac 2 -y "${outputPath}"`,
      (err) => (err ? reject(err) : resolve())
    );
  });

  // Cleanup
  fs.rmSync(convertedDir, { recursive: true, force: true });
  fs.unlinkSync(concatFile);
  fs.unlinkSync(finalListFile);
  fs.unlinkSync(speechConcat);
  fs.unlinkSync(fadedMusic);
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

// Main route
router.post("/merge", async (req, res) => {
  console.log("🔥🔥🔥 MERGE-AUDIO REQUEST RECEIVED 🔥🔥🔥");
  console.log("🎧 Request body:", JSON.stringify(req.body, null, 2));

  try {
    const { files, audioUrls, musicUrl, outputName } = req.body;
    const inputUrls = audioUrls || files;

    if (!Array.isArray(inputUrls) || inputUrls.length === 0 || !musicUrl || !outputName) {
      return res.status(400).json({ error: "Missing required input" });
    }

    const tempDir = path.join(__dirname, "temp", uuidv4());
    fs.mkdirSync(tempDir, { recursive: true });

    const audioPaths = [];
    for (let i = 0; i < inputUrls.length; i++) {
      const audioPath = path.join(tempDir, `clip-${i}.mp3`);
      await downloadFile(inputUrls[i], audioPath);
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
