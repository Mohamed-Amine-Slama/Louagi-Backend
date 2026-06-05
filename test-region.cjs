const postgres = require('postgres');
const regions = ["us-east-1","us-east-2","us-west-1","us-west-2","eu-central-1","eu-west-1","eu-west-2","eu-west-3","ap-northeast-1","ap-northeast-2","ap-south-1","ap-southeast-1","ap-southeast-2","ca-central-1","sa-east-1"];

async function main() {
  for (const r of regions) {
    console.log(`Testing ${r}`);
    const sql = postgres(`postgresql://postgres.rxpbfcolqtocfyhtsnqp:Ld%402026%40@aws-0-${r}.pooler.supabase.com:5432/postgres`, {
      max: 1,
      connect_timeout: 4,
      idle_timeout: 1
    });

    try {
      await sql`select 1`;
      console.log(`SUCCESS: ${r}`);
      process.exit(0);
    } catch (e) {
      console.log(`Fail: ${e.code || e.message}`);
    }
  }
}
main();