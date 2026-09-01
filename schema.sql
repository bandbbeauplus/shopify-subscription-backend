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
  shipment_kind VARCHAR(20) DEFAULT 'subscription', -- subscription or ordinary
  order_id VARCHAR(50),
  order_name VARCHAR(50),
  customer_id VARCHAR(50),
  customer_name VARCHAR(150),
  customer_email VARCHAR(150),
  customer_phone VARCHAR(20),
  shipping_address JSONB,
  product_name VARCHAR(200),
  variant_title VARCHAR(150),
  product_sku VARCHAR(100),
  product_variant_id VARCHAR(50),
  product_quantity INT DEFAULT 1,
  line_items JSONB DEFAULT '[]'::jsonb,
  order_total_price DECIMAL(10,2),
  physical_box_count INT DEFAULT 1,
  parcel_weight_kg DECIMAL(10,3),
  shipment_number INT,                     -- 1 of 6, 2 of 6, etc.
  total_shipments INT,                     -- so dashboard can show "2 of 6"
  scheduled_ship_date DATE NOT NULL,
  actual_ship_date DATE,
  spx_tracking_number VARCHAR(50),
  spx_batch_no VARCHAR(30),
  spx_order_id VARCHAR(32),
  spx_booking_status VARCHAR(30) DEFAULT 'not_created', -- not_created, creating, submitted, processing, created, awb_processing, ready, failed
  spx_last_synced_at TIMESTAMP,
  spx_error TEXT,
  shipment_status VARCHAR(20) DEFAULT 'pending', -- pending, ready_to_ship, shipped, delivered, failed, cancelled
  spx_entry_created BOOLEAN DEFAULT FALSE,
  spx_entry_date TIMESTAMP,
  spx_awb_url TEXT,
  spx_tracking_status VARCHAR(100),
  spx_tracking_status_code VARCHAR(30),
  spx_tracking_message VARCHAR(500),
  spx_tracking_link TEXT,
  spx_tracking_updated_at TIMESTAMP,
  spx_actual_shipping_fee DECIMAL(10,2),
  spx_latest_actual_weight DECIMAL(10,3),
  spx_epod_urls JSONB DEFAULT '[]'::jsonb,
  spx_epop_urls JSONB DEFAULT '[]'::jsonb,
  spx_epor_urls JSONB DEFAULT '[]'::jsonb,
  spx_epooh_urls JSONB DEFAULT '[]'::jsonb,
  spx_evidence_status VARCHAR(100),
  spx_evidence_status_code_name VARCHAR(100),
  spx_evidence_updated_at TIMESTAMP,
  spx_awb_sent_at TIMESTAMP,
  google_drive_file_id VARCHAR(100),
  google_awb_url TEXT,
  google_sheet_row_number INT,
  google_awb_sync_status VARCHAR(30) DEFAULT 'not_synced', -- not_synced, syncing, synced, failed
  google_awb_synced_at TIMESTAMP,
  google_awb_error TEXT,
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
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS shipment_kind VARCHAR(20) DEFAULT 'subscription';
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS order_name VARCHAR(50);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS variant_title VARCHAR(150);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS product_sku VARCHAR(100);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS product_variant_id VARCHAR(50);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS product_quantity INT DEFAULT 1;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS line_items JSONB DEFAULT '[]'::jsonb;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS order_total_price DECIMAL(10,2);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS physical_box_count INT DEFAULT 1;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS parcel_weight_kg DECIMAL(10,3);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_batch_no VARCHAR(30);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_order_id VARCHAR(32);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_tracking_status VARCHAR(100);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_tracking_status_code VARCHAR(30);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_tracking_message VARCHAR(500);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_tracking_link TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_tracking_updated_at TIMESTAMP;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_actual_shipping_fee DECIMAL(10,2);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_latest_actual_weight DECIMAL(10,3);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_epod_urls JSONB DEFAULT '[]'::jsonb;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_epop_urls JSONB DEFAULT '[]'::jsonb;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_epor_urls JSONB DEFAULT '[]'::jsonb;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_epooh_urls JSONB DEFAULT '[]'::jsonb;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_evidence_status VARCHAR(100);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_evidence_status_code_name VARCHAR(100);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_evidence_updated_at TIMESTAMP;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_booking_status VARCHAR(30) DEFAULT 'not_created';
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_last_synced_at TIMESTAMP;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_error TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_awb_url TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS spx_awb_sent_at TIMESTAMP;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS google_drive_file_id VARCHAR(100);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS google_awb_url TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS google_sheet_row_number INT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS google_awb_sync_status VARCHAR(30) DEFAULT 'not_synced';
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS google_awb_synced_at TIMESTAMP;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS google_awb_error TEXT;
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
CREATE INDEX IF NOT EXISTS idx_shipments_spx_batch_no ON shipments(spx_batch_no);
CREATE INDEX IF NOT EXISTS idx_shipments_kind ON shipments(shipment_kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipments_ordinary_order_unique
  ON shipments(order_id) WHERE shipment_kind = 'ordinary';
CREATE INDEX IF NOT EXISTS idx_subscriptions_order_id ON subscriptions(order_id);

CREATE TABLE IF NOT EXISTS spx_tracking_events (
  event_id VARCHAR(100) PRIMARY KEY,
  shipment_id INT REFERENCES shipments(id) ON DELETE SET NULL,
  tracking_no VARCHAR(50),
  order_id VARCHAR(50),
  status_code VARCHAR(30),
  status VARCHAR(100),
  event_timestamp TIMESTAMP NOT NULL,
  received_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spx_tracking_events_shipment ON spx_tracking_events(shipment_id);

CREATE TABLE IF NOT EXISTS spx_evidence_events (
  event_id VARCHAR(100) PRIMARY KEY,
  shipment_id INT REFERENCES shipments(id) ON DELETE SET NULL,
  tracking_no VARCHAR(50),
  customer_order_id VARCHAR(50),
  tracking_code_name VARCHAR(100),
  status VARCHAR(100),
  status_code_name VARCHAR(100),
  received_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spx_evidence_events_shipment ON spx_evidence_events(shipment_id);
