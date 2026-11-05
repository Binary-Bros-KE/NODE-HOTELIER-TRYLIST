-- Every existing Super Admin role can see the activity log (the server already lets
-- a Super Admin through; this makes the menu item show for them too).
UPDATE "Role" SET "permissions" = array_append("permissions", 'ACTIVITY_VIEW'::"Permission")
WHERE "name" = 'Super Admin' AND NOT ('ACTIVITY_VIEW'::"Permission" = ANY("permissions"));
