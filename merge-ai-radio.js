const express = require("express");
const axios = require("axios");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const cloudinary = require("cloudinary").v2;
const { exec } = require("child_process");
const path = require("path");

const useShortMusic = true; 
const router = express.Router();

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
    // console.log(`Converting dialogue clip: ${input} to ${output}`); // Less verbose
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
  console.log("Converted dialogue files created.");

  const fadedMusic = path.join(tempDir, "music-faded.mp3");
  // console.log(`Processing music file: ${musicPath} to ${fadedMusic}`); // Less verbose
  if (useShortMusic) {
    await new Promise((resolve, reject) => {
      exec(`ffmpeg -i "${musicPath}" -t 30 -af "afade=t=in:ss=0:d=2,afade=t=out:st=28:d=2" -ar 44100 -ac 2 -y "${fadedMusic}"`, (err, stdout, stderr) => {
        if (err) { console.error(`FFMPEG short music processing error for ${musicPath}: ${stderr}`); return reject(err); }
        resolve();
      });
    });
  } else {
    await new Promise((resolve, reject) => {
      exec(`ffmpeg -i "${musicPath}" -af "afade=t=in:ss=0:d=2" -ar 44100 -ac 2 -y "${fadedMusic}"`, (err, stdout, stderr) => {
        if (err) { console.error(`FFMPEG full music processing error for ${musicPath}: ${stderr}`); return reject(err); }
        resolve();
      });
    });
  }
  console.log("Processed music file created:", fadedMusic);

  let durationAlexAnnounce = 0;
  let durationMusic = 0;
  // let durationAlexWelcome = 0; // We'll use this later
  const overlapTimeSeconds = 3.0;

  if (musicInsertIndex < 0 || musicInsertIndex >= convertedFiles.length) {
    throw new Error(`Invalid musicInsertIndex ${musicInsertIndex} for convertedFiles array of length ${convertedFiles.length}`);
  }
  const alexAnnouncePath = convertedFiles[musicInsertIndex];
  // const alexWelcomePath = musicInsertIndex + 2 < convertedFiles.length ? convertedFiles[musicInsertIndex + 2] : null; // For later

  try {
    if (alexAnnouncePath && fs.existsSync(alexAnnouncePath)) {
      durationAlexAnnounce = await getAudioDuration(alexAnnouncePath);
      console.log(`Alex Announce Clip: ${alexAnnouncePath}, Duration: ${durationAlexAnnounce}s`);
    } else { console.warn(`Alex announcement clip path not found: ${alexAnnouncePath}`); }
    
    if (fs.existsSync(fadedMusic)) {
      durationMusic = await getAudioDuration(fadedMusic);
      console.log(`Music Clip: ${fadedMusic}, Duration: ${durationMusic}s`);
    } else { throw new Error(`Processed music file not found: ${fadedMusic}`); }

    // if (alexWelcomePath && fs.existsSync(alexWelcomePath)) { // For later
    //   durationAlexWelcome = await getAudioDuration(alexWelcomePath);
    //   console.log(`Alex Welcome Clip: ${alexWelcomePath}, Duration: ${durationAlexWelcome}s`);
    // } else { console.warn(`Alex welcome back clip path not found: ${alexWelcomePath}`); }

    if (durationAlexAnnounce > 0 && durationAlexAnnounce <= overlapTimeSeconds) {
      console.warn(`Warning: Alex's announcement (${durationAlexAnnounce}s) is too short for the full ${overlapTimeSeconds}s overlap.`);
    }
  } catch (err) { console.error("Error getting audio durations:", err.message); throw err; }

  // --- NEW FFMPEG LOGIC FOR TRANSITION 1 ---
  const transition1Output = path.join(tempDir, "transition1_announce_ducked.mp3");
  const musicStartTimeInAnnounce = Math.max(0, durationAlexAnnounce - overlapTimeSeconds); // In seconds
  const musicDelayMs = musicStartTimeInAnnounce * 1000;

  // Ducking parameters (can be tweaked)
  const duckingThreshold = "0.1"; // approx -20dB assuming peak is 1.0
  const duckingRatio = "5";
  const duckingAttack = "50"; // ms
  const duckingRelease = "500"; // ms

  // This command creates the first transition: Alex's full announcement,
  // with music starting 'overlapTimeSeconds' before he ends, ducked under him.
  const ffmpegTransition1Command = `ffmpeg -i "${alexAnnouncePath}" -i "${fadedMusic}" -filter_complex "[0:a]asplit[alex_main][alex_sidechain]; [1:a]adelay=${musicDelayMs}|${musicDelayMs}[delayed_music]; [alex_sidechain][delayed_music]sidechaincompress=threshold=${duckingThreshold}:ratio=${duckingRatio}:attack=${duckingAttack}:release=${duckingRelease}[ducked_music]; [alex_main][ducked_music]amix=inputs=2:duration=first[mixed_output]" -map "[mixed_output]" -c:a libmp3lame -b:a 192k -ar 44100 -ac 2 -y "${transition1Output}"`;

  console.log("Executing FFMPEG for Transition 1 (Announce Outro/Music Intro):");
  console.log(ffmpegTransition1Command);
  await new Promise((resolve, reject) => {
    exec(ffmpegTransition1Command, (err, stdout, stderr) => {
      if (err) {
        console.error(`FFMPEG Transition 1 error: ${stderr}`);
        return reject(err);
      }
      console.log("Transition 1 created successfully:", transition1Output);
      resolve();
    });
  });
  // --- END FFMPEG LOGIC FOR TRANSITION 1 ---

  // --- MODIFIED Concatenation List for THIS TEST ---
  // This is simplified to test transition1. We will make it more complete later.
  console.log("Creating simplified final concatenation list for testing Transition 1...");
  const finalListPath = path.join(tempDir, "final-list.txt");
  const finalConcatList = [];

  // 1. Add clips before Alex's announcement
  for (let i = 0; i < musicInsertIndex; i++) {
    finalConcatList.push(`file '${convertedFiles[i]}'`);
  }

  // 2. Add the new transition1 clip (which contains Alex's full announcement + music intro)
  finalConcatList.push(`file '${transition1Output}'`);

  // 3. Add the rest of the music (for this test, let's trim it simply)
  // The music in transition1 played for overlapTimeSeconds from its start.
  // So, the rest of the music starts from overlapTimeSeconds.
  if (durationMusic > overlapTimeSeconds) {
    const musicRestPath = path.join(tempDir, "music_rest.mp3");
    const musicRestStartTime = overlapTimeSeconds;
    // For now, let's just take the remainder of the fadedMusic (which might be short if useShortMusic=true)
    // Later we'll calculate precisely how much music to play before the next transition.
    const musicRestDuration = durationMusic - overlapTimeSeconds; 
    if (musicRestDuration > 0) {
        const ffmpegMusicRestCommand = `ffmpeg -i "${fadedMusic}" -ss ${musicRestStartTime} -t ${musicRestDuration} -c:a libmp3lame -b:a 192k -ar 44100 -ac 2 -y "${musicRestPath}"`;
        console.log("Creating rest of music segment:", ffmpegMusicRestCommand);
        await new Promise((resolve, reject) => {
            exec(ffmpegMusicRestCommand, (err, stdout, stderr) => {
            if (err) { console.error(`FFMPEG music rest error: ${stderr}`); return reject(err); }
            finalConcatList.push(`file '${musicRestPath}'`);
            resolve();
            });
        });
    } else {
        console.log("No significant music duration left after intro overlap.");
    }
  }

  // 4. Add clips after Alex's welcome back (for this test, starting from musicInsertIndex + 2)
  // We are SKIPPING Jamie's silent turn (musicInsertIndex + 1) and Alex's welcome (musicInsertIndex + 2) for now,
  // as the welcome back transition isn't built yet.
  for (let i = musicInsertIndex + 3; i < convertedFiles.length; i++) {
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
    if (fs.existsSync(fadedMusic)) fs.unlinkSync(fadedMusic);
    if (fs.existsSync(transition1Output)) fs.unlinkSync(transition1Output);
    const musicRestPathCheck = path.join(tempDir, "music_rest.mp3");
    if (fs.existsSync(musicRestPathCheck)) fs.unlinkSync(musicRestPathCheck);

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
      // console.log(`[${operationId}] Downloading dialogue clip ${i}: ${inputUrls[i]} to ${audioPath}`); // Less verbose
      await downloadFile(inputUrls[i], audioPath);
      audioPaths.push(audioPath);
    }
    console.log(`[${operationId}] All dialogue clips downloaded.`);

    const musicPath = path.join(tempDir, "background-music-original.mp3");
    // console.log(`[${operationId}] Downloading music: ${musicUrl} to ${musicPath}`); // Less verbose
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
