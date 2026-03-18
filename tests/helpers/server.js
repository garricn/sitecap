import { createServer } from "node:http";
import { Buffer } from "node:buffer";

const HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Test Page</title><link rel="stylesheet" href="/style.css"></head>
<body>
  <h1>Test Page</h1>
  <p>This is a test page for sitecap.</p>
  <a href="/about">About</a>
  <a href="/contact">Contact</a>
  <a href="https://external.example.com">External Link</a>
  <script src="/script.js"></script>
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
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "text/html");

    if (req.url === "/" || req.url === "/index.html") {
      res.end(HTML);
    } else if (req.url === "/about") {
      res.end(ABOUT_HTML);
    } else if (req.url === "/contact") {
      res.end("<html><body><h1>Contact</h1></body></html>");
    } else if (req.url === "/style.css") {
      res.setHeader("Content-Type", "text/css");
      res.end("body { color: red; }");
    } else if (req.url === "/script.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.end("console.log('hello');");
    } else if (req.url === "/api/data") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ message: "hello" }));
    } else if (req.url === "/wordpress") {
      res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="generator" content="WordPress 6.4"><title>WP</title></head>
<body><h1>WordPress Site</h1><link rel="stylesheet" href="/wp-content/themes/test/style.css">
<script>window.wp = { heartbeat: {} }; window.wpApiSettings = { root: '/wp-json/', nonce: 'test-nonce-123' };</script></body></html>`);
    } else if (req.url?.startsWith("/wp-json/wp/v2/types")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ post: { slug: "post", name: "Posts", rest_base: "posts" }, page: { slug: "page", name: "Pages", rest_base: "pages" } }));
    } else if (req.url?.startsWith("/wp-json/wp/v2/posts")) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("X-WP-Total", "1");
      res.setHeader("X-WP-TotalPages", "1");
      res.end(JSON.stringify([{ id: 1, title: { rendered: "Test Post" }, slug: "test-post", status: "publish", type: "post", template: "", acf: { hero_text: "Welcome" } }]));
    } else if (req.url?.startsWith("/wp-json/wp/v2/pages")) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("X-WP-Total", "1");
      res.setHeader("X-WP-TotalPages", "1");
      res.end(JSON.stringify([{ id: 2, title: { rendered: "Test Page" }, slug: "test-page", status: "publish", template: "page-custom.php" }]));
    } else if (req.url?.startsWith("/wp-json/wp/v2/themes")) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("X-WP-Total", "1");
      res.setHeader("X-WP-TotalPages", "1");
      res.end(JSON.stringify([{ stylesheet: "test-theme", name: { rendered: "Test Theme" }, status: "active" }]));
    } else if (req.url?.startsWith("/wp-json/wp/v2/templates")) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("X-WP-Total", "0");
      res.setHeader("X-WP-TotalPages", "1");
      res.end("[]");
    } else if (req.url?.startsWith("/wp-json/acf/")) {
      res.setHeader("Content-Type", "application/json");
      res.end("[]");
    } else if (req.url === "/modx") {
      res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MODX</title></head>
<body><h1>MODX Site</h1>
<script>window.MODx = { config: {} };</script></body></html>`);
    } else if (req.url === "/modx-admin") {
      res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MODX Manager</title></head>
<body><h1>MODX Manager</h1>
<script>window.MODx = { config: { site_id: "abc123", connectors_url: "/connectors/" } };</script></body></html>`);
    } else if (req.url?.startsWith("/connectors/")) {
      res.setHeader("Content-Type", "application/json");
      // Read POST body to differentiate connector actions
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      if (body.includes("resource/tv/getlist")) {
        res.end(JSON.stringify({ success: true, total: 1, results: [{ id: 1, name: "hero_image", value: "/assets/hero.jpg" }] }));
      } else if (body.includes("element/template/get&") || body.includes("element/chunk/get&")) {
        res.end(JSON.stringify({ success: true, object: { id: 1, name: "BaseTemplate", content: "<html>[[$header]][[getResources]]</html>" } }));
      } else {
        res.end(JSON.stringify({ success: true, total: 1, results: [{ id: 1, name: "TestElement", description: "Mock element" }] }));
      }
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
