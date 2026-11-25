const fs = require("fs");
const p = "scratch-membership-location.cjs";
let t = fs.readFileSync(p, "utf8");
const before = 'appointments    Appointment[]\n  @@index([tenantId, customerId, status])"';
const after = 'appointments    Appointment[]\n\n  @@index([tenantId, customerId, status])"';
if (t.split(before).length !== 2) throw new Error("fixer anchor " + (t.split(before).length - 1));
fs.writeFileSync(p, t.replace(before, () => after));
console.log("fixed");
