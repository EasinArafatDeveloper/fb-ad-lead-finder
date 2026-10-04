#!/bin/bash
set -a; . ~/server/databases/.env; set +a
docker exec -e MU="$MONGO_USER" -e MP="$MONGO_PASSWORD" mongodb sh -c 'mongosh --quiet -u "$MU" -p "$MP" --authenticationDatabase admin --eval "
  const d = db.getSiblingDB(\"fb_ad_leads\");
  print(\"--- page status\"); d.pages.aggregate([{\$group:{_id:\"\$scrapeStatus\",n:{\$sum:1}}}]).forEach(x=>print(x._id, x.n));
  print(\"--- read pages, time order\");
  d.pages.find({lastAttemptAt:{\$exists:true}},{pageName:1,lastAttemptAt:1,scrapeStatus:1,lastError:1,phones:1,emails:1,_id:0}).sort({lastAttemptAt:1}).forEach(p=>print(p.lastAttemptAt.toISOString().slice(11,19), p.scrapeStatus, (p.phones||[]).length+\"p\", (p.emails||[]).length+\"e\", p.pageName, p.lastError||\"\"));
  print(\"--- logs\"); d.logs.find().sort({ts:-1}).limit(10).forEach(l=>print(l.ts.toISOString().slice(11,19), l.level, l.msg));
  print(\"--- settings\"); printjson(d.settings.find().toArray());
"' </dev/null
