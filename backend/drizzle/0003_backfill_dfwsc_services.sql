-- Backfill workspace for existing dfwsc_services records
-- This migration identifies existing DFWSC clients/groups by name pattern and sets their workspace correctly

UPDATE client_groups SET workspace = 'dfwsc_services' WHERE name ILIKE '%dfwsc%' OR name ILIKE '%software%consulting%';
UPDATE clients SET workspace = 'dfwsc_services' WHERE name ILIKE '%dfwsc%' OR name ILIKE '%software%consulting%' OR email ILIKE '%dfwsc%';