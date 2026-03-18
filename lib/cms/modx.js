/**
 * MODX adapter — extracts CMS structure via /connectors/ API.
 * Requires admin session with site_id (HTTP_MODAUTH) token.
 */

const BATCH_SIZE = 20;
const IMAGE_FILE_TV_TYPES = ["image", "file", "migx"];

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

/**
 * Parse MODx.load() blocks from manager edit page HTML.
 * Extracts TV name/value pairs from ExtJS config objects.
 * @param {string} html - raw HTML from manager edit page
 * @param {Set<string>} tvNames - set of TV names to look for
 * @returns {Object} map of tvName -> value
 */
export function parseModxLoadBlock(html, tvNames) {
  const result = {};
  if (!html || !tvNames || tvNames.size === 0) return result;

  // Match fieldLabel/name/value groups in MODx.load() config objects
  // Pattern: "fieldLabel":"<label>",...,"name":"<name>",...,"value":"<value>"
  // Also handles the reverse order and variations
  // TODO: [^}]*? stops at } chars — real ExtJS configs with nested braces (e.g. renderer: function(){...})
  // may cause silent match failures. A more robust approach would use balanced-brace matching.
  const tvPattern = /"fieldLabel"\s*:\s*"([^"]*)"[^}]*?"name"\s*:\s*"([^"]*)"[^}]*?"value"\s*:\s*"([^"]*)"/g;
  let match;
  while ((match = tvPattern.exec(html)) !== null) {
    const [, fieldLabel, , value] = match;
    if (tvNames.has(fieldLabel)) {
      result[fieldLabel] = value;
    }
  }

  // Also try value before name pattern
  const tvPattern2 = /"fieldLabel"\s*:\s*"([^"]*)"[^}]*?"value"\s*:\s*"([^"]*)"[^}]*?"name"\s*:\s*"([^"]*)"/g;
  while ((match = tvPattern2.exec(html)) !== null) {
    const [, fieldLabel, value] = match;
    if (tvNames.has(fieldLabel) && !(fieldLabel in result)) {
      result[fieldLabel] = value;
    }
  }

  return result;
}

/**
 * Generic connector fetch with explicit 2.x fallback path.
 * Unlike fetchConnector (which hardcodes element/ paths), this accepts
 * an explicit fallback2xPath for non-element connector actions.
 *
 * @param {import('playwright').Page} page
 * @param {string} connectorsUrl
 * @param {string} siteId
 * @param {string} action - 3.x action (e.g. "source/getlist")
 * @param {string} fallback2xPath - 2.x fallback file (e.g. "source/index.php")
 * @param {object} [extraParams] - additional POST body params
 * @returns {Promise<object>}
 */
export async function fetchModxSource(page, connectorsUrl, siteId, action, fallback2xPath, extraParams = {}) {
  return page.evaluate(async ({ connectorsUrl, siteId, action, fallback2xPath, extraParams }) => {
    const buildBody = (params) => {
      const parts = [];
      for (const [k, v] of Object.entries(params)) {
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
      }
      return parts.join("&");
    };

    // Try MODX 3.x single entry point first
    try {
      const body = buildBody({ action, HTTP_MODAUTH: siteId, limit: 0, ...extraParams });
      const res = await fetch(connectorsUrl + "index.php", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const data = await res.json();
      if (data.success) return data;
    } catch { /* fall through to 2.x */ }

    // Fall back to MODX 2.x separate connector files
    try {
      // Determine 2.x action from the 3.x action name
      const actionName = action.includes("/") ? action.split("/").pop() : action;
      const fallbackAction = actionName === "getlist" ? "getList" : actionName;
      const body = buildBody({ action: fallbackAction, HTTP_MODAUTH: siteId, limit: 0, ...extraParams });
      const res = await fetch(connectorsUrl + fallback2xPath, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const data = await res.json();
      if (data.success) return data;
    } catch { /* ignore */ }

    return { success: false, results: [], total: 0 };
  }, { connectorsUrl, siteId, action, fallback2xPath, extraParams });
}

/**
 * List all MODX media sources with their properties (basePath, baseUrl).
 *
 * @param {import('playwright').Page} page
 * @param {string} connectorsUrl
 * @param {string} siteId
 * @returns {Promise<Array<{id: number, name: string, basePath: string, baseUrl: string}>>}
 */
export async function listModxMediaSources(page, connectorsUrl, siteId) {
  // Step 1: List all media sources
  const listData = await fetchModxSource(page, connectorsUrl, siteId, "source/getlist", "source/index.php");
  const sources = listData.results || [];

  // Step 2: Get properties for each source
  const detailed = [];
  for (const src of sources) {
    try {
      const detail = await fetchModxSource(
        page, connectorsUrl, siteId,
        `source/get`, "source/index.php",
        { id: src.id }
      );
      const obj = detail.object || detail.results?.[0] || {};
      const props = obj.properties || {};
      // Extract basePath/baseUrl from properties (may be nested objects or plain strings)
      const basePath = typeof props.basePath === "object" ? props.basePath.value : (props.basePath || "");
      const baseUrl = typeof props.baseUrl === "object" ? props.baseUrl.value : (props.baseUrl || "");
      detailed.push({
        id: src.id,
        name: src.name || `Source ${src.id}`,
        basePath,
        baseUrl,
      });
    } catch {
      detailed.push({ id: src.id, name: src.name || `Source ${src.id}`, basePath: "", baseUrl: "" });
    }
  }

  return detailed;
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

  // Build set of image/file/migx TV names for MODx.load() parsing
  const mediaTvNames = new Set();
  for (const tv of (result.tvs || [])) {
    if (tv.type && IMAGE_FILE_TV_TYPES.includes(tv.type.toLowerCase())) {
      mediaTvNames.add(tv.name);
    }
  }

  // Track TV fetch stats
  const tvStats = { totalResources: result.resources.length, tvsFetched: 0, tvErrors: 0 };

  // Warn if resource count is large
  const meta = {};
  if (result.resources.length > 500) {
    meta.warning = `Large resource count (${result.resources.length}). TV fetching may be slow.`;
  }

  // Fetch TV values per resource in batches (sequential batches, MODX connectors share PHP session)
  for (let i = 0; i < result.resources.length; i += BATCH_SIZE) {
    const batch = result.resources.slice(i, i + BATCH_SIZE);
    for (const resource of batch) {
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
        tvStats.tvsFetched++;
      } catch {
        resource.fields = {};
        tvStats.tvErrors++;
      }

      // CMS-7: For resources with image/file/migx TVs, fetch manager edit page
      // and parse MODx.load() blocks to fill in empty TV values.
      // Only fetch if at least one media TV is empty or missing — skip if all are populated.
      if (mediaTvNames.size > 0) {
        const hasEmptyMediaTv = [...mediaTvNames].some(name =>
          !(name in resource.fields) || resource.fields[name] === ""
        );
        if (hasEmptyMediaTv) {
          try {
            const managerUrl = `${connectorsUrl}../manager/?a=resource/update&id=${resource.id}`;
            const editHtml = await page.evaluate(async (url) => {
              try {
                const res = await fetch(url, { credentials: "include" });
                return await res.text();
              } catch { return ""; }
            }, managerUrl);

            if (editHtml) {
              // Use all TV definitions (not just connector response keys) to catch TVs the connector omitted
              const allTvNames = new Set([...mediaTvNames, ...(result.tvs || []).map(tv => tv.name)]);
              const parsed = parseModxLoadBlock(editHtml, allTvNames);
              // Merge: connector values authoritative for non-empty text;
              // MODx.load() values fill in where connector returned empty string
              for (const [name, value] of Object.entries(parsed)) {
                if (!resource.fields[name] || resource.fields[name] === "") {
                  resource.fields[name] = value;
                }
              }
            }
          } catch {
            // Ignore edit page fetch failures
          }
        }
      }
    }
  }

  result.tvStats = tvStats;
  if (meta.warning) {
    result.meta = meta;
  }

  return result;
}
