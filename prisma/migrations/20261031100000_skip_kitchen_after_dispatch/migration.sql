-- Store-dispatch locations can skip the kitchen: a dispatched order goes straight to READY.
ALTER TABLE "Location" ADD COLUMN "skipKitchenAfterDispatch" BOOLEAN NOT NULL DEFAULT false;
