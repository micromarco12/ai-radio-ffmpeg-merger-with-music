const express = require("express");
const axios = require("axios");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const cloudinary = require("cloudinary").v2;
const { exec } = require("child_process");
const path = require("path");
// Toggle to control music length during testing
const useShortMusic = true; // ✅ Set to false when you're ready for full songs
const router = express.Router();
const config = require("./settings.json");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const downloadFile = async (url, outputPath) => {
  const writer = fs.createWriteStream(outputPath);
  const response = await axios({ url, method: "GET", responseType: "stream" });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
};

const mergeAudioFiles = async (filePaths, musicPath, outputPath, musicInsertIndex) => {
  const tempDir = path.dirname(outputPath);
  const convertedDir = path.join(tempDir, "converted");
  fs.mkdirSync(convertedDir, { recursive: true });

  const convertedFiles = [];

  for (let i = 0; i < filePaths.length; i++) {
    const input = filePaths[i];
    const output = path.join(convertedDir, `converted-${i}.mp3`);
    await new Promise((resolve, reject) => {
      exec(`ffmpeg -i "${input}" -ac 2 -ar 44100 -y "${output}"`, (err) => err ? reject(err) : resolve());
    });
    convertedFiles.push(output);
  }

const fadedMusic = path.join(tempDir, "music-faded.mp3");

if (useShortMusic) {
  // Short version: fade in/out and trim to 30s
  await new Promise((resolve, reject) => {
    exec(`ffmpeg -i "${musicPath}" -t 30 -af "afade=t=in:ss=0:d=2,afade=t=out:st=28:d=2" -ar 44100 -ac 2 -y "${fadedMusic}"`, (err) => err ? reject(err) : resolve());
  });
} else {
  // Full version: just fade in
  await new Promise((resolve, reject) => {
    exec(`ffmpeg -i "${musicPath}" -af "afade=t=in:ss=0:d=2" -ar 44100 -ac 2 -y "${fadedMusic}"`, (err) => err ? reject(err) : resolve());
  });
}

  const finalListPath = path.join(tempDir, "final-list.txt");
  const finalConcatList = [];

  for (let i = 0; i < convertedFiles.length; i++) {
    finalConcatList.push(`file '${convertedFiles[i]}'`);
    if (i === musicInsertIndex) {
      finalConcatList.push(`file '${fadedMusic}'`);
    }
  }

  fs.writeFileSync(finalListPath, finalConcatList.join("\n"));

  await new Promise((resolve, reject) => {
    exec(`ffmpeg -f concat -safe 0 -i "${finalListPath}" -c:a libmp3lame -b:a 256k -ar 44100 -ac 2 -y "${outputPath}"`, (err) => err ? reject(err) : resolve());
  });

  fs.rmSync(convertedDir, { recursive: true, force: true });
  fs.unlinkSync(finalListPath);
  fs.unlinkSync(fadedMusic);
};

const uploadToCloudinary = (filePath, folder, outputName) => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(
      filePath,
      {
        resource_type: "video",
        folder,
        public_id: path.parse(outputName).name,
        overwrite: true,
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url);
      }
    );
  });
};

router.post("/merge", async (req, res) => {
  console.log("🔥🔥🔥 MERGE-AUDIO REQUEST RECEIVED 🔥🔥🔥");
  console.log("🎧 Request body:", JSON.stringify(req.body, null, 2));

  try {
    const { files, audioUrls, musicUrl, outputName, musicBreakIndex } = req.body;
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
    await mergeAudioFiles(audioPaths, musicPath, finalOutput, musicBreakIndex);

    const cloudUrl = await uploadToCloudinary(finalOutput, "audio-webflow", outputName);

    // CLEANUP downloaded speech clips
    audioPaths.forEach(p => {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });

    // ✅ NEW: CLEANUP Cloudinary source chunks
    try {
      const cleanup = await cloudinary.api.delete_resources_by_prefix("FFmpeg-converter/", {
        resource_type: "video",
        invalidate: true
      });
      console.log("🧹 Deleted Cloudinary source chunks:", cleanup);
    } catch (err) {
      console.warn("⚠️ Cloudinary cleanup failed:", err.message);
    }

    fs.rmSync(tempDir, { recursive: true, force: true });

    return res.json({ url: cloudUrl });
  } catch (err) {
    console.error("🔥 Merge Error:", err);
    res.status(500).json({ error: "Failed to merge audio" });
  }
});

module.exports = router;
