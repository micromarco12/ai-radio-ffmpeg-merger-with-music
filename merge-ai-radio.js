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
// const config = require("./settings.json"); // Not currently used, can be uncommented if needed later

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

// Helper function to get audio duration using ffprobe
const getAudioDuration = (filePath) => {
  return new Promise((resolve, reject) => {
    const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`FFprobe stderr for ${filePath}: ${stderr}`);
        if (stderr && stderr.includes("No such file or directory")) {
            return reject(new Error(`FFprobe failed: File not found at ${filePath}. ${stderr}`));
        } else if (stderr && stderr.includes("Invalid data found when processing input")) {
            return reject(new Error(`FFprobe failed: Invalid data or not an audio file at ${filePath}. ${stderr}`));
        }
        return reject(new Error(`FFprobe execution failed for ${filePath}: ${error?.message || stderr || 'Unknown ffprobe error'}`));
      }
      if (!stdout || stdout.trim() === '') {
        return reject(new Error(`FFprobe returned empty duration for ${filePath}. Is it a valid audio file and is ffprobe in PATH?`));
      }
      resolve(parseFloat(stdout.trim()));
    });
  });
};

// Function to upload to Cloudinary (from your original script structure)
const uploadToCloudinary = (filePath, folder, outputName) => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(
      filePath,
      {
        resource_type: "video", // Assuming audio is treated as video for storage if mp3
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

const mergeAudioFiles = async (filePaths, musicPath, outputPath, musicInsertIndex) => {
  const tempDir = path.dirname(outputPath);
  const convertedDir = path.join(tempDir, "converted");
  fs.mkdirSync(convertedDir, { recursive: true });

  console.log("Dialogue clips to convert:", filePaths);
  const convertedFiles = [];
  for (let i = 0; i < filePaths.length; i++) {
    const input = filePaths[i];
    const output = path.join(convertedDir, `converted-${i}.mp3`);
    console.log(`Converting dialogue clip: ${input} to ${output}`);
    await new Promise((resolve, reject) => {
      exec(`ffmpeg -i "${input}" -ac 2 -ar 44100 -y "${output}"`, (err, stdout, stderr) => {
        if (err) {
          console.error(`FFMPEG conversion error for ${input}: ${stderr}`);
          return reject(err);
        }
        resolve();
      });
    });
    convertedFiles.push(output);
  }
  console.log("Converted dialogue files:", convertedFiles);

  const fadedMusic = path.join(tempDir, "music-faded.mp3");
  console.log(`Processing music file: ${musicPath} to ${fadedMusic}`);

  if (useShortMusic) {
    await new Promise((resolve, reject) => {
      exec(`ffmpeg -i "${musicPath}" -t 30 -af "afade=t=in:ss=0:d=2,afade=t=out:st=28:d=2" -ar 44100 -ac 2 -y "${fadedMusic}"`, (err, stdout, stderr) => {
        if (err) {
          console.error(`FFMPEG short music processing error for ${musicPath}: ${stderr}`);
          return reject(err);
        }
        resolve();
      });
    });
  } else {
    await new Promise((resolve, reject) => {
      exec(`ffmpeg -i "${musicPath}" -af "afade=t=in:ss=0:d=2" -ar 44100 -ac 2 -y "${fadedMusic}"`, (err, stdout, stderr) => {
        if (err) {
          console.error(`FFMPEG full music processing error for ${musicPath}: ${stderr}`);
          return reject(err);
        }
        resolve();
      });
    });
  }
  console.log("Processed music file created:", fadedMusic);

  // --- GET DURATIONS ---
  let durationAlexAnnounce = 0;
  let durationMusic = 0;
  let durationAlexWelcome = 0;
  const overlapTimeSeconds = 3.0;

  if (musicInsertIndex < 0 || musicInsertIndex >= convertedFiles.length) {
    throw new Error(`Invalid musicInsertIndex ${musicInsertIndex} for convertedFiles array of length ${convertedFiles.length}`);
  }
  const alexAnnouncePath = convertedFiles[musicInsertIndex];

  let alexWelcomePath;
  if (musicInsertIndex + 2 < convertedFiles.length) {
    alexWelcomePath = convertedFiles[musicInsertIndex + 2];
  } else {
    console.warn(`Not enough audio clips after musicInsertIndex to identify Alex's welcome back at index ${musicInsertIndex + 2}. Skipping duration fetch for it.`);
  }

  try {
    if (alexAnnouncePath && fs.existsSync(alexAnnouncePath)) {
      durationAlexAnnounce = await getAudioDuration(alexAnnouncePath);
      console.log(`Alex Announce Clip: ${alexAnnouncePath}, Duration: ${durationAlexAnnounce}s`);
    } else {
      console.warn(`Alex announcement clip path not found or invalid: ${alexAnnouncePath}. Using duration 0.`);
    }
    
    if (fs.existsSync(fadedMusic)) {
      durationMusic = await getAudioDuration(fadedMusic);
      console.log(`Music Clip: ${fadedMusic}, Duration: ${durationMusic}s`);
    } else {
      throw new Error(`Processed music file not found: ${fadedMusic}`);
    }

    if (alexWelcomePath && fs.existsSync(alexWelcomePath)) {
      durationAlexWelcome = await getAudioDuration(alexWelcomePath);
      console.log(`Alex Welcome Clip: ${alexWelcomePath}, Duration: ${durationAlexWelcome}s`);
    } else {
      console.warn(`Alex welcome back clip path not found or invalid: ${alexWelcomePath}. Using duration 0.`);
    }

    if (durationAlexAnnounce > 0 && durationAlexAnnounce <= overlapTimeSeconds) {
      console.warn(`Warning: Alex's announcement clip (${durationAlexAnnounce}s) is shorter/equal to overlap time (${overlapTimeSeconds}s). Ducking intro might be problematic.`);
    }
    if (durationMusic > 0 && durationMusic <= overlapTimeSeconds * 2) {
      console.warn(`Warning: Music clip (${durationMusic}s) is very short relative to overlaps.`);
    }

  } catch (err) {
    console.error("Error getting audio durations:", err.message);
    throw err; 
  }
  // --- END GET DURATIONS ---

  // Original FFMPEG concat logic (to be replaced later with ducking logic)
  console.log("Creating final concatenation list...");
  const finalListPath = path.join(tempDir, "final-list.txt");
  const finalConcatList = [];
  for (let i = 0; i < convertedFiles.length; i++) {
    finalConcatList.push(`file '${convertedFiles[i]}'`);
    if (i === musicInsertIndex) {
      console.log(`Adding music file '${fadedMusic}' to concat list after clip index ${i}`);
      finalConcatList.push(`file '${fadedMusic}'`);
    }
  }
  fs.writeFileSync(finalListPath, finalConcatList.join("\n"));
  console.log("Concatenation list created:", finalListPath);
  console.log("Final concatenation list content:\n", finalConcatList.join("\n"));
  console.log(`Starting final concatenation to: ${outputPath}`);

  await new Promise((resolve, reject) => {
    exec(`ffmpeg -f concat -safe 0 -i "${finalListPath}" -c:a libmp3lame -b:a 256k -ar 44100 -ac 2 -y "${outputPath}"`, (err, stdout, stderr) => {
      if (err) {
        console.error(`FFMPEG final concatenation error: ${stderr}`);
        return reject(err);
      }
      console.log("Final concatenation successful.");
      resolve();
    });
  });

  console.log("Cleaning up temporary files...");
  try {
    if (fs.existsSync(convertedDir)) fs.rmSync(convertedDir, { recursive: true, force: true });
    if (fs.existsSync(finalListPath)) fs.unlinkSync(finalListPath);
    if (fs.existsSync(fadedMusic)) fs.unlinkSync(fadedMusic);
  } catch (cleanupErr) {
    console.warn("Warning: Error during cleanup of some temporary files:", cleanupErr.message);
  }
  console.log("Temporary files cleanup attempt finished.");
};

router.post("/merge", async (req, res) => {
  const operationId = uuidv4();
  console.log(`\n--- Operation ID: ${operationId} ---`);
  console.log(`[${operationId}] 🔥🔥🔥 MERGE-AUDIO REQUEST RECEIVED 🔥🔥🔥`);
  console.log(`[${operationId}] 🎧 Request body:`, JSON.stringify(req.body, null, 2));

  const { files, audioUrls, musicUrl, outputName, musicBreakIndex } = req.body;
  const inputUrls = audioUrls || files;

  if (!Array.isArray(inputUrls) || inputUrls.length === 0 || !musicUrl || !outputName || musicBreakIndex === undefined) {
    console.error(`[${operationId}] Missing required input. Provided: inputUrls=${Array.isArray(inputUrls) ? inputUrls.length : 'not an array/undefined'}, musicUrl=${!!musicUrl}, outputName=${!!outputName}, musicBreakIndex=${musicBreakIndex}`);
    return res.status(400).json({ error: "Missing required input: audioUrls (array), musicUrl, outputName, and musicBreakIndex are required." });
  }
  
  const mBreakIndex = parseInt(musicBreakIndex, 10);
  if (isNaN(mBreakIndex)) {
      console.error(`[${operationId}] Invalid musicBreakIndex: not a number. Value: ${musicBreakIndex}`);
      return res.status(400).json({ error: `Invalid musicBreakIndex: must be a number. Value: ${musicBreakIndex}` });
  }

  const tempDir = path.join(__dirname, "temp", operationId);
  console.log(`[${operationId}] Creating temporary directory: ${tempDir}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const audioPaths = [];
    console.log(`[${operationId}] Downloading ${inputUrls.length} dialogue clips...`);
    for (let i = 0; i < inputUrls.length; i++) {
      const audioPath = path.join(tempDir, `dialogue-clip-${i}.mp3`);
      console.log(`[${operationId}] Downloading dialogue clip ${i}: ${inputUrls[i]} to ${audioPath}`);
      await downloadFile(inputUrls[i], audioPath);
      audioPaths.push(audioPath);
    }
    console.log(`[${operationId}] All dialogue clips downloaded.`);

    const musicPath = path.join(tempDir, "background-music-original.mp3");
    console.log(`[${operationId}] Downloading music: ${musicUrl} to ${musicPath}`);
    await downloadFile(musicUrl, musicPath);
    console.log(`[${operationId}] Music downloaded.`);

    const finalOutput = path.join(tempDir, outputName);
    console.log(`[${operationId}] Starting mergeAudioFiles function. Output will be: ${finalOutput}`);
    await mergeAudioFiles(audioPaths, musicPath, finalOutput, mBreakIndex);
    console.log(`[${operationId}] mergeAudioFiles function completed.`);

    console.log(`[${operationId}] Uploading final output to Cloudinary: ${finalOutput}`);
    const cloudUrl = await uploadToCloudinary(finalOutput, "audio-webflow", outputName); // This call should now work
    console.log(`[${operationId}] Upload to Cloudinary successful. URL: ${cloudUrl}`);

    console.log(`[${operationId}] Cleaning up local downloaded dialogue clips...`);
    audioPaths.forEach(p => {
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch (e) {
          console.warn(`[${operationId}] Warn: Failed to delete local dialogue clip ${p}: ${e.message}`);
        }
      }
    });

    console.log(`[${operationId}] Attempting Cloudinary source chunk cleanup...`);
    try {
      const cleanup = await cloudinary.api.delete_resources_by_prefix("FFmpeg-converter/", {
        resource_type: "video",
        invalidate: true
      });
      console.log(`[${operationId}] 🧹 Cloudinary source chunk cleanup result:`, cleanup.deleted && typeof cleanup.deleted === 'object' ? Object.keys(cleanup.deleted) : cleanup.deleted_counts || cleanup);
    } catch (err) {
      console.warn(`[${operationId}] ⚠️ Cloudinary cleanup failed:`, err.message || err);
    }

    console.log(`[${operationId}] Removing temporary directory: ${tempDir}`);
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    console.log(`[${operationId}] ✅ MERGE-AUDIO REQUEST COMPLETED SUCCESSFULLY for ${outputName}`);
    return res.json({ url: cloudUrl });

  } catch (err) {
    console.error(`[${operationId}] 🔥 Merge Error:`, err.message || err);
    console.error(`[${operationId}] Full error object:`, err);
    if (fs.existsSync(tempDir)) {
        console.log(`[${operationId}] Cleaning up temporary directory due to error: ${tempDir}`);
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (cleanupErr) {
            console.error(`[${operationId}] Error during cleanup on error: ${cleanupErr.message}`);
        }
    }
    res.status(500).json({ error: "Failed to merge audio", details: err.message });
  }
});

module.exports = router;
