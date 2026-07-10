import { roundMoney } from "./money.js";

const COINGECKO_API_BASE = "https://api.coingecko.com/api/v3";
const DAILY_REFRESH_MS = 24 * 60 * 60 * 1000;

export function normalizeCryptoQuantity(value) {
  const parsed = Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function calculateCryptoBalance(quantity, priceUsd) {
  return roundMoney((Number(quantity) || 0) * (Number(priceUsd) || 0));
}

export function isCryptoPriceStale(lastPriceUpdatedAt, refreshMs = DAILY_REFRESH_MS) {
  if (!lastPriceUpdatedAt) return true;
  return Date.now() - Number(lastPriceUpdatedAt) >= refreshMs;
}

export async function searchCryptoAssets(query, options = {}) {
  const trimmedQuery = String(query || "").trim();
  if (!trimmedQuery) return [];

  const response = await fetch(
    `${COINGECKO_API_BASE}/search?query=${encodeURIComponent(trimmedQuery)}`,
    { signal: options.signal }
  );

  if (!response.ok) {
    throw new Error(`Crypto search failed (${response.status})`);
  }

  const data = await response.json();
  return (data.coins || []).slice(0, 8).map((coin) => ({
    id: coin.id,
    name: coin.name,
    symbol: String(coin.symbol || "").toUpperCase(),
    marketCapRank: coin.market_cap_rank,
    thumb: coin.thumb,
  }));
}

export async function fetchCryptoQuotes(assetIds, options = {}) {
  const uniqueIds = [...new Set((assetIds || []).filter(Boolean))];
  if (uniqueIds.length === 0) return {};

  const searchParams = new URLSearchParams({
    ids: uniqueIds.join(","),
    vs_currencies: "usd",
    include_last_updated_at: "true",
  });
  const response = await fetch(`${COINGECKO_API_BASE}/simple/price?${searchParams}`, {
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`Crypto pricing failed (${response.status})`);
  }

  const data = await response.json();
  return uniqueIds.reduce((quotes, assetId) => {
    const quote = data[assetId];
    if (!quote || quote.usd === undefined || quote.usd === null) return quotes;

    quotes[assetId] = {
      priceUsd: Number(quote.usd) || 0,
      lastUpdatedAt: quote.last_updated_at ? Number(quote.last_updated_at) * 1000 : Date.now(),
    };
    return quotes;
  }, {});
}
