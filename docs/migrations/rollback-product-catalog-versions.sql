-- Emergency rollback for the product catalog history schema.
-- This intentionally destroys catalog audit history. Run only after exporting
-- product_catalog_versions and only as part of an approved rollback.
DROP TRIGGER IF EXISTS product_catalog_versions_immutable ON product_catalog_versions;
DROP FUNCTION IF EXISTS prevent_product_catalog_version_mutation();
DROP TABLE IF EXISTS product_catalog_versions;
