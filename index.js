const express = require("express");
const path = require("path");
const mergeRouter = require("./merge-ai-radio");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "50mb" }));

// Health check
app.get("/", (req, res) => {
  res.send("🎙️ AI Radio Merge API is running!");
});

// Merge audio route
app.use("/merge", mergeRouter);

app.listen(PORT, () => {
  console.log(`🟢 Server running on port ${PORT}`);
});
