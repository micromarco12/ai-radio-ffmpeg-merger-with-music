const express = require("express");
const axios = require("axios");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const cloudinary = require("cloudinary").v2;
const { exec } = require("child_process");
const path = require("path");

// ✅ Utility function to get duration of an audio file
const getAudioDuration = (filePath) => {
  return new Promise((resolve, reject) => {
    exec(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      (error, stdout) => {
        if (error) return reject(error);
        resolve(parseFloat(stdout.trim()));
      }
    );
  });
};

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

  const alexPath = convertedFiles[musicInsertIndex];
  const musicInput = musicPath;
  const mixedOutput = path.join(tempDir, "mixed-intro.mp3");

  const alexDuration = await getAudioDuration(alexPath);
  const musicOffset = Math.max(0, Math.floor((alexDuration - 3) * 1000));

  await new Promise((resolve, reject) => {
    const cmd = `ffmpeg -i "${alexPath}" -i "${musicInput}" -filter_complex "[0:a]volume=2.5[a0];[1:a]adelay=${musicOffset}|${musicOffset},volume=0.3[bg];[a0][bg]amix=inputs=2:duration=longest:dropout_transition=3" -c:a libmp3lame -b:a 256k -y "${mixedOutput}"`;
    exec(cmd, (err) => (err ? reject(err) : resolve()));
  });

  const finalListPath = path.join(tempDir, "final-list.txt");
  const finalConcatList = [];

  for (let i = 0; i < convertedFiles.length; i++) {
    if (i === musicInsertIndex) {
      finalConcatList.push(`file '${mixedOutput}'`);
    } else {
      finalConcatList.push(`file '${convertedFiles[i]}'`);
    }
  }

  fs.writeFileSync(finalListPath, finalConcatList.join("\n"));

  await new Promise((resolve, reject) => {
    exec(`ffmpeg -f concat -safe 0 -i "${finalListPath}" -c:a libmp3lame -b:a 256k -ar 44100 -ac 2 -y "${outputPath}"`, (err) => err ? reject(err) : resolve());
  });

  fs.rmSync(convertedDir, { recursive: true, force: true });
  fs.unlinkSync(finalListPath);
  fs.unlinkSync(mixedOutput);
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

    audioPaths.forEach(p => {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });

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
