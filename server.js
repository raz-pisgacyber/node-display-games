const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const BASE_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function getFilePath(urlPath) {
  const decodedPath = decodeURIComponent(urlPath.split('?')[0]);
  const safePath = path.normalize(decodedPath).replace(/^([/\\]?\.\.(?:[/\\]|$))+/, '');
  if (safePath === '/' || safePath === '') {
    return path.join(BASE_DIR, 'modules', 'project', 'project.html');
  }
  return path.join(BASE_DIR, safePath);
}

function serveFile(filePath, res) {
  fs.stat(filePath, (statErr, stats) => {
    if (statErr) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    let resolvedPath = filePath;
    if (stats.isDirectory()) {
      resolvedPath = path.join(filePath, 'index.html');
    }

    fs.readFile(resolvedPath, (readErr, data) => {
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 Internal Server Error');
        return;
      }

      const ext = path.extname(resolvedPath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  });
}

const server = http.createServer((req, res) => {
  const filePath = getFilePath(req.url);
  serveFile(filePath, res);
});

server.listen(PORT, () => {
  console.log(`Static server running at http://localhost:${PORT}/`);
});
