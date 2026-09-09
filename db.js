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
-- Admin controls over an individual account.
alter table users add column if not exists disabled     boolean not null default false;
-- The spendable counter. credit_ledger stays the audit trail, but a balance
-- cannot be safely enforced by "read the sum, then insert": two concurrent
-- requests both read the same sum and both spend it. A guarded single-statement
-- UPDATE (see consumeCredits) can't interleave that way, and unlike a row lock
-- its correctness doesn't depend on the surrounding code getting a transaction
-- right. Backfilled from the ledger on boot.
alter table users add column if not exists credit_balance integer not null default 0;
-- Per-user override of the global DAILY_FREE allowance. NULL = use the default,
-- so raising the default still lifts everyone who was never given an override.
alter table users add column if not exists daily_quota  integer;
-- Suspension is deliberately NOT the same thing as disabling, or there would be
-- no reason for two controls: a disabled account cannot sign in at all, while a
-- suspended one can still sign in, see why, and manage its billing — it just
-- can't spend credits. That distinction is what lets you pause someone during
-- an investigation without locking them out of their own subscription.
alter table users add column if not exists suspended_until timestamptz;
alter table users add column if not exists suspend_reason  text;
-- Razorpay bookkeeping. provider is stored rather than assumed so a second
-- processor later doesn't require reinterpreting existing rows.
alter table subscriptions add column if not exists provider    text;
alter table subscriptions add column if not exists provider_customer_id text;
alter table subscriptions add column if not exists updated_at  timestamptz not null default now();
-- Webhook deliveries are retried by the provider, and a retried "payment
-- captured" must not grant the credits twice. Recording each event id makes
-- replay a no-op.
create table if not exists webhook_events (
  id           text primary key,
  provider     text not null,
  event        text,
  received_at  timestamptz not null default now()
);
create index if not exists credit_ledger_user_created on credit_ledger (user_id, created_at);
-- What each plan actually grants. Previously "pro" was just a string on the
-- subscription with nothing behind it, so no plan changed what a user could do.
-- daily_quota of -1 means unlimited.
create table if not exists plans (
  id               text primary key,
  name             text not null,
  daily_quota      integer not null,
  price_inr        integer not null default 0,
  razorpay_plan_id text,
  active           boolean not null default true,
  sort_order       integer not null default 0
);
-- Who changed what, and when. Append-only: there is no endpoint that updates or
-- deletes a row here, because a log an admin can edit is not evidence of
-- anything.
--
-- actor_email is stored alongside actor_id on purpose. An entry reading
-- "user 7 disabled an account" becomes useless the moment user 7 is renamed or
-- removed, which is exactly when you most want to read it. actor_id is
-- nullable so a FAILED sign-in — the entry that matters most when someone is
-- trying to get in — can still be recorded with no session behind it.
create table if not exists admin_audit (
  id          serial primary key,
  actor_id    integer,
  actor_email text,
  action      text not null,
  target_type text,
  target_id   text,
  detail      jsonb not null default '{}'::jsonb,
  ip          text,
  created_at  timestamptz not null default now()
);
create index if not exists admin_audit_created on admin_audit (created_at desc);
`;

// Seeded rather than hardcoded so the Control Room can edit them, but only when
// absent — this runs on every boot and must never overwrite edited pricing.
const DEFAULT_PLANS = [
  { id: "free", name: "Free", daily_quota: 15, price_inr: 0, sort_order: 0 },
  { id: "pro", name: "Pro", daily_quota: 500, price_inr: 499, sort_order: 1 },
  { id: "unlimited", name: "Unlimited", daily_quota: -1, price_inr: 1499, sort_order: 2 },
];

/* Brings users.credit_balance in line with the ledger. Runs on boot so the
 * column is correct for accounts that predate it, and so any drift between the
 * two is corrected rather than compounding. */
async function reconcileBalances() {
  const sums = (await getPool().query(
    "select user_id, sum(delta)::int s from credit_ledger group by user_id"
  )).rows;
  const byUser = new Map(sums.map((r) => [r.user_id, r.s]));
  const users = (await getPool().query("select id, credit_balance from users")).rows;
  let fixed = 0;
  for (const u of users) {
    const expected = byUser.get(u.id) || 0;
    if (u.credit_balance !== expected) {
      await getPool().query("update users set credit_balance=$1 where id=$2", [expected, u.id]);
      fixed++;
    }
  }
  if (fixed) console.log("[credits] reconciled balance for " + fixed + " account(s)");
}

async function init() {
  await getPool().query(SCHEMA);
  for (const p of DEFAULT_PLANS) {
    await getPool().query(
      `insert into plans (id, name, daily_quota, price_inr, sort_order) values ($1,$2,$3,$4,$5)
       on conflict (id) do nothing`,
      [p.id, p.name, p.daily_quota, p.price_inr, p.sort_order]
    );
  }
  await reconcileBalances();
}

function query(text, params) {
  return getPool().query(text, params);
}

module.exports = { getPool, init, query, reconcileBalances };
