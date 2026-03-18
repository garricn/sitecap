/**
 * Template dependency graph — parses CMS templates to map include references.
 */

const MODX_CHUNK_RE = /\[\[\$([^\]?]+?)(?:\?[^\]]*?)?\]\]/g;
const MODX_SNIPPET_RE = /\[\[!?(?![+*~%$])([a-zA-Z_]\w*?)(?:\?[^\]]*?)?\]\]/g;
const WP_TEMPLATE_PART_RE = /wp:template-part.*?"slug"\s*:\s*"([^"]+)"/g;

function parseModxContent(content) {
  const refs = [];
  for (const match of content.matchAll(MODX_CHUNK_RE)) {
    refs.push({ type: "chunk", name: match[1].trim() });
  }
  for (const match of content.matchAll(MODX_SNIPPET_RE)) {
    const name = match[1].trim();
    // Skip if already matched as chunk (chunks start with $)
    if (!refs.some((r) => r.name === name)) {
      refs.push({ type: "snippet", name });
    }
  }
  return refs;
}

function parseWpContent(content) {
  const refs = [];
  for (const match of content.matchAll(WP_TEMPLATE_PART_RE)) {
    refs.push({ type: "template-part", slug: match[1] });
  }
  return refs;
}

async function fetchModxContent(page, connectorsUrl, siteId, elementType, id) {
  return page.evaluate(async ({ connectorsUrl, siteId, elementType, id }) => {
    // Try 3.x
    try {
      const res = await fetch(connectorsUrl + "index.php", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `action=element/${elementType}/get&id=${id}&HTTP_MODAUTH=${siteId}`,
      });
      const data = await res.json();
      if (data.success && data.object) return data.object.content || "";
    } catch { /* fall through */ }

    // Try 2.x
    try {
      const res = await fetch(connectorsUrl + `element/${elementType}.php`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `action=get&id=${id}&HTTP_MODAUTH=${siteId}`,
      });
      const data = await res.json();
      if (data.success && data.object) return data.object.content || "";
    } catch { /* ignore */ }

    return "";
  }, { connectorsUrl, siteId, elementType, id });
}

async function fetchWpTemplateContent(page, apiRoot, nonce, templateId) {
  return page.evaluate(async ({ apiRoot, nonce, templateId }) => {
    try {
      const res = await fetch(`${apiRoot}wp/v2/templates/${templateId}?context=edit`, {
        credentials: "include",
        headers: { "X-WP-Nonce": nonce },
      });
      if (!res.ok) return "";
      const data = await res.json();
      return data.content?.raw || "";
    } catch {
      return "";
    }
  }, { apiRoot, nonce, templateId });
}

export async function buildDependencyGraph(page, cmsData, context) {
  const nodes = [];
  const edges = [];

  if (cmsData.cms === "modx") {
    const { siteId, connectorsUrl } = context;
    if (!siteId || !connectorsUrl) return { cms: "modx", nodes, edges };

    // Add template nodes and fetch content (cap at 50)
    const templates = (cmsData.templates || []).slice(0, 50);
    for (const t of templates) {
      const nodeId = `template:${t.id}`;
      nodes.push({ id: nodeId, name: t.name, type: "template" });

      const content = await fetchModxContent(page, connectorsUrl, siteId, "template", t.id);
      for (const ref of parseModxContent(content)) {
        edges.push({ from: nodeId, to: `${ref.type}:${ref.name}`, syntax: ref.type === "chunk" ? `[[$${ref.name}]]` : `[[${ref.name}]]` });
        if (!nodes.some((n) => n.id === `${ref.type}:${ref.name}`)) {
          nodes.push({ id: `${ref.type}:${ref.name}`, name: ref.name, type: ref.type });
        }
      }
    }

    // Fetch chunk content for nested includes (cap at 100)
    const chunks = (cmsData.chunks || []).slice(0, 100);
    for (const c of chunks) {
      const nodeId = `chunk:${c.name}`;
      if (!nodes.some((n) => n.id === nodeId)) {
        nodes.push({ id: nodeId, name: c.name, type: "chunk" });
      }

      const content = await fetchModxContent(page, connectorsUrl, siteId, "chunk", c.id);
      for (const ref of parseModxContent(content)) {
        edges.push({ from: nodeId, to: `${ref.type}:${ref.name}`, syntax: ref.type === "chunk" ? `[[$${ref.name}]]` : `[[${ref.name}]]` });
        if (!nodes.some((n) => n.id === `${ref.type}:${ref.name}`)) {
          nodes.push({ id: `${ref.type}:${ref.name}`, name: ref.name, type: ref.type });
        }
      }
    }
  } else if (cmsData.cms === "wordpress") {
    const { nonce, apiRoot } = context;
    if (!nonce || !apiRoot) return { cms: "wordpress", nodes, edges };

    const templates = (cmsData.templates || []).slice(0, 50);
    for (const t of templates) {
      const nodeId = `template:${t.id || t.slug}`;
      nodes.push({ id: nodeId, name: t.slug || t.title, type: "template" });

      const content = await fetchWpTemplateContent(page, apiRoot, nonce, t.id);
      for (const ref of parseWpContent(content)) {
        const targetId = `template-part:${ref.slug}`;
        edges.push({ from: nodeId, to: targetId, syntax: `wp:template-part {"slug":"${ref.slug}"}` });
        if (!nodes.some((n) => n.id === targetId)) {
          nodes.push({ id: targetId, name: ref.slug, type: "template-part" });
        }
      }
    }
  }

  return { cms: cmsData.cms, nodes, edges };
}
