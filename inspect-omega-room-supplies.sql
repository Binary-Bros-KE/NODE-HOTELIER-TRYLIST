\echo == locations
select l.name, l.type from "Location" l join "Tenant" t on t.id=l."tenantId" where t.slug='omega';
\echo == related products (name | unit | cost | perishable | shelfLifeDays | total stock)
select p.name, p.unit, p."unitCost", p."isPerishable", p."shelfLifeDays", coalesce((select sum(s.quantity) from "ProductStock" s where s."productId"=p.id),0) as stock
from "Product" p join "Tenant" t on t.id=p."tenantId"
where t.slug='omega' and p.name ~* '(soap|lotion|tissue|sugar|coffee|chocolate|mineral|serviette|tea |milo|honey cup|slipper|water)' order by 1;
\echo == counts
select (select count(*) from "Asset" a join "Tenant" t on t.id=a."tenantId" where t.slug='omega') assets,
       (select count(*) from "RoomConsumableStandard" a join "Tenant" t on t.id=a."tenantId" where t.slug='omega') standards;
\echo == units
select u.name, u."measurementKind" from "UnitOfMeasure" u join "Tenant" t on t.id=u."tenantId" where t.slug='omega' order by 1;
\echo == asset categories
select c.name from "Category" c join "Tenant" t on t.id=c."tenantId" where t.slug='omega' and c.scope='ASSETS';
