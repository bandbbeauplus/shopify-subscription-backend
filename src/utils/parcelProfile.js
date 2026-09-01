const { getPlanMonths } = require('./subscriptionPlan');

const DEFAULT_UNIT_BOX_WEIGHT_G = 188;

function positiveInteger(value, fallback = 1) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function boxesPerUnit(item) {
  if (getPlanMonths(item)) return 4;

  const variantTitle = String(item?.variant_title || '').trim();
  const title = String(item?.title || '').trim();
  const sku = String(item?.sku || '').trim().toUpperCase();
  const searchable = `${variantTitle} ${title}`;

  if (/\b7\s*SACHETS?\b/i.test(searchable) || /-7P$/i.test(sku)) return 1;
  if (/\b14\s*SACHETS?\b/i.test(searchable) || /-14P$/i.test(sku)) return 2;
  if (/\b28\s*SACHETS?\b/i.test(searchable) || /-28P$/i.test(sku)) return 4;
  if (/-SP(?:1|3|6|12)M$/i.test(sku)) return 4;

  return 1;
}

function normalizeLineItems(lineItems) {
  if (!Array.isArray(lineItems)) return [];
  return lineItems.map((item) => ({
    title: String(item?.title || 'Shopify item').trim().slice(0, 200),
    variant_title: String(item?.variant_title || '').trim().slice(0, 150),
    sku: String(item?.sku || '').trim().slice(0, 100) || null,
    variant_id: item?.variant_id ? String(item.variant_id) : null,
    quantity: positiveInteger(item?.quantity),
    unit_price: String(item?.price || '0').trim(),
    boxes_per_unit: boxesPerUnit(item),
  }));
}

function summarizeItems(lineItems, unitBoxWeightG = DEFAULT_UNIT_BOX_WEIGHT_G) {
  const items = normalizeLineItems(lineItems);
  const boxWeight = Number(unitBoxWeightG);
  if (!Number.isFinite(boxWeight) || boxWeight <= 0) {
    throw new Error('Unit box weight must be a positive number of grams');
  }
  const physicalBoxCount = items.reduce(
    (total, item) => total + (item.quantity * item.boxes_per_unit),
    0
  );
  const parcelWeightKg = Math.round((physicalBoxCount * boxWeight)) / 1000;
  return {
    items,
    physicalBoxCount: Math.max(1, physicalBoxCount),
    parcelWeightKg: Math.max(0.001, parcelWeightKg),
    productName: items.map((item) => item.title).filter(Boolean).join(' + ').slice(0, 200),
    productSku: [...new Set(items.map((item) => item.sku).filter(Boolean))].join(', ').slice(0, 100) || null,
    productQuantity: items.reduce((total, item) => total + item.quantity, 0) || 1,
  };
}

function shipmentParcelProfile(shipment, unitBoxWeightG = DEFAULT_UNIT_BOX_WEIGHT_G) {
  const storedBoxes = Number(shipment?.physical_box_count);
  const storedWeight = Number(shipment?.parcel_weight_kg);
  if (Number.isInteger(storedBoxes) && storedBoxes > 0 && Number.isFinite(storedWeight) && storedWeight > 0) {
    return { physicalBoxCount: storedBoxes, parcelWeightKg: storedWeight };
  }

  if (
    (!Array.isArray(shipment?.line_items) || shipment.line_items.length === 0)
    && (shipment?.shipment_kind === 'subscription' || shipment?.subscription_id)
  ) {
    const physicalBoxCount = positiveInteger(shipment?.product_quantity) * 4;
    return {
      physicalBoxCount,
      parcelWeightKg: Math.round(physicalBoxCount * Number(unitBoxWeightG)) / 1000,
    };
  }

  const lineItems = Array.isArray(shipment?.line_items) && shipment.line_items.length
    ? shipment.line_items
    : [{
      title: shipment?.product_name,
      sku: shipment?.product_sku,
      quantity: shipment?.product_quantity,
      variant_title: shipment?.variant_title,
    }];
  const summary = summarizeItems(lineItems, unitBoxWeightG);
  return {
    physicalBoxCount: summary.physicalBoxCount,
    parcelWeightKg: summary.parcelWeightKg,
  };
}

module.exports = {
  DEFAULT_UNIT_BOX_WEIGHT_G,
  boxesPerUnit,
  normalizeLineItems,
  shipmentParcelProfile,
  summarizeItems,
};
