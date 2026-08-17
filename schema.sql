-- Run this once against your Postgres database to set up tables.
-- Usage: psql $DATABASE_URL -f schema.sql

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  order_id VARCHAR(50) NOT NULL UNIQUE,
  order_name VARCHAR(50),                 -- e.g. "#1001", nicer for humans than raw order_id
  customer_id VARCHAR(50),
  customer_email VARCHAR(150),
  customer_phone VARCHAR(20),
  shipping_address JSONB,
  product_name VARCHAR(200),
  variant_title VARCHAR(150),              -- "6 Months Subscription - Ships Monthly"
  total_price_paid DECIMAL(10,2),
  plan_months INT NOT NULL,                -- 1, 3, 6, or 12
  payment_date TIMESTAMP,
  subscription_start_date TIMESTAMP,
  subscription_end_date TIMESTAMP,
  subscription_status VARCHAR(20) DEFAULT 'active', -- active, paused, cancelled, completed
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shipments (
  id SERIAL PRIMARY KEY,
  subscription_id INT REFERENCES subscriptions(id) ON DELETE CASCADE,
  order_id VARCHAR(50),
  customer_id VARCHAR(50),
  customer_name VARCHAR(150),
  customer_email VARCHAR(150),
  customer_phone VARCHAR(20),
  shipping_address JSONB,
  product_name VARCHAR(200),
  product_sku VARCHAR(100),
  product_variant_id VARCHAR(50),
  product_quantity INT DEFAULT 1,
  shipment_number INT,                     -- 1 of 6, 2 of 6, etc.
  total_shipments INT,                     -- so dashboard can show "2 of 6"
  scheduled_ship_date DATE NOT NULL,
  actual_ship_date DATE,
  spx_tracking_number VARCHAR(50),
  shipment_status VARCHAR(20) DEFAULT 'pending', -- pending, ready_to_ship, shipped, delivered, failed, cancelled
  spx_entry_created BOOLEAN DEFAULT FALSE,
  spx_entry_date TIMESTAMP,
  spx_awb_url TEXT,
  spx_awb_sent_at TIMESTAMP,
  oms_order_id VARCHAR(100),
  oms_order_reference VARCHAR(100),
  shopify_delivery_order_id VARCHAR(50),
  shopify_delivery_order_name VARCHAR(50),
  shopify_delivery_created_at TIMESTAMP,
  warehouse_status VARCHAR(30) DEFAULT 'not_sent', -- not_sent, submitted, picking, packed, awb_sent, ready_for_pickup, failed
  oms_submitted_at TIMESTAMP,
  oms_packed_at TIMESTAMP,
  oms_last_synced_at TIMESTAMP,
  warehouse_error TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Safe upgrades for databases created before the OMS/WMS workflow was added.
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS product_sku VARCHAR(100);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS product_variant_id VARCHAR(50);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS product_quantity INT DEFAULT 1;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_awb_url TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_awb_sent_at TIMESTAMP;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS oms_order_id VARCHAR(100);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS oms_order_reference VARCHAR(100);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS shopify_delivery_order_id VARCHAR(50);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS shopify_delivery_order_name VARCHAR(50);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS shopify_delivery_created_at TIMESTAMP;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS warehouse_status VARCHAR(30) DEFAULT 'not_sent';
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS oms_submitted_at TIMESTAMP;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS oms_packed_at TIMESTAMP;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS oms_last_synced_at TIMESTAMP;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS warehouse_error TEXT;

-- Speeds up shipment and dashboard queries. Create these after upgrade columns.
CREATE INDEX IF NOT EXISTS idx_shipments_scheduled_date ON shipments(scheduled_ship_date);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(shipment_status);
CREATE INDEX IF NOT EXISTS idx_shipments_warehouse_status ON shipments(warehouse_status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_order_id ON subscriptions(order_id);
