const express = require('express');
const {
  fetchSahibindenPrices,
  fetchArabamPrices,
  fetchArabamBrands,
  fetchSahibindenBrands,
  fetchArabamModelsByBrand,
  fetchSahibindenModelsByBrand
} = require('../services/providers');
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
      brand: '',
      model: '',
      km: '',
      degisenSayisi: '',
      hasarKaydiTl: '',
      boyaSayisi: ''
    },
    result: null,
    error: null
  });
});

router.get('/api/brands', async (req, res) => {
  try {
    const results = await Promise.allSettled([fetchArabamBrands(), fetchSahibindenBrands()]);

    const lists = results
      .filter((r) => r.status === 'fulfilled' && Array.isArray(r.value))
      .map((r) => r.value);

    if (!lists.length) {
      return res.status(500).json({ error: 'Marka listesi alınamadı.' });
    }

    const map = new Map();
    for (const list of lists) {
      for (const item of list) {
        const slug = String(item.slug || '').toLowerCase();
        if (!slug) continue;
        if (!map.has(slug)) map.set(slug, item);
      }
    }

    const brands = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    return res.json({ brands });
  } catch (error) {
    return res.status(500).json({
      error: `Marka listesi alınamadı: ${error.message}`
    });
  }
});

router.get('/api/models', async (req, res) => {
  const brand = String(req.query.brand || '').trim().toLowerCase();

  if (!brand) {
    return res.status(400).json({ error: 'brand parametresi zorunludur.' });
  }

  try {
    const models = await fetchArabamModelsByBrand(brand);
    // models is an array of { model, modelSlug, versions: [{label,value}] }
    return res.json({ models });
  } catch (error) {
    return res.status(500).json({
      error: `Model listesi alınamadı: ${error.message}`
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

router.post('/analyze', async (req, res) => {
  const form = {
    brand: (req.body.brand || '').trim(),
    model: (req.body.model || '').trim(),
    km: Number(req.body.km) || 0,
    degisenSayisi: Number(req.body.degisenSayisi) || 0,
    hasarKaydiTl: Number(req.body.hasarKaydiTl) || 0,
    boyaSayisi: Number(req.body.boyaSayisi) || 0
  };

  if (!form.model) {
    return res.status(400).render('index', {
      form,
      result: null,
      error: 'Marka ve model seçimi zorunludur.'
    });
  }

  try {
    const providerResults = await Promise.allSettled([
      fetchSahibindenPrices(form.model),
      fetchArabamPrices(form.model)
    ]);

    const providers = providerResults
      .filter((item) => item.status === 'fulfilled')
      .map((item) => item.value);

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
      adjustmentPercent: Math.round((analysis.adjustmentMultiplier - 1) * 100)
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
