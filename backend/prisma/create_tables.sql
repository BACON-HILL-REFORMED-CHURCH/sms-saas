-- SMS SaaS — Create all tables in Supabase
-- Run this in Supabase SQL Editor

CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'RECEIVED', 'CANCELED', 'EXPIRED');
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT', 'DEBIT', 'REFUND', 'ADMIN_ADJ');

CREATE TABLE IF NOT EXISTS "users" (
  "id"              TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "email"           TEXT NOT NULL,
  "passwordHash"    TEXT NOT NULL,
  "role"            "Role" NOT NULL DEFAULT 'USER',
  "balance"         INTEGER NOT NULL DEFAULT 0,
  "isEmailVerified" BOOLEAN NOT NULL DEFAULT false,
  "verifyToken"     TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email");

CREATE TABLE IF NOT EXISTS "orders" (
  "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "userId"      TEXT NOT NULL,
  "provider"    TEXT NOT NULL,
  "externalId"  TEXT NOT NULL,
  "phoneNumber" TEXT NOT NULL,
  "service"     TEXT NOT NULL,
  "country"     TEXT NOT NULL,
  "status"      "OrderStatus" NOT NULL DEFAULT 'PENDING',
  "smsCode"     TEXT,
  "smsFullText" TEXT,
  "price"       INTEGER NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id")
);
CREATE INDEX IF NOT EXISTS "orders_userId_idx" ON "orders"("userId");
CREATE INDEX IF NOT EXISTS "orders_status_idx" ON "orders"("status");

CREATE TABLE IF NOT EXISTS "transactions" (
  "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "userId"       TEXT NOT NULL,
  "type"         "TransactionType" NOT NULL,
  "amount"       INTEGER NOT NULL,
  "balanceAfter" INTEGER NOT NULL,
  "description"  TEXT NOT NULL,
  "orderId"      TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "transactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id"),
  CONSTRAINT "transactions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "transactions_orderId_key" ON "transactions"("orderId");
CREATE INDEX IF NOT EXISTS "transactions_userId_idx" ON "transactions"("userId");

CREATE TABLE IF NOT EXISTS "service_pricing" (
  "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "service"       TEXT NOT NULL,
  "country"       TEXT NOT NULL,
  "provider"      TEXT NOT NULL,
  "marginPercent" INTEGER NOT NULL DEFAULT 30,
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_pricing_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "service_pricing_service_country_provider_key" ON "service_pricing"("service","country","provider");

-- eSIM tables
CREATE TABLE IF NOT EXISTS "esim_products" (
  "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "name"        TEXT NOT NULL,
  "country"     TEXT NOT NULL,
  "countryCode" TEXT NOT NULL,
  "gb"          DOUBLE PRECISION NOT NULL,
  "days"        INTEGER NOT NULL,
  "price"       INTEGER NOT NULL,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "esim_products_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "esim_inventory" (
  "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "productId"      TEXT NOT NULL,
  "qrCodeData"     TEXT NOT NULL,
  "activationCode" TEXT,
  "isSold"         BOOLEAN NOT NULL DEFAULT false,
  "soldAt"         TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "esim_inventory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "esim_inventory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "esim_products"("id")
);
CREATE INDEX IF NOT EXISTS "esim_inventory_productId_idx" ON "esim_inventory"("productId");
CREATE INDEX IF NOT EXISTS "esim_inventory_isSold_idx" ON "esim_inventory"("isSold");

CREATE TABLE IF NOT EXISTS "esim_orders" (
  "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "userId"      TEXT NOT NULL,
  "productId"   TEXT NOT NULL,
  "inventoryId" TEXT,
  "price"       INTEGER NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'COMPLETED',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "esim_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "esim_orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id"),
  CONSTRAINT "esim_orders_productId_fkey" FOREIGN KEY ("productId") REFERENCES "esim_products"("id"),
  CONSTRAINT "esim_orders_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "esim_inventory"("id"),
  CONSTRAINT "esim_orders_inventoryId_key" UNIQUE ("inventoryId")
);
CREATE INDEX IF NOT EXISTS "esim_orders_userId_idx" ON "esim_orders"("userId");

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "userId"    TEXT,
  "action"    TEXT NOT NULL,
  "details"   JSONB,
  "ip"        TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "audit_logs_userId_idx" ON "audit_logs"("userId");
