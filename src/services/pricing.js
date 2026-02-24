function average(values) {
  if (!values.length) return null;
  const sum = values.reduce((acc, val) => acc + val, 0);
  return Math.round(sum / values.length);
}

// Vites tipine göre çarpan
function transmissionFactor(vites) {
  const v = String(vites || '').toLowerCase();
  if (v === 'otomatik') return 0.03;       // +%3 prim
  if (v === 'yari-otomatik') return 0.01;  // +%1 prim
  return 0;                                // manuel: nötr
}

// Yıla göre çarpan — referans yıl: şu anki yıl
function yearFactor(yil) {
  const y = Number(yil) || 0;
  if (!y) return 0;
  const currentYear = new Date().getFullYear();
  const age = currentYear - y;
  // Her yıl için -0.5%, max ±%20
  const raw = -(age * 0.005);
  return Math.max(-0.20, Math.min(raw, 0.20));
}

function calculateAdjustmentMultiplier({ km, degisenSayisi, boyaSayisi, hasarKaydiTl, vites, yil }) {
  const normalizedKm = Number(km) || 0;
  const normalizedDegisen = Number(degisenSayisi) || 0;
  const normalizedBoya = Number(boyaSayisi) || 0;
  const normalizedHasar = Number(hasarKaydiTl) || 0;

  const kmDiff = normalizedKm - 100000;
  const kmFactor = kmDiff > 0 ? -(kmDiff / 10000) * 0.01 : Math.abs(kmDiff / 10000) * 0.005;
  const degisenFactor = normalizedDegisen * -0.01;
  const boyaFactor = normalizedBoya * -0.005;
  const hasarFactor = -(normalizedHasar / 10000) * 0.01;
  const vitesFactor = transmissionFactor(vites);
  const yilFactor = yearFactor(yil);

  const raw = 1 + kmFactor + degisenFactor + boyaFactor + hasarFactor + vitesFactor + yilFactor;
  return Math.max(0.6, Math.min(raw, 1.30));
}

function analyzePricing({ providerResults, vehicle }) {
  let allPrices = providerResults.flatMap((provider) => provider.prices);

  if (!allPrices.length) {
    return {
      marketAverage: null,
      adjustedPrice: null,
      salePriceWithProfit: null,
      adjustmentMultiplier: null,
      allPrices: []
    };
  }

  // 1. Aykırı Değer Temizliği (Interquartile Range - IQR Yöntemi)
  allPrices.sort((a, b) => a - b);
  const q1 = allPrices[Math.floor((allPrices.length / 4))];
  const q3 = allPrices[Math.floor((allPrices.length * (3 / 4)))];
  const iqr = q3 - q1;
  const lowerBound = q1 - (iqr * 1.5);
  const upperBound = q3 + (iqr * 1.5);

  const filteredPrices = allPrices.filter(price => price >= lowerBound && price <= upperBound);

  // Eğer filtreleme sonucunda fiyat kalmazsa (hepsi aynıysa vb.) orijinal listeyi kullan
  const basePrices = filteredPrices.length > 0 ? filteredPrices : allPrices;

  const marketAverage = average(basePrices);

  const adjustmentMultiplier = calculateAdjustmentMultiplier(vehicle);
  const adjustedPrice = Math.round(marketAverage * adjustmentMultiplier);
  const salePriceWithProfit = Math.round(adjustedPrice * 1.1);

  return {
    marketAverage,
    adjustedPrice,
    salePriceWithProfit,
    adjustmentMultiplier,
    allPrices: basePrices
  };
}

module.exports = {
  analyzePricing,
  calculateAdjustmentMultiplier
};
