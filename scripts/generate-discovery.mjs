import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const site = "https://www.grum.so";
const root = new URL("../", import.meta.url);
const check = process.argv.includes("--check");
const read = (path) => readFile(new URL(path, root), "utf8");
const xml = (value) => String(value).replace(/[<>&"']/g, (character) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
})[character]);

// The public listing is the publication boundary. Unlisted drafts are never
// discovered here; keep their files outside the deployed tree as AGENTS.md says.
const listing = await read("blog/index.html");
const slugs = [...new Set([...listing.matchAll(/href="\/blog\/([a-z0-9]+(?:-[a-z0-9]+)*)"/g)].map((match) => match[1]))];
const posts = [];
for (const slug of slugs) {
  const html = await read(`blog/${slug}.html`);
  const blocks = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  const data = blocks.map((match) => JSON.parse(match[1])).find((item) => item["@type"] === "BlogPosting");
  const url = `${site}/blog/${slug}`;
  const canonical = html.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/)?.[1];
  if (!data?.headline || !data.description || canonical !== url || data.url !== url) {
    throw new Error(`Missing or inconsistent article metadata: ${slug}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(data.datePublished) || Number.isNaN(Date.parse(data.datePublished))) {
    throw new Error(`Invalid publication date: ${slug}`);
  }
  if (/name="robots"[^>]*content="[^"]*noindex/i.test(html)) {
    throw new Error(`An unindexable article is linked from the blog: ${slug}`);
  }
  posts.push({ ...data, url });
}
posts.sort((a, b) => b.datePublished.localeCompare(a.datePublished));

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${["/", "/blog", "/privacy", "/terms"].map((path) => `  <url><loc>${site}${path}</loc></url>`).join("\n")}
${posts.map((post) => `  <url><loc>${xml(post.url)}</loc><lastmod>${xml(post.dateModified || post.datePublished)}</lastmod></url>`).join("\n")}
</urlset>
`;

// Preserve the actual date supplied by the author, rather than inventing a
// publication time for a date-only article. Dublin Core accepts ISO dates.
const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Grum blog</title>
    <link>${site}/blog</link>
    <description>Ideas on design contracts, building with agents, and keeping teams aligned as products grow.</description>
    <language>en</language>
    <atom:link href="${site}/feed.xml" rel="self" type="application/rss+xml" />
${posts.map((post) => `    <item>
      <title>${xml(post.headline)}</title>
      <link>${xml(post.url)}</link>
      <guid isPermaLink="true">${xml(post.url)}</guid>
      <description>${xml(post.description)}</description>
      <dc:creator>${xml(post.author.name)}</dc:creator>
      <dc:date>${xml(post.datePublished)}</dc:date>
    </item>`).join("\n")}
  </channel>
</rss>
`;

for (const [path, content] of [["sitemap.xml", sitemap], ["feed.xml", feed]]) {
  if (check) {
    let current;
    try { current = await read(path); } catch { /* Report missing output as stale. */ }
    if (current !== content) throw new Error(`${path} is stale. Run npm run generate:discovery.`);
  } else {
    await writeFile(new URL(path, root), content);
  }
}
console.log(`${check ? "Verified" : "Generated"} sitemap and feed for ${posts.length} published article(s) in ${fileURLToPath(root)}`);
