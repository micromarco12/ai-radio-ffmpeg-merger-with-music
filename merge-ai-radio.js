const mergeAudioFiles = async (filePaths, musicPath, outputPath) => {
  const speechConcat = path.join(path.dirname(outputPath), "speech.mp3");
  const finalWithMusic = path.join(path.dirname(outputPath), "with-music.mp3");

  // Step 1: Concatenate speech clips into one file
  const concatList = filePaths.map(fp => `file '${fp}'`).join("\n");
  const concatFile = path.join(path.dirname(outputPath), "concat.txt");
  fs.writeFileSync(concatFile, concatList);

  await new Promise((resolve, reject) => {
    exec(`ffmpeg -f concat -safe 0 -i "${concatFile}" -c copy "${speechConcat}"`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // Step 2: Fade in/out music
  const fadedMusic = path.join(path.dirname(outputPath), "music-faded.mp3");
  await new Promise((resolve, reject) => {
    exec(`ffmpeg -i "${musicPath}" -af "afade=t=in:ss=0:d=2,afade=t=out:st=18:d=2" -y "${fadedMusic}"`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // Step 3: Concatenate speech + music
  const finalConcatList = `file '${speechConcat}'\nfile '${fadedMusic}'`;
  const finalConcatFile = path.join(path.dirname(outputPath), "final-list.txt");
  fs.writeFileSync(finalConcatFile, finalConcatList);

  await new Promise((resolve, reject) => {
    exec(`ffmpeg -f concat -safe 0 -i "${finalConcatFile}" -c copy -y "${outputPath}"`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};
