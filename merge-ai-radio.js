// merge-ai-radio.js (partial, focusing on mergeAudioFiles)

// ... (keep existing requires, cloudinary.config, downloadFile, getAudioDuration, uploadToCloudinary functions as they are) ...

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

  const fadedMusic = path.join(tempDir, "music-faded.mp3");
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
  const overlapTimeSeconds = 3.0;

  if (musicInsertIndex < 0 || musicInsertIndex >= convertedFiles.length) {
    throw new Error(`Invalid musicInsertIndex ${musicInsertIndex} for convertedFiles array of length ${convertedFiles.length}`);
  }
  const alexAnnouncePath = convertedFiles[musicInsertIndex];

  try {
    if (alexAnnouncePath && fs.existsSync(alexAnnouncePath)) {
      durationAlexAnnounce = await getAudioDuration(alexAnnouncePath);
      console.log(`Alex Announce Clip: ${alexAnnouncePath}, Duration: ${durationAlexAnnounce}s`);
    } else { console.warn(`Alex announcement clip path not found: ${alexAnnouncePath}`); durationAlexAnnounce = 0;} // Handle missing file
    
    if (fs.existsSync(fadedMusic)) {
      durationMusic = await getAudioDuration(fadedMusic);
      console.log(`Music Clip: ${fadedMusic}, Duration: ${durationMusic}s`);
    } else { throw new Error(`Processed music file not found: ${fadedMusic}`); }

    if (durationAlexAnnounce > 0 && durationAlexAnnounce <= overlapTimeSeconds) {
      console.warn(`Warning: Alex's announcement (${durationAlexAnnounce}s) is too short for the full ${overlapTimeSeconds}s overlap.`);
      // In this case, the overlap might effectively be durationAlexAnnounce
    }
  } catch (err) { console.error("Error getting audio durations:", err.message); throw err; }

  const transition1Output = path.join(tempDir, "transition1_announce_ducked.mp3");
  const announcePart1Duration = Math.max(0, durationAlexAnnounce - overlapTimeSeconds);

  // Ducking parameters
  const duckThreshold = "0.1"; // e.g., -20dB
  const duckRatio = "5";
  const duckAttack = "20"; // ms
  const duckRelease = "250"; // ms

  // --- REVISED FFMPEG COMMAND FOR TRANSITION 1 ---
  // This command takes Alex's full announcement and the start of the music.
  // It aims to have the music start fading in (ducked) under the last 'overlapTimeSeconds' of Alex's speech.
  // The output 'transition1_announce_ducked.mp3' will be the length of Alex's original announcement.
  const ffmpegTransition1Command = `ffmpeg -i "${alexAnnouncePath}" -i "${fadedMusic}" \\
-filter_complex \
"[0:a]asplit[alex_full_speech][alex_for_sidechain]; \
 [1:a]adelay=${announcePart1Duration * 1000}|${announcePart1Duration * 1000}[delayed_music_start]; \
 [alex_for_sidechain][delayed_music_start]sidechaincompress=threshold=${duckThreshold}:ratio=${duckRatio}:attack=${duckAttack}:release=${duckRelease}[ducked_music_segment]; \
 [alex_full_speech][ducked_music_segment]amix=inputs=2:duration=first[mixed_output]" \
-map "[mixed_output]" -c:a libmp3lame -b:a 192k -ar 44100 -ac 2 -y "${transition1Output}"`;

  console.log("Executing FFMPEG for Transition 1 (Announce Outro/Music Intro):");
  console.log(ffmpegTransition1Command); // Log the command
  await new Promise((resolve, reject) => {
    exec(ffmpegTransition1Command, (err, stdout, stderr) => {
      if (err) {
        console.error(`FFMPEG Transition 1 error: ${stderr}`);
        console.error(`FFMPEG Transition 1 stdout: ${stdout}`);
        return reject(err);
      }
      console.log("Transition 1 created successfully:", transition1Output);
      resolve();
    });
  });
  // --- END REVISED FFMPEG LOGIC FOR TRANSITION 1 ---

  console.log("Creating simplified final concatenation list for testing Transition 1...");
  const finalListPath = path.join(tempDir, "final-list.txt");
  const finalConcatList = [];

  for (let i = 0; i < musicInsertIndex; i++) {
    finalConcatList.push(`file '${convertedFiles[i]}'`);
  }
  finalConcatList.push(`file '${transition1Output}'`); // This IS Alex's announcement with music intro

  // Add the rest of the music, ensuring we don't re-add the part already in the transition
  // The 'transition1Output' effectively used 'overlapTimeSeconds' of music from its start.
  // So, the main music should start 'overlapTimeSeconds' into the 'fadedMusic' track.
  if (durationMusic > overlapTimeSeconds) {
    const musicRestPath = path.join(tempDir, "music_rest.mp3");
    const musicRestStartTime = overlapTimeSeconds;
    const musicRestDuration = durationMusic - overlapTimeSeconds; // This will be the full remaining duration for now

    if (musicRestDuration > 0.1) { // Only process if there's a meaningful duration left
        const ffmpegMusicRestCommand = `ffmpeg -i "${fadedMusic}" -ss ${musicRestStartTime} -t ${musicRestDuration} -c copy -y "${musicRestPath}"`;
        // Using -c copy if no further processing needed, or re-encode if necessary:
        // const ffmpegMusicRestCommand = `ffmpeg -i "${fadedMusic}" -ss ${musicRestStartTime} -t ${musicRestDuration} -c:a libmp3lame -b:a 192k -ar 44100 -ac 2 -y "${musicRestPath}"`;
        console.log("Creating rest of music segment:", ffmpegMusicRestCommand);
        await new Promise((resolve, reject) => {
            exec(ffmpegMusicRestCommand, (err, stdout, stderr) => {
            if (err) { console.error(`FFMPEG music rest error: ${stderr}`); return reject(err); }
            finalConcatList.push(`file '${musicRestPath}'`);
            resolve();
            });
        });
    } else {
        console.log("No significant music duration left after intro overlap, or music is shorter than overlap.");
    }
  }


  // Add dialogue clips that come after the music break and Jamie's SILENT turn & Alex's welcome back
  // musicInsertIndex = Alex's announcement
  // musicInsertIndex + 1 = Jamie's SILENT turn (usually not added to concat if truly silent audio)
  // musicInsertIndex + 2 = Alex's Welcome Back (this will be part of Transition 2 later)
  // So, for now, we add clips from musicInsertIndex + 3 onwards
  for (let i = musicInsertIndex + 3; i < convertedFiles.length; i++) {
    finalConcatList.push(`file '${convertedFiles[i]}'`);
  }
  
  fs.writeFileSync(finalListPath, finalConcatList.join("\n"));
  console.log("Concatenation list for testing Transition 1 created:", finalListPath);
  console.log("Final concatenation list content for testing Transition 1:\n", finalConcatList.join("\n"));
  console.log(`Starting final concatenation (test of T1) to: ${outputPath}`);

  await new Promise((resolve, reject) => {
    exec(`ffmpeg -f concat -safe 0 -i "${finalListPath}" -c:a libmp3lame -b:a 256k -ar 44100 -ac 2 -y "${outputPath}"`, (err, stdout, stderr) => {
      if (err) {
        console.error(`FFMPEG final concatenation error (test of T1): ${stderr}`);
        return reject(err);
      }
      console.log("Final concatenation (test of T1) successful.");
      resolve();
    });
  });

  console.log("Cleaning up temporary files...");
  try {
    if (fs.existsSync(convertedDir)) fs.rmSync(convertedDir, { recursive: true, force: true });
    if (fs.existsSync(finalListPath)) fs.unlinkSync(finalListPath);
    if (fs.existsSync(fadedMusic)) fs.unlinkSync(fadedMusic); // Original faded music
    if (fs.existsSync(transition1Output)) fs.unlinkSync(transition1Output); // The mixed intro
    const musicRestPathCheck = path.join(tempDir, "music_rest.mp3");
    if (fs.existsSync(musicRestPathCheck)) fs.unlinkSync(musicRestPathCheck); // The rest of the music
  } catch (cleanupErr) {
    console.warn("Warning: Error during cleanup of some temporary files:", cleanupErr.message);
  }
  console.log("Temporary files cleanup attempt finished.");
};

// ... (rest of your script: router.post("/merge", ...) and module.exports = router; should remain the same) ...
// Ensure the router.post("/merge", ...) calls this mergeAudioFiles function.
// The existing router.post seems fine and calls it.
