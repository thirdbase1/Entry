const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });
(async () => {
  await client.connect();
  const res = await client.query(`
    SELECT id, source, message, "userId", "chatId", "createdAt"
    FROM "ErrorLog"
    WHERE "createdAt" > NOW() - INTERVAL '6 hours'
    ORDER BY "createdAt" DESC
    LIMIT 40;
  `);
  console.log(JSON.stringify(res.rows, null, 2));
  await client.end();
})().catch(e => { console.error(e); process.exit(1); });
