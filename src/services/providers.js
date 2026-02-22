const axios = require('axios');
const cheerio = require('cheerio');

let puppeteer = null;
let chromeExecutablePath = null;
try {
  puppeteer = require('puppeteer-core');
  const fs = require('fs');
  const possible = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ].filter(Boolean);

  // include user-local Chrome path
  try {
    const userLocal = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\AppData\\Local` : null);
    if (userLocal) {
      possible.push(`${userLocal}\\Google\\Chrome\\Application\\chrome.exe`);
    }
  } catch (e) {
    // ignore
  }

  for (const p of possible) {
    try {
      if (p && fs.existsSync(p)) {
        chromeExecutablePath = p;
        break;
      }
    } catch (e) {
      // ignore
    }
  }
} catch (e) {
  puppeteer = null;
}

const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 15000;
const CACHE_TTL_MS = Number(process.env.BRAND_MODEL_CACHE_TTL_MS) || 6 * 60 * 60 * 1000;
const brandCache = {
  expiresAt: 0,
  value: null
};
const sahibindenBrandCache = {
  expiresAt: 0,
  value: null
};
const modelCache = new Map();

function normalizePriceText(raw) {
  const cleaned = raw.replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const numeric = Number(cleaned.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(numeric)) {
    return null;
  }

  if (numeric < 100000 || numeric > 10000000) {
    return null;
  }

  return Math.round(numeric);
}

function extractPrices(html) {
  const prices = [];
  const priceRegex = /(\d{1,3}(?:[.,]\d{3})+|\d{5,8})\s*TL/gi;

  let match;
  while ((match = priceRegex.exec(html)) !== null) {
    const parsed = normalizePriceText(match[1]);
    if (parsed) {
      prices.push(parsed);
    }
  }

  return [...new Set(prices)].slice(0, 80);
}

function slugToTitle(value) {
  return String(value || '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
    .trim();
}

function prettifyToken(token) {
  if (!token) return '';
  const normalized = token.toLowerCase();
  const dictionary = {
    dci: 'dCi',
    tce: 'TCe',
    tdi: 'TDI',
    tsi: 'TSI',
    mpi: 'MPI',
    hdi: 'HDI',
    cdti: 'CDTI',
    ecog: 'Eco-G',
    bluedci: 'Blue dCi',
    ehev: 'e:HEV',
    epower: 'e-POWER',
    suv: 'SUV',
    gt: 'GT'
  };

  if (dictionary[normalized]) return dictionary[normalized];
  if (/^\d+$/.test(normalized)) return normalized;
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function prettifySlugText(slug) {
  return String(slug || '')
    .split('-')
    .reduce((acc, token) => {
      if (!token) return acc;
      const current = token.toLowerCase();
      const prev = acc[acc.length - 1] || '';

      if (/^\d+$/.test(current) && /^\d+$/.test(prev)) {
        acc[acc.length - 1] = `${prev}.${current}`;
        return acc;
      }

      acc.push(prettifyToken(current));
      return acc;
    }, [])
    .join(' ')
    .trim();
}

function getCachedModel(brandSlug) {
  const cached = modelCache.get(brandSlug);
  if (!cached) return null;
  if (cached.expiresAt < Date.now()) {
    modelCache.delete(brandSlug);
    return null;
  }

  return cached.value;
}

function setCachedModel(brandSlug, value) {
  modelCache.set(brandSlug, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
}

async function fetchHtml(url) {
  const response = await axios.get(url, {
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8'
    }
  });

  return response.data;
}

async function fetchArabamBrands() {
  if (brandCache.value && brandCache.expiresAt > Date.now()) {
    return brandCache.value;
  }

  const url = 'https://www.arabam.com/ikinci-el/tum-markalar';
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const items = new Map();

  $('.tab-content-item a[href*="/ikinci-el/otomobil/"]').each((_, element) => {
    const href = ($(element).attr('href') || '').trim();
    const absoluteHref = href.startsWith('http') ? href : `https://www.arabam.com${href}`;

    const pathMatch = absoluteHref.match(/\/ikinci-el\/otomobil\/([a-z0-9-]+)$/i);
    if (!pathMatch) return;

    const slug = pathMatch[1].toLowerCase();
    if (!slug || slug.includes('sahibinden')) return;

    const anchorText = $(element).text().replace(/\s+/g, ' ').trim();
      const normalizedText = anchorText
        .replace(/^İkinci El\s+/i, '')
        .replace(/\s+Fiyatlar[ıi]$/i, '')
        .replace(/\s*\(\s*[\d.,]+\s*\)\s*$/i, '')
        .trim();

    const name = normalizedText || slugToTitle(slug);

    if (!items.has(slug)) {
      items.set(slug, {
        slug,
        name,
        url: absoluteHref
      });
    }
  });

  const brands = [...items.values()]
    .filter((item) => {
      if (!item.slug.includes('-')) return true;
      const rootSlug = item.slug.split('-')[0];
      return !items.has(rootSlug);
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'tr'));
  brandCache.value = brands;
  brandCache.expiresAt = Date.now() + CACHE_TTL_MS;
  return brands;
}

async function fetchSahibindenBrands() {
  if (sahibindenBrandCache.value && sahibindenBrandCache.expiresAt > Date.now()) {
    return sahibindenBrandCache.value;
  }

  const url = 'https://www.sahibinden.com/otomobil';
  // try lightweight fetch first
  try {
    const html = await fetchHtml(url);
    const items = new Map();
    const regex = /\/otomobil\/([a-z0-9-]+)/gi;
    let match;

    while ((match = regex.exec(html)) !== null) {
      const slug = (match[1] || '').toLowerCase();
      if (!slug) continue;
      if (items.has(slug)) continue;

      const name = slugToTitle(slug);
      const urlCandidate = `https://www.sahibinden.com/otomobil/${slug}`;

      items.set(slug, {
        slug,
        name,
        url: urlCandidate
      });
    }

    if (items.size) {
      const brands = [...items.values()].sort((a, b) => a.name.localeCompare(b.name, 'tr'));
      sahibindenBrandCache.value = brands;
      sahibindenBrandCache.expiresAt = Date.now() + CACHE_TTL_MS;
      return brands;
    }
  } catch (e) {
    // fallthrough to browser fallback
  }

  // browser fallback (require system Chrome when using puppeteer-core)
  if (!puppeteer || !chromeExecutablePath) {
    return [];
  }

  try {
    const browser = await puppeteer.launch({
      executablePath: chromeExecutablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: REQUEST_TIMEOUT_MS });

    const brandsArr = await page.evaluate(() => {
      const items = new Map();
      const anchors = Array.from(document.querySelectorAll('a'));
      anchors.forEach((a) => {
        const href = (a.getAttribute('href') || '').trim();
        if (!href) return;
        const m = href.match(/\/otomobil\/([a-z0-9-]+)/i);
        if (!m) return;
        const slug = (m[1] || '').toLowerCase();
        if (!slug) return;
        const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
        items.set(slug, { slug, name: text, url: a.href });
      });
      return [...items.values()];
    });

    await browser.close();

    const brands = (brandsArr || []).map((b) => ({ slug: b.slug.toLowerCase(), name: (b.name || '').replace(/\s*\(\s*[\d.,]+\s*\)\s*$/i, '').trim(), url: b.url }));
    sahibindenBrandCache.value = brands;
    sahibindenBrandCache.expiresAt = Date.now() + CACHE_TTL_MS;
    return brands;
  } catch (e) {
    return [];
  }
}

function extractAdvertSlugs(html) {
  const slugs = new Set();
  const regex = /\/ilan\/([a-z0-9-]+)\/([a-z0-9-]+)/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const firstSlug = (match[1] || '').toLowerCase();
    if (firstSlug) slugs.add(firstSlug);
  }

  return [...slugs];
}

function extractBrandModelSlugs(html, brandSlug) {
  const $ = cheerio.load(html);
  const map = new Map();
  const brandToken = `${brandSlug}-`;

  $('a[href*="/ikinci-el/"]').each((_, element) => {
    const href = ($(element).attr('href') || '').trim();
    if (!href) return;

    const absoluteHref = href.startsWith('http') ? href : `https://www.arabam.com${href}`;
    const match = absoluteHref.match(/\/ikinci-el\/[a-z0-9-]+\/([a-z0-9-]+)(?:$|[\/?#])/i);
    if (!match) return;

    const value = (match[1] || '').toLowerCase();
    if (!value) return;
    if (!value.startsWith(brandToken)) return;
    if (value.endsWith('-sahibinden')) return;

    if (!map.has(value)) {
      map.set(value, absoluteHref.toLowerCase());
    }
  });

  return [...map.entries()].map(([slug, url]) => ({ slug, url }));
}

async function fetchArabamModelsByBrand(brandSlugInput) {
  const brandSlug = String(brandSlugInput || '').trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(brandSlug)) {
    return [];
  }

  const cached = getCachedModel(brandSlug);
  if (cached) {
    return cached;
  }

  const brandDisplayName = slugToTitle(brandSlug);
  const searchText = brandSlug.replace(/-/g, ' ');
  const searchUrl = `https://www.arabam.com/ikinci-el?searchText=${encodeURIComponent(searchText)}`;
  const html = await fetchHtml(searchUrl);

  let modelSources = extractBrandModelSlugs(html, brandSlug);

  // Fallback: some sayfa yapılarında linkler farklı olabilir; ham HTML içinde regex ile de ara
  if (!modelSources.length) {
    try {
      const escapedBrand = brandSlug.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      const regex = new RegExp(`\/ikinci-el\/[a-z0-9-]+\/(${escapedBrand}-[a-z0-9-]+)`, 'gi');
      const found = new Map();
      let m;
      while ((m = regex.exec(html)) !== null) {
        const slug = (m[1] || '').toLowerCase();
        if (slug && !found.has(slug) && !slug.endsWith('-sahibinden')) {
          found.set(slug, `https://www.arabam.com/ikinci-el/${slug}`);
        }
      }

      if (found.size) {
        modelSources = [...found.entries()].map(([slug, url]) => ({ slug, url }));
      }
    } catch (e) {
      // ignore fallback errors
    }
  }

  const modelSlugs = modelSources
    .map((item) => item.slug.replace(`${brandSlug}-`, '').trim())
    .filter(Boolean);

  const uniqueModelSlugs = [...new Set(modelSlugs)].slice(0, 60);
  const modelMap = new Map(modelSources.map((item) => [item.slug.replace(`${brandSlug}-`, '').trim(), item.url]));

  const results = [];

  for (const modelSlug of uniqueModelSlugs) {
    const modelLabel = prettifySlugText(modelSlug);
    const modelUrl = modelMap.get(modelSlug);
    let versionsArr = [];

    if (modelUrl) {
      try {
        const modelHtml = await fetchHtml(modelUrl);
        const advertSlugs = extractAdvertSlugs(modelHtml);

        // versionsMap: versionToken -> { versionSlug, label, baseValue, packages: Map }
        const versionsMap = new Map();

        advertSlugs.forEach((advertSlug) => {
          const marker = `${brandSlug}-${modelSlug}-`;
          const markerIndex = advertSlug.indexOf(marker);
          if (markerIndex < 0) return;

          const remainder = advertSlug.slice(markerIndex + marker.length).trim();
          if (!remainder) return;

          const parts = remainder.split('-').filter(Boolean);
          if (!parts.length) return;

          const versionToken = parts[0];
          const packageTokens = parts.slice(1);

          const versionLabel = prettifySlugText(versionToken);
          const baseFullLabel = `${brandDisplayName} ${modelLabel} ${versionLabel}`.trim();
          const baseValue = baseFullLabel;

          if (!versionsMap.has(versionToken)) {
            versionsMap.set(versionToken, {
              versionSlug: versionToken,
              label: versionLabel,
              baseValue,
              packages: new Map()
            });
          }

          if (packageTokens.length) {
            const packageSlug = packageTokens.join('-');
            const packageLabel = prettifySlugText(packageSlug);
            const packageValue = `${baseFullLabel} ${packageLabel}`.trim();
            const ver = versionsMap.get(versionToken);
            if (!ver.packages.has(packageSlug)) {
              ver.packages.set(packageSlug, { packageSlug, label: packageLabel, value: packageValue });
            }
          } else {
            // ensure base version exists even if no package
            // already ensured when map entry created
          }
        });

        // convert versionsMap to versions array for this model
        versionsArr = [];
        for (const [vslug, vobj] of versionsMap.entries()) {
          const packagesArr = [...vobj.packages.values()];
          versionsArr.push({
            label: vobj.label,
            versionSlug: vobj.versionSlug,
            baseValue: vobj.baseValue,
            packages: packagesArr
          });
        }
      } catch (e) {
        // ignore per-model fetch errors
      }
    }

    // if no versions discovered, add a single base version entry
    if (!versionsArr || !versionsArr.length) {
      versionsArr.push({
        label: modelLabel,
        versionSlug: '',
        baseValue: `${brandDisplayName} ${modelLabel}`.trim(),
        packages: []
      });
    }

    results.push({
      model: modelLabel,
      modelSlug,
      versions: versionsArr
    });
  }

  const sorted = results.sort((a, b) => a.model.localeCompare(b.model, 'tr')).slice(0, 200);
  setCachedModel(brandSlug, sorted);
  return sorted;
}

async function fetchSahibindenModelsByBrand(brandSlugInput) {
  const brandSlug = String(brandSlugInput || '').trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(brandSlug)) return [];

  const cacheKey = `sahibinden:${brandSlug}`;
  const cached = getCachedModel(cacheKey);
  if (cached) return cached;

  const brandDisplayName = slugToTitle(brandSlug);
  const url = `https://www.sahibinden.com/otomobil/${brandSlug}`;

  let html;
  try {
    html = await fetchHtml(url);
  } catch (e) {
    return [];
  }

  // find model slugs from links like /otomobil/{brandSlug}-{modelSlug}
  const modelSet = new Set();
  try {
    const regex = new RegExp(`/otomobil/${brandSlug}-([a-z0-9-]+)`, 'gi');
    let m;
    while ((m = regex.exec(html)) !== null) {
      const slug = (m[1] || '').toLowerCase();
      if (slug) modelSet.add(slug);
    }
  } catch (e) {
    // ignore
  }

  const uniqueModelSlugs = [...modelSet].slice(0, 60);
  const results = [];

  for (const modelSlug of uniqueModelSlugs) {
    const modelLabel = prettifySlugText(modelSlug);
    const modelUrl = `https://www.sahibinden.com/otomobil/${brandSlug}-${modelSlug}`;
    let versionsArr = [];

    try {
      const modelHtml = await fetchHtml(modelUrl);
      const advertSlugs = extractAdvertSlugs(modelHtml);

      const versionsMap = new Map();

      advertSlugs.forEach((advertSlug) => {
        const marker = `${brandSlug}-${modelSlug}-`;
        const markerIndex = advertSlug.indexOf(marker);
        if (markerIndex < 0) return;

        const remainder = advertSlug.slice(markerIndex + marker.length).trim();
        if (!remainder) return;

        const parts = remainder.split('-').filter(Boolean);
        if (!parts.length) return;

        const versionToken = parts[0];
        const packageTokens = parts.slice(1);

        const versionLabel = prettifySlugText(versionToken);
        const baseFullLabel = `${brandDisplayName} ${modelLabel} ${versionLabel}`.trim();

        if (!versionsMap.has(versionToken)) {
          versionsMap.set(versionToken, { versionSlug: versionToken, label: versionLabel, baseValue: baseFullLabel, packages: new Map() });
        }

        if (packageTokens.length) {
          const packageSlug = packageTokens.join('-');
          const packageLabel = prettifySlugText(packageSlug);
          const packageValue = `${baseFullLabel} ${packageLabel}`.trim();
          const ver = versionsMap.get(versionToken);
          if (!ver.packages.has(packageSlug)) ver.packages.set(packageSlug, { packageSlug, label: packageLabel, value: packageValue });
        }
      });

      for (const [vslug, vobj] of versionsMap.entries()) {
        const packagesArr = [...vobj.packages.values()];
        versionsArr.push({ label: vobj.label, versionSlug: vobj.versionSlug, baseValue: vobj.baseValue, packages: packagesArr });
      }
    } catch (e) {
      // ignore per-model fetch errors
    }

    if (!versionsArr.length) {
      versionsArr.push({ label: modelLabel, versionSlug: '', baseValue: `${brandDisplayName} ${modelLabel}`.trim(), packages: [] });
    }

    results.push({ model: modelLabel, modelSlug, versions: versionsArr });
  }

  const sorted = results.sort((a, b) => a.model.localeCompare(b.model, 'tr')).slice(0, 200);
  setCachedModel(cacheKey, sorted);
  return sorted;
}

async function fetchSahibindenPrices(model) {
  const encoded = encodeURIComponent(model);
  const url = `https://www.sahibinden.com/otomobil?query_text=${encoded}`;
  const html = await fetchHtml(url);

  const $ = cheerio.load(html);
  const text = $('body').text();
  const prices = extractPrices(text);

  return { source: 'sahibinden.com', url, prices };
}

async function fetchArabamPrices(model) {
  const encoded = encodeURIComponent(model);
  const url = `https://www.arabam.com/ikinci-el/otomobil?searchText=${encoded}`;
  const html = await fetchHtml(url);

  const $ = cheerio.load(html);
  const text = $('body').text();
  const prices = extractPrices(text);

  return { source: 'arabam.com', url, prices };
}

module.exports = {
  fetchSahibindenPrices,
  fetchSahibindenBrands,
  fetchArabamPrices,
  fetchArabamBrands,
  fetchArabamModelsByBrand,
  fetchSahibindenModelsByBrand
};
