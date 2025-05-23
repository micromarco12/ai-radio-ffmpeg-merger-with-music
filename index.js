const express = require("express");
const app = express();

app.use(express.json());

const mergeRoute = require("./merge-ai-radio");
app.use("/merge-audio", mergeRoute);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🟢 Server running on port ${PORT}`);
});
