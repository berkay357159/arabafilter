const express = require('express');
const {
  fetchSahibindenPrices,
  fetchArabamPrices,
  fetchArabamBrands,
  fetchArabamModelsQuick,
  fetchArabamVersionsByModel,
  fetchSahibindenModelsByBrand,
  fetchCarvakPrices,
  fetchOtokocPrices,
  fetchOtoplusPrices,
  fetchBorusanPrices
} = require('../services/providers');
// Marka/model kaynağı: arabam.com (sahibinden anti-bot nedeniyle güvenilmez)
const { analyzePricing } = require('../services/pricing');

const router = express.Router();

function formatCurrency(value) {
  if (value === null || value === undefined) return '-';
  return new Intl.NumberFormat('tr-TR', {
    style: 'currency',
    currency: 'TRY',
    maximumFractionDigits: 0
  }).format(value);
}

router.get('/', (req, res) => {
  res.render('index', {
    form: {
      category: 'otomobil',
      brand: '',
      model: '',
      km: '',
      degisenSayisi: '',
      hasarKaydiTl: '',
      boyaSayisi: '',
      vites: 'manuel',
      yil: ''
    },
    result: null,
    error: null
  });
});

router.get('/api/brands', async (req, res) => {
  const category = (req.query.category || 'otomobil').trim().toLowerCase();
  try {
    const brands = await fetchArabamBrands(category);
    if (!brands || !brands.length) {
      return res.status(500).json({ error: 'arabam.com marka listesi alınamadı.' });
    }
    return res.json({ brands });
  } catch (error) {
    return res.status(500).json({
      error: `Marka listesi alınamadı: ${error.message}`
    });
  }
});

router.get('/api/models', async (req, res) => {
  const brand = String(req.query.brand || '').trim().toLowerCase();
  const category = (req.query.category || 'otomobil').trim().toLowerCase();

  if (!brand) {
    return res.status(400).json({ error: 'brand parametresi zorunludur.' });
  }

  try {
    const models = await fetchArabamModelsQuick(category, brand);
    return res.json({ models });
  } catch (error) {
    return res.status(500).json({
      error: `Model listesi alınamadı: ${error.message}`
    });
  }
});

router.get('/api/versions', async (req, res) => {
  const brand = String(req.query.brand || '').trim().toLowerCase();
  const model = String(req.query.model || '').trim().toLowerCase();
  const category = (req.query.category || 'otomobil').trim().toLowerCase();

  if (!brand || !model) {
    return res.status(400).json({ error: 'brand ve model parametreleri zorunludur.' });
  }

  try {
    const versions = await fetchArabamVersionsByModel(category, brand, model);
    return res.json({ versions });
  } catch (error) {
    return res.status(500).json({
      error: `Versiyon listesi alınamadı: ${error.message}`
    });
  }
});

// Sahibinden specific endpoints
router.get('/api/sahibinden/brands', async (req, res) => {
  try {
    const brands = await fetchSahibindenBrands();
    return res.json({ brands });
  } catch (error) {
    return res.status(500).json({ error: `Sahibinden marka listesi alınamadı: ${error.message}` });
  }
});

router.get('/api/sahibinden/prices', async (req, res) => {
  const model = String(req.query.model || '').trim();
  if (!model) return res.status(400).json({ error: 'model parametresi zorunludur.' });

  try {
    const data = await fetchSahibindenPrices(model);
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: `Sahibinden fiyatları alınamadı: ${error.message}` });
  }
});

router.get('/api/sahibinden/models', async (req, res) => {
  const brand = String(req.query.brand || '').trim().toLowerCase();
  if (!brand) return res.status(400).json({ error: 'brand parametresi zorunludur.' });

  try {
    const models = await fetchSahibindenModelsByBrand(brand);
    return res.json({ models });
  } catch (error) {
    return res.status(500).json({ error: `Sahibinden model listesi alınamadı: ${error.message}` });
  }
});

router.get('/api/prefetch', async (req, res) => {
  const { category, brand, modelSlug, versionSlug, yil, vites, km } = req.query;
  if (brand && modelSlug) {
    const filters = { category: category || 'otomobil', brand, modelSlug, versionSlug: versionSlug || null, vites: vites || 'manuel', km: km || 0 };
    if (yil) {
      if (yil.includes('-')) {
        const parts = yil.split('-').map(p => Number(p.trim())).filter(n => !isNaN(n));
        filters.minYear = Math.min(parts[0], parts[1]); filters.maxYear = Math.max(parts[0], parts[1]);
      } else {
        const y = Number(yil); if (!isNaN(y)) filters.minYear = filters.maxYear = y;
      }
    }
    const modelName = `${brand} ${modelSlug}`.trim();
    res.json({ status: 'started' });

  } else {
    res.json({ status: 'ignored' });
  }
});

router.post('/analyze', async (req, res) => {
  const form = {
    category: (req.body.category || 'otomobil').trim().toLowerCase(),
    brand: (req.body.brand || '').trim().toLowerCase(),
    model: (req.body.model || '').trim(),
    modelSlug: (req.body.modelSlug || '').trim().toLowerCase(),
    versionSlug: (req.body.versionSlug || '').trim().toLowerCase(),
    km: Number(req.body.km) || 0,
    degisenSayisi: Number(req.body.degisenSayisi) || 0,
    hasarKaydiTl: Number(req.body.hasarKaydiTl) || 0,
    boyaSayisi: Number(req.body.boyaSayisi) || 0,
    vites: (req.body.vites || 'manuel').trim(),
    yil: (req.body.yil || '').trim()
  };

  let minYear = null;
  let maxYear = null;

  if (form.yil) {
    if (form.yil.includes('-')) {
      const parts = form.yil.split('-').map(p => Number(p.trim())).filter(n => !isNaN(n));
      if (parts.length >= 2) {
        minYear = Math.min(parts[0], parts[1]);
        maxYear = Math.max(parts[0], parts[1]);
      } else if (parts.length === 1) {
        minYear = maxYear = parts[0];
      }
    } else {
      const y = Number(form.yil);
      if (!isNaN(y) && y > 0) {
        minYear = maxYear = y;
      }
    }
  }

  if (!form.model) {
    return res.status(400).render('index', {
      form,
      result: null,
      error: 'Marka ve model seçimi zorunludur.'
    });
  }

  // Fiyat filtreleri
  const priceFilters = {
    minYear,
    maxYear,
    vites: form.vites || null,
    brand: form.brand || null,
    modelSlug: form.modelSlug || null,
    versionSlug: form.versionSlug || null,
    km: form.km || null,
    category: form.category
  };

  try {
    // Filtreli arama
    let providerResults = await Promise.allSettled([
      fetchSahibindenPrices(form.model, priceFilters),
      // fetchArabamPrices(form.model, priceFilters),
      // fetchCarvakPrices(form.model, priceFilters),
      // fetchOtokocPrices(form.model, priceFilters),
      // fetchOtoplusPrices(form.model, priceFilters),
      // fetchBorusanPrices(form.model, priceFilters)
    ]);

    let providers = providerResults
      .filter((item) => item.status === 'fulfilled')
      .map((item) => item.value);

    const totalPrices = providers.reduce((sum, p) => sum + p.prices.length, 0);

    // 1. Kademe: Filtreli aramada hiç sonuç çıkmadıysa YIL ARALIĞINI GENİŞLET (±1 Yıl)
    if (totalPrices === 0 && priceFilters.minYear && priceFilters.minYear === priceFilters.maxYear) {
      const expandedYearFilters = {
        ...priceFilters,
        minYear: priceFilters.minYear - 1,
        maxYear: priceFilters.maxYear + 1
      };

      console.log(`[Analyze] ${priceFilters.minYear} yılı için sonuç bulunamadı. Aralığı ${expandedYearFilters.minYear}-${expandedYearFilters.maxYear} olarak genişletiyorum...`);

      const expandedResults = await Promise.allSettled([
        fetchSahibindenPrices(form.model, expandedYearFilters),
        // fetchArabamPrices(form.model, expandedYearFilters),
        // fetchCarvakPrices(form.model, expandedYearFilters),
        // fetchOtokocPrices(form.model, expandedYearFilters),
        // fetchOtoplusPrices(form.model, expandedYearFilters),
        // fetchBorusanPrices(form.model, expandedYearFilters)
      ]);

      const expandedProviders = expandedResults
        .filter((item) => item.status === 'fulfilled')
        .map((item) => ({ ...item.value, expanded: true }));

      if (expandedProviders.reduce((sum, p) => sum + p.prices.length, 0) > 0) {
        providers = expandedProviders;
      }
    }

    const currentTotalPrices = providers.reduce((sum, p) => sum + p.prices.length, 0);

    // 2. Kademe: Genişletilmiş yılda da sonuç yoksa filtresiz tekrar dene (Son çare)
    if (currentTotalPrices === 0 && (priceFilters.minYear || priceFilters.maxYear || priceFilters.vites)) {
      const fallbackResults = await Promise.allSettled([
        fetchSahibindenPrices(form.model, { brand: priceFilters.brand, modelSlug: priceFilters.modelSlug }),
        // fetchArabamPrices(form.model, { brand: priceFilters.brand, modelSlug: priceFilters.modelSlug }),
        // fetchCarvakPrices(form.model, { brand: priceFilters.brand, modelSlug: priceFilters.modelSlug }),
        // fetchOtokocPrices(form.model, { brand: priceFilters.brand, modelSlug: priceFilters.modelSlug }),
        // fetchOtoplusPrices(form.model, { brand: priceFilters.brand, modelSlug: priceFilters.modelSlug }),
        // fetchBorusanPrices(form.model, { brand: priceFilters.brand, modelSlug: priceFilters.modelSlug })
      ]);
      const fallbackProviders = fallbackResults
        .filter((item) => item.status === 'fulfilled')
        .map((item) => ({ ...item.value, fallback: true }));
      if (fallbackProviders.reduce((sum, p) => sum + p.prices.length, 0) > 0) {
        providers = fallbackProviders;
      }
    }

    if (!providers.length) {
      return res.render('index', {
        form,
        result: null,
        error: 'Kaynak sitelere erişilemedi. Lütfen tekrar deneyin.'
      });
    }

    const analysis = analyzePricing({ providerResults: providers, vehicle: form });

    if (!analysis.marketAverage) {
      return res.render('index', {
        form,
        result: {
          providers,
          formatted: {
            marketAverage: '-',
            adjustedPrice: '-',
            salePriceWithProfit: '-'
          },
          adjustmentPercent: null
        },
        error: 'İlanlardan fiyat okunamadı. Model adını daha detaylı yazmayı deneyin (örn: Toyota Corolla 1.6).'
      });
    }

    const result = {
      providers,
      raw: analysis,
      formatted: {
        marketAverage: formatCurrency(analysis.marketAverage),
        adjustedPrice: formatCurrency(analysis.adjustedPrice),
        salePriceWithProfit: formatCurrency(analysis.salePriceWithProfit)
      },
      adjustmentPercent: Math.round((analysis.adjustmentMultiplier - 1) * 100),
      form
    };

    return res.render('index', { form, result, error: null });
  } catch (error) {
    return res.status(500).render('index', {
      form,
      result: null,
      error: `İşlem sırasında hata oluştu: ${error.message}`
    });
  }
});

module.exports = router;
