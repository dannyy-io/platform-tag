// A tiny web server. Its only job is to send the files in "public" to the browser.
const express = require("express");

const app = express();
const PORT = 3000;

// Any file inside the "public" folder can be requested by the browser.
// Visiting http://localhost:3000/ serves public/index.html automatically.
app.use(express.static("public"));

app.listen(PORT, () => {
  console.log(`Game running at http://localhost:${PORT}`);
});
