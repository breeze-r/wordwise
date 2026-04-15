const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3100;
const DIR = path.resolve(__dirname, "..");

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
};

http.createServer((req, res) => {
  let file = path.join(DIR, req.url === "/" ? "/prototypes/extension.html" : req.url);
  const ext = path.extname(file);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Serving on http://localhost:${PORT}`));
