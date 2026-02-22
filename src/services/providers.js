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

  // arabam.com'dan marka listesini çekmeye çalışılacak URL'ler
  const candidates = [
    'https://www.arabam.com/ikinci-el/otomobil',
    'https://www.arabam.com/ikinci-el/tum-markalar'
  ];

  const items = new Map();

  for (const url of candidates) {
    try {
      const html = await fetchHtml(url);
      const $ = cheerio.load(html);

      // Cheerio ile önce otomobil linklerini ara
      $('a[href*="/ikinci-el/otomobil/"]').each((_, element) => {
        const href = ($(element).attr('href') || '').trim();
        const absoluteHref = href.startsWith('http') ? href : `https://www.arabam.com${href}`;
        const pathMatch = absoluteHref.match(/\/ikinci-el\/otomobil\/([a-z0-9-]+)$/i);
        if (!pathMatch) return;

        const slug = pathMatch[1].toLowerCase();
        if (!slug || slug.includes('sahibinden')) return;

        const anchorText = $(element).text().replace(/\s+/g, ' ').trim();
        const normalizedText = anchorText
          .replace(/^İkinci El\s+/i, '')
          .replace(/\s+Fiyatlar[\u0131i]$/i, '')
          .replace(/\s*\(\s*[\d.,]+\s*\)\s*$/i, '')
          .trim();

        const name = normalizedText || slugToTitle(slug);
        if (!items.has(slug)) {
          items.set(slug, { slug, name, url: absoluteHref });
        }
      });

      // Cheerio bulamazsa regex fallback
      if (!items.size) {
        const regex = /\/ikinci-el\/otomobil\/([a-z0-9-]+)/gi;
        let m;
        while ((m = regex.exec(html)) !== null) {
          const slug = (m[1] || '').toLowerCase();
          if (!slug || slug.includes('sahibinden')) continue;
          if (!items.has(slug)) {
            items.set(slug, {
              slug,
              name: slugToTitle(slug),
              url: `https://www.arabam.com/ikinci-el/otomobil/${slug}`
            });
          }
        }
      }

      if (items.size) break; // ilk başarılı URL yeterli
    } catch (e) {
      // sonraki URL'yi dene
    }
  }

  const brands = [...items.values()]
    .filter((item) => {
      if (!item.slug.includes('-')) return true;
      const rootSlug = item.slug.split('-')[0];
      return !items.has(rootSlug);
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'tr'));

  if (brands.length) {
    brandCache.value = brands;
    brandCache.expiresAt = Date.now() + CACHE_TTL_MS;
  }

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

// İlan slug'larındaki ve kategori linklerindeki anlamsız token'ları temizler.
// "satilik", "galeriden", "yetkili", "bayiden", uzun sayılar vb. çöp kelimeleri kapsar.
const SLUG_STOP_WORDS = new Set([
  'satilik', 'ikinci', 'el', 'otomobil', 'temiz', 'kullanilmis', 'hatasiz',
  'sahibinden', 'yeni', 'galeriden', 'yetkili', 'bayiden', 'galerist',
  'bayi', 'galeri', 'ultimate', 'gs'
]);

function cleanAdvertRemainder(remainder) {
  const parts = remainder.split('-').filter(Boolean);
  const meaningful = [];
  for (const part of parts) {
    if (/^\d+$/.test(part) && part.length >= 5) break; // uzun ID sayısı
    if (SLUG_STOP_WORDS.has(part.toLowerCase())) break;  // çöp kelime
    meaningful.push(part);
  }
  return meaningful.join('-');
}

// Versiyon slug'ındaki stop word içeren her token'ı ve sonrasını kırpar
function cleanVersionSlug(slug) {
  const parts = slug.split('-').filter(Boolean);
  const meaningful = [];
  for (const part of parts) {
    if (/^\d+$/.test(part) && part.length >= 5) break; // uzun ID sayısı
    if (SLUG_STOP_WORDS.has(part.toLowerCase())) break;
    meaningful.push(part);
  }
  return meaningful.join('-');
}

// Model sayfasındaki kategori linklerinden versiyon slug'larını çeker.
// Örneğin /ikinci-el/otomobil/opel-corsa-1-4-twinport-enjoy -> "1-4-twinport-enjoy"
function extractVersionSlugsFromModelPage(html, brandSlug, modelSlug) {
  const prefix = `${brandSlug}-${modelSlug}-`;
  const $ = cheerio.load(html);
  const found = new Map();

  $('a[href*="/ikinci-el/"]').each((_, element) => {
    const href = ($(element).attr('href') || '').trim();
    if (!href) return;
    const absoluteHref = href.startsWith('http') ? href : `https://www.arabam.com${href}`;
    const match = absoluteHref.match(/\/ikinci-el\/[a-z0-9-]+\/([a-z0-9-]+)(?:$|[\/?#])/i);
    if (!match) return;
    const slug = (match[1] || '').toLowerCase();
    if (!slug.startsWith(prefix)) return;
    if (slug.endsWith('-sahibinden')) return;
    const rawVersion = slug.slice(prefix.length);
    const versionSlug = cleanVersionSlug(rawVersion);
    if (versionSlug && !found.has(versionSlug)) {
      found.set(versionSlug, true);
    }
  });

  // Regex fallback: href olmayan ama HTML içinde geçen prefix
  if (!found.size) {
    const escapedPrefix = prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const re = new RegExp(`${escapedPrefix}([a-z0-9]+(?:-[a-z0-9]+)*)`, 'gi');
    let m;
    while ((m = re.exec(html)) !== null) {
      const rawVersion = (m[1] || '').toLowerCase();
      const versionSlug = cleanVersionSlug(rawVersion);
      if (versionSlug && !found.has(versionSlug)) {
        found.set(versionSlug, true);
      }
    }
  }

  return [...found.keys()];
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

  // Arabam.com'dan modelleri çekmek için denlenecek URL'ler (öncelik sırasıyla)
  const candidateUrls = [
    `https://www.arabam.com/ikinci-el/otomobil/${brandSlug}`,
    `https://www.arabam.com/ikinci-el?searchText=${encodeURIComponent(brandSlug.replace(/-/g, ' '))}`
  ];

  let modelSources = [];

  for (const pageUrl of candidateUrls) {
    try {
      const html = await fetchHtml(pageUrl);

      // Yöntem 1: Cheerio ile {brandSlug}-model linklerini bul
      let sources = extractBrandModelSlugs(html, brandSlug);

      // Yöntem 2: Regex fallback — daha geniş tarama
      if (!sources.length) {
        const escapedBrand = brandSlug.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        const regex = new RegExp(
          `href=["']?(?:https://www\\.arabam\\.com)?/ikinci-el/[a-z0-9-]+/(${escapedBrand}-[a-z0-9]+(?:-[a-z0-9]+)*)`,
          'gi'
        );
        const found = new Map();
        let m;
        while ((m = regex.exec(html)) !== null) {
          const slug = (m[1] || '').toLowerCase();
          if (slug && !found.has(slug) && !slug.endsWith('-sahibinden')) {
            found.set(slug, `https://www.arabam.com/ikinci-el/otomobil/${slug}`);
          }
        }
        if (found.size) {
          sources = [...found.entries()].map(([slug, url]) => ({ slug, url }));
        }
      }

      if (sources.length) {
        modelSources = sources;
        break; // ilk başarılı URL yeterli
      }
    } catch (e) {
      // sonraki URL'yi dene
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

        // 1. Kademe: Model sayfasından motor versiyonlarını çek (örn: 1-4-twinport)
        let topLevelSlugs = extractVersionSlugsFromModelPage(modelHtml, brandSlug, modelSlug);

        // Bulunamadıysa ilan fallback
        if (!topLevelSlugs.length) {
          const advertSlugs = extractAdvertSlugs(modelHtml);
          const marker = `${brandSlug}-${modelSlug}-`;
          const cleaned = new Set();
          advertSlugs.forEach((advertSlug) => {
            const idx = advertSlug.indexOf(marker);
            if (idx < 0) return;
            const raw = advertSlug.slice(idx + marker.length);
            const cl = cleanAdvertRemainder(raw);
            if (cl) cleaned.add(cl);
          });
          topLevelSlugs = [...cleaned];
        }

        // 2. Kademe: Her motor versiyonunun kendi sayfasından paket linklerini çek
        // Örn: opel-corsa-1-4-twinport sayfasından -> enjoy, comfort, edition vb.
        const flatSlugs = new Set();

        for (const vs of topLevelSlugs) {
          const versionPageUrl = `https://www.arabam.com/ikinci-el/otomobil/${brandSlug}-${modelSlug}-${vs}`;
          let subSlugs = [];
          try {
            const versionHtml = await fetchHtml(versionPageUrl);
            // Bu sayfadaki linkler brandSlug-modelSlug-vs- ile başlıyor
            subSlugs = extractVersionSlugsFromModelPage(versionHtml, brandSlug, modelSlug);
            // Sadece bu vs prefix'iyle başlayanları al (paketler: vs-enjoy, vs-comfort vb.)
            subSlugs = subSlugs.filter((s) => s.startsWith(vs + '-') || s === vs);
          } catch (e) {
            // erişilemezse sadece üst seviyeyi kullan
          }

          if (subSlugs.length) {
            subSlugs.forEach((s) => flatSlugs.add(s));
          } else {
            flatSlugs.add(vs); // alt sayfa yoksa veya erişilemediyse üst seviyeyi ekle
          }
        }

        // Tüm slug'lardan düzleştirilmiş versiyon listesi oluştur
        const versionsMap = new Map();
        for (const vs of flatSlugs) {
          if (versionsMap.has(vs)) continue;
          const versionLabel = prettifySlugText(vs);
          const baseValue = `${brandDisplayName} ${modelLabel} ${versionLabel}`.trim();
          versionsMap.set(vs, {
            label: versionLabel,
            versionSlug: vs,
            baseValue,
            packages: []
          });
        }

        versionsArr = [...versionsMap.values()];
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
