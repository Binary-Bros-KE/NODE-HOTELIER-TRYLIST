-- Earlier cancellation/void flows created OUT rows for POS and folio reversals.
-- The ledger now treats those events as void-only, so historical reversal rows
-- must be excluded from revenue, shift handovers and transaction summaries too.
UPDATE "Transaction"
SET "status" = 'VOIDED'
WHERE "direction" = 'OUT'
  AND "source" IN ('POS_SALE', 'FOLIO_DEPOSIT', 'FOLIO_SETTLEMENT')
  AND "status" = 'COMPLETE';
