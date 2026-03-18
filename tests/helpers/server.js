import { createServer } from "node:http";

const HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Test Page</title></head>
<body>
  <h1>Test Page</h1>
  <p>This is a test page for sitecap.</p>
  <a href="/about">About</a>
  <a href="/contact">Contact</a>
  <a href="https://external.example.com">External Link</a>
</body>
</html>`;

const ABOUT_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>About</title></head>
<body><h1>About</h1><p>About page.</p><a href="/">Home</a></body>
</html>`;

/**
 * Start a local HTTP server for tests.
 * @returns {Promise<{url: string, server: import('http').Server, close: () => Promise<void>}>}
 */
export async function startTestServer() {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");

    if (req.url === "/" || req.url === "/index.html") {
      res.end(HTML);
    } else if (req.url === "/about") {
      res.end(ABOUT_HTML);
    } else if (req.url === "/contact") {
      res.end("<html><body><h1>Contact</h1></body></html>");
    } else if (req.url === "/api/data") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ message: "hello" }));
    } else if (req.url === "/wordpress") {
      res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="generator" content="WordPress 6.4"><title>WP</title></head>
<body><h1>WordPress Site</h1><link rel="stylesheet" href="/wp-content/themes/test/style.css">
<script>window.wp = { heartbeat: {} };</script></body></html>`);
    } else if (req.url === "/modx") {
      res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MODX</title></head>
<body><h1>MODX Site</h1>
<script>window.MODx = { config: {} };</script></body></html>`);
    } else if (req.url === "/modx-admin") {
      res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MODX Manager</title></head>
<body><h1>MODX Manager</h1>
<script>window.MODx = { config: { site_id: "abc123" } };</script></body></html>`);
    } else if (req.url === "/drupal") {
      res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="generator" content="Drupal 10"><title>Drupal</title></head>
<body><h1>Drupal Site</h1>
<script>window.Drupal = {}; window.drupalSettings = { user: { uid: 0 } };</script></body></html>`);
    } else {
      res.statusCode = 404;
      res.end("<html><body><h1>404</h1></body></html>");
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
