const express = require("express");
const axios = require("axios");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const cloudinary = require("cloudinary").v2;
const { exec } = require("child_process");
const path = require("path");

// Toggle to control music length during testing
const useShortMusic = true; 
const router = express.Router();
// const config = require("./settings.json"); // Not currently used

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

const mergeAudioFiles = async (filePaths, musicPath, outputPath, musicInsertIndex) => {
  const tempDir = path.dirname(outputPath);
  const convertedDir = path.join(tempDir, "converted");
  fs.mkdirSync(convertedDir, { recursive: true });

  console.log("Dialogue clips to convert:", filePaths);
  const convertedFiles = [];
  for (let i = 0; i < filePaths.length; i++) {
    const input = filePaths[i];
    const output = path.join(convertedDir, `converted-${i}.mp3`);
    await new Promise((resolve, reject) => {
      exec(`ffmpeg -i "${input}" -ac 2 -ar 44100 -y "${output}"`, (err, stdout, stderr) => {
        if (err) { console.error(`FFMPEG conversion error for ${input}: ${stderr}`); return reject(err); }
        resolve();
      });
    });
    convertedFiles.push(output);
  }
  console.log("Converted dialogue files created.");

  const originalMusicInputPath = musicPath;
  const fadedMusicPath = path.join(tempDir, "music-faded.mp3");
  let durationMusic = 0;

  if (useShortMusic) {
    await new Promise((resolve, reject) => {
      exec(`ffmpeg -i "${originalMusicInputPath}" -t 30 -af "afade=t=in:ss=0:d=2,afade=t=out:st=28:d=2" -ar 44100 -ac 2 -y "${fadedMusicPath}"`, (err, stdout, stderr) => {
        if (err) { console.error(`FFMPEG short music processing error for ${originalMusicInputPath}: ${stderr}`); return reject(err); }
        resolve();
      });
    });
    // Get duration of the actually created fadedMusicPath for accuracy
    if (fs.existsSync(fadedMusicPath)) { try { durationMusic = await getAudioDuration(fadedMusicPath); } catch(e){ console.error("Could not get duration for short fadedMusicPath", e); throw e;} } else { throw new Error(`Short processed music file not found: ${fadedMusicPath}`); }

  } else {
    await new Promise((resolve, reject) => {
      exec(`ffmpeg -i "${originalMusicInputPath}" -af "afade=t=in:ss=0:d=2" -ar 44100 -ac 2 -y "${fadedMusicPath}"`, (err, stdout, stderr) => {
        if (err) { console.error(`FFMPEG full music processing error for ${originalMusicInputPath}: ${stderr}`); return reject(err); }
        resolve();
      });
    });
    if (fs.existsSync(fadedMusicPath)) { try { durationMusic = await getAudioDuration(fadedMusicPath); } catch(e){ console.error("Could not get duration for full fadedMusicPath", e); throw e;} } else { throw new Error(`Full processed music file not found: ${fadedMusicPath}`); }
  }
  console.log("Processed music file created:", fadedMusicPath, "Duration:", durationMusic, "s");

  let durationAlexAnnounce = 0;
  const overlapTimeSeconds = 3.0;

  if (musicInsertIndex < 0 || musicInsertIndex >= convertedFiles.length) {
    throw new Error(`Invalid musicInsertIndex ${musicInsertIndex} for convertedFiles array of length ${convertedFiles.length}`);
  }
  const alexAnnouncePath = convertedFiles[musicInsertIndex];

  try {
    if (alexAnnouncePath && fs.existsSync(alexAnnouncePath)) {
      durationAlexAnnounce = await getAudioDuration(alexAnnouncePath);
      console.log(`Alex Announce Clip: ${alexAnnouncePath}, Duration: ${durationAlexAnnounce}s`);
    } else { 
        console.warn(`Alex announcement clip path not found: ${alexAnnouncePath}`); 
        durationAlexAnnounce = 0;
    }
    
    if (durationAlexAnnounce > 0 && durationAlexAnnounce < overlapTimeSeconds) {
      console.warn(`Warning: Alex's announcement (${durationAlexAnnounce}s) is shorter than overlap time (${overlapTimeSeconds}s). Overlap will be ${durationAlexAnnounce}s.`);
    }
  } catch (err) { console.error("Error getting Alex announce duration:", err.message); throw err; }

  const transition1File = path.join(tempDir, "transition1_announce_ducked.mp3");
  // Ensure music starts playing 'overlapTimeSeconds' before Alex finishes.
  // If Alex's speech is shorter than overlap, music starts at beginning of Alex's speech.
  const actualAnnounceOverlap = Math.min(durationAlexAnnounce, overlapTimeSeconds);
  const musicStartDelayMs = Math.max(0, durationAlexAnnounce - actualAnnounceOverlap) * 1000;

  const duckThreshold = "0.12"; 
  const duckRatio = "5";
  const duckAttack = "50"; 
  const duckRelease = "500"; 

  let ffmpegTransition1Command = `ffmpeg -i "${alexAnnouncePath}" -i "${fadedMusicPath}" `;
  ffmpegTransition1Command += `-filter_complex "[0:a]asplit[alex_main][alex_sc]; `;
  ffmpegTransition1Command += `[1:a]adelay=${musicStartDelayMs}|${musicStartDelayMs}[delayed_music]; `;
  ffmpegTransition1Command += `[alex_sc][delayed_music]sidechaincompress=threshold=${duckThreshold}:ratio=${duckRatio}:attack=${duckAttack}:release=${duckRelease}[ducked_music_stream]; `;
  ffmpegTransition1Command += `[alex_main][ducked_music_stream]amix=inputs=2:duration=first:dropout_transition=${actualAnnounceOverlap}[mixed_output]" `;
  ffmpegTransition1Command += `-map "[mixed_output]" -c:a libmp3lame -b:a 192k -ar 44100 -ac 2 -y "${transition1File}"`;

  console.log("Executing FFMPEG for Transition 1 (Announce Outro/Music Intro):");
  console.log(ffmpegTransition1Command);
  await new Promise((resolve, reject) => {
    exec(ffmpegTransition1Command, (err, stdout, stderr) => {
      if (err) {
        console.error(`FFMPEG Transition 1 error: ${stderr}`);
        console.error(`FFMPEG Transition 1 stdout: ${stdout}`);
        return reject(err);
      }
      console.log("Transition 1 (announce with music intro) created successfully:", transition1File);
      resolve();
    });
  });

  console.log("Creating final concatenation list...");
  const finalListPath = path.join(tempDir, "final-list.txt");
  const finalConcatList = [];

  for (let i = 0; i < musicInsertIndex; i++) {
    finalConcatList.push(`file '${convertedFiles[i]}'`);
  }
  finalConcatList.push(`file '${transition1File}'`);

  const musicPlayedInTransition1 = actualAnnounceOverlap; 
  const musicNeededForOutroLater = overlapTimeSeconds; // Placeholder for now
  let mainMusicBodyDuration = durationMusic - musicPlayedInTransition1 - musicNeededForOutroLater;
  
  const musicMainBodyFile = path.join(tempDir, "music_main_body.mp3");

  if (mainMusicBodyDuration > 0.1) {
    const musicBodyStartTime = musicPlayedInTransition1;
    const ffmpegMusicBodyCommand = `ffmpeg -i "${fadedMusicPath}" -ss ${musicBodyStartTime} -t ${mainMusicBodyDuration} -c copy -y "${musicMainBodyFile}"`;
    console.log("Creating main music body segment:", ffmpegMusicBodyCommand);
    await new Promise((resolve, reject) => {
        exec(ffmpegMusicBodyCommand, (err, stdout, stderr) => {
        if (err) { console.error(`FFMPEG main music body error: ${stderr}`); return reject(err); }
        finalConcatList.push(`file '${musicMainBodyFile}'`);
        console.log("Main music body segment created:", musicMainBodyFile);
        resolve();
        });
    });
  } else {
    console.log("Music duration too short for a separate main body or main body duration is negligible.");
  }

  // Add dialogue clips after the point where the second transition (welcome back) would end.
  // For now, this means starting after Alex's Welcome Back clip (index musicInsertIndex + 2).
  // We skip Jamie's SILENT turn (musicInsertIndex + 1).
  for (let i = musicInsertIndex + 2; i < convertedFiles.length; i++) {
      if (i === (musicInsertIndex + 1)) { 
        console.log(`Skipping potential SILENT turn file in concatenation (index ${i}): ${convertedFiles[i]}`);
        continue; 
      }
    finalConcatList.push(`file '${convertedFiles[i]}'`);
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
    if (fs.existsSync(fadedMusicPath)) fs.unlinkSync(fadedMusicPath);
    if (fs.existsSync(transition1File)) fs.unlinkSync(transition1File);
    if (fs.existsSync(musicMainBodyFile)) fs.unlinkSync(musicMainBodyFile);
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
    console.error(`[${operationId}] Missing required input.`);
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
      await downloadFile(inputUrls[i], audioPath);
      audioPaths.push(audioPath);
    }
    console.log(`[${operationId}] All dialogue clips downloaded.`);

    const musicPath = path.join(tempDir, "background-music-original.mp3");
    await downloadFile(musicUrl, musicPath);
    console.log(`[${operationId}] Music downloaded.`);

    const finalOutput = path.join(tempDir, outputName);
    console.log(`[${operationId}] Starting mergeAudioFiles function. Output will be: ${finalOutput}`);
    await mergeAudioFiles(audioPaths, musicPath, finalOutput, mBreakIndex);
    console.log(`[${operationId}] mergeAudioFiles function completed.`);

    console.log(`[${operationId}] Uploading final output to Cloudinary: ${finalOutput}`);
    const cloudUrl = await uploadToCloudinary(finalOutput, "audio-webflow", outputName);
    console.log(`[${operationId}] Upload to Cloudinary successful. URL: ${cloudUrl}`);

    console.log(`[${operationId}] Cleaning up local downloaded dialogue clips...`);
    audioPaths.forEach(p => {
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch (e) { console.warn(`[${operationId}] Warn: Failed to delete local dialogue clip ${p}: ${e.message}`); }
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
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (cleanupErr) { console.error(`[${operationId}] Error during cleanup on error: ${cleanupErr.message}`);}
    }
    res.status(500).json({ error: "Failed to merge audio", details: err.message });
  }
});

module.exports = router;
