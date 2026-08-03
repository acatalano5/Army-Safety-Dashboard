import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

const SECTION_CONFIG = {
  exercises: {
    query: '("military exercise" OR "joint exercise" OR "training exercise" OR "National Guard training" OR "Army Reserve training" OR "Air Force Reserve training" OR "Navy Reserve training" OR "Marine Forces Reserve training" OR "Coast Guard Reserve training")',
    timespan: "7d",
    allowedDomains: [
      "af.mil",
      "army.mil",
      "coastguard.mil",
      "defense.gov",
      "dvidshub.net",
      "marines.mil",
      "nationalguard.mil",
      "navy.mil",
      "spaceforce.mil",
      "uscg.mil",
    ],
  },
  safety: {
    query: '((military OR Army OR Navy OR "Air Force" OR Marines OR "Coast Guard") AND (mishap OR accident OR crash OR fatality OR fire OR "emergency landing" OR "near miss" OR "safety review"))',
    timespan: "30d",
    allowedDomains: [
      "af.mil",
      "airandspaceforces.com",
      "apnews.com",
      "army.mil",
      "coastguard.mil",
      "defense.gov",
      "dvidshub.net",
      "marines.mil",
      "military.com",
      "militarytimes.com",
      "navalsafetycommand.navy.mil",
      "navy.mil",
      "reuters.com",
      "safety.af.mil",
      "safety.army.mil",
      "spaceforce.mil",
      "stripes.com",
      "taskandpurpose.com",
      "usni.org",
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
const OFFICIAL_MILITARY_DOMAINS = [
  "af.mil",
  "army.mil",
  "coastguard.mil",
  "defense.gov",
  "dvidshub.net",
  "marines.mil",
  "navalsafetycommand.navy.mil",
  "navy.mil",
  "safety.af.mil",
  "safety.army.mil",
  "spaceforce.mil",
  "uscg.mil",
];
const ANALYTIC_DOMAINS = ["cfr.org", "crisisgroup.org", "reliefweb.int", "understandingwar.org"];
const BASELINE_CONFLICT_SOURCES = [
  {
    title: "Global Conflict Tracker",
    url: "https://www.cfr.org/global-conflict-tracker",
    domain: "cfr.org",
    sourceTier: "Structured / analytic",
  },
  {
    title: "CrisisWatch global conflict tracker",
    url: "https://www.crisisgroup.org/crisiswatch",
    domain: "crisisgroup.org",
    sourceTier: "Structured / analytic",
  },
  {
    title: "United Nations Secretary-General highlights",
    url: "https://www.un.org/sg/en/content/highlight",
    domain: "un.org",
    sourceTier: "Official / intergovernmental",
  },
];
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
const KNOWN_SAFETY_REPORTS = [
  {
    title: "Marine Corps MV-22 Osprey suffers engine fire during Air Force training exercise",
    url: "https://www.militarytimes.com/news/your-military/2026/07/21/marine-corps-mv-22-osprey-suffers-engine-fire-during-air-force-training-exercise/",
    domain: "militarytimes.com",
    seen: "20260721T174800Z",
  },
  {
    title: "Navy suspends search after MH-60S helicopter mishap; one Sailor missing",
    url: "https://www.navy.mil/Press-Office/Statements/display-statement/Article/4533332/us-navy-suspended-active-search-for-a-sailor-assigned-to-helicopter-sea-combat/",
    domain: "navy.mil",
    seen: "20260705T150000Z",
  },
  {
    title: "Navy conducts safety review after Blue Angels low-altitude flyover",
    url: "https://apnews.com/article/hegseth-blue-angels-military-flyovers-safety-c2601ce50f433996c919464f1de7985c",
    domain: "apnews.com",
    seen: "20260716T220900Z",
  },
];

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
  if (domainIsAllowed(domain, OFFICIAL_MILITARY_DOMAINS)) return "Official military source";
  if (domainIsAllowed(domain, OFFICIAL_DOMAINS)) return "Official / intergovernmental";
  if (domainIsAllowed(domain, ANALYTIC_DOMAINS)) return "Structured / analytic";
  if (domainIsAllowed(domain, STATE_AFFILIATED_DOMAINS)) return "State-affiliated reporting";
  if (domainIsAllowed(domain, REGIONAL_DOMAINS)) return "Regional reporting";
  if (domainIsAllowed(domain, OSINT_DOMAINS)) return "OSINT aggregator";
  return "Independent reporting";
}

function classifyExerciseComponents(title = "") {
  const text = title.toLowerCase();
  const components = [];
  if (/\b(national guard|army guard|air guard|ang)\b/.test(text)) components.push("National Guard");
  if (/\b(army reserve|air force reserve|navy reserve|marine forces reserve|marine reserve|coast guard reserve|reserve command|reservists?)\b/.test(text)) components.push("Reserve");
  if (/\b(active[- ]duty|active component|regular army)\b/.test(text)) components.push("Active");
  return components.length ? components : ["Component not specified"];
}

function confidenceLabel(tier) {
  if (tier === "Official military source") return "OFFICIAL REPORT";
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

function mergeConflictReports(items, previousReports, generatedAt) {
  const discovered = items.map(conflictReportFromItem);
  const retainedAssessed = (Array.isArray(previousReports) ? previousReports : [])
    .filter((report) => !String(report.confidenceLabel || "").includes("UNCONFIRMED"));
  const baseline = BASELINE_CONFLICT_SOURCES.map((item) => ({
    ...conflictReportFromItem({ ...item, seen: generatedAt.replaceAll("-", "").replaceAll(":", "").replace(".000", "") }),
    reportedAt: generatedAt,
  }));
  const merged = [...discovered, ...retainedAssessed, ...baseline];
  const seen = new Set();
  return merged.filter((report) => {
    if (!report?.url || seen.has(report.url)) return false;
    seen.add(report.url);
    return true;
  });
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
  if (text.includes("af.mil") || /\b(air force|b-52|t-38)\b/.test(text)) {
    return { branch: "Air Force", department: "Department of the Air Force" };
  }
  if (text.includes("uscg.mil") || text.includes("coastguard.mil") || /\bcoast guard\b/.test(text)) {
    return { branch: "Coast Guard", department: "Department of Homeland Security" };
  }
  return { branch: "Army", department: "Department of the Army" };
}

function classifyMishap(title) {
  const text = title.toLowerCase();
  if (/(aircraft|aviation|helicopter|plane|jet|flight|crash|hard landing|eject|engine fire|mv-22|cv-22|osprey)/.test(text)) return "Aviation";
  if (/(ship|vessel|boat|collision at sea|maritime)/.test(text)) return "Maritime";
  if (/(vehicle|rollover|range|weapon|ammunition|ground|training area)/.test(text)) return "Ground";
  return "Other";
}

function sectionRelevant(section, title, domain = "") {
  const text = title.toLowerCase();
  if (section === "safety") {
    const mishapLanguage = /(mishap|accident|crash|fatal|killed|death|injur|collision|rollover|hard landing|eject|engine fire|caught fire|emergency landing|near miss|close call|safety review|grounded|operational pause|missing|suspends search)/.test(text);
    const militaryContext = /(military|army|navy|air force|marine|coast guard|soldier|sailor|airman|service member|b-52|t-38|f-1[568]|f-35|mv-22|cv-22|osprey|black hawk|apache)/.test(text);
    const usMarker = /(?:^|[^a-z])u\.?s\.?(?:[^a-z]|$)|\bamerican\b/.test(text);
    const officialMilitaryContext = domainIsAllowed(domain, OFFICIAL_MILITARY_DOMAINS) && militaryContext;
    const usMilitaryContext = officialMilitaryContext || (usMarker && militaryContext) || /\b(marine corps|air force|coast guard|blue angels|b-52|t-38|f-1[568]|f-35|mv-22|cv-22|osprey|black hawk|apache)\b/.test(text);
    const safetyCenter = domainIsAllowed(domain, ["navalsafetycommand.navy.mil", "safety.af.mil", "safety.army.mil"]);
    const responseOnly = /(responds? to|response to)/.test(text);
    return mishapLanguage && !responseOnly && (safetyCenter || usMilitaryContext);
  }
  if (section === "exercises") {
    return /(exercise|training|drill|readiness|maneuver|manoeuvre)/.test(text);
  }
  return /(war|conflict|strike|attack|ceasefire|military|missile|drone|combat|crisis|troops|invasion)/.test(text);
}

function safetyClass(title) {
  const text = title.toLowerCase();
  if (/(near miss|close call)/.test(text)) return "NEAR MISS";
  if (/(safety review|low.altitude|buzzed|operational pause|grounded)/.test(text)) return "SAFETY SIGNAL";
  return "REPORTED MISHAP";
}

function incidentFromItem(item) {
  const service = classifyService(item);
  const classification = safetyClass(item.title);
  const official = item.sourceTier === "Official military source";
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
    status: official ? "OFFICIAL INTAKE" : classification === "REPORTED MISHAP" ? "REPORTED / UNVALIDATED" : classification,
    signalClass: classification,
    sourceTier: item.sourceTier,
    confidenceLabel: official ? "OFFICIAL SOURCE · AWAITING REVIEW" : "OPEN-SOURCE REPORT · UNVALIDATED",
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
    const domainGroups = section !== "conflicts"
      ? Array.from({ length: Math.ceil(config.allowedDomains.length / 5) }, (_, index) => config.allowedDomains.slice(index * 5, index * 5 + 5))
      : [config.allowedDomains];
    rawItems = [];
    for (const [index, domains] of domainGroups.entries()) {
      const rssUrl = new URL("https://news.google.com/rss/search");
      const siteQuery = domains.map((domain) => `site:${domain}`).join(" OR ");
      const query = section === "safety"
        ? `(mishap OR accident OR crash OR fatality OR fire OR "emergency landing" OR "near miss" OR "safety review") (${siteQuery}) when:${config.timespan}`
        : `${config.query} (${siteQuery}) when:${config.timespan}`;
      rssUrl.searchParams.set("q", query);
      rssUrl.searchParams.set("hl", "en-US");
      rssUrl.searchParams.set("gl", "US");
      rssUrl.searchParams.set("ceid", "US:en");
      const rssResponse = await fetchWithRetry(rssUrl, `${section} RSS ${index + 1}`, 3);
      rawItems.push(...googleNewsItems(await rssResponse.text(), config));
      if (index < domainGroups.length - 1) await wait(1_500);
    }
  }

  const seen = new Set();
  const candidates = section === "safety" ? [...KNOWN_SAFETY_REPORTS, ...rawItems] : rawItems;
  const items = candidates
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
        ...(section === "exercises" ? { components: classifyExerciseComponents(article.title) } : {}),
      };
    })
    .filter((item) => item?.title && item?.url && domainIsAllowed(item.domain, config.allowedDomains))
    .filter((item) => sectionRelevant(section, item.title, item.domain))
    .filter((item) => withinTimespan(item.seen, config.timespan))
    .filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    })
    .slice(0, section === "safety" ? 20 : section === "conflicts" ? 24 : 24);

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
    const newSafetyIncidents = section === "safety" ? items.map(incidentFromItem) : [];
    const priorSafetyIncidents = section === "safety" && Array.isArray(current.sections?.safety?.incidents)
      ? current.sections.safety.incidents
      : [];
    const safetyHistory = [...newSafetyIncidents, ...priorSafetyIncidents]
      .filter((item, index, records) => item?.source && records.findIndex((candidate) => candidate.source === item.source) === index)
      .sort((a, b) => (b.reportDate || "").localeCompare(a.reportDate || ""));

    const previousConflictReports = current.sections?.conflicts?.reports;
    current.sections[section] = {
      generatedAt,
      cadence: section === "safety" ? "daily" : "every 6 hours",
      items,
      ...(section === "safety"
        ? { incidents: safetyHistory }
        : {}),
      ...(section === "conflicts" ? { reports: mergeConflictReports(items, previousConflictReports, generatedAt) } : {}),
    };
  }

  current.schemaVersion = 1;
  current.generatedAt = generatedAt;
  current.method =
    "Automated discovery from GDELT and Google News, restricted to allowlisted official and credible public sources. Exercise intake explicitly covers Active, Reserve and National Guard reporting and does not infer a component when the public source is ambiguous. Safety reports are categorized automatically by source and signal type; casualty values remain unknown unless reported.";

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  console.log(`Updated ${sections.join(", ")} in ${path}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
