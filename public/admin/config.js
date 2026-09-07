/* Erasezo Admin — YOUR OWN Supabase project. Completely separate from erasio.io.
 *
 * SECURITY NOTES:
 *  • SUPABASE_ANON_KEY (publishable key) is a PUBLIC key. Safe in client code
 *    ONLY because every table has Row Level Security (see admin/schema.sql).
 *  • NEVER put the service_role key or the database password / postgres
 *    connection string here or anywhere in the extension.
 *  • ADMIN_EMAILS is a UI convenience gate. The real gate is the is_admin() RLS
 *    policy in schema.sql — the `admins` table row must match this email.
 */
window.ERASIO_ADMIN_CONFIG = {
  SUPABASE_URL: "https://barabqcsskqacxgmelcb.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_-x3LCnZvc7SAxZuvqEgK7A_GxKo2LsD",
  ADMIN_EMAILS: ["thebloggersocean@gmail.com", "vthapan29@gmail.com"]
};
