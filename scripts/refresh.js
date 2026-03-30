import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_API_DOCS_URL = "https://www.enrichanything.com/api/";
const PUBLIC_API_OPENAPI_URL = "https://www.enrichanything.com/openapi.json";
const NODE_SDK_REPO_URL = "https://github.com/bhumanai/enrichanything-public-api-node";
const PYTHON_SDK_REPO_URL = "https://github.com/bhumanai/enrichanything-public-api-python";
const CONFIG_PATH = path.join(ROOT, "repo.config.json");
const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
const generatedAt = new Date().toISOString();

const refreshedMarkets = [];
for (const market of config.markets || []) {
  const payload = await fetchJson(new URL("/api/public-market", config.siteOrigin), market.slug);
  const merged = mergeMarket(market, payload);
  refreshedMarkets.push(merged);
}

const refreshedReports = [];
for (const report of config.reports || []) {
  const payload = await fetchJson(new URL("/api/public-report", config.siteOrigin), report.slug);
  const merged = mergeReport(report, payload);
  refreshedReports.push(merged);
}

const nextConfig = decorateRepoConfig({
  ...config,
  generatedAt,
  markets: refreshedMarkets,
  reports: refreshedReports,
});

for (const market of nextConfig.markets || []) {
  const targetDir = path.join(ROOT, "markets", market.slug);
  await fs.mkdir(targetDir, { recursive: true });
  await writeText(path.join(targetDir, "README.md"), renderMarketReadme(market));
  await writeJson(path.join(targetDir, "market.json"), market);
}

for (const report of nextConfig.reports || []) {
  const targetDir = path.join(ROOT, "reports", report.slug);
  await fs.mkdir(targetDir, { recursive: true });
  await writeText(path.join(targetDir, "README.md"), renderReportReadme(report));
  await writeJson(path.join(targetDir, "report.json"), report);
}

await writeJson(path.join(ROOT, "repo.config.json"), nextConfig);
await writeJson(path.join(ROOT, "data", "catalog.json"), {
  generatedAt,
  title: nextConfig.title,
  summary: nextConfig.summary,
  topics: nextConfig.topics,
  markets: nextConfig.markets,
  reports: nextConfig.reports,
});
await writeText(path.join(ROOT, "README.md"), renderRepoReadme(nextConfig));
await writeText(path.join(ROOT, "index.html"), renderLandingPage(nextConfig));
await writeText(path.join(ROOT, ".nojekyll"), "");

console.log(
  JSON.stringify({
    action: "refreshed_public_repo_assets",
    repo: nextConfig.name,
    generatedAt,
    markets: nextConfig.markets.length,
    reports: nextConfig.reports.length,
  }),
);

async function fetchJson(url, slug) {
  const requestUrl = new URL(url);
  requestUrl.searchParams.set("slug", slug);
  const response = await fetch(requestUrl, {
    headers: {
      "User-Agent": "enrichanything-public-repo-refresh",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to refresh ${slug}: HTTP ${response.status}`);
  }

  return response.json();
}

function mergeMarket(previous, payload) {
  return {
    ...previous,
    live: Boolean(payload?.live),
    dataSource: String(payload?.dataSource || "").trim(),
    dataNote: String(payload?.dataNote || "").trim(),
    rowCount: Math.max(0, Number(payload?.rowCount || 0) || 0),
    collectionTarget: Math.max(0, Number(payload?.collectionTarget || 0) || 0),
    lastSuccessAt: String(payload?.lastSuccessAt || "").trim(),
    lastSuccessLabel: formatDate(payload?.lastSuccessAt),
    lastStatus: String(payload?.lastStatus || "").trim(),
    status: formatStatus(payload),
    statsSource:
      Array.isArray(payload?.stats) && payload.stats.length
        ? "live_payload"
        : previous.statsSource || "",
    stats:
      Array.isArray(payload?.stats) && payload.stats.length
        ? normalizeStats(payload.stats)
        : normalizeStats(previous.stats),
    sampleRows: normalizeRows(payload?.sampleRows),
  };
}

function mergeReport(previous, payload) {
  return {
    ...previous,
    live: Boolean(payload?.live),
    dataSource: String(payload?.dataSource || "").trim(),
    dataNote: String(payload?.dataNote || "").trim(),
    rowCount: Math.max(0, Number(payload?.rowCount || 0) || 0),
    lastSuccessAt: String(payload?.lastSuccessAt || "").trim(),
    lastSuccessLabel: formatDate(payload?.lastSuccessAt),
    lastStatus: String(payload?.lastStatus || "").trim(),
    status: formatStatus(payload),
    contextLine: String(payload?.contextLine || previous.contextLine || "").trim(),
    citationText: String(payload?.citationText || "").trim(),
    stats: normalizeStats(payload?.stats),
    chartRows: normalizeStats(payload?.chartRows),
    sampleRows: normalizeRows(payload?.sampleRows),
  };
}

function decorateRepoConfig(config = {}) {
  const campaign = String(config.name || "enrichanything-public-repo").trim();
  const trackedHomeUrl = buildTrackedUrl(config.siteOrigin, {
    campaign,
    content: "repo-home",
  });

  const draftReports = Array.isArray(config.reports)
    ? config.reports.map((report) => decorateReport({ report, campaign, repoUrl: config.repoUrl }))
    : [];
  const reportBySlug = new Map(draftReports.map((report) => [report.slug, report]));

  const markets = Array.isArray(config.markets)
    ? config.markets.map((market) =>
        decorateMarket({
          market,
          campaign,
          repoUrl: config.repoUrl,
          reportBySlug,
        }),
      )
    : [];

  const marketBySlug = new Map(markets.map((market) => [market.slug, market]));
  const reports = draftReports.map((report) => ({
    ...report,
    trackedMarketUrl:
      buildTrackedUrl(report.marketUrl || marketBySlug.get(report.marketSlug)?.siteUrl || "", {
        campaign,
        content: `report-${report.slug}-market`,
      }) ||
      marketBySlug.get(report.marketSlug)?.trackedSiteUrl ||
      "",
  }));

  const finalReportBySlug = new Map(reports.map((report) => [report.slug, report]));
  const finalMarkets = markets.map((market) => ({
    ...market,
    trackedReportUrl:
      buildTrackedUrl(market.reportUrl || finalReportBySlug.get(market.reportSlug)?.siteUrl || "", {
        campaign,
        content: `market-${market.slug}-report`,
      }) || "",
  }));

  const finalMarketBySlug = new Map(finalMarkets.map((market) => [market.slug, market]));
  const featuredMarket = pickPreferredRecord(finalMarkets, config.featuredMarketSlug);
  const featuredReport = pickPreferredRecord(
    reports,
    featuredMarket?.reportSlug || config.featuredReportSlug,
  );

  return {
    ...config,
    trackedHomeUrl,
    socialImagePath: "assets/social-preview.png",
    socialImageSvgPath: "assets/social-preview.svg",
    socialImageUrl: buildAssetUrl(config.pagesUrl, "assets/social-preview.png"),
    socialImageSvgUrl: buildAssetUrl(config.pagesUrl, "assets/social-preview.svg"),
    markets: finalMarkets,
    reports,
    featuredMarketSlug: featuredMarket?.slug || "",
    featuredMarketTitle: featuredMarket?.title || "",
    featuredMarketUrl: featuredMarket?.trackedSiteUrl || trackedHomeUrl,
    featuredReportSlug: featuredReport?.slug || "",
    featuredReportTitle: featuredReport?.title || "",
    featuredReportUrl: featuredReport?.trackedSiteUrl || trackedHomeUrl,
    buyerPlaybooks: Array.isArray(config.buyerPlaybooks)
      ? config.buyerPlaybooks.map((playbook) =>
          decoratePlaybook({
            playbook,
            marketBySlug: finalMarketBySlug,
            trackedHomeUrl,
          }),
        )
      : [],
  };
}

function decorateMarket({ market = {}, campaign = "", repoUrl = "", reportBySlug = new Map() } = {}) {
  const slug = String(market.slug || "").trim();
  const reportSlug = String(market.reportSlug || "").trim();
  const relatedReport = reportBySlug.get(reportSlug);

  return {
    ...market,
    slug,
    reportSlug,
    repoReadmePath: slug ? `markets/${slug}/README.md` : "",
    githubReadmeUrl: slug && repoUrl ? `${repoUrl}/blob/main/markets/${slug}/README.md` : "",
    trackedSiteUrl: buildTrackedUrl(market.siteUrl, {
      campaign,
      content: `market-${slug}`,
    }),
    trackedReportUrl: buildTrackedUrl(market.reportUrl || relatedReport?.siteUrl || "", {
      campaign,
      content: `market-${slug}-report`,
    }),
  };
}

function decorateReport({ report = {}, campaign = "", repoUrl = "" } = {}) {
  const slug = String(report.slug || "").trim();
  const marketSlug = String(report.marketSlug || "").trim();

  return {
    ...report,
    slug,
    marketSlug,
    repoReadmePath: slug ? `reports/${slug}/README.md` : "",
    githubReadmeUrl: slug && repoUrl ? `${repoUrl}/blob/main/reports/${slug}/README.md` : "",
    trackedSiteUrl: buildTrackedUrl(report.siteUrl, {
      campaign,
      content: `report-${slug}`,
    }),
    trackedMarketUrl: "",
  };
}

function decoratePlaybook({ playbook = {}, marketBySlug = new Map(), trackedHomeUrl = "" } = {}) {
  const startSlug = String(playbook.startSlug || "").trim();
  const market = marketBySlug.get(startSlug);

  return {
    role: String(playbook.role || "").trim(),
    pitch: String(playbook.pitch || "").trim(),
    startSlug,
    startTitle: market?.title || "",
    startStatus: market?.status || "",
    startUrl: market?.trackedSiteUrl || trackedHomeUrl,
    startReadmePath: market?.repoReadmePath || "",
  };
}

function renderRepoReadme(config = {}) {
  const activeMarkets = getActiveRecords(config.markets);
  const pipelineMarkets = getPipelineRecords(config.markets);
  const activeReports = getActiveRecords(config.reports);
  const pipelineReports = getPipelineRecords(config.reports);
  const featuredMarket = pickPreferredRecord(config.markets, config.featuredMarketSlug);

  const lines = [
    `# ${config.title}`,
    "",
    config.socialImagePath ? `![${config.title}](${config.socialImagePath})` : null,
    "",
    config.summary,
    "",
    config.theme,
    "",
    "## Start here",
    "",
    featuredMarket
      ? `- Fastest first click: [${featuredMarket.title}](${featuredMarket.trackedSiteUrl || featuredMarket.siteUrl}) (${featuredMarket.status})`
      : `- Open EnrichAnything: [Build from the main site](${config.trackedHomeUrl || config.siteOrigin})`,
    config.pagesUrl ? `- Cleaner web version: [${config.pagesUrl}](${config.pagesUrl})` : null,
    `- Full product: [EnrichAnything](${config.trackedHomeUrl || config.siteOrigin})`,
    "",
    `- Source product: ${config.siteOrigin}`,
    config.repoUrl ? `- GitHub repo: ${config.repoUrl}` : null,
    `- Public API docs: ${PUBLIC_API_DOCS_URL}`,
    `- OpenAPI spec: ${PUBLIC_API_OPENAPI_URL}`,
    `- Last refresh: ${formatDate(config.generatedAt) || config.generatedAt}`,
    "- Refresh command: `npm run refresh`",
    "",
    "## Developer links",
    "",
    `- Public API docs: [EnrichAnything API](${PUBLIC_API_DOCS_URL})`,
    `- Node SDK repo: [enrichanything-public-api-node](${NODE_SDK_REPO_URL})`,
    `- Python SDK repo: [enrichanything-public-api-python](${PYTHON_SDK_REPO_URL})`,
    "",
    "## Use this repo if...",
    "",
    ...renderPlaybookMarkdown(config.buyerPlaybooks),
  ].filter((line) => line !== null);

  lines.push(
    "",
    "## Lists you can use now",
    "",
    "| List | Status | Rows | Open |",
    "| --- | --- | ---: | --- |",
    ...activeMarkets.map(
      (market) =>
        `| [${escapeTable(market.title)}](${market.repoReadmePath}) | ${escapeTable(market.status)} | ${formatRowCount(market.rowCount)} | [Open in EnrichAnything](${market.trackedSiteUrl || market.siteUrl}) |`,
    ),
    "",
  );

  if (activeReports.length) {
    lines.push(
      "## Notes that explain the market",
      "",
      "| Note | Status | Rows | Open |",
      "| --- | --- | ---: | --- |",
      ...activeReports.map(
        (report) =>
          `| [${escapeTable(report.title)}](${report.repoReadmePath}) | ${escapeTable(report.status)} | ${formatRowCount(report.rowCount)} | [Open in EnrichAnything](${report.trackedSiteUrl || report.siteUrl}) |`,
      ),
      "",
    );
  }

  if (pipelineMarkets.length) {
    lines.push(
      "## Still queued up",
      "",
      "These list ideas exist already, but the public sample is not ready yet.",
      "",
      "| List | Status |",
      "| --- | --- |",
      ...pipelineMarkets.map(
        (market) =>
          `| [${escapeTable(market.title)}](${market.repoReadmePath}) | ${escapeTable(market.status)} |`,
      ),
      "",
    );
  }

  if (pipelineReports.length) {
    lines.push(
      "## Notes still queued up",
      "",
      "| Note | Status |",
      "| --- | --- |",
      ...pipelineReports.map(
        (report) =>
          `| [${escapeTable(report.title)}](${report.repoReadmePath}) | ${escapeTable(report.status)} |`,
      ),
      "",
    );
  }

  lines.push(
    "## Need a custom cut?",
    "",
    `Open [EnrichAnything](${config.trackedHomeUrl || config.siteOrigin}) if you want more columns, a fresh export, or the same pattern for a different niche.`,
    "",
  );

  return lines.join("\n");
}

function renderMarketReadme(record = {}) {
  const lines = [
    `# ${record.title}`,
    "",
    record.summary || "Public company list from EnrichAnything.",
    "",
    record.trackedSiteUrl
      ? `- Open in EnrichAnything: [See the live list](${record.trackedSiteUrl})`
      : `- Page: ${record.siteUrl}`,
    record.trackedReportUrl
      ? `- Related note: [Read the matching note](${record.trackedReportUrl})`
      : record.reportUrl
        ? `- Related note: ${record.reportUrl}`
        : null,
    record.audience ? `- Useful for: ${record.audience}` : null,
    `- Status: ${record.status}`,
    record.lastSuccessLabel ? `- Last checked: ${record.lastSuccessLabel}` : null,
    formatPublicSampleLine(record),
    "",
    "## Why this list is useful",
    "",
    buildMarketStatusLine(record),
    "",
  ].filter((line) => line !== null);

  if ((record.signals || []).length) {
    lines.push("## Why companies land on this list", "");
    for (const signal of record.signals) {
      lines.push(`- ${signal}`);
    }
    lines.push("");
  }

  if ((record.stats || []).length) {
    lines.push("## Quick numbers", "");
    lines.push(
      record.statsSource === "page_content"
        ? "These numbers come from the live market page. The sample in this repo may be smaller."
        : "These numbers come from the current public sample.",
      "",
    );

    lines.push("| Metric | Value | Detail |", "| --- | ---: | --- |");
    for (const stat of record.stats) {
      lines.push(
        `| ${escapeTable(stat.label)} | ${escapeTable(stat.value)} | ${escapeTable(stat.detail || stat.note || "")} |`,
      );
    }
    lines.push("");
  }

  if ((record.sampleRows || []).length) {
    lines.push(
      "## Sample rows",
      "",
      "| Company | Location | Signal | Gap | Why now |",
      "| --- | --- | --- | --- | --- |",
    );

    for (const row of record.sampleRows) {
      lines.push(
        `| ${escapeTable(row.company)} | ${escapeTable(row.location)} | ${escapeTable(row.signal)} | ${escapeTable(row.gap)} | ${escapeTable(row.whyNow)} |`,
      );
    }

    lines.push("");
  }

  if ((record.analysisParagraphs || []).length) {
    lines.push("## What to notice", "");
    for (const paragraph of record.analysisParagraphs) {
      lines.push(paragraph, "");
    }
  }

  if ((record.analysisTakeaways || []).length) {
    lines.push("## In plain English", "");
    for (const takeaway of record.analysisTakeaways) {
      lines.push(`- ${takeaway}`);
    }
    lines.push("");
  }

  if (record.ctaPrompt) {
    lines.push(
      "## Prompt behind this list",
      "",
      "```text",
      record.ctaPrompt,
      "```",
      "",
    );
  }

  if (record.methodology) {
    lines.push("## How we built it", "", record.methodology, "");
  }

  lines.push("## Want the full version?", "");
  if (record.ctaNote) {
    lines.push(record.ctaNote, "");
  }
  lines.push(
    record.trackedSiteUrl
      ? `Open [the live list in EnrichAnything](${record.trackedSiteUrl}) if you want the full table, extra columns, or the same search for a different niche.`
      : `Open this list in EnrichAnything if you want the full table, extra columns, or a version for a different niche: ${record.siteUrl}`,
    "",
  );

  return lines.join("\n");
}

function renderReportReadme(record = {}) {
  const lines = [
    `# ${record.title}`,
    "",
    record.summary || "Public note from EnrichAnything.",
    "",
    record.trackedSiteUrl
      ? `- Open in EnrichAnything: [See the note](${record.trackedSiteUrl})`
      : `- Page: ${record.siteUrl}`,
    record.trackedMarketUrl
      ? `- Related list: [Open the linked list](${record.trackedMarketUrl})`
      : record.marketUrl
        ? `- Related list: ${record.marketUrl}`
        : null,
    `- Status: ${record.status}`,
    record.contextLine ? `- Context: ${record.contextLine}` : null,
    record.lastSuccessLabel ? `- Last checked: ${record.lastSuccessLabel}` : null,
    record.rowCount ? `- Public sample: ${record.rowCount} rows` : null,
    "",
    "## What this note says",
    "",
    buildReportStatusLine(record),
    "",
  ].filter((line) => line !== null);

  if ((record.stats || []).length) {
    lines.push("## Key numbers", "", "| Metric | Value | Note |", "| --- | ---: | --- |");
    for (const stat of record.stats) {
      lines.push(
        `| ${escapeTable(stat.label)} | ${escapeTable(stat.value)} | ${escapeTable(stat.note || stat.detail || "")} |`,
      );
    }
    lines.push("");
  }

  if ((record.chartRows || []).length) {
    lines.push("## Breakdown", "", "| Label | Value | Note |", "| --- | ---: | --- |");
    for (const row of record.chartRows) {
      lines.push(
        `| ${escapeTable(row.label)} | ${escapeTable(row.value)} | ${escapeTable(row.note || row.detail || "")} |`,
      );
    }
    lines.push("");
  }

  if (record.citationText) {
    lines.push("## One-line version", "", `> ${record.citationText}`, "");
  }

  if ((record.sampleRows || []).length) {
    lines.push(
      "## Sample rows",
      "",
      "| Company | Location | Signal | Gap | Why now |",
      "| --- | --- | --- | --- | --- |",
    );

    for (const row of record.sampleRows) {
      lines.push(
        `| ${escapeTable(row.company)} | ${escapeTable(row.location)} | ${escapeTable(row.signal)} | ${escapeTable(row.gap)} | ${escapeTable(row.whyNow)} |`,
      );
    }

    lines.push("");
  }

  lines.push("## Want the full list?", "");
  lines.push(
    record.trackedMarketUrl
      ? `Open the [related list in EnrichAnything](${record.trackedMarketUrl}) if you want rows, more columns, or a version for your own segment.`
      : `Open the related list in EnrichAnything if you want to inspect rows, add columns, or build your own version: ${record.siteUrl}`,
    "",
  );

  return lines.join("\n");
}

function renderLandingPage(config = {}) {
  const accentColor = sanitizeColor(config.accentColor, "#0f766e");
  const activeMarkets = getActiveRecords(config.markets);
  const activeReports = getActiveRecords(config.reports);
  const pipelineMarkets = getPipelineRecords(config.markets);
  const pipelineReports = getPipelineRecords(config.reports);
  const featuredMarket = pickPreferredRecord(config.markets, config.featuredMarketSlug);

  const playbookCards = Array.isArray(config.buyerPlaybooks)
    ? config.buyerPlaybooks
        .map((playbook) => {
          const startLine =
            playbook.startTitle && playbook.startUrl
              ? `<p class="card-link"><a href="${escapeHtml(playbook.startUrl)}">Start with ${escapeHtml(playbook.startTitle)}</a>${playbook.startStatus ? ` <span>${escapeHtml(playbook.startStatus)}</span>` : ""}</p>`
              : "";

          return [
            '<article class="card playbook-card">',
            `<p class="eyebrow">${escapeHtml(playbook.role)}</p>`,
            `<p class="card-copy">${escapeHtml(playbook.pitch)}</p>`,
            startLine,
            "</article>",
          ].join("");
        })
        .join("")
    : "";

  const marketCards = activeMarkets
    .map((market) =>
      [
        '<article class="card list-card">',
        `<p class="card-status">${escapeHtml(market.status)}</p>`,
        `<h3>${escapeHtml(market.title)}</h3>`,
        `<p class="card-copy">${escapeHtml(market.summary || "Public list from EnrichAnything.")}</p>`,
        `<p class="card-meta">${formatRowCount(market.rowCount)} rows${market.audience ? ` · ${escapeHtml(market.audience)}` : ""}</p>`,
        '<div class="card-actions">',
        market.githubReadmeUrl
          ? `<a class="ghost" href="${escapeHtml(market.githubReadmeUrl)}">Read details</a>`
          : "",
        `<a class="button" href="${escapeHtml(market.trackedSiteUrl || market.siteUrl)}">Open list</a>`,
        "</div>",
        "</article>",
      ].join(""),
    )
    .join("");

  const reportCards = activeReports
    .map((report) =>
      [
        '<article class="card list-card">',
        `<p class="card-status">${escapeHtml(report.status)}</p>`,
        `<h3>${escapeHtml(report.title)}</h3>`,
        `<p class="card-copy">${escapeHtml(report.summary || "Public note from EnrichAnything.")}</p>`,
        `<p class="card-meta">${formatRowCount(report.rowCount)} rows${report.contextLine ? ` · ${escapeHtml(report.contextLine)}` : ""}</p>`,
        '<div class="card-actions">',
        report.githubReadmeUrl
          ? `<a class="ghost" href="${escapeHtml(report.githubReadmeUrl)}">Read details</a>`
          : "",
        `<a class="button" href="${escapeHtml(report.trackedSiteUrl || report.siteUrl)}">Open note</a>`,
        "</div>",
        "</article>",
      ].join(""),
    )
    .join("");

  const queuedCards = [...pipelineMarkets, ...pipelineReports]
    .slice(0, 8)
    .map(
      (record) =>
        `<article class="queued-item"><strong>${escapeHtml(record.title)}</strong><span>${escapeHtml(record.status)}</span></article>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(config.title)}</title>
    <meta name="description" content="${escapeHtml(config.summary)}">
    <meta property="og:type" content="website">
    <meta property="og:title" content="${escapeHtml(config.title)}">
    <meta property="og:description" content="${escapeHtml(config.summary)}">
    ${config.pagesUrl ? `<meta property="og:url" content="${escapeHtml(config.pagesUrl)}">` : ""}
    ${config.socialImageUrl ? `<meta property="og:image" content="${escapeHtml(config.socialImageUrl)}">` : ""}
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(config.title)}">
    <meta name="twitter:description" content="${escapeHtml(config.summary)}">
    ${config.socialImageUrl ? `<meta name="twitter:image" content="${escapeHtml(config.socialImageUrl)}">` : ""}
    <style>
      :root {
        --bg: #f5f0e8;
        --surface: rgba(255, 251, 245, 0.94);
        --surface-strong: #fffdf8;
        --ink: #1c1712;
        --muted: #62584e;
        --border: rgba(28, 23, 18, 0.12);
        --accent: ${accentColor};
        --shadow: 0 24px 60px rgba(33, 25, 18, 0.08);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(255, 255, 255, 0.7), transparent 30rem),
          linear-gradient(180deg, #f7f2ea 0%, #efe6da 100%);
        color: var(--ink);
      }

      a {
        color: inherit;
      }

      .shell {
        max-width: 1120px;
        margin: 0 auto;
        padding: 32px 20px 72px;
      }

      .topbar {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: center;
        margin-bottom: 32px;
        font-size: 0.95rem;
        color: var(--muted);
      }

      .topbar-links {
        display: flex;
        gap: 14px;
        flex-wrap: wrap;
      }

      .hero {
        padding: 40px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 28px;
        box-shadow: var(--shadow);
      }

      .eyebrow {
        margin: 0 0 12px;
        font-size: 0.82rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--accent);
      }

      h1,
      h2,
      h3,
      p {
        margin-top: 0;
      }

      h1 {
        margin-bottom: 12px;
        font-size: clamp(2.3rem, 5vw, 4.4rem);
        line-height: 0.96;
        max-width: 14ch;
      }

      .lede {
        max-width: 44rem;
        margin-bottom: 10px;
        font-size: 1.12rem;
        line-height: 1.6;
      }

      .sublede {
        max-width: 42rem;
        margin-bottom: 24px;
        color: var(--muted);
        font-size: 1rem;
        line-height: 1.6;
      }

      .hero-stats,
      .card-actions,
      .topbar-links,
      .hero-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }

      .stat {
        padding: 10px 14px;
        border: 1px solid var(--border);
        border-radius: 999px;
        background: var(--surface-strong);
        font-size: 0.92rem;
      }

      .hero-actions {
        margin-top: 24px;
      }

      .button,
      .ghost {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 44px;
        padding: 0 16px;
        border-radius: 999px;
        border: 1px solid var(--border);
        text-decoration: none;
        font-weight: 600;
      }

      .button {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }

      .ghost {
        background: var(--surface-strong);
        color: var(--ink);
      }

      .section {
        margin-top: 36px;
      }

      .section-head {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: flex-end;
        margin-bottom: 16px;
      }

      .section-head p {
        color: var(--muted);
        max-width: 40rem;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
        gap: 16px;
      }

      .card {
        padding: 22px;
        border-radius: 22px;
        border: 1px solid var(--border);
        background: var(--surface);
      }

      .playbook-card {
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(255, 249, 242, 0.95));
      }

      .list-card h3 {
        margin-bottom: 10px;
        font-size: 1.18rem;
        line-height: 1.2;
      }

      .card-copy,
      .card-meta,
      .card-link,
      .queued-item span {
        color: var(--muted);
        line-height: 1.55;
      }

      .card-status {
        margin-bottom: 12px;
        color: var(--accent);
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 0.76rem;
      }

      .queued-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
        gap: 12px;
      }

      .queued-item {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 18px;
        border: 1px solid var(--border);
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.6);
      }

      footer {
        margin-top: 42px;
        color: var(--muted);
        font-size: 0.92rem;
      }

      @media (max-width: 720px) {
        .shell {
          padding: 20px 14px 52px;
        }

        .hero {
          padding: 24px;
          border-radius: 22px;
        }

        .topbar,
        .section-head {
          display: block;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <div class="topbar">
        <strong>EnrichAnything public repo</strong>
        <div class="topbar-links">
          ${config.repoUrl ? `<a href="${escapeHtml(config.repoUrl)}">GitHub repo</a>` : ""}
          <a href="${escapeHtml(config.trackedHomeUrl || config.siteOrigin)}">Main site</a>
        </div>
      </div>

      <section class="hero">
        <p class="eyebrow">Source-backed prospect lists</p>
        <h1>${escapeHtml(config.title)}</h1>
        <p class="lede">${escapeHtml(config.summary)}</p>
        <p class="sublede">${escapeHtml(config.theme)}</p>

        <div class="hero-stats">
          <span class="stat">${activeMarkets.length} lists ready</span>
          <span class="stat">${activeReports.length} notes ready</span>
          <span class="stat">Updated ${escapeHtml(formatDate(config.generatedAt) || config.generatedAt)}</span>
        </div>

        <div class="hero-actions">
          ${
            featuredMarket
              ? `<a class="button" href="${escapeHtml(featuredMarket.trackedSiteUrl || featuredMarket.siteUrl)}">Open the main list</a>`
              : `<a class="button" href="${escapeHtml(config.trackedHomeUrl || config.siteOrigin)}">Open EnrichAnything</a>`
          }
          ${
            config.featuredReportUrl
              ? `<a class="ghost" href="${escapeHtml(config.featuredReportUrl)}">Read the matching note</a>`
              : ""
          }
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>How people actually use this</h2>
            <p>Each repo is aimed at a buyer motion, not a vague category page.</p>
          </div>
        </div>
        <div class="grid">
          ${playbookCards}
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Use the same data as JSON</h2>
            <p>API docs, OpenAPI, and thin SDK repos for teams that want the published scans programmatically.</p>
          </div>
        </div>
        <div class="grid">
          <article class="card">
            <p class="card-status">Docs</p>
            <h3>Public API docs</h3>
            <p class="card-copy">Stable docs URL plus OpenAPI for directories, examples, and internal tooling.</p>
            <div class="card-actions">
              <a class="button" href="${escapeHtml(PUBLIC_API_DOCS_URL)}">Open docs</a>
              <a class="ghost" href="${escapeHtml(PUBLIC_API_OPENAPI_URL)}">OpenAPI JSON</a>
            </div>
          </article>
          <article class="card">
            <p class="card-status">Node</p>
            <h3>Node SDK repo</h3>
            <p class="card-copy">Thin wrapper around the public market and report endpoints.</p>
            <div class="card-actions">
              <a class="button" href="${escapeHtml(NODE_SDK_REPO_URL)}">View repo</a>
            </div>
          </article>
          <article class="card">
            <p class="card-status">Python</p>
            <h3>Python SDK repo</h3>
            <p class="card-copy">Same public endpoints packaged for notebooks, scripts, and ops workflows.</p>
            <div class="card-actions">
              <a class="button" href="${escapeHtml(PYTHON_SDK_REPO_URL)}">View repo</a>
            </div>
          </article>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Lists you can use now</h2>
            <p>Open the list on EnrichAnything when you want the full table. Read the GitHub page when you want the context first.</p>
          </div>
        </div>
        <div class="grid">
          ${marketCards}
        </div>
      </section>

      ${
        reportCards
          ? `<section class="section">
        <div class="section-head">
          <div>
            <h2>Notes that explain the market</h2>
            <p>These are the short writeups behind the lists, so the repo does not feel like a random dump of CSV-shaped pages.</p>
          </div>
        </div>
        <div class="grid">
          ${reportCards}
        </div>
      </section>`
          : ""
      }

      ${
        queuedCards
          ? `<section class="section">
        <div class="section-head">
          <div>
            <h2>Still queued up</h2>
            <p>These ideas already exist. They just need more public sample depth.</p>
          </div>
        </div>
        <div class="queued-grid">
          ${queuedCards}
        </div>
      </section>`
          : ""
      }

      <footer>
        Want a different cut, more columns, or a fresh export? <a href="${escapeHtml(config.trackedHomeUrl || config.siteOrigin)}">Open EnrichAnything</a>.
      </footer>
    </main>
  </body>
</html>
`;
}

function renderPlaybookMarkdown(playbooks = []) {
  if (!Array.isArray(playbooks) || !playbooks.length) {
    return ["- Use the live lists below as a narrowed prospect pool, then click through if you want the full table."];
  }

  return playbooks.map((playbook) => {
    const startLine =
      playbook.startTitle && playbook.startUrl
        ? ` Start with [${playbook.startTitle}](${playbook.startUrl})${playbook.startStatus ? ` (${playbook.startStatus})` : ""}.`
        : "";

    return `- ${playbook.role}: ${playbook.pitch}${startLine}`;
  });
}

function normalizeStats(stats = []) {
  if (!Array.isArray(stats)) {
    return [];
  }

  return stats
    .map((stat) => {
      if (!stat || typeof stat !== "object" || Array.isArray(stat)) {
        return null;
      }

      return {
        value: String(stat.value ?? "").trim(),
        label: String(stat.label ?? "").trim(),
        detail: String(stat.detail ?? "").trim(),
        note: String(stat.note ?? "").trim(),
      };
    })
    .filter((stat) => stat && (stat.value || stat.label || stat.detail || stat.note));
}

function normalizeRows(rows = []) {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        return null;
      }

      return {
        company: String(row.company ?? "").trim(),
        location: String(row.location ?? "").trim(),
        signal: String(row.signal ?? "").trim(),
        gap: String(row.gap ?? "").trim(),
        whyNow: String(row.whyNow ?? "").trim(),
      };
    })
    .filter((row) => row && Object.values(row).some(Boolean));
}

function formatStatus(payload = {}) {
  if (!payload || typeof payload !== "object") {
    return "draft";
  }

  if (payload.live) {
    return "live";
  }

  const source = String(payload.dataSource || "").trim();

  if (source === "collecting_sample") {
    return "collecting sample";
  }

  if (source === "archived_sample") {
    return "archived sample";
  }

  if (source === "template") {
    return "template only";
  }

  return source || "draft";
}

function formatPublicSampleLine(record = {}) {
  const rowCount = Math.max(0, Number(record?.rowCount || 0) || 0);
  const collectionTarget = Math.max(0, Number(record?.collectionTarget || 0) || 0);

  if (!rowCount) {
    return null;
  }

  if (collectionTarget && rowCount < collectionTarget) {
    return `- Public sample: ${rowCount} rows so far`;
  }

  return `- Public sample: ${rowCount} rows`;
}

function buildMarketStatusLine(record = {}) {
  const status = String(record?.status || "").trim();

  if (status === "live") {
    return "This list is live. You can use it to see the angle and the kinds of companies that match.";
  }

  if (status === "collecting sample") {
    return "This list is still filling in. The angle is clear, but the public sample is not complete yet.";
  }

  if (status === "template only") {
    return "The list definition exists, but the public sample is not live yet.";
  }

  if (status === "archived sample") {
    return "This list is archived because the public sample stayed too thin.";
  }

  return String(record?.dataNote || "").trim() || "This list is available as a public sample.";
}

function buildReportStatusLine(record = {}) {
  const status = String(record?.status || "").trim();

  if (status === "live") {
    return "This note is live and based on the current public list.";
  }

  if (status === "collecting sample") {
    return "This note is still being built because the underlying list is still filling in.";
  }

  if (status === "template only") {
    return "The note exists, but the underlying public list is not live yet.";
  }

  if (status === "archived sample") {
    return "This note is archived because the underlying public list stayed too thin.";
  }

  return String(record?.dataNote || "").trim() || "This note is based on a public EnrichAnything list.";
}

function pickPreferredRecord(records = [], preferredSlug = "") {
  const items = Array.isArray(records) ? records.filter(Boolean) : [];
  const slug = String(preferredSlug || "").trim();

  if (slug) {
    const exact = items.find((record) => String(record.slug || "").trim() === slug);
    if (exact) {
      return exact;
    }
  }

  return items
    .slice()
    .sort((left, right) => {
      const rankDelta = getStatusRank(left?.status) - getStatusRank(right?.status);
      if (rankDelta !== 0) {
        return rankDelta;
      }

      return String(left?.title || "").localeCompare(String(right?.title || ""));
    })[0] || null;
}

function getActiveRecords(records = []) {
  return Array.isArray(records)
    ? records.filter((record) => String(record?.status || "").trim() !== "template only")
    : [];
}

function getPipelineRecords(records = []) {
  return Array.isArray(records)
    ? records.filter((record) => String(record?.status || "").trim() === "template only")
    : [];
}

function getStatusRank(status = "") {
  const value = String(status || "").trim();

  if (value === "live") {
    return 0;
  }

  if (value === "collecting sample") {
    return 1;
  }

  if (value === "archived sample") {
    return 2;
  }

  if (value === "template only") {
    return 3;
  }

  return 4;
}

function formatDate(value = "") {
  const date = new Date(value);

  if (!value || Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function formatRowCount(value = 0) {
  const rowCount = Math.max(0, Number(value || 0) || 0);
  return rowCount ? String(rowCount) : "-";
}

function buildTrackedUrl(baseUrl = "", { source = "github", medium = "public_repo", campaign = "", content = "" } = {}) {
  const rawValue = String(baseUrl || "").trim();

  if (!rawValue) {
    return "";
  }

  try {
    const url = new URL(rawValue);
    url.searchParams.set("utm_source", source);
    url.searchParams.set("utm_medium", medium);

    if (campaign) {
      url.searchParams.set("utm_campaign", campaign);
    }

    if (content) {
      url.searchParams.set("utm_content", content);
    }

    return url.toString();
  } catch {
    return rawValue;
  }
}

function buildAssetUrl(baseUrl = "", assetPath = "") {
  const rawBase = String(baseUrl || "").trim();
  const rawAsset = String(assetPath || "").trim().replace(/^\/+/, "");

  if (!rawBase || !rawAsset) {
    return "";
  }

  try {
    return new URL(rawAsset, rawBase.endsWith("/") ? rawBase : `${rawBase}/`).toString();
  } catch {
    return "";
  }
}

function sanitizeColor(value = "", fallback = "#0f766e") {
  return /^#[0-9a-f]{6}$/i.test(String(value || "").trim()) ? String(value).trim() : fallback;
}

function escapeTable(value = "") {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function escapeHtml(value = "") {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function writeJson(targetPath, value) {
  await fs.writeFile(targetPath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function writeText(targetPath, value) {
  await fs.writeFile(targetPath, String(value || ""), "utf8");
}
