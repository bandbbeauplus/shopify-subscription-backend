const httpError = require('../utils/httpError');
const { locations } = require('../data/spxLocations.json');

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function municipality(value) {
  return normalize(value).replace(/^city of /, '').replace(/ city$/, '');
}

const deliveryByProvinceAndCity = new Map();
const pickupLocations = new Map();
for (const [state, city, district, street, pickup, deliver] of locations) {
  const exact = [state, city, district, street].map(normalize).join('|');
  if (pickup) pickupLocations.set(exact, { state, city, district, street });
  if (deliver) {
    const key = [normalize(city), municipality(district)].join('|');
    if (!deliveryByProvinceAndCity.has(key)) deliveryByProvinceAndCity.set(key, []);
    deliveryByProvinceAndCity.get(key).push({ state, city, district, street });
  }
}

function assertPickupLocation({ state, city, district, street }) {
  const key = [state, city, district, street].map(normalize).join('|');
  const canonical = pickupLocations.get(key);
  if (!canonical) {
    throw httpError(503, 'SPX warehouse pickup location is not in the current SPX serviceable-area list');
  }
  return canonical;
}

function resolveDeliveryLocation(address = {}) {
  const province = normalize(address.province);
  const city = municipality(address.city);
  const candidates = deliveryByProvinceAndCity.get([province, city].join('|')) || [];
  // Shopify address2 is the barangay only when it matches a listed SPX street.
  // Never infer a barangay from the detailed street/unit address.
  const barangays = [address.district, address.street, address.address2]
    .map((value) => normalize(value).replace(/^(?:brgy|barangay) /, ''))
    .filter(Boolean);
  const matches = candidates.filter((row) => barangays.includes(normalize(row.street)));
  if (matches.length !== 1) {
    throw httpError(422,
      'SPX delivery location cannot be matched exactly. Confirm the customer province, city, and barangay in Shopify address line 2 before booking.');
  }
  const { state, city: spxCity, district, street } = matches[0];
  return { state, city: spxCity, district, street };
}

module.exports = { assertPickupLocation, resolveDeliveryLocation };
