const axios = require('axios');
const cheerio = require('cheerio');

let puppeteer = null;
let chromeExecutablePath = null;
try {
  const puppeteerExtra = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteerExtra.use(StealthPlugin());
  puppeteer = puppeteerExtra;

  // puppeteer-core alt yapısını kullanmak için base puppeteer'ı bağla
  const vanillaPuppeteer = require('puppeteer-core');
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

const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 12000;
const CONCURRENCY_LIMIT = Number(process.env.CONCURRENCY_LIMIT) || 3; // Puppeteer için daha düşük, axios için yeterli.

let _sharedBrowser = null;

/**
 * Tarayıcıyı bir kez başlatır ve bağlı kalır.
 */
async function getBrowserInstance() {
  if (_sharedBrowser && _sharedBrowser.connected) {
    return _sharedBrowser;
  }

  if (!puppeteer || !chromeExecutablePath) return null;

  try {
    const userLocal = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\AppData\\Local` : '');
    const userDataDir = `${userLocal}\\Google\\Chrome\\User Data\\SahibindenPersistent`;

    _sharedBrowser = await puppeteer.launch({
      executablePath: chromeExecutablePath,
      headless: false,
      userDataDir: userDataDir, // Çakışmasız ama kalıcı profil
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: null,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1280,800',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ]
    });
    return _sharedBrowser;
  } catch (err) {
    console.error("Tarayıcı başlatma hatası:", err);
    return null;
  }
}

/**
 * Mevcut sekmeleri kontrol eder ve boş sayfa varsa onu kullanır (Spamı önler).
 */
async function createOptimizedPage() {
  const browser = await getBrowserInstance();
  if (!browser) return null;

  try {
    const pages = await browser.pages();
    let page = pages.find(p => p.url() === 'about:blank');

    if (!page) {
      page = await browser.newPage();
    }

    // Sahibinden bot koruması için gizlilik ayarları
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    return page;
  } catch (err) {
    return null;
  }
}

// Eş zamanlı istek sayısını sınırlayan yardımcı fonksiyon
async function pMap(items, fn, limit) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[index - 1] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

const CACHE_TTL_MS = 1000 * 60 * 60; // 1 saat (marka/model için)
const PRICE_TTL_MS = 1000 * 60 * 15; // 15 dakika (fiyatlar için)

const brandCache = {};
const modelCache = new Map();
const versionCache = new Map();
const priceCache = new Map();
const sahibindenBrandCache = {
  expiresAt: 0,
  value: null
};

function setCachedModel(key, value) {
  modelCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function getCachedModel(key) {
  const c = modelCache.get(key);
  if (c && c.expiresAt > Date.now()) return c.value;
  return null;
}

function normalizePriceText(raw) {
  const cleaned = raw.replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const numeric = Number(cleaned.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(numeric)) {
    return null;
  }

  if (numeric < 50000 || numeric > 20000000) {
    return null;
  }

  return Math.round(numeric);
}

function extractPrices(container, options = {}) {
  const prices = [];
  const { brandKeyword, yearFilter, gearKeyword } = options;

  // Eğer container bir cheerio nesnesi ise, içindeki listing item'ları dön
  if (typeof container !== 'string' && container.find) {
    // Arabam.com ve Sahibinden için genel liste öğeleri
    const items = container.find('tr.listing-list-item, .searchResultsItem, .listing-item');

    items.each((_, el) => {
      const $el = container.constructor(el);
      const itemText = $el.text().toLowerCase();

      // Filtre kontrolü: Eğer kategori sayfasındaysak marka kontrolünü çok katı yapma
      if (brandKeyword && !itemText.includes(brandKeyword)) {
        // Bazı durumlarda tabloda marka yazmaz, eğer model veya versiyon geçiyorsa devam et
        if (!itemText.includes('corsa') && !itemText.includes('astra') && !itemText.includes('egea')) {
          // Marka/model geçmiyorsa ve marka keywordü varsa ele
          // return; // Burayı şimdilik yorum satırı yapıyoruz çünkü kategori navigasyonu zaten doğru yere götürüyor
        }
      }
      if (yearFilter && !itemText.includes(yearFilter.toString())) {
        const yearMatch = itemText.match(/\b(20\d{2}|19\d{2})\b/);
        if (yearMatch && yearMatch[0] !== yearFilter.toString()) return;
      }

      // Manuel/Düz vites için ek kontrol gerekirse burada yapılabilir, 
      // ancak şimdilik navigasyon bazlı arama bunu büyük oranda çözer.
      if (gearKeyword) {
        if (gearKeyword === 'manuel') {
          if (itemText.includes('otomatik') && !itemText.includes('manuel') && !itemText.includes('düz')) return;
        } else if (gearKeyword === 'otomatik' || gearKeyword === 'yari-otomatik') {
          if (!itemText.includes('otomatik') && !itemText.includes('yarı') && !itemText.includes('vites')) {
            // Not: Otomatik vites ilanlarında 'otomatik' yazmama ihtimali manuelden düşüktür
          }
        }
      }

      const priceText = container.constructor(el).find('.price, .listing-list-item-price, .searchResultsPriceValue').text();
      if (priceText) {
        const parsed = normalizePriceText(priceText);
        if (parsed) prices.push(parsed);
      }
    });

    if (prices.length > 0) return [...new Set(prices)];
  }

  // Fallback: Regex ile arama (Sadece güvenilir olmayan durumlarda)
  const html = typeof container === 'string' ? container : container.text();
  const priceRegex = /(\d{1,3}(?:[.,]\d{3})+)\s*TL/gi;

  let match;
  while ((match = priceRegex.exec(html)) !== null) {
    const context = html.substring(Math.max(0, match.index - 100), Math.min(html.length, match.index + 100)).toLowerCase();

    if (brandKeyword && !context.includes(brandKeyword)) continue;
    if (gearKeyword) {
      if (gearKeyword === 'manuel') {
        if (context.includes('otomatik') && !context.includes('manuel') && !context.includes('düz')) continue;
      } else if (gearKeyword === 'otomatik' || gearKeyword === 'yari-otomatik') {
        if (!context.includes('otomatik') && !context.includes('yarı') && !context.includes('vites')) continue;
      }
    }

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

async function fetchArabamBrands(category = 'otomobil') {
  const cacheKey = `brands:${category}`;
  if (brandCache[cacheKey] && brandCache[cacheKey].expiresAt > Date.now()) {
    return brandCache[cacheKey].value;
  }

  // arabam.com'dan kategori bazlı marka listesini çek
  const candidates = [
    `https://www.arabam.com/ikinci-el/${category}`,
    `https://www.arabam.com/ikinci-el/tum-markalar`
  ];

  const items = new Map();

  for (const url of candidates) {
    try {
      const html = await fetchHtml(url);
      const $ = cheerio.load(html);

      // Kategori bazlı marka linklerini ara
      $(`a[href*="/ikinci-el/${category}/"]`).each((_, element) => {
        const href = ($(element).attr('href') || '').trim();
        const absoluteHref = href.startsWith('http') ? href : `https://www.arabam.com${href}`;
        const pathMatch = absoluteHref.match(new RegExp(`\\/ikinci-el\\/${category}\\/([a-z0-9-]+)$`, 'i'));
        if (!pathMatch) return;

        const slug = pathMatch[1].toLowerCase();
        if (!slug || slug.includes('sahibinden')) return;

        // İlan sayısını çek
        let count = null;
        const spans = $(element).find('span');
        let nameMatch = '';

        if (spans.length >= 2) {
          nameMatch = $(spans[0]).text().trim();
          count = $(spans[spans.length - 1]).text().trim();
        } else {
          const fullText = $(element).text().replace(/\s+/g, ' ').trim();
          const match = fullText.match(/^(.*?)\s*\(?([\d.,]+)\)?$/);
          if (match) {
            nameMatch = match[1].trim();
            count = match[2].trim();
          } else {
            nameMatch = fullText;
          }
        }

        const normalizedText = nameMatch
          .replace(/^İkinci El\s+/i, '')
          .replace(/\s+Fiyatlar[\u0131i]$/i, '')
          .trim();

        const name = normalizedText || slugToTitle(slug);
        if (!items.has(slug)) {
          items.set(slug, { slug, name, url: absoluteHref, count });
        }
      });

      // Cheerio bulamazsa regex fallback
      if (!items.size) {
        const regex = new RegExp(`\\/ikinci-el\\/${category}\\/([a-z0-9-]+)`, 'gi');
        let m;
        while ((m = regex.exec(html)) !== null) {
          const slug = (m[1] || '').toLowerCase();
          if (!slug || slug.includes('sahibinden')) continue;
          if (!items.has(slug)) {
            items.set(slug, {
              slug,
              name: slugToTitle(slug),
              url: `https://www.arabam.com/ikinci-el/${category}/${slug}`
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
    brandCache[cacheKey] = {
      value: brands,
      expiresAt: Date.now() + CACHE_TTL_MS
    };
  }

  return brands;
}

async function fetchSahibindenBrands() {
  if (sahibindenBrandCache.value && sahibindenBrandCache.expiresAt > Date.now()) {
    return sahibindenBrandCache.value;
  }

  const url = 'https://www.sahibinden.com/otomobil';

  // Browser instance al
  const page = await createOptimizedPage();
  if (!page) {
    // Fallback to Axios if browser fail
    try {
      const html = await fetchHtml(url);
      const items = new Map();
      const regex = /\/otomobil\/([a-z0-9-]+)/gi;
      let match;
      while ((match = regex.exec(html)) !== null) {
        const slug = (match[1] || '').toLowerCase();
        if (slug && !items.has(slug)) {
          items.set(slug, { slug, name: slugToTitle(slug), url: `https://www.sahibinden.com/otomobil/${slug}` });
        }
      }
      if (items.size) {
        const brands = [...items.values()].sort((a, b) => a.name.localeCompare(b.name, 'tr'));
        sahibindenBrandCache.value = brands;
        sahibindenBrandCache.expiresAt = Date.now() + CACHE_TTL_MS;
        return brands;
      }
    } catch (e) { return []; }
    return [];
  }

  try {
    console.log("[Sahibinden] Markalar çekiliyor (Paylaşımlı Tarayıcı)...");
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Bot algılanmaması için kısa bekleme
    await new Promise(r => setTimeout(r, 2000));

    const brandsArr = await page.evaluate(() => {
      const items = new Map();
      const anchors = Array.from(document.querySelectorAll('a'));
      anchors.forEach((a) => {
        const href = (a.getAttribute('href') || '').trim();
        if (!href) return;
        const m = href.match(/\/otomobil\/([a-z0-9-]+)/i);
        if (!m) return;
        const slug = (m[1] || '').toLowerCase();
        if (!slug || slug === 'otomobil') return;
        const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
        if (text && text.length > 2) {
          items.set(slug, { slug, name: text, url: a.href });
        }
      });
      return [...items.values()];
    });

    await page.close();

    const brands = (brandsArr || [])
      .map((b) => ({
        slug: b.slug.toLowerCase(),
        name: (b.name || '').replace(/\s*\(\s*[\d.,]+\s*\)\s*$/i, '').trim(),
        url: b.url
      }))
      .filter(b => b.name && b.name.length > 1)
      .sort((a, b) => a.name.localeCompare(b.name, 'tr'));

    if (brands.length) {
      sahibindenBrandCache.value = brands;
      sahibindenBrandCache.expiresAt = Date.now() + CACHE_TTL_MS;
    }
    return brands;
  } catch (e) {
    if (page) await page.close();
    return [];
  }
}

function extractAdvertSlugs(html) {
  const slugs = new Set();
  const regex = /\/ilan\/([a-z0-9\.-]+)\/([a-z0-9-]+)/gi;
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
function extractVersionSlugsFromModelPage(html, category, brandSlug, modelSlug) {
  const prefix = `${brandSlug}-${modelSlug}-`;
  const $ = cheerio.load(html);
  const found = new Map();

  $('a[href*="/ikinci-el/"]').each((_, element) => {
    const href = ($(element).attr('href') || '').trim();
    if (!href) return;
    const absoluteHref = href.startsWith('http') ? href : `https://www.arabam.com${href}`;
    // Kategoriye uygun linkleri yakala
    const match = absoluteHref.match(new RegExp(`\\/ikinci-el\\/${category}\\/([a-z0-9-]+)(?:$|[\\/?#])`, 'i'));
    if (!match) return;
    const slug = (match[1] || '').toLowerCase();
    if (!slug.startsWith(prefix)) return;
    if (slug.endsWith('-sahibinden')) return;
    const rawVersion = slug.slice(prefix.length);
    const versionSlug = cleanVersionSlug(rawVersion);

    const anchorText = $(element).text().replace(/\s+/g, ' ').trim();
    const countMatch = anchorText.match(/\(?\s*([\d.,]+)\s*\)?\s*$/);
    const count = countMatch ? countMatch[1] : null;

    if (versionSlug && !found.has(versionSlug)) {
      found.set(versionSlug, { versionSlug, count });
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
        found.set(versionSlug, { versionSlug, count: null });
      }
    }
  }

  return [...found.values()];
}

function extractBrandModelSlugs(html, category, brandSlug) {
  const $ = cheerio.load(html);
  const map = new Map();
  const brandToken = `${brandSlug}-`;

  $(`a[href*="/ikinci-el/${category}/"]`).each((_, element) => {
    const href = ($(element).attr('href') || '').trim();
    if (!href) return;

    const absoluteHref = href.startsWith('http') ? href : `https://www.arabam.com${href}`;
    const match = absoluteHref.match(new RegExp(`\\/ikinci-el\\/${category}\\/([a-z0-9-]+)(?:$|[\\/?#])`, 'i'));
    if (!match) return;

    const value = (match[1] || '').toLowerCase();
    if (!value) return;
    if (!value.startsWith(brandToken)) return;
    if (value.endsWith('-sahibinden')) return;

    if (!map.has(value)) {
      const anchorText = $(element).text().replace(/\s+/g, ' ').trim();
      const countMatch = anchorText.match(/\(?\s*([\d.,]+)\s*\)?\s*$/);
      const count = countMatch ? countMatch[1] : null;
      map.set(value, { url: absoluteHref.toLowerCase(), count });
    }
  });

  return [...map.entries()].map(([slug, data]) => ({ slug, url: data.url, count: data.count }));
}

// Sadece model adlarını hızlıca döndürür (versiyon detayına girmez)
async function fetchArabamModelsQuick(category = 'otomobil', brandSlugInput) {
  const brandSlug = String(brandSlugInput || '').trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(brandSlug)) return [];

  const cacheKey = `quick:${category}:${brandSlug}`;
  const cached = getCachedModel(cacheKey);
  if (cached) return cached;

  const candidateUrls = [
    `https://www.arabam.com/ikinci-el/${category}/${brandSlug}`,
    `https://www.arabam.com/ikinci-el?searchText=${encodeURIComponent(brandSlug.replace(/-/g, ' '))}`
  ];

  let modelSources = [];

  for (const pageUrl of candidateUrls) {
    try {
      const html = await fetchHtml(pageUrl);
      let sources = extractBrandModelSlugs(html, category, brandSlug);

      if (!sources.length) {
        const escapedBrand = brandSlug.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        const regex = new RegExp(
          `href=["']?(?:https://www\\.arabam\\.com)?/ikinci-el/${category}/(${escapedBrand}-[a-z0-9]+(?:-[a-z0-9]+)*)`,
          'gi'
        );
        const found = new Map();
        let m;
        while ((m = regex.exec(html)) !== null) {
          const slug = (m[1] || '').toLowerCase();
          if (slug && !found.has(slug) && !slug.endsWith('-sahibinden')) {
            found.set(slug, { url: `https://www.arabam.com/ikinci-el/${category}/${slug}`, count: null });
          }
        }
        if (found.size) {
          sources = [...found.entries()].map(([slug, data]) => ({ slug, url: data.url, count: data.count }));
        }
      }

      if (sources.length) {
        modelSources = sources;
        break;
      }
    } catch (e) {
      // ignore
    }
  }

  const modelSlugs = modelSources
    .map((item) => item.slug.replace(`${brandSlug}-`, '').trim())
    .filter(Boolean);

  const uniqueModelSlugs = [...new Set(modelSlugs)].slice(0, 60);
  const modelInfoMap = new Map(modelSources.map((item) => [item.slug.replace(`${brandSlug}-`, '').trim(), { url: item.url, count: item.count }]));

  const results = uniqueModelSlugs.map((modelSlug) => {
    const info = modelInfoMap.get(modelSlug);
    return {
      model: prettifySlugText(modelSlug),
      modelSlug,
      modelUrl: (info && info.url) || `https://www.arabam.com/ikinci-el/${category}/${brandSlug}-${modelSlug}`,
      count: info ? info.count : null,
      versions: []
    };
  }).sort((a, b) => a.model.localeCompare(b.model, 'tr'));

  if (results.length) setCachedModel(cacheKey, results);
  return results;
}

// Belirli bir model için versiyonları çeker (kullanıcı modeli seçince çağrılır)
async function fetchArabamVersionsByModel(category = 'otomobil', brandSlugInput, modelSlugInput) {
  const brandSlug = String(brandSlugInput || '').trim().toLowerCase();
  const modelSlug = String(modelSlugInput || '').trim().toLowerCase();
  if (!brandSlug || !modelSlug) return [];

  const cacheKey = `versions:${category}:${brandSlug}:${modelSlug}`;
  const cached = versionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const brandDisplayName = slugToTitle(brandSlug);
  const modelLabel = prettifySlugText(modelSlug);
  const modelUrl = `https://www.arabam.com/ikinci-el/${category}/${brandSlug}-${modelSlug}`;

  try {
    const modelHtml = await fetchHtml(modelUrl);
    let topLevelSlugs = extractVersionSlugsFromModelPage(modelHtml, category, brandSlug, modelSlug);

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
      topLevelSlugs = [...cleaned].map(vs => ({ versionSlug: vs, count: null }));
    }

    const flatSlugs = new Set();

    const subResults = await pMap(topLevelSlugs, async (item) => {
      const vs = item.versionSlug;
      const versionPageUrl = `https://www.arabam.com/ikinci-el/${category}/${brandSlug}-${modelSlug}-${vs}`;
      try {
        const versionHtml = await fetchHtml(versionPageUrl);
        let subSlugs = extractVersionSlugsFromModelPage(versionHtml, category, brandSlug, modelSlug);
        subSlugs = subSlugs.filter((s) => s.versionSlug.startsWith(vs + '-') || s.versionSlug === vs);
        return { vs, subSlugs, originalCount: item.count };
      } catch (e) {
        return { vs, subSlugs: [], originalCount: item.count };
      }
    }, CONCURRENCY_LIMIT);

    for (const { vs, subSlugs, originalCount } of subResults) {
      if (subSlugs.length) subSlugs.forEach((s) => flatSlugs.add(s));
      else flatSlugs.add({ versionSlug: vs, count: originalCount });
    }

    const versionsMap = new Map();
    for (const { versionSlug: vs, count } of flatSlugs) {
      if (versionsMap.has(vs)) continue;
      const versionLabel = prettifySlugText(vs);
      const baseValue = `${brandDisplayName} ${modelLabel} ${versionLabel}`.trim();
      versionsMap.set(vs, { label: versionLabel, versionSlug: vs, baseValue, count, packages: [] });
    }

    const versions = [...versionsMap.values()];
    if (!versions.length) {
      versions.push({ label: modelLabel, versionSlug: '', baseValue: `${brandDisplayName} ${modelLabel}`.trim(), count: null, packages: [] });
    }

    versionCache.set(cacheKey, { value: versions, expiresAt: Date.now() + CACHE_TTL_MS });
    return versions;
  } catch (e) {
    return [{ label: modelLabel, versionSlug: '', baseValue: `${brandDisplayName} ${modelLabel}`.trim(), packages: [] }];
  }
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

  // Tüm modelleri PARALEL olarak çek (concurrency limiti ile)
  const results = await pMap(uniqueModelSlugs, async (modelSlug) => {
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

        // 2. Kademe: Her motor versiyonunun alt sayfalarını PARALEL çek
        const flatSlugs = new Set();

        const subResults = await pMap(topLevelSlugs, async (vs) => {
          const versionPageUrl = `https://www.arabam.com/ikinci-el/otomobil/${brandSlug}-${modelSlug}-${vs}`;
          try {
            const versionHtml = await fetchHtml(versionPageUrl);
            let subSlugs = extractVersionSlugsFromModelPage(versionHtml, brandSlug, modelSlug);
            subSlugs = subSlugs.filter((s) => s.startsWith(vs + '-') || s === vs);
            return { vs, subSlugs };
          } catch (e) {
            return { vs, subSlugs: [] };
          }
        }, CONCURRENCY_LIMIT);

        for (const { vs, subSlugs } of subResults) {
          if (subSlugs.length) {
            subSlugs.forEach((s) => flatSlugs.add(s));
          } else {
            flatSlugs.add(vs);
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

    // Versiyon bulunamadıysa tek temel versiyon ekle
    if (!versionsArr || !versionsArr.length) {
      versionsArr.push({
        label: modelLabel,
        versionSlug: '',
        baseValue: `${brandDisplayName} ${modelLabel}`.trim(),
        packages: []
      });
    }

    return { model: modelLabel, modelSlug, versions: versionsArr };
  }, CONCURRENCY_LIMIT);

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

  const page = await createOptimizedPage();
  if (!page) return [];

  try {
    console.log(`[Sahibinden] ${brandSlug} modelleri çekiliyor...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // Bot algılanmaması için bekleme
    await new Promise(r => setTimeout(r, 3000));

    const html = await page.content();

    // find model slugs from links like /otomobil/{brandSlug}-{modelSlug}
    const modelSet = new Set();
    const regex = new RegExp(`/otomobil/${brandSlug}-([a-z0-9-]+)`, 'gi');
    let m;
    while ((m = regex.exec(html)) !== null) {
      const slug = (m[1] || '').toLowerCase();
      if (slug) modelSet.add(slug);
    }

    const uniqueModelSlugs = [...modelSet].slice(0, 60);
    const results = [];

    for (const modelSlug of uniqueModelSlugs) {
      const modelLabel = prettifySlugText(modelSlug);
      results.push({
        model: modelLabel,
        modelSlug,
        versions: [{ label: modelLabel, versionSlug: '', baseValue: `${brandDisplayName} ${modelLabel}`.trim(), packages: [] }]
      });
    }

    await page.close();
    const sorted = results.sort((a, b) => a.model.localeCompare(b.model, 'tr')).slice(0, 200);
    setCachedModel(cacheKey, sorted);
    return sorted;
  } catch (e) {
    if (page) await page.close();
    return [];
  }
}

// Vites ismini arabam.com'un beklediği formata dönüştür
function toArabamGear(vites) {
  if (!vites) return null;
  const v = vites.toLowerCase();
  if (v === 'otomatik') return 'Otomatik';
  if (v === 'yari-otomatik') return 'Yarı Otomatik';
  if (v === 'manuel' || v === 'düz') return 'Düz';
  return null;
}

async function fetchSahibindenPrices(model, filters = {}) {
  const { minYear, maxYear, vites, category, brand, modelSlug, versionSlug, km } = filters;
  let activeCategory = category || 'otomobil';

  const sahibindenCategoryMap = {
    'otomobil': 'otomobil',
    'arazi-suv-pick-up': 'arazi-suv-pickup',
    'minivan-panelvan': 'minivan-van',
    'ticari-araclar': 'ticari-araclar',
    'motosiklet': 'motosiklet',
    'motorlu-araclar': 'motorlu-araclar' // Genel bir kategori, eğer eşleşme olmazsa
  };
  activeCategory = sahibindenCategoryMap[activeCategory] || 'otomobil';


  const cacheKey = `prices:sahibinden:${activeCategory}:${brand}:${modelSlug}:${versionSlug}:${minYear}:${maxYear}:${vites}:${km}`;
  const cached = priceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const searchParts = [model];
  const encoded = encodeURIComponent(searchParts.join(' '));

  let url;
  if (brand && modelSlug) {
    // Kullanıcının öğrettiği navigasyon yolu: /otomobil/marka-model-motor-paket
    let categoryPath = `${brand}-${modelSlug}`;

    if (versionSlug) {
      // Eğer versionSlug '1-4-twinport-enjoy' gibi geliyorsa, Sahibinden bunu düz bir şekilde bekler
      // Bazı durumlarda yan yana tireler (--) oluşmaması için normalize ediyoruz
      const cleanVersion = versionSlug.replace(/^-+|-+$/g, '');
      categoryPath += `-${cleanVersion}`;
    }

    url = `https://www.sahibinden.com/${activeCategory}/${categoryPath}`;
  } else {
    url = `https://www.sahibinden.com/${activeCategory}?query_text=${encoded}`;
  }

  const queryParams = [];

  if (minYear && maxYear) {
    queryParams.push(`a5_min=${minYear}`, `a5_max=${maxYear}`);
  }

  // KM filtresi (a10) - Kullanıcı örneğine göre (86k -> 60k-100k) hassaslaştırıldı
  if (km && Number(km) > 0) {
    const k = Number(km);
    // Kullanıcı 86k için 60-100k seçtiyse, yaklaşık ±%20 aralık kullanıyoruz
    const minK = Math.max(0, Math.round(k * 0.75));
    const maxK = Math.round(k * 1.25);
    queryParams.push(`a10_min=${minK}`, `a10_max=${maxK}`);
  }

  // Vites filtresi (a4)
  if (vites) {
    const normalizedVites = vites.toLowerCase();
    if (normalizedVites === 'manuel' || normalizedVites === 'düz') queryParams.push('a4_type=4094');
    else if (normalizedVites === 'otomatik') queryParams.push('a4_type=4095');
    else if (normalizedVites === 'yari-otomatik') queryParams.push('a4_type=215206');
  }

  if (queryParams.length) {
    url += (url.includes('?') ? '&' : '?') + queryParams.join('&');
  }

  if (puppeteer && chromeExecutablePath) {
    let page;
    try {
      page = await createOptimizedPage();
      if (!page) throw new Error("Sayfa oluşturulamadı");

      await page.setExtraHTTPHeaders({
        'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      });

      console.log(`[Sahibinden] Kademeli navigasyon başlatılıyor (Stealth Modu)...`);

      let finalResults = [];
      let retryCount = 0;
      const maxRetries = 2;

      // Her aramadan önce temiz bir oturum aç
      // NOT: Kullanıcı oturumunu korumak için çerezleri TEMİZLEME
      const client = await page.target().createCDPSession();
      // await client.send('Network.clearBrowserCookies'); // Devre dışı
      // await client.send('Network.clearBrowserCache'); // Devre dışı
      while (retryCount <= maxRetries && finalResults.length === 0) {
        try {
          if (retryCount > 0) {
            console.log(`[Sahibinden] Deneme ${retryCount + 1}: Koruma aşılıyor...`);
            await new Promise(r => setTimeout(r, 5000));
          }

          // Sayfa daha önce açılmış olabilir, kontrol et
          if (page.isClosed()) {
            page = await createOptimizedPage();
          }

          // Adım 1: Ana sayfa (Login durumunu kontrol etmek için)
          console.log(`[Sahibinden] Oturum kontrol ediliyor...`);
          try {
            await page.goto('https://www.sahibinden.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
          } catch (e) {
            console.warn("[Sahibinden] Ana sayfa hızlı yükleme uyarısı.");
          }

          let pageTitle = await page.title().catch(() => "");
          let pageContent = await page.content().catch(() => "");

          // Eğer giriş yapılmamışsa bekle, yapılmışsa hemen geç
          if (pageTitle.includes('Giriş') || pageContent.includes('Giriş yap') || pageContent.includes('secure.sahibinden.com/giris')) {
            console.log("\n⚠️  Giriş yapmanız bekleniyor... (Oturum kapalı)");
            await new Promise(r => setTimeout(r, 20000)); // Giriş yapılması için 20sn şans tanı
          } else {
            console.log("[Sahibinden] Oturum aktif. Bot algılanmaması için 10 saniye bekleniyor (Kullanıcı talebi)...");
            await new Promise(r => setTimeout(r, 10000)); // Kullanıcının istediği 10sn bekleme
          }

          // Adım 2: Filtreli ilan listesine asıl geçiş
          console.log(`[Sahibinden] İlan listesine gidiliyor: ${url}`);

          // Çok hızlı geçişi önlemek için küçük bir rastgele bekleme daha
          await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));

          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

          // Akıllı bekleme: İlanlar gelene kadar bekle
          try {
            await page.waitForSelector('.searchResultsItem', { timeout: 10000 });
            console.log("[Sahibinden] İlanlar yüklendi.");
          } catch (e) {
            console.log("[Sahibinden] İlanlar için ek süre bekleniyor...");
            await new Promise(r => setTimeout(r, 5000));
          }

          const finalContent = await page.content().catch(() => "");
          if (finalContent.includes('Captcha') || finalContent.includes('Olağandışı')) {
            console.warn(`[Sahibinden] Kısıtlama tespit edildi.`);
            await page.screenshot({ path: 'sahibinden_hata.png' }).catch(() => { });
            retryCount++;
            continue;
          }

          const brandKeyword = (brand || '').toLowerCase();
          const gearType = (vites || '').toLowerCase();
          const yearFilter = minYear;

          const prices = await page.evaluate((brandKey, gear, targetYear) => {
            const results = [];
            // Daha geniş bir seçici listesi
            const items = document.querySelectorAll('.searchResultsItem, .search-result-item, tr.searchResultsItem, .listing-item, [data-id]');

            items.forEach(item => {
              const text = (item.innerText || '').toLowerCase();

              // Çok katı filtreleri yumuşatıyoruz
              if (brandKey && !text.includes(brandKey.toLowerCase()) && !text.includes(brandKey.split(' ')[0].toLowerCase())) {
                return;
              }

              // Fiyat elementini bul
              const priceEl = item.querySelector('.searchResultsPriceValue, .price-value, .price, .listing-price, td.searchResultsPriceValue');
              if (priceEl) {
                const priceText = priceEl.innerText.replace(/[^\d]/g, '');
                const num = parseInt(priceText);
                if (num > 50000 && num < 50000000) {
                  results.push(num);
                }
              }
            });

            // Yedek Plan: Eğer seçicilerle hiç fiyat bulamadıysa tüm sayfadaki fiyat benzeri sayıları topla
            if (results.length === 0) {
              const bodyText = document.body.innerText;
              const priceMatches = bodyText.match(/(\d{1,3}(?:\.\d{3})+)\s*TL/gi);
              if (priceMatches) {
                priceMatches.forEach(m => {
                  const num = parseInt(m.replace(/[^\d]/g, ''));
                  if (num > 50000 && num < 50000000) results.push(num);
                });
              }
            }

            return results;
          }, (brand || ''), (vites || ''), minYear);

          // Üstte evaluate ile fiyatları zaten çektik
          finalResults = prices || [];

          if (finalResults.length === 0) {
            console.log("[Sahibinden] Hiç ilan bulunamadı, tekrar deneniyor...");
            retryCount++;
          }
        } catch (innerErr) {
          console.error(`[Sahibinden] Adım hatası: ${innerErr.message}`);
          retryCount++;
        }
      }

      await page.close();
      const finalPrices = [...new Set(finalResults)].slice(0, 50);
      console.log(`[Sahibinden] Bulunan Fiyat: ${finalPrices.length}`);

      if (finalPrices.length > 0) {
        const result = { source: 'sahibinden.com', url, prices: finalPrices };
        priceCache.set(cacheKey, { value: result, expiresAt: Date.now() + PRICE_TTL_MS });
        return result;
      }
    } catch (err) {
      if (page) await page.close();
      console.error(`[Sahibinden] Hata: ${err.message}`);
    }
  }

  // Fallback: Axios + Cheerio (Puppeteer çalışmazsa)
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const text = $('body').text();
    const prices = extractPrices(text);
    const result = { source: 'sahibinden.com', url, prices };
    priceCache.set(cacheKey, { value: result, expiresAt: Date.now() + PRICE_TTL_MS });
    return result;
  } catch (e) {
    return { source: 'sahibinden.com', url, prices: [] };
  }
}

async function fetchArabamPrices(model, filters = {}) {
  const { minYear, maxYear, vites, brand, modelSlug, versionSlug, km, category } = filters;
  const activeCategory = category || 'otomobil';

  const cacheKey = `prices:arabam:${activeCategory}:${brand}:${modelSlug}:${versionSlug}:${minYear}:${maxYear}:${vites}:${km}`;
  const cached = priceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let url;

  if (brand && modelSlug) {
    // Kategori URL'i kur: brand-modelSlug[-versionSlug]
    let categoryPath = `${brand}-${modelSlug}`;
    if (versionSlug) categoryPath += `-${versionSlug}`;

    const params = new URLSearchParams();

    // Yıl filtresi: Kesin aralık
    if (minYear) params.set('minYear', minYear);
    if (maxYear) params.set('maxYear', maxYear);

    // KM filtresi: ±%30 aralık
    if (km && Number(km) > 0) {
      const k = Number(km);
      params.set('minKm', Math.max(0, Math.round(k * 0.70)));
      params.set('maxKm', Math.round(k * 1.30));
    }

    // Vites filtresi
    const gear = toArabamGear(vites);
    if (gear) params.set('transmissionName', gear);

    const query = params.toString();
    const baseUrl = `https://www.arabam.com/ikinci-el/${activeCategory}/${categoryPath}`;
    url = query ? `${baseUrl}?${query}` : baseUrl;
  } else {
    // Fallback: genel metin araması
    const searchParts = [model];
    if (vites && vites !== 'manuel') {
      searchParts.push(vites === 'otomatik' ? 'otomatik' : 'yarı otomatik');
    }
    if (minYear && maxYear) {
      if (minYear === maxYear) searchParts.push(String(minYear));
      else searchParts.push(`${minYear}-${maxYear}`);
    }
    const encoded = encodeURIComponent(searchParts.join(' '));
    url = `https://www.arabam.com/ikinci-el/${activeCategory}?searchText=${encoded}`;
  }

  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    // Sadece ilan tablosunu/listesini hedefle (Benzer ilanları engellemek için)
    const listingTable = $('#listing-list, .listing-list, .searchResultsTable');
    let finalPrices = [];

    if (listingTable.length) {
      finalPrices = extractPrices(listingTable, { brandKeyword: (brand || '').toLowerCase(), yearFilter: minYear });
    } else {
      finalPrices = extractPrices($('body'), { brandKeyword: (brand || '').toLowerCase(), yearFilter: minYear });
    }

    let finalUrl = url;

    // Hiç fiyat bulunamazsa ve versionSlug varsa, versionsuz dene
    if (finalPrices.length === 0 && versionSlug && brand && modelSlug) {
      console.log(`[Arabam] Versiyon (${versionSlug}) ile sonuç bulunamadı. Model bazlı deneniyor...`);
      const params = new URLSearchParams();
      if (minYear) params.set('minYear', minYear);
      if (maxYear) params.set('maxYear', maxYear);
      const gear = toArabamGear(vites);
      if (gear) params.set('transmissionName', gear);

      const query = params.toString();
      const fallbackUrl = `https://www.arabam.com/ikinci-el/${activeCategory}/${brand}-${modelSlug}${query ? '?' + query : ''}`;
      try {
        const fallbackHtml = await fetchHtml(fallbackUrl);
        const $f = cheerio.load(fallbackHtml);
        const listingTableF = $f('#listing-list, .listing-list, .searchResultsTable');
        const fallbackPrices = extractPrices(listingTableF.length ? listingTableF : $f('body'), { brandKeyword: (brand || '').toLowerCase(), yearFilter: minYear });

        if (fallbackPrices.length > finalPrices.length) {
          finalPrices = [...new Set([...finalPrices, ...fallbackPrices])];
          finalUrl = fallbackUrl;
        }
      } catch (e2) { /* ignore */ }
    }

    const result = { source: 'arabam.com', url: finalUrl, prices: finalPrices };
    console.log(`[Arabam] URL: ${finalUrl} | Bulunan Fiyat: ${finalPrices.length}`);
    priceCache.set(cacheKey, { value: result, expiresAt: Date.now() + PRICE_TTL_MS });
    return result;
  } catch (e) {
    return { source: 'arabam.com', url: url, prices: [] };
  }
}

async function fetchCarvakPrices(model, filters = {}) {
  const { minYear, maxYear, vites, category, brand, modelSlug, versionSlug, km } = filters;
  const cacheKey = `prices:carvak:${category}:${brand}:${modelSlug}:${versionSlug}:${minYear}:${maxYear}:${vites}:${km}`;
  const cached = priceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const catMap = { 'otomobil': 'otomobil', 'arazi-suv-pick-up': 'suv', 'minivan-panelvan': 'minivan' };
  const catPath = catMap[category] || 'otomobil';

  const searchParts = [brand, modelSlug];
  if (minYear) searchParts.push(minYear);
  if (vites) {
    const v = vites.toLowerCase();
    searchParts.push(v === 'manuel' ? 'düz' : v.replace('-', ' '));
  }

  const url = `https://www.carvak.com/tr/satilik-arac/${catPath}?q=${encodeURIComponent(searchParts.join(' '))}`;

  if (puppeteer && chromeExecutablePath) {
    let page;
    try {
      page = await createOptimizedPage();
      if (!page) throw new Error("Sayfa oluşturulamadı");

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise(r => setTimeout(r, 2000));

      const brandKeyword = (brand || '').toLowerCase();
      const prices = await page.evaluate((brandKey) => {
        const res = [];
        const cards = document.querySelectorAll('aui-product-card, .product-card, [data-testid="product-card"]');

        cards.forEach(card => {
          const titleEl = card.querySelector('.product-title, .card-title, h2, h3');
          const titleText = titleEl ? titleEl.innerText.toLowerCase() : card.innerText.toLowerCase();

          if (brandKey && !titleText.includes(brandKey)) return;

          const priceEl = card.querySelector('aui-price-product, .price, .amount');
          if (priceEl) {
            const m = priceEl.innerText.replace(/\s+/g, '').match(/([\d.,]+)/);
            if (m) {
              const num = Math.round(Number(m[1].replace(/\./g, '').replace(',', '.')));
              if (num > 50000) res.push(num);
            }
          }
        });
        return res;
      }, brandKeyword);

      await page.close();
      const finalPrices = [...new Set(prices)].slice(0, 50);
      console.log(`[Carvak] Bulunan Fiyat: ${finalPrices.length}`);
      const result = { source: 'carvak.com', url, prices: finalPrices };
      priceCache.set(cacheKey, { value: result, expiresAt: Date.now() + PRICE_TTL_MS });
      return result;
    } catch (e) {
      if (page) await page.close();
      console.error(`[Carvak] Hata: ${e.message}`);
    }
  }
  return { source: 'carvak.com', url, prices: [] };
}

async function fetchOtokocPrices(model, filters = {}) {
  const { minYear, maxYear, vites, category, brand, modelSlug, versionSlug, km } = filters;
  const cacheKey = `prices:otokoc:${category}:${brand}:${modelSlug}:${versionSlug}:${minYear}:${maxYear}:${vites}:${km}`;
  const cached = priceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const searchParts = [brand, modelSlug];
  if (minYear) searchParts.push(minYear);
  if (vites) {
    const v = vites.toLowerCase();
    searchParts.push(v === 'manuel' ? 'düz' : v.replace('-', ' '));
  }

  const url = `https://www.otokocikinciel.com/ikinci-el-araba-modelleri?searchText=${encodeURIComponent(searchParts.join(' '))}`;

  if (puppeteer && chromeExecutablePath) {
    let page;
    try {
      page = await createOptimizedPage();
      if (!page) throw new Error("Sayfa oluşturulamadı");

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await new Promise(r => setTimeout(r, 2000));

      const brandKeyword = (brand || '').toLowerCase();
      const prices = await page.evaluate((brandKey) => {
        const res = [];
        const cards = document.querySelectorAll('.product-card, .vehicle-card, .cars-list-item');

        cards.forEach(card => {
          const titleEl = card.querySelector('.card-title, .product-name, h3, h2, .vehicle-title');
          const titleText = titleEl ? titleEl.innerText.toLowerCase() : card.innerText.toLowerCase();

          if (brandKey && !titleText.includes(brandKey)) return;

          const match = card.innerText.match(/(\d{1,3}(?:\.\d{3})+)\s*TL/i);
          if (match) {
            const num = Number(match[1].replace(/\./g, ''));
            if (num > 50000) res.push(num);
          }
        });
        return res;
      }, brandKeyword);

      await page.close();
      const finalPrices = [...new Set(prices)].slice(0, 50);
      const result = { source: 'otokocikinciel.com', url, prices: finalPrices };
      priceCache.set(cacheKey, { value: result, expiresAt: Date.now() + PRICE_TTL_MS });
      return result;
    } catch (e) {
      if (page) await page.close();
      console.error(`[Otokoc] Hata: ${e.message}`);
    }
  }
  return { source: 'otokocikinciel.com', url, prices: [] };
}

async function fetchOtoplusPrices(model, filters = {}) {
  const { minYear, maxYear, vites, category, brand, modelSlug, versionSlug, km } = filters;
  const cacheKey = `prices:otoplus:${category}:${brand}:${modelSlug}:${versionSlug}:${minYear}:${maxYear}:${vites}:${km}`;
  const cached = priceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const catMap = { 'otomobil': 'otomobil', 'arazi-suv-pick-up': 'suv', 'minivan-panelvan': 'minivan' };
  const catPath = catMap[category] || 'otomobil';

  const searchParts = [brand, modelSlug];
  if (minYear) searchParts.push(minYear);
  if (vites) {
    const v = vites.toLowerCase();
    searchParts.push(v === 'manuel' ? 'düz' : v.replace('-', ' '));
  }

  const url = `https://www.otoplus.com/al/${catPath}?searchText=${encodeURIComponent(searchParts.join(' '))}`;

  if (puppeteer && chromeExecutablePath) {
    let page;
    try {
      page = await createOptimizedPage();
      if (!page) throw new Error("Sayfa oluşturulamadı");

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise(r => setTimeout(r, 2000));

      const brandKeyword = (brand || '').toLowerCase();
      const prices = await page.evaluate((brandKey) => {
        const res = [];
        const cards = document.querySelectorAll('.vehicle-card, .car-card, .search-result-card');

        cards.forEach(card => {
          const titleEl = card.querySelector('.card-header, .vehicle-title, strong');
          const titleText = titleEl ? titleEl.innerText.toLowerCase() : card.innerText.toLowerCase();

          if (brandKey && !titleText.includes(brandKey)) return;

          const priceEl = card.querySelector('.vehicle-price, .price, strong:last-child');
          if (priceEl) {
            const num = Math.round(Number(priceEl.innerText.replace(/\./g, '').replace(/[^\d]/g, '')));
            if (num > 50000) res.push(num);
          }
        });
        return res;
      }, brandKeyword);

      await page.close();
      const finalPrices = [...new Set(prices)].slice(0, 50);
      console.log(`[Otoplus] Bulunan Fiyat: ${finalPrices.length}`);
      const result = { source: 'otoplus.com', url, prices: finalPrices };
      priceCache.set(cacheKey, { value: result, expiresAt: Date.now() + PRICE_TTL_MS });
      return result;
    } catch (e) {
      if (page) await page.close();
      console.error(`[Otoplus] Hata: ${e.message}`);
    }
  }
  return { source: 'otoplus.com', url, prices: [] };
}

async function fetchBorusanPrices(model, filters = {}) {
  const { minYear, maxYear, vites, category, brand, modelSlug, versionSlug, km } = filters;
  const cacheKey = `prices:borusan:${category}:${brand}:${modelSlug}:${versionSlug}:${minYear}:${maxYear}:${vites}:${km}`;
  const cached = priceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const catMap = { 'otomobil': 'otomobil', 'arazi-suv-pick-up': 'suv', 'minivan-panelvan': 'minivan' };
  const catPath = catMap[category] || 'otomobil';

  const searchParts = [brand, modelSlug];
  if (minYear) searchParts.push(minYear);
  if (vites) {
    const v = vites.toLowerCase();
    searchParts.push(v === 'manuel' ? 'düz' : v.replace('-', ' '));
  }

  const url = `https://borusannext.com/araba-al/${catPath}?model_search=${encodeURIComponent(searchParts.join(' '))}`;

  if (puppeteer && chromeExecutablePath) {
    let page;
    try {
      page = await createOptimizedPage();
      if (!page) throw new Error("Sayfa oluşturulamadı");

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise(r => setTimeout(r, 2000));

      const brandKeyword = (brand || '').toLowerCase();
      const prices = await page.evaluate((brandKey) => {
        const res = [];
        const cards = document.querySelectorAll('.vehicle-card, .car-card');

        cards.forEach(card => {
          const titleEl = card.querySelector('.card-title, .vehicle-name, h3');
          const titleText = titleEl ? titleEl.innerText.toLowerCase() : card.innerText.toLowerCase();

          if (brandKey && !titleText.includes(brandKey)) return;

          const m = card.innerText.match(/(\d{1,3}(?:\.\d{3})+)\s*₺/i);
          if (m) {
            const num = Number(m[1].replace(/\./g, ''));
            if (num > 50000) res.push(num);
          }
        });
        return res;
      }, brandKeyword);

      await page.close();
      const finalPrices = [...new Set(prices)].slice(0, 50);
      console.log(`[Borusan] Bulunan Fiyat: ${finalPrices.length}`);
      const result = { source: 'borusannext.com', url, prices: finalPrices };
      priceCache.set(cacheKey, { value: result, expiresAt: Date.now() + PRICE_TTL_MS });
      return result;
    } catch (e) {
      if (page) await page.close();
      console.error(`[Borusan] Hata: ${e.message}`);
    }
  }
  return { source: 'borusannext.com', url, prices: [] };
}

module.exports = {
  fetchSahibindenPrices,
  fetchSahibindenBrands,
  fetchArabamPrices,
  fetchArabamBrands,
  fetchArabamModelsByBrand,
  fetchArabamModelsQuick,
  fetchArabamVersionsByModel,
  fetchSahibindenModelsByBrand,
  fetchCarvakPrices,
  fetchOtokocPrices,
  fetchOtoplusPrices,
  fetchBorusanPrices
};
