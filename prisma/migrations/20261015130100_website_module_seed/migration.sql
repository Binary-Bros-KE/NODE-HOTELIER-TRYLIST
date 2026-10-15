-- Reference data for the WEBSITE module. Kept out of the previous migration
-- because Postgres can't use a newly added enum value ('WEBSITE') in the
-- same transaction that adds it.

-- Global module row (same shape tenantBootstrap upserts).
INSERT INTO "Module" ("key", "name", "description")
VALUES ('WEBSITE', 'WEBSITE', 'Public tenant website')
ON CONFLICT ("key") DO NOTHING;

-- Every existing tenant gets the module row, switched off — the website is
-- an opt-in add-on enabled per tenant from the platform admin.
INSERT INTO "TenantModule" ("id", "tenantId", "moduleKey", "isEnabled", "createdAt")
SELECT md5('WEBSITE:' || t."id"), t."id", 'WEBSITE', false, CURRENT_TIMESTAMP
FROM "Tenant" t
ON CONFLICT ("tenantId", "moduleKey") DO NOTHING;

-- Theme #1. sectionTypes = the blocks the platform page editor may offer;
-- grows with the theme in the WEBSITE app (src/themes/aurora).
INSERT INTO "WebsiteTheme" ("key", "name", "description", "version", "sectionTypes", "isActive", "updatedAt")
VALUES (
  'aurora',
  'Aurora',
  'Hospitality theme for hotels, restaurants, bars and spas.',
  '1.0.0',
  ARRAY['hero', 'rich-text', 'image-text', 'rooms-showcase', 'menu-highlights', 'services-showcase',
        'membership-plans', 'amenities', 'gallery', 'testimonials', 'faq', 'cta', 'contact-map'],
  true,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;
