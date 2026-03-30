import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "repo.config.json");
const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
const generatedAt = new Date().toISOString();

const refreshedMarkets = [];
for (const market of config.markets || []) {
  const payload = await fetchJson(new URL("/api/public-market", config.siteOrigin), market.slug);
  const merged = mergeMarket(market, payload);
  refreshedMarkets.push(merged);

  const targetDir = path.join(ROOT, "markets", merged.slug);
  await fs.mkdir(targetDir, { recursive: true });
  await writeText(path.join(targetDir, "README.md"), renderMarketReadme(merged));
  await writeJson(path.join(targetDir, "market.json"), merged);
}

const refreshedReports = [];
for (const report of config.reports || []) {
  const payload = await fetchJson(new URL("/api/public-report", config.siteOrigin), report.slug);
  const merged = mergeReport(report, payload);
  refreshedReports.push(merged);

  const targetDir = path.join(ROOT, "reports", merged.slug);
  await fs.mkdir(targetDir, { recursive: true });
  await writeText(path.join(targetDir, "README.md"), renderReportReadme(merged));
  await writeJson(path.join(targetDir, "report.json"), merged);
}

const nextConfig = {
  ...config,
  generatedAt,
  markets: refreshedMarkets,
  reports: refreshedReports,
};

await writeJson(path.join(ROOT, "repo.config.json"), nextConfig);
await writeJson(path.join(ROOT, "data", "catalog.json"), {
  generatedAt,
  title: nextConfig.title,
  summary: nextConfig.summary,
  topics: nextConfig.topics,
  markets: refreshedMarkets,
  reports: refreshedReports,
});
await writeText(path.join(ROOT, "README.md"), renderRepoReadme(nextConfig));

console.log(
  JSON.stringify({
    action: "refreshed_public_repo_assets",
    repo: config.name,
    generatedAt,
    markets: refreshedMarkets.length,
    reports: refreshedReports.length,
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

function renderRepoReadme(config = {}) {
  const activeMarkets = (config.markets || []).filter((market) => market.status !== "template only");
  const pipelineMarkets = (config.markets || []).filter((market) => market.status === "template only");
  const activeReports = (config.reports || []).filter((report) => report.status !== "template only");
  const pipelineReports = (config.reports || []).filter((report) => report.status === "template only");

  const lines = [
    `# ${config.title}`,
    "",
    config.summary,
    "",
    config.theme,
    "",
    `- Source product: ${config.siteOrigin}`,
    `- Generated from EnrichAnything public assets: ${formatDate(config.generatedAt) || config.generatedAt}`,
    "- Refresh command: `npm run refresh`",
    "",
    "## What you'll find here",
    "",
    "These are public examples from EnrichAnything. You can browse the lists, see why a company matched, and click through if you want the full table or want to build your own version.",
    "",
    "## Live lists",
    "",
    "| Market | Status | Rows | Page |",
    "| --- | --- | ---: | --- |",
    ...activeMarkets.map(
      (market) =>
        `| [${escapeTable(market.title)}](markets/${market.slug}/README.md) | ${escapeTable(market.status)} | ${market.rowCount} | [Live page](${market.siteUrl}) |`,
    ),
    "",
  ];

  if (activeReports.length) {
    lines.push(
      "## Notes built from those lists",
      "",
      "| Report | Status | Rows | Page |",
      "| --- | --- | ---: | --- |",
      ...activeReports.map(
        (report) =>
          `| [${escapeTable(report.title)}](reports/${report.slug}/README.md) | ${escapeTable(report.status)} | ${report.rowCount} | [Live page](${report.siteUrl}) |`,
      ),
      "",
    );
  }

  if (pipelineMarkets.length) {
    lines.push(
      "## Coming next",
      "",
      "These list ideas already exist in EnrichAnything, but the public sample is not live yet.",
      "",
      "| Market | Status | Page |",
      "| --- | --- | --- |",
      ...pipelineMarkets.map(
        (market) =>
          `| [${escapeTable(market.title)}](markets/${market.slug}/README.md) | ${escapeTable(market.status)} | [Live page](${market.siteUrl}) |`,
      ),
      "",
    );
  }

  if (pipelineReports.length) {
    lines.push(
      "## Notes coming next",
      "",
      "| Report | Status | Page |",
      "| --- | --- | --- |",
      ...pipelineReports.map(
        (report) =>
          `| [${escapeTable(report.title)}](reports/${report.slug}/README.md) | ${escapeTable(report.status)} | [Live page](${report.siteUrl}) |`,
      ),
      "",
    );
  }

  lines.push(
    "## Want more than the sample?",
    "",
    "Open any list in EnrichAnything if you want the full table, more columns, or a custom version for your niche.",
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
    `- Page: ${record.siteUrl}`,
    record.reportUrl ? `- Related note: ${record.reportUrl}` : null,
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
    `Open this list in EnrichAnything if you want the full table, extra columns, or a version for a different niche: ${record.siteUrl}`,
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
    `- Page: ${record.siteUrl}`,
    record.marketUrl ? `- Related list: ${record.marketUrl}` : null,
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
    `Open the related list in EnrichAnything if you want to inspect rows, add columns, or build your own version: ${record.siteUrl}`,
    "",
  );

  return lines.join("\n");
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

function escapeTable(value = "") {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

async function writeJson(targetPath, value) {
  await fs.writeFile(targetPath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function writeText(targetPath, value) {
  await fs.writeFile(targetPath, String(value || ""), "utf8");
}
