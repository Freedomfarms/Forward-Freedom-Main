import { roundMoney as roundCurrency } from "./money.js";

const MINTED_METAL_API_URL = "https://mintedmetal.com/api/prices.json";
const METALS_REFRESH_MS = 24 * 60 * 60 * 1000;
const TROY_OUNCE_IN_GRAMS = 31.1034768;

const METAL_API_KEYS = {
  Gold: "gold",
  Silver: "silver",
  Platinum: "platinum",
  Palladium: "palladium",
};

export function isPreciousMetalsPriceStale(lastValuedAt, refreshMs = METALS_REFRESH_MS) {
  if (!lastValuedAt) return true;
  return Date.now() - Number(lastValuedAt) >= refreshMs;
}

export function normalizePreciousMetalsPricePerUnit(pricePerTroyOunce, unit) {
  const ouncePrice = Number(pricePerTroyOunce) || 0;
  if (unit === "g") {
    return roundCurrency(ouncePrice / TROY_OUNCE_IN_GRAMS);
  }

  return roundCurrency(ouncePrice);
}

export async function fetchPreciousMetalsSpotPrices(options = {}) {
  const response = await fetch(MINTED_METAL_API_URL, { signal: options.signal });
  if (!response.ok) {
    throw new Error(`Precious metals pricing failed (${response.status})`);
  }

  const data = await response.json();
  const updatedAt = data.updatedAt ? new Date(data.updatedAt).getTime() : Date.now();
  const metals = data.metals || {};

  return Object.entries(METAL_API_KEYS).reduce((prices, [metalType, apiKey]) => {
    const quote = metals[apiKey];
    if (!quote || quote.price === undefined || quote.price === null) return prices;

    prices[metalType] = {
      pricePerTroyOunce: Number(quote.price) || 0,
      updatedAt,
      source: "Minted Metal",
      sourceLabel: quote.sourceLabel || quote.source || "Spot",
    };
    return prices;
  }, {});
}
