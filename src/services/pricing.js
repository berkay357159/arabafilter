function average(values) {
  if (!values.length) return null;
  const sum = values.reduce((acc, val) => acc + val, 0);
  return Math.round(sum / values.length);
}

function calculateAdjustmentMultiplier({ km, degisenSayisi, boyaSayisi, hasarKaydiTl }) {
  const normalizedKm = Number(km) || 0;
  const normalizedDegisen = Number(degisenSayisi) || 0;
  const normalizedBoya = Number(boyaSayisi) || 0;
  const normalizedHasar = Number(hasarKaydiTl) || 0;

  const kmDiff = normalizedKm - 100000;
  const kmFactor = kmDiff > 0 ? -(kmDiff / 10000) * 0.01 : Math.abs(kmDiff / 10000) * 0.005;
  const degisenFactor = normalizedDegisen * -0.01;
  const boyaFactor = normalizedBoya * -0.005;
  const hasarFactor = -(normalizedHasar / 10000) * 0.01;

  const raw = 1 + kmFactor + degisenFactor + boyaFactor + hasarFactor;
  return Math.max(0.6, Math.min(raw, 1.25));
}

function analyzePricing({ providerResults, vehicle }) {
  const allPrices = providerResults.flatMap((provider) => provider.prices);
  const marketAverage = average(allPrices);

  if (!marketAverage) {
    return {
      marketAverage: null,
      adjustedPrice: null,
      salePriceWithProfit: null,
      adjustmentMultiplier: null,
      allPrices
    };
  }

  const adjustmentMultiplier = calculateAdjustmentMultiplier(vehicle);
  const adjustedPrice = Math.round(marketAverage * adjustmentMultiplier);
  const salePriceWithProfit = Math.round(adjustedPrice * 1.1);

  return {
    marketAverage,
    adjustedPrice,
    salePriceWithProfit,
    adjustmentMultiplier,
    allPrices
  };
}

module.exports = {
  analyzePricing,
  calculateAdjustmentMultiplier
};
