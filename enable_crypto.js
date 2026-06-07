import postgres from 'postgres';
import dotenv from 'dotenv';
dotenv.config();

const sql = postgres(process.env.DATABASE_URL);

async function enablePgcrypto() {
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;`;
    console.log('pgcrypto extension enabled successfully.');
  } catch (err) {
    console.error('Failed to enable pgcrypto:', err);
  } finally {
    process.exit(0);
  }
}

enablePgcrypto();
