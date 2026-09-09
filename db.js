/* Postgres access. Production/Railway: real `pg` Pool from DATABASE_URL.
 * Local dev/test: in-memory Postgres (pg-mem) when USE_PGMEM=1 — same SQL, no
 * server needed. */
"use strict";

let pool = null;

function makePool() {
  if (process.env.USE_PGMEM === "1") {
    const { newDb } = require("pg-mem");
    const mem = newDb();
    const pg = mem.adapters.createPg();
    return new pg.Pool();
  }
  const { Pool } = require("pg");
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    // Railway Postgres works without SSL on the internal network; set PGSSL=require
    // if connecting over the public proxy.
    ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : undefined,
  });
}

function getPool() {
  if (!pool) pool = makePool();
  return pool;
}

const SCHEMA = `
create table if not exists users (
  id            serial primary key,
  email         text unique not null,
  username      text,
  avatar_url    text,
  auth_provider text not null default 'password',
  password_hash text,
  google_id     text unique,
  referral_code text unique,
  referred_by   integer,
  is_admin      boolean not null default false,
  created_at    timestamptz not null default now()
);
create table if not exists credit_ledger (
  id         serial primary key,
  user_id    integer not null,
  delta      integer not null,
  reason     text not null,
  created_at timestamptz not null default now()
);
create table if not exists referrals (
  id                serial primary key,
  referrer_user_id  integer not null,
  referred_user_id  integer,
  status            text not null default 'pending',
  created_at        timestamptz not null default now()
);
create table if not exists subscriptions (
  user_id                  integer primary key,
  provider_subscription_id text,
  status                   text not null default 'none',
  plan                     text,
  current_period_end       timestamptz
);
-- Control Room settings, one row per admin. Replaces the Supabase table the
-- panel used to sync to; keeping it here means the panel has no second
-- database, and no second account, to go wrong.
create table if not exists admin_settings (
  user_id    integer primary key,
  settings   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
-- Added after the first deploy, so these must be ALTERs: "create table if not
-- exists" above silently skips an existing table and would leave them missing.
alter table users add column if not exists totp_secret  text;
alter table users add column if not exists totp_enabled boolean not null default false;
`;

async function init() {
  await getPool().query(SCHEMA);
}

function query(text, params) {
  return getPool().query(text, params);
}

module.exports = { getPool, init, query };
