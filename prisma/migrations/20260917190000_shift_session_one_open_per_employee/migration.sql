-- POST /shifts/start-request already checked for an existing open session
-- before creating one, but that check-then-create was two separate steps —
-- a slow connection causing a double-tap (or a client retry) could pass the
-- check twice before either INSERT commits, leaving an employee with two
-- open ShiftSession rows. A partial unique index makes this impossible at
-- the database level regardless of timing: at most one row per
-- (tenantId, employeeId) may be in an "open" status at a time. The second
-- concurrent INSERT now fails with a unique-violation instead, which the
-- route catches and reports as the same "already have an open shift" 409.
--
-- Not expressible in schema.prisma's own DSL (no partial/WHERE unique
-- index syntax) — this exists only here, applied via `prisma migrate
-- deploy` same as everything else; see the comment on ShiftSession itself.
CREATE UNIQUE INDEX "ShiftSession_one_open_per_employee"
  ON "ShiftSession" ("tenantId", "employeeId")
  WHERE status IN ('REQUESTED_START', 'ACTIVE', 'REQUESTED_END');
