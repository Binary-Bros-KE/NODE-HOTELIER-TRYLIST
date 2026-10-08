-- A relief/roaming employee with deliberately no fixed location (as opposed to one simply
-- never assigned any). locationIds must be non-empty unless this is true.
ALTER TABLE "Employee" ADD COLUMN "worksAnywhere" BOOLEAN NOT NULL DEFAULT false;

-- Every existing employee with zero assigned locations today got there before a location
-- was mandatory, not through a deliberate "works anywhere" choice - but it's the same
-- real-world state (the POS already asks them each time), so mark them as such rather than
-- leaving them stuck unable to save until someone revisits every one of them individually.
-- Employees with several locations and simply no default chosen are untouched - that's a
-- different state, not "works anywhere".
UPDATE "Employee" e SET "worksAnywhere" = true
WHERE NOT EXISTS (SELECT 1 FROM "_LocationStaff" ls WHERE ls."A" = e.id);
