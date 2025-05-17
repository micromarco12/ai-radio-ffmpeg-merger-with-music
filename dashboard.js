require('dotenv').config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const cloudinary = require("cloudinary").v2;
const { exec } = require("child_process");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.get("/dashboard", (req, res) => {
  res.send(`
    <h2>FFmpeg Audio Merge Interface</h2>
    <form method="POST" action="/merge-audio">
      <label>File URLs (one per line):<br>
        <textarea name="files" rows="12" cols="100" style="width: 100%; font-size: 14px;"></textarea>
      </label><br><br>

      <label>Output Name (e.g., output.mp3):<br>
        <input name="outputName" type="text">
      </label><br><br>

      <label>Bitrate:<br>
        <select name="bitrate">
          <option value="128k">128 kbps</option>
          <option value="192k">192 kbps</option>
          <option value="256k">256 kbps</option>
          <option value="320k">320 kbps</option>
        </select>
      </label><br><br>

      <label>Silence Between Files (seconds):<br>
        <input name="silence" type="number" min="0" value="0">
      </label><br><br>

      <label>Target Cloudinary Folder:<br>
        <select name="targetFolder">
          <option value="audio-webflow">audio-webflow</option>
          <option value="FFmpeg-converter">FFmpeg-converter</option>
          <option value="final-images">final-images</option>
        </select>
      </label><br><br>

      <button type="submit">Merge & Upload</button>
    </form>
  `);
});

app.post("/merge-audio", async (req, res) => {
  const { files, outputName, bitrate, silence, targetFolder } = req.body;
  const urls = files.split("\n").map(url => url.trim()).filter(Boolean);

  const tempDir = `temp_${uuidv4()}`;
  fs.mkdirSync(tempDir);

  try {
    const audioFiles = [];
    for (let i = 0; i < urls.length; i++) {
      const filePath = path.join(tempDir, `part${i}.mp3`);
      const response = await axios.get(urls[i], { responseType: "stream" });
      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on("finish", () => resolve());
        writer.on("error", err => reject(err));
      });

      audioFiles.push(filePath);

      if (parseInt(silence) > 0 && i < urls.length - 1) {
        const silencePath = path.join(tempDir, `silence${i}.mp3`);
        await new Promise((resolve, reject) => {
          exec(`ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t ${silence} -q:a 9 -acodec libmp3lame ${silencePath}`, err => {
            if (err) reject(err);
            else resolve();
          });
        });
        audioFiles.push(silencePath);
      }
    }

    const listFile = path.join(tempDir, "list.txt");
    fs.writeFileSync(listFile, audioFiles.map(p => `file '${path.basename(p)}'`).join("\n"));

    const finalPath = path.join(tempDir, outputName);
    await new Promise((resolve, reject) => {
      exec(`cd ${tempDir} && ffmpeg -f concat -safe 0 -i list.txt -b:a ${bitrate} -c copy "${outputName}"`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    const uploadResult = await cloudinary.uploader.upload(finalPath, {
      resource_type: "video",
      public_id: outputName.replace(".mp3", ""),
      folder: targetFolder || "audio-webflow",
    });

    res.send(`<p>✅ Uploaded to Cloudinary: <a href="${uploadResult.secure_url}" target="_blank">${uploadResult.secure_url}</a></p>`);
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).send("Error merging or uploading files.");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🟢 Dashboard running on port ${PORT}`));