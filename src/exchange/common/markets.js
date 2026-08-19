export const FALLBACK_MARKETS = {
  n1: [{ marketId: 1, name: 'BTC-PERP', displayName: 'BTC-PERP', symbol: 'BTC', lastPrice: 100_000, stepSize: 0.001, stepPrice: 1, minOrderSize: 0.001, maxLeverage: 30 }],
  ph: [{ marketId: 1, name: 'BTC-PERP', displayName: 'BTC-PERP', symbol: 'BTC', lastPrice: 100_000, stepSize: 0.0001, stepPrice: 1, minOrderSize: 0.0001, maxLeverage: 30 }],
  ph2: [{ marketId: 1, name: 'BTC-PERP', displayName: 'BTC-PERP', symbol: 'BTC', lastPrice: 100_000, stepSize: 0.0001, stepPrice: 1, minOrderSize: 0.0001, maxLeverage: 30 }],
  na: [{ marketId: 1, name: 'BTC-PERP', displayName: 'BTC-PERP', symbol: 'BTC', lastPrice: 100_000, stepSize: 0.00005, stepPrice: 1, minOrderSize: 0.00005, maxLeverage: 30 }],
  pd: [{ marketId: 1, name: 'BTCUSDT', displayName: 'BTCUSDT', symbol: 'BTCUSDT', lastPrice: 100_000, stepSize: 0.001, stepPrice: 0.1, minOrderSize: 0.001, minOrderNotional: 5, maxLeverage: 30 }],
};

export function fallbackMarkets(key) {
  return (FALLBACK_MARKETS[key] || FALLBACK_MARKETS.ph).map((market) => ({ ...market }));
}
