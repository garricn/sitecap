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
  <img src="/image.png" alt="Test">
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
    } else if (req.url === "/image.png") {
      res.setHeader("Content-Type", "image/png");
      // 1x1 red PNG
      res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64"));
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
    } else if (req.url?.startsWith("/wp-json/wp/v2/media/123")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: 123, source_url: `http://${req.headers.host}/wp-content/uploads/hero.jpg`, mime_type: "image/jpeg", alt_text: "Hero image", media_details: { width: 1200, height: 800 } }));
    } else if (req.url?.startsWith("/wp-json/wp/v2/media/")) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: "rest_post_invalid_id", message: "Invalid post ID." }));
    } else if (req.url?.startsWith("/wp-json/wp/v2/posts")) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("X-WP-Total", "1");
      res.setHeader("X-WP-TotalPages", "1");
      res.end(JSON.stringify([{ id: 1, title: { rendered: "Test Post" }, slug: "test-post", status: "publish", type: "post", template: "", acf: { hero_text: "Welcome", hero_image: 123, missing_ref: 999 } }]));
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
    } else if (req.url?.startsWith("/manager/")) {
      // CMS-7: Mock manager edit page with MODx.load() block
      res.setHeader("Content-Type", "text/html");
      res.end(`<!DOCTYPE html>
<html><head><title>MODX Manager</title></head>
<body>
<script>MODx.load({xtype:"modx-panel-resource",items:[{xtype:"modx-panel-resource-tv",items:[{"fieldLabel":"hero_image","name":"tv123","xtype":"modx-panel-tv-image","value":"/assets/images/hero.jpg"},{"fieldLabel":"sidebar_file","name":"tv456","xtype":"modx-panel-tv-file","value":"/assets/docs/guide.pdf"},{"fieldLabel":"plain_text","name":"tv789","xtype":"textfield","value":"Hello from load"}]}]});</script>
</body></html>`);
    } else if (req.url === "/assets/hero.jpg") {
      res.setHeader("Content-Type", "image/jpeg");
      res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64"));
    } else if (req.url === "/assets/docs/guide.pdf") {
      res.setHeader("Content-Type", "application/pdf");
      res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64"));
    } else if (req.url === "/assets/images/hero.jpg") {
      res.setHeader("Content-Type", "image/jpeg");
      // 1x1 red PNG (reuse existing pattern)
      res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64"));
    } else if (req.url === "/wp-content/uploads/hero.jpg") {
      res.setHeader("Content-Type", "image/jpeg");
      // 1x1 red PNG (reuse existing pattern)
      res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64"));
    } else if (req.url?.startsWith("/connectors/")) {
      res.setHeader("Content-Type", "application/json");
      // Read POST body to differentiate connector actions
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      if (body.includes("resource/tv/getlist")) {
        // Extract resource ID from body
        const resourceMatch = body.match(/resource=(\d+)/);
        const resourceId = resourceMatch ? parseInt(resourceMatch[1]) : 0;
        // For resources with even IDs, return empty value for hero_image (so MODx.load() fills it)
        const heroValue = resourceId % 2 === 0 ? "" : "/assets/hero.jpg";
        res.end(JSON.stringify({ success: true, total: 3, results: [
          { id: 1, name: "hero_image", value: heroValue, type: "image" },
          { id: 2, name: "sidebar_file", value: "", type: "file" },
          { id: 3, name: "plain_text", value: "Connector text", type: "text" },
        ] }));
      } else if (body.includes("element/tv/getlist")) {
        // TV definitions with type info
        res.end(JSON.stringify({ success: true, total: 3, results: [
          { id: 1, name: "hero_image", type: "image", description: "Hero image TV" },
          { id: 2, name: "sidebar_file", type: "file", description: "Sidebar file TV" },
          { id: 3, name: "plain_text", type: "text", description: "Plain text TV" },
        ] }));
      } else if (body.includes("resource/getlist")) {
        // CMS-6: Return 150 resources
        const resources = [];
        for (let i = 1; i <= 150; i++) {
          resources.push({ id: i, pagetitle: `Page ${i}`, alias: `page-${i}`, template: 1 });
        }
        res.end(JSON.stringify({ success: true, total: 150, results: resources }));
      } else if (body.includes("element/template/get&") || body.includes("element/chunk/get&")) {
        res.end(JSON.stringify({ success: true, object: { id: 1, name: "BaseTemplate", content: "<html>[[$header]][[getResources]]</html>" } }));
      } else if (body.includes("source%2Fgetlist") || body.includes("action=source/getlist")) {
        // CMS-8: List media sources (URL-encoded from fetchModxSource)
        res.end(JSON.stringify({ success: true, total: 2, results: [
          { id: 1, name: "Assets" },
          { id: 2, name: "Images" },
        ] }));
      } else if ((body.includes("source%2Fget&") || body.includes("action=source/get&")) && !body.includes("getlist")) {
        // CMS-8: Get media source properties
        const idMatch = body.match(/id=(\d+)/);
        const sourceId = idMatch ? parseInt(idMatch[1]) : 1;
        const props = sourceId === 1
          ? { basePath: { value: "assets/" }, baseUrl: { value: "/assets/" } }
          : { basePath: { value: "assets/images/" }, baseUrl: { value: "/assets/images/" } };
        res.end(JSON.stringify({ success: true, object: { id: sourceId, name: sourceId === 1 ? "Assets" : "Images", properties: props } }));
      } else if (body.includes("browser%2Fdirectory%2Fgetlist") || body.includes("browser/directory/getlist")) {
        // CMS-8: List files in media source
        res.end(JSON.stringify({ success: true, total: 1, results: [
          { name: "hero.jpg", pathname: "images/hero.jpg", type: "image/jpeg" },
        ] }));
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
