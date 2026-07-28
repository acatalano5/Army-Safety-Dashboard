import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

const SECTION_CONFIG = {
  exercises: {
    query: '("military exercise" OR "joint exercise" OR "training exercise")',
    timespan: "3d",
    allowedDomains: [
      "af.mil",
      "army.mil",
      "coastguard.mil",
      "defense.gov",
      "dvidshub.net",
      "marines.mil",
      "navy.mil",
      "spaceforce.mil",
      "uscg.mil",
    ],
  },
  safety: {
    query: '("military training" AND (mishap OR accident OR crash OR fatality))',
    timespan: "14d",
    allowedDomains: [
      "af.mil",
      "army.mil",
      "coastguard.mil",
      "defense.gov",
      "marines.mil",
      "navalsafetycommand.navy.mil",
      "navy.mil",
      "safety.af.mil",
      "safety.army.mil",
      "spaceforce.mil",
      "uscg.mil",
    ],
  },
  conflicts: {
    query: '(war OR "armed conflict" OR airstrike OR escalation OR ceasefire)',
    timespan: "3d",
    allowedDomains: [
      "aa.com.tr",
      "aljazeera.com",
      "al-monitor.com",
      "apnews.com",
      "bbc.com",
      "cfr.org",
      "channelnewsasia.com",
      "crisisgroup.org",
      "defense.gov",
      "dw.com",
      "france24.com",
      "globaltimes.cn",
      "haaretz.com",
      "kyivindependent.com",
      "liveuamap.com",
      "nato.int",
      "nhk.or.jp",
      "presstv.ir",
      "pravda.com.ua",
      "rferl.org",
      "reliefweb.int",
      "reuters.com",
      "state.gov",
      "tass.com",
      "timesofisrael.com",
      "un.org",
      "understandingwar.org",
      "ukmto.org",
      "voanews.com",
    ],
  },
};

const OFFICIAL_DOMAINS = ["defense.gov", "state.gov", "un.org", "nato.int", "ukmto.org"];
const ANALYTIC_DOMAINS = ["cfr.org", "crisisgroup.org", "reliefweb.int", "understandingwar.org"];
const REGIONAL_DOMAINS = [
  "al-monitor.com",
  "channelnewsasia.com",
  "haaretz.com",
  "kyivindependent.com",
  "nhk.or.jp",
  "pravda.com.ua",
  "timesofisrael.com",
];
const STATE_AFFILIATED_DOMAINS = ["aa.com.tr", "globaltimes.cn", "presstv.ir", "rferl.org", "tass.com", "voanews.com"];
const OSINT_DOMAINS = ["liveuamap.com"];

function parseSections() {
  const flag = process.argv.find((argument) => argument.startsWith("--sections="));
  const requested = (flag?.split("=")[1] || Object.keys(SECTION_CONFIG).join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const invalid = requested.filter((section) => !(section in SECTION_CONFIG));
  if (invalid.length) throw new Error(`Unknown section: ${invalid.join(", ")}`);
  return requested;
}

function dataPath() {
  if (process.env.DASHBOARD_DATA_PATH) return resolve(process.env.DASHBOARD_DATA_PATH);
  return resolve(existsSync("public") ? "public/data/live-headlines.json" : "data/live-headlines.json");
}

function normalizeDomain(value = "") {
  return value.toLowerCase().replace(/^www\./, "");
}

function domainIsAllowed(domain, allowlist) {
  const normalized = normalizeDomain(domain);
  return allowlist.some((allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`));
}

function sourceTier(domain) {
  if (domainIsAllowed(domain, OFFICIAL_DOMAINS)) return "Official / intergovernmental";
  if (domainIsAllowed(domain, ANALYTIC_DOMAINS)) return "Structured / analytic";
  if (domainIsAllowed(domain, STATE_AFFILIATED_DOMAINS)) return "State-affiliated reporting";
  if (domainIsAllowed(domain, REGIONAL_DOMAINS)) return "Regional reporting";
  if (domainIsAllowed(domain, OSINT_DOMAINS)) return "OSINT aggregator";
  return "Independent reporting";
}

function confidenceLabel(tier) {
  if (tier === "Official / intergovernmental") return "OFFICIAL STATEMENT";
  if (tier === "Structured / analytic") return "ANALYTIC REPORT";
  if (tier === "State-affiliated reporting") return "PARTY / STATE CLAIM · UNCONFIRMED";
  if (tier === "Regional reporting") return "REGIONAL REPORT · UNCONFIRMED";
  if (tier === "OSINT aggregator") return "OSINT LEAD · UNCONFIRMED";
  return "MEDIA REPORT · UNCONFIRMED";
}

function cleanTitle(value = "") {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

function decodeXml(value = "") {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function fetchWithRetry(url, label, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Open-Source-Readiness-Dashboard/3.0" },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return response;
      lastError = new Error(`${label}: source returned ${response.status}`);
      if (response.status !== 429 && response.status < 500) throw lastError;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts - 1) await wait(5_000 * 2 ** attempt);
  }
  throw lastError || new Error(`${label}: source unavailable`);
}

function reportDate(value = "") {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : new Date().toISOString().slice(0, 10);
}

function withinTimespan(value, timespan) {
  const days = Number(timespan.match(/^(\d+)d$/)?.[1]);
  if (!days || !value) return false;
  const published = new Date(`${reportDate(value)}T00:00:00Z`);
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days - 1);
  return published >= cutoff;
}

function googleNewsItems(xml, config) {
  const entries = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  return entries.map(([, item]) => {
    const title = decodeXml(item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1] || "");
    const url = decodeXml(item.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "");
    const sourceUrl = decodeXml(item.match(/<source[^>]+url="([^"]+)"/i)?.[1] || "");
    const published = decodeXml(item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || "");
    let domain = "";
    try {
      domain = normalizeDomain(new URL(sourceUrl || url).hostname);
    } catch {
      return null;
    }
    const publishedDate = new Date(published);
    return {
      title: cleanTitle(title.replace(/\s+-\s+[^-]+$/, "")),
      url,
      domain,
      sourceTier: sourceTier(domain),
      seen: Number.isNaN(publishedDate.getTime())
        ? ""
        : publishedDate.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".000", ""),
    };
  }).filter((item) => item?.title && item?.url && domainIsAllowed(item.domain, config.allowedDomains));
}

function reportTimestamp(value = "") {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?/);
  if (!match) return new Date().toISOString();
  return `${match[1]}-${match[2]}-${match[3]}T${match[4] || "00"}:${match[5] || "00"}:${match[6] || "00"}Z`;
}

function conflictReportFromItem(item) {
  return {
    id: `report-${createHash("sha256").update(item.url).digest("hex").slice(0, 12)}`,
    title: item.title,
    url: item.url,
    domain: item.domain,
    sourceTier: item.sourceTier,
    confidenceLabel: confidenceLabel(item.sourceTier),
    reportedAt: reportTimestamp(item.seen),
  };
}

function classifyService(item) {
  const text = `${item.domain} ${item.title}`.toLowerCase();
  if (text.includes("marines.mil") || /\bmarine(s| corps)?\b/.test(text)) {
    return { branch: "Marine Corps", department: "Department of the Navy" };
  }
  if (text.includes("navy.mil") || text.includes("navalsafetycommand") || /\bnavy\b/.test(text)) {
    return { branch: "Navy", department: "Department of the Navy" };
  }
  if (text.includes("spaceforce.mil") || /\bspace force\b/.test(text)) {
    return { branch: "Space Force", department: "Department of the Air Force" };
  }
  if (text.includes("af.mil") || /\bair force\b/.test(text)) {
    return { branch: "Air Force", department: "Department of the Air Force" };
  }
  if (text.includes("uscg.mil") || text.includes("coastguard.mil") || /\bcoast guard\b/.test(text)) {
    return { branch: "Coast Guard", department: "Department of Homeland Security" };
  }
  return { branch: "Army", department: "Department of the Army" };
}

function classifyMishap(title) {
  const text = title.toLowerCase();
  if (/(aircraft|aviation|helicopter|plane|jet|flight|crash|hard landing|eject)/.test(text)) return "Aviation";
  if (/(ship|vessel|boat|collision at sea|maritime)/.test(text)) return "Maritime";
  if (/(vehicle|rollover|range|weapon|ammunition|ground|training area)/.test(text)) return "Ground";
  return "Other";
}

function sectionRelevant(section, title) {
  const text = title.toLowerCase();
  if (section === "safety") {
    return /(mishap|accident|crash|fatal|killed|death|injur|collision|rollover|hard landing|eject)/.test(text);
  }
  if (section === "exercises") {
    return /(exercise|training|drill|readiness|maneuver|manoeuvre)/.test(text);
  }
  return /(war|conflict|strike|attack|ceasefire|military|missile|drone|combat|crisis|troops|invasion)/.test(text);
}

function incidentFromItem(item) {
  const service = classifyService(item);
  return {
    id: `auto-${createHash("sha256").update(item.url).digest("hex").slice(0, 12)}`,
    reportDate: reportDate(item.seen),
    dateBasis: "report discovery date",
    branch: service.branch,
    department: service.department,
    type: classifyMishap(item.title),
    event: item.title,
    location: "See official source",
    fatalities: null,
    injuries: null,
    status: "AUTOMATED INTAKE",
    source: item.url,
    sourceLabel: item.domain,
  };
}

async function requestSection(section) {
  const config = SECTION_CONFIG[section];
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  const domainQuery = config.allowedDomains.map((domain) => `domainis:${domain}`).join(" OR ");
  url.searchParams.set("query", `${config.query} (${domainQuery})`);
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("maxrecords", "75");
  url.searchParams.set("format", "json");
  url.searchParams.set("timespan", config.timespan);
  url.searchParams.set("sort", "HybridRel");

  let rawItems;
  try {
    const response = await fetchWithRetry(url, `${section} GDELT`);
    const payload = await response.json();
    rawItems = (Array.isArray(payload.articles) ? payload.articles : []).map((article) => ({
      title: article.title,
      url: article.url,
      domain: article.domain,
      seen: article.seendate || "",
    }));
  } catch (gdeltError) {
    console.warn(`${gdeltError.message}; trying Google News RSS fallback`);
    const rssUrl = new URL("https://news.google.com/rss/search");
    const siteQuery = config.allowedDomains.map((domain) => `site:${domain}`).join(" OR ");
    rssUrl.searchParams.set("q", `${config.query} (${siteQuery}) when:${config.timespan}`);
    rssUrl.searchParams.set("hl", "en-US");
    rssUrl.searchParams.set("gl", "US");
    rssUrl.searchParams.set("ceid", "US:en");
    const rssResponse = await fetchWithRetry(rssUrl, `${section} RSS`, 3);
    rawItems = googleNewsItems(await rssResponse.text(), config);
  }

  const seen = new Set();
  const items = rawItems
    .map((article) => {
      let domain = normalizeDomain(article.domain);
      try {
        domain ||= normalizeDomain(new URL(article.url).hostname);
      } catch {
        return null;
      }
      return {
        title: cleanTitle(article.title),
        url: article.url,
        domain,
        sourceTier: sourceTier(domain),
        seen: article.seendate || article.seen || "",
      };
    })
    .filter((item) => item?.title && item?.url && domainIsAllowed(item.domain, config.allowedDomains))
    .filter((item) => sectionRelevant(section, item.title))
    .filter((item) => withinTimespan(item.seen, config.timespan))
    .filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    })
    .slice(0, section === "safety" ? 20 : section === "conflicts" ? 24 : 8);

  return items;
}

async function main() {
  const path = dataPath();
  const validatedPath = resolve(dirname(path), "validated-incidents.json");
  const sections = parseSections();
  let current = { schemaVersion: 1, generatedAt: null, sections: {} };
  let validatedSources = new Set();

  try {
    current = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  try {
    const validated = JSON.parse(await readFile(validatedPath, "utf8"));
    validatedSources = new Set((validated.incidents || []).map((item) => item.source).filter(Boolean));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const updates = [];
  for (const section of sections) {
    updates.push([section, await requestSection(section)]);
    if (sections.length > 1) await wait(3_000);
  }
  const generatedAt = new Date().toISOString();

  for (const [section, items] of updates) {
    current.sections[section] = {
      generatedAt,
      cadence: section === "safety" ? "daily" : "every 6 hours",
      items,
      ...(section === "safety"
        ? { incidents: items.map(incidentFromItem).filter((item) => !validatedSources.has(item.source)) }
        : {}),
      ...(section === "conflicts" ? { reports: items.map(conflictReportFromItem) } : {}),
    };
  }

  current.schemaVersion = 1;
  current.generatedAt = generatedAt;
  current.method =
    "Automated discovery from GDELT, restricted to allowlisted public and official domains. Curated dashboard records require human validation.";

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  console.log(`Updated ${sections.join(", ")} in ${path}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
