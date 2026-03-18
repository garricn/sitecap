/**
 * MODX adapter — extracts CMS structure via /connectors/ API.
 * Requires admin session with site_id (HTTP_MODAUTH) token.
 */

async function fetchConnector(page, connectorsUrl, siteId, action) {
  return page.evaluate(async ({ connectorsUrl, siteId, action }) => {
    // Try MODX 3.x single entry point first
    try {
      const res = await fetch(connectorsUrl + "index.php", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `action=${action}&HTTP_MODAUTH=${siteId}&limit=0`,
      });
      const data = await res.json();
      if (data.success) return data;
    } catch { /* fall through to 2.x */ }

    // Fall back to MODX 2.x separate connector files
    const parts = action.split("/");
    const elementType = parts[1]; // e.g. "chunk" from "element/chunk/getlist"
    const file = `element/${elementType}.php`;
    try {
      const res = await fetch(connectorsUrl + file, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `action=getList&HTTP_MODAUTH=${siteId}&limit=0`,
      });
      const data = await res.json();
      if (data.success) return data;
    } catch { /* ignore */ }

    return { success: false, results: [], total: 0 };
  }, { connectorsUrl, siteId, action });
}

export async function extractModx(page, context) {
  const { siteId, connectorsUrl } = context;
  if (!siteId || !connectorsUrl) {
    return { cms: "modx", extracted: false, reason: "Missing siteId or connectorsUrl" };
  }

  const elements = {
    templates: "element/template/getlist",
    chunks: "element/chunk/getlist",
    snippets: "element/snippet/getlist",
    plugins: "element/plugin/getlist",
    tvs: "element/tv/getlist",
  };

  const result = { cms: "modx", extracted: true };

  for (const [key, action] of Object.entries(elements)) {
    try {
      const data = await fetchConnector(page, connectorsUrl, siteId, action);
      result[key] = data.results || [];
    } catch {
      result[key] = [];
    }
  }

  // Resources via separate connector path
  try {
    const resData = await page.evaluate(async ({ connectorsUrl, siteId }) => {
      // Try 3.x
      try {
        const res = await fetch(connectorsUrl + "index.php", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `action=resource/getlist&HTTP_MODAUTH=${siteId}&limit=0`,
        });
        const data = await res.json();
        if (data.success) return data;
      } catch { /* fall through */ }

      // Try 2.x
      try {
        const res = await fetch(connectorsUrl + "resource/index.php", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `action=getList&HTTP_MODAUTH=${siteId}&limit=0`,
        });
        const data = await res.json();
        if (data.success) return data;
      } catch { /* ignore */ }

      return { success: false, results: [], total: 0 };
    }, { connectorsUrl, siteId });
    result.resources = resData.results || [];
  } catch {
    result.resources = [];
  }

  // Fetch TV values per resource (cap at 100)
  const resourcesToFetch = result.resources.slice(0, 100);
  for (const resource of resourcesToFetch) {
    try {
      const tvData = await page.evaluate(async ({ connectorsUrl, siteId, resourceId }) => {
        try {
          const res = await fetch(connectorsUrl + "index.php", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `action=resource/tv/getlist&resource=${resourceId}&HTTP_MODAUTH=${siteId}&limit=0`,
          });
          const data = await res.json();
          if (data.success) return data;
        } catch { /* ignore */ }
        return { success: false, results: [], total: 0 };
      }, { connectorsUrl, siteId, resourceId: resource.id });
      const fields = {};
      for (const tv of (tvData.results || [])) {
        fields[tv.name] = tv.value;
      }
      resource.fields = fields;
    } catch {
      resource.fields = {};
    }
  }

  return result;
}
