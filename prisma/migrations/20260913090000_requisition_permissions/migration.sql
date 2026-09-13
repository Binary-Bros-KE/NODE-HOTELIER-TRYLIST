-- Two new capabilities so "who can raise a requisition" and "who can
-- approve it (and see/set cost)" stop being hardcoded role names.
ALTER TYPE "Permission" ADD VALUE 'REQUISITION_CREATE';
ALTER TYPE "Permission" ADD VALUE 'REQUISITION_APPROVE';
