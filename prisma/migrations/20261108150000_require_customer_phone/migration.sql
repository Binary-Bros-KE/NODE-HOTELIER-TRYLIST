-- Super Admin setting: require a real phone number on customers (off by default).
ALTER TABLE "BusinessProfile" ADD COLUMN "requireCustomerPhone" BOOLEAN NOT NULL DEFAULT false;
