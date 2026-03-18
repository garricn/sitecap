/**
 * WordPress adapter — extracts CMS structure via /wp-json/wp/v2/ REST API.
 * Requires admin session with nonce for authenticated endpoints.
 */

const MAX_PAGES = 10;

async function wpFetch(page, apiRoot, nonce, endpoint) {
  return page.evaluate(async ({ apiRoot, nonce, endpoint, maxPages }) => {
    const allItems = [];
    let currentPage = 1;

    for (;;) {
      const sep = endpoint.includes("?") ? "&" : "?";
      const url = `${apiRoot}${endpoint}${sep}per_page=100&page=${currentPage}`;
      const headers = { "X-WP-Nonce": nonce };

      const res = await fetch(url, { credentials: "include", headers });
      if (!res.ok) return { items: [], total: 0 };

      const data = await res.json();
      const totalPages = parseInt(res.headers.get("X-WP-TotalPages") || "1", 10);

      if (Array.isArray(data)) {
        allItems.push(...data);
      } else {
        return { items: data, total: 1 };
      }
      currentPage++;
      if (currentPage > totalPages || currentPage > maxPages) break;
    }

    return { items: allItems, total: allItems.length };
  }, { apiRoot, nonce, endpoint, maxPages: MAX_PAGES });
}

async function getNonce(page, apiRoot, existingNonce) {
  if (existingNonce) return existingNonce;

  // Fallback: try fetching nonce from admin-ajax
  return page.evaluate(async () => {
    try {
      const res = await fetch("/wp-admin/admin-ajax.php?action=rest-nonce", { credentials: "include" });
      if (res.ok) return await res.text();
    } catch { /* ignore */ }
    return null;
  });
}

export async function extractWordPress(page, context) {
  const apiRoot = context.apiRoot || "/wp-json/";
  const nonce = await getNonce(page, apiRoot, context.nonce);

  if (!nonce) {
    return { cms: "wordpress", extracted: false, reason: "No nonce available for authenticated API access" };
  }

  const result = { cms: "wordpress", extracted: true };

  // Discover post types
  try {
    const typesData = await wpFetch(page, apiRoot, nonce, "wp/v2/types");
    result.types = typesData.items || {};
  } catch {
    result.types = {};
  }

  // Posts
  try {
    const postsData = await wpFetch(page, apiRoot, nonce, "wp/v2/posts");
    result.posts = (postsData.items || []).map((p) => ({
      id: p.id, title: p.title?.rendered, slug: p.slug, status: p.status,
      type: p.type, template: p.template, fields: p.acf || {},
    }));
  } catch {
    result.posts = [];
  }

  // Pages
  try {
    const pagesData = await wpFetch(page, apiRoot, nonce, "wp/v2/pages");
    result.pages = (pagesData.items || []).map((p) => ({
      id: p.id, title: p.title?.rendered, slug: p.slug, status: p.status,
      template: p.template, fields: p.acf || {},
    }));
  } catch {
    result.pages = [];
  }

  // Themes
  try {
    const themesData = await wpFetch(page, apiRoot, nonce, "wp/v2/themes");
    result.themes = (themesData.items || []).map((t) => ({
      stylesheet: t.stylesheet, name: t.name?.rendered || t.name, status: t.status,
    }));
  } catch {
    result.themes = [];
  }

  // Block templates (WP 5.9+)
  try {
    const tplData = await wpFetch(page, apiRoot, nonce, "wp/v2/templates");
    result.templates = (tplData.items || []).map((t) => ({
      id: t.id, slug: t.slug, title: t.title?.rendered, type: t.type,
    }));
  } catch {
    result.templates = [];
  }

  // ACF field groups (if ACF PRO is active)
  try {
    const acfData = await wpFetch(page, apiRoot, nonce, "acf/v3/field-groups");
    result.acf_field_groups = (acfData.items || []).map((g) => ({
      id: g.id, title: g.title, key: g.key, active: g.active,
    }));
  } catch {
    result.acf_field_groups = [];
  }

  return result;
}
