const PLAN_VARIANT_PATTERN = /^\s*(1|3|6|12)\s*[-\u2013\u2014]\s*month\s+plan\b/i;

function getPlanMonths(lineItem) {
  // Subscription detection intentionally uses only Shopify's variant title.
  // Product titles, quantities, and SKUs can contain numbers for normal items.
  const variantTitle = String(lineItem?.variant_title || '');
  const match = variantTitle.match(PLAN_VARIANT_PATTERN);
  return match ? Number(match[1]) : null;
}

module.exports = { getPlanMonths };
