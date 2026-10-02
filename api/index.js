// Ledgerline API — rebuilt from frontend contract + DB forensics (2026-10-01)
// Node 24 runtime, zero deps.
// DB: Neon Postgres via HTTP SQL API. Files: inline base64 in records (frontend supports {data,mime,filename}).
// Auth: settings t:<tenantId>:auth {salt,hash}; hash = crypto.scryptSync(pw, salt, 32).hex()
// Cookie: ll=<ts>.<tenantId>.o.owner.<sig>; sig = HMAC-SHA256(t:<tenantId>:secret, "ts.tenantId.o.owner")

const crypto = require("crypto");

/* ---------------- demo-tenant guard (production defense-in-depth) ----------------
   The demo tenant (marked t:<id>:demo) is publicly logged into. These guards make sure
   nothing on it can reach real Stripe / Twilio / Resend. The dedicated sandboxed demo
   lives at ledgerline-demo-chi.vercel.app (DEMO_MODE build). */
const DEMO_TENANT = "e1360f77-d688-4e73-bcde-5fbf680117d8";
const isDemoTenant = tid => tid === DEMO_TENANT;

/* ---------------- Neon HTTP SQL ---------------- */
function neonHost() {
  const u = new URL(process.env.DATABASE_URL);
  return u.hostname;
}
async function sql(query, params) {
  const res = await fetch(`https://${neonHost()}/sql`, {
    method: "POST",
    headers: { "Neon-Connection-String": process.env.DATABASE_URL, "Content-Type": "application/json" },
    body: JSON.stringify(params && params.length ? { query, params } : { query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error("db: " + text.slice(0, 300));
  const data = JSON.parse(text);
  return data.rows || [];
}
async function getSetting(k) {
  const rows = await sql("SELECT v FROM settings WHERE k=$1 LIMIT 1", [k]);
  return rows.length ? rows[0].v : null;
}
async function setSetting(k, v) {
  await sql("INSERT INTO settings (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v", [k, v]);
}
async function delSetting(k) { await sql("DELETE FROM settings WHERE k=$1", [k]); }

/* ---------------- records ---------------- */
const uid = () => crypto.randomUUID();
async function getRecord(kind, id) {
  const rows = await sql("SELECT id, data FROM records WHERE kind=$1 AND id=$2 LIMIT 1", [kind, id]);
  return rows.length ? withId(rows[0]) : null;
}
async function listRecords(kind, tenantId) {
  return sql("SELECT id, data FROM records WHERE kind=$1 AND data->>'tenantId'=$2", [kind, tenantId]);
}

// Some forms let a new customer be typed in on the fly ("add a job while on the
// phone"). Estimates handled that; jobs and invoices answered "Pick a customer."
// and silently dropped the booking. Create the customer, then link it.
async function inlineCustomer(tenantId, c, now) {
  if (!c) return null;
  const name = String(c.name || "").trim();
  const phone = String(c.phone || "").trim();
  const email = String(c.email || "").trim();
  if (!name && !phone && !email) return null;
  const id = uid();
  await putRecord("customer", id, {
    tenantId,
    name: name || phone || email,
    phone,
    email,
    address: "",
    createdAt: now,
    portalToken: crypto.randomBytes(12).toString("hex"),
  });
  return id;
}

async function putRecord(kind, id, data) {
  const j = JSON.stringify(data);
  const upd = await sql("UPDATE records SET data=$3 WHERE kind=$1 AND id=$2 RETURNING id", [kind, id, j]);
  if (upd.length === 0) await sql("INSERT INTO records (id,kind,data) VALUES ($1,$2,$3)", [id, kind, j]);
}
async function delRecord(kind, id) {
  await sql("DELETE FROM records WHERE kind=$1 AND id=$2", [kind, id]);
}
const withId = row => Object.assign({}, row.data, { id: row.id });

/* ---------------- auth ---------------- */
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString("hex");
}
function sign(tenantId, ts, role, secret) {
  return crypto.createHmac("sha256", secret).update(`${ts}.${tenantId}.o.${role}`).digest("hex");
}
async function tenantSecret(tenantId) {
  return (await getSetting(`t:${tenantId}:secret`)) || crypto.randomBytes(24).toString("hex");
}
async function readAuth(req) {
  const cookies = (req.headers.cookie || "").split(/;\s*/);
  const ll = cookies.find(c => c.startsWith("ll="));
  if (!ll) return null;
  const parts = decodeURIComponent(ll.slice(3)).split(".");
  if (parts.length !== 5) return null;
  const [ts, tenantId, umark, role, sig] = parts;
  const secret = await getSetting(`t:${tenantId}:secret`);
  if (!secret) return null;
  if (sign(tenantId, ts, role, secret) !== sig) return null;
  if (Date.now() - Number(ts) > 30 * 24 * 3600 * 1000) return null;
  return { tenantId, role };
}
async function tenants() {
  const v = await getSetting("tenants");
  const list = v ? JSON.parse(v) : [];
  return Array.isArray(list) ? list : [];
}
async function tenantBusiness(tenantId) {
  const v = await getSetting(`t:${tenantId}:business`);
  return v ? JSON.parse(v) : {};
}

/* ---------------- helpers ---------------- */
function json(res, code, obj, headers) {
  const h = Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, headers || {});
  res.statusCode = code;
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}
const err = (res, code, msg, extra) => json(res, code, Object.assign({ error: msg }, extra || {}));
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > 12_000_000) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}
function csvEscape(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csv(rows, cols) {
  return "\ufeff" + cols.map(csvEscape).join(",") + "\n" + rows.map(r => cols.map(c => csvEscape(r[c])).join(",")).join("\n");
}
const ENTITLEMENTS = plan => ({
  cardPayments: plan === "good" || plan === "better" || plan === "best",
  emailReminders: plan === "good" || plan === "better" || plan === "best",
  smsReminders: plan === "best",
  reviewRequests: plan === "good" || plan === "better" || plan === "best",
  proofline: plan === "better" || plan === "best",
  reviewline: plan === "best",
  portal: plan === "better" || plan === "best",
  api: plan !== "good" && plan !== "free",
  reports: plan === "better" || plan === "best",
});
async function tenantEntitlements(tenantId) {
  const v = await getSetting(`t:${tenantId}:billing`);
  const billing = v ? JSON.parse(v) : (isDemoTenant(tenantId) ? { plan: "best" } : { plan: "free" });
  return ENTITLEMENTS(billing.plan);
}

/* ---------------- inspection reports ---------------- */
const Q_TYPES = ["yesno", "text", "number", "photo", "select"];
const OUTCOMES = ["pass", "attention", "fail"];
const clip = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
function cleanQuestions(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 150).map((q, i) => {
    const type = Q_TYPES.includes(q && q.type) ? q.type : "text";
    const out = { id: clip(q && q.id, 40) || "q" + (i + 1), label: clip(q && q.label, 300), type, required: !!(q && q.required) };
    if (type === "select") out.options = (Array.isArray(q.options) ? q.options : []).map(o => clip(o, 120)).filter(Boolean).slice(0, 30);
    if (type === "yesno") { out.rate = !!q.rate; out.good = q.good === "no" ? "no" : "yes"; }
    if (q && q.hint) out.hint = clip(q.hint, 300);
    return out;
  }).filter(q => q.label);
}
function cleanAnswers(questions, raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const q of questions) {
    const a = src[q.id];
    if (!a || typeof a !== "object") continue;
    const v = {};
    if (q.type === "yesno" && (a.value === "yes" || a.value === "no")) v.value = a.value;
    if (q.type === "text" && a.value != null) v.value = clip(a.value, 4000);
    if (q.type === "number" && a.value !== "" && a.value != null && isFinite(Number(a.value))) v.value = Number(a.value);
    if (q.type === "select" && a.value != null && (q.options || []).includes(String(a.value))) v.value = String(a.value);
    if (q.type === "photo" && Array.isArray(a.photos)) v.photos = a.photos.slice(0, 12).map(p => ({ fileId: clip(p && p.fileId, 60), filename: clip(p && p.filename, 200) })).filter(p => p.fileId || p.filename);
    if (q.type === "yesno" && OUTCOMES.includes(a.outcome)) v.outcome = a.outcome;
    if (a.note) v.note = clip(a.note, 1000);
    if (Object.keys(v).length) out[q.id] = v;
  }
  return out;
}
function reportSummary(answers) {
  const s = { pass: 0, attention: 0, fail: 0 };
  for (const a of Object.values(answers || {})) if (a && OUTCOMES.includes(a.outcome)) s[a.outcome]++;
  return s;
}
async function sendEmail(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.RESEND_FROM || "Ledgerline <onboarding@resend.dev>", to: [to], subject, html }),
    });
    return r.ok;
  } catch (e) { return false; }
}
async function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM;
  if (!sid || !tok || !from || !to) return false;
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from(sid + ":" + tok).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: from, To: to, Body: body }).toString(),
    });
    return r.ok;
  } catch (e) { return false; }
}
function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "app.leonlink.net";
  return `${proto}://${host}`;
}

/* ---------------- main handler ---------------- */
module.exports = async (req, res) => {
  const url = new URL(req.url, "http://x");
  const a = url.searchParams.get("a") || "";
  const kind = url.searchParams.get("kind") || "";
  const id = url.searchParams.get("id") || "";
  const t = url.searchParams.get("t") || "";
  let body = {};
  if (req.method === "POST") {
    try { body = await readBody(req); } catch (e) { return err(res, 400, e.message === "too large" ? "File too large (3MB max)." : "Bad request."); }
  }

  try {
    switch (a) {

      /* ---------- public ---------- */
      case "needs-setup": {
        const list = await tenants();
        return json(res, 200, { needsSetup: list.length === 0 });
      }

      case "login": {
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");
        if (!email || !password) return err(res, 400, "Enter your email and password.");
        let match = null;
        for (const tid of await tenants()) {
          const biz = await tenantBusiness(tid);
          if ((biz.email || "").trim().toLowerCase() === email) { match = tid; break; }
        }
        if (!match) return err(res, 401, "Wrong email or password");
        const authV = await getSetting(`t:${match}:auth`);
        if (!authV) return err(res, 401, "Wrong email or password");
        const { salt, hash } = JSON.parse(authV);
        if (hashPassword(password, salt) !== hash) return err(res, 401, "Wrong email or password");
        const ts = String(Date.now());
        const secret = await tenantSecret(match);
        const sig = sign(match, ts, "owner", secret);
        const cookie = `ll=${encodeURIComponent(`${ts}.${match}.o.owner.${sig}`)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
        return json(res, 200, { ok: true, tenantId: match, demo: email === "demo@ledgerline.app" }, { "Set-Cookie": cookie });
      }

      case "logout": {
        return json(res, 200, { ok: true }, { "Set-Cookie": "ll=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0" });
      }

      case "ensure-demo": {
        // Reset the designated demo workspace's password to 'demo' (matches old behavior)
        const list = await tenants();
        let target = null;
        for (const tid of list) {
          const biz = await tenantBusiness(tid);
          if ((biz.email || "").trim().toLowerCase() === "demo@ledgerline.app") { target = tid; break; }
        }
        if (!target && list.length) target = list[list.length - 1];
        if (!target) return err(res, 500, "No workspace to seed.");
        const salt = crypto.randomBytes(16).toString("hex");
        await setSetting(`t:${target}:auth`, JSON.stringify({ salt, hash: hashPassword("demo", salt) }));
        const biz = await tenantBusiness(target);
        if (!biz.email) { biz.email = "demo@ledgerline.app"; await setSetting(`t:${target}:business`, JSON.stringify(biz)); }
        return json(res, 200, { ok: true, tenantId: target, email: biz.email || "demo@ledgerline.app", password: "demo" });
      }

      case "signup": {
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");
        const businessName = String(body.businessName || "").trim() || "My business";
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(res, 400, "Enter a valid email.");
        if (password.length < 6) return err(res, 400, "Password must be at least 6 characters.");
        const list = await tenants();
        for (const tid of list) {
          const biz = await tenantBusiness(tid);
          if ((biz.email || "").trim().toLowerCase() === email) return err(res, 400, "That email already has an account.");
        }
        const tid = uid();
        const salt = crypto.randomBytes(16).toString("hex");
        await setSetting(`t:${tid}:auth`, JSON.stringify({ salt, hash: hashPassword(password, salt) }));
        await setSetting(`t:${tid}:secret`, crypto.randomBytes(24).toString("hex"));
        await setSetting(`t:${tid}:business`, JSON.stringify({ name: businessName, email, phone: "", address: "" }));
        await setSetting(`t:${tid}:billing`, JSON.stringify({ status: "free", plan: "free" }));
        await setSetting(`t:${tid}:users`, "[]");
        await setSetting(`t:${tid}:docstyle`, JSON.stringify({ template: "classic", accent: "" }));
        await setSetting(`t:${tid}:reminders`, JSON.stringify({ email24h: true, email2h: false, sms24h: false, sms2h: false }));
        await setSetting(`t:${tid}:reviews`, JSON.stringify({ link: "" }));
        list.push(tid);
        await setSetting("tenants", JSON.stringify(list));
        const ts = String(Date.now());
        const secret = await tenantSecret(tid);
        const sig = sign(tid, ts, "owner", secret);
        const cookie = `ll=${encodeURIComponent(`${ts}.${tid}.o.owner.${sig}`)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
        return json(res, 200, { ok: true, tenantId: tid }, { "Set-Cookie": cookie });
      }

      case "admin": {
        const sec = req.headers["x-cron-secret"] || "";
        if (!process.env.CRON_SECRET || sec !== process.env.CRON_SECRET) return err(res, 403, "Forbidden");
        const act = url.searchParams.get("action") || "list";
        if (act === "list") {
          const out = [];
          for (const tid of await tenants()) {
            const biz = await tenantBusiness(tid);
            out.push({ tenant: tid, name: biz.name || "", email: biz.email || "", hasLogin: !!(await getSetting(`t:${tid}:auth`)), demo: isDemoTenant(tid) });
          }
          return json(res, 200, { count: out.length, tenants: out });
        }
        if (act === "set-email") {
          const tid = String(url.searchParams.get("tenant") || "");
          const em = String(url.searchParams.get("email") || "").trim().toLowerCase();
          if (!tid || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return err(res, 400, "Need tenant and a valid email.");
          const biz = await tenantBusiness(tid);
          biz.email = em;
          await setSetting(`t:${tid}:business`, JSON.stringify(biz));
          return json(res, 200, { ok: true, tenant: tid, email: em });
        }
        if (act === "set-password") {
          const tid = String(url.searchParams.get("tenant") || "");
          const pw = String(url.searchParams.get("password") || "");
          if (!tid || pw.length < 6) return err(res, 400, "Need tenant and a 6+ character password.");
          const salt = crypto.randomBytes(16).toString("hex");
          await setSetting(`t:${tid}:auth`, JSON.stringify({ salt, hash: hashPassword(pw, salt) }));
          return json(res, 200, { ok: true, tenant: tid });
        }
        return err(res, 400, "Unknown admin action.");
      }
      case "request-reset": {
        const email = String(body.email || "").trim().toLowerCase();
        for (const tid of await tenants()) {
          const biz = await tenantBusiness(tid);
          if ((biz.email || "").trim().toLowerCase() !== email) continue;
          if (isDemoTenant(tid)) return err(res, 400, "This is the demo. The password is just 'demo'.");
          const secret = await tenantSecret(tid);
          const exp = Date.now() + 2 * 3600 * 1000;
          const token = crypto.createHmac("sha256", secret).update(`reset.${tid}.${exp}`).digest("hex");
          const link = `${baseUrl(req)}/login?reset=1&t=${exp}.${token}`;
          const sent = await sendEmail(email, "Reset your Ledgerline password", `<p>Reset your password:</p><p><a href="${link}">${link}</a></p><p>Link expires in 2 hours.</p>`);
          if (sent) return json(res, 200, { ok: true });
          return err(res, 500, "Email is not connected yet. Contact support.", { contact: { name: "Ledgerline", email: "info@leonlink.net" } });
        }
        return json(res, 200, { ok: true });
      }

      case "reset-password": {
        const raw = String(body.token || "");
        const password = String(body.password || "");
        if (password.length < 6) return err(res, 400, "Password must be at least 6 characters.");
        const [expStr, token] = raw.split(".");
        const exp = Number(expStr);
        if (!exp || exp < Date.now()) return err(res, 400, "That reset link expired. Request a new one.");
        for (const tid of await tenants()) {
          const secret = await tenantSecret(tid);
          const expect = crypto.createHmac("sha256", secret).update(`reset.${tid}.${exp}`).digest("hex");
          if (expect !== token) continue;
          const authV = await getSetting(`t:${tid}:auth`);
          const auth = authV ? JSON.parse(authV) : { salt: crypto.randomBytes(16).toString("hex") };
          auth.hash = hashPassword(password, auth.salt);
          await setSetting(`t:${tid}:auth`, JSON.stringify(auth));
          const ts = String(Date.now());
          const sig = sign(tid, ts, "owner", secret);
          return json(res, 200, { ok: true }, { "Set-Cookie": `ll=${encodeURIComponent(`${ts}.${tid}.o.owner.${sig}`)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000` });
        }
        return err(res, 400, "That reset link is invalid.");
      }

      /* ---------- customer portal (token) ---------- */
      case "portal": {
        if (!t) return err(res, 401, "Link missing. Ask us to resend your portal link.");
        const rows = await sql("SELECT id, data FROM records WHERE kind='customer' AND data->>'portalToken'=$1 LIMIT 1", [t]);
        if (!rows.length) return err(res, 404, "This portal link is no longer valid.", { contact: {} });
        const customer = withId(rows[0]);
        const tenantId = customer.tenantId;
        const [estimates, invoices, jobs, files, messages, business] = await Promise.all([
          listRecords("estimate", tenantId), listRecords("invoice", tenantId), listRecords("job", tenantId),
          listRecords("file", tenantId), listRecords("message", tenantId), tenantBusiness(tenantId),
        ]);
        const cid = customer.id;
        return json(res, 200, {
          customer: { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone },
          business,
          estimates: estimates.map(withId).filter(x => x.customerId === cid),
          invoices: invoices.map(withId).filter(x => x.customerId === cid),
          jobs: jobs.map(withId).filter(x => x.customerId === cid).sort((a, b) => String(a.date || "").localeCompare(String(b.date || ""))),
          files: files.filter(r => r.data.customerId === cid).map(r => { const d = r.data; return { id: r.id, filename: d.filename, mime: d.mime, category: d.category, size: d.size, createdAt: d.createdAt }; }).filter(f => f.category === "photo" || f.category === "document"),
          messages: messages.map(withId).filter(x => x.customerId === cid).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)),
        });
      }

      case "pay-invoice": {
        // owner (cookie) or portal (token)
        let invoiceId = body.invoiceId, tenantId = null, after = "";
        if (body.token) {
          const rows = await sql("SELECT id, data FROM records WHERE kind='customer' AND data->>'portalToken'=$1 LIMIT 1", [String(body.token)]);
          if (!rows.length) return err(res, 401, "Invalid link.");
          tenantId = withId(rows[0]).tenantId;
          after = `portal?t=${encodeURIComponent(String(body.token))}&session_id={CHECKOUT_SESSION_ID}`;
        } else {
          const auth = await readAuth(req);
          if (!auth) return err(res, 401, "Please log in");
          tenantId = auth.tenantId;
          after = `invoices?paid=1&session_id={CHECKOUT_SESSION_ID}`;
        }
        const inv = await getRecord("invoice", invoiceId);
        if (!inv || inv.tenantId !== tenantId) return err(res, 404, "Invoice not found.");
        if (inv.status === "paid") return err(res, 400, "Already paid.");
        if (isDemoTenant(tenantId)) {
          const dinv = await getRecord("invoice", invoiceId);
          if (dinv && dinv.tenantId === tenantId && dinv.status !== "paid") {
            dinv.status = "paid"; dinv.paidAt = Date.now(); dinv.paidMethod = "card";
            await putRecord("invoice", dinv.id, dinv);
          }
          const origin2 = baseUrl(req);
          const after2 = body.token ? `portal?t=${encodeURIComponent(String(body.token))}` : "invoices?paid=1";
          return json(res, 200, { url: `${origin2}/${after2}`, demo: true });
        }
        const sk = process.env.STRIPE_SECRET_KEY;
        if (!sk) return err(res, 500, "Card payments are not connected yet. Ask us for other ways to pay.", { contact: await tenantBusiness(tenantId) });
        const origin = baseUrl(req);
        const form = new URLSearchParams({
          mode: "payment",
          "line_items[0][price_data][currency]": "usd",
          "line_items[0][price_data][unit_amount]": String(Math.round(Number(inv.total) * 100)),
          "line_items[0][price_data][product_data][name]": inv.title || "Invoice",
          "line_items[0][quantity]": "1",
          success_url: `${origin}/${after}`,
          cancel_url: `${origin}/${after.replace("session_id={CHECKOUT_SESSION_ID}", "canceled=1")}`,
          "metadata[invoiceId]": invoiceId,
          "metadata[tenantId]": tenantId,
          "metadata[plan]": String(body.plan || ""),
          "metadata[period]": prepaid ? "6mo" : "month",
          "subscription_data[metadata][tenantId]": tenantId,
        });
        const r = await fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { Authorization: "Bearer " + sk, "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
        const d = await r.json();
        if (!r.ok) return err(res, 500, "Payment provider error. Try again shortly.");
        return json(res, 200, { url: d.url });
      }

      case "stripe-confirm": {
        const sk = process.env.STRIPE_SECRET_KEY;
        if (!sk) return err(res, 500, "Payments not configured.");
        const r = await fetch("https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(String(body.session_id || "")), { headers: { Authorization: "Bearer " + sk } });
        if (!r.ok) return err(res, 400, "Could not verify that payment.");
        const d = await r.json();
        if (d.payment_status !== "paid") return err(res, 400, "Payment not completed.");
        const invoiceId = d.metadata && d.metadata.invoiceId;
        if (invoiceId) {
          const inv = await getRecord("invoice", invoiceId);
          if (inv && inv.status !== "paid") {
            inv.status = "paid"; inv.paidAt = Date.now(); inv.paidMethod = "card";
            await putRecord("invoice", invoiceId, inv);
          }
        }
        const md = d.metadata || {};
        if (md.tenantId && md.plan) {
          const tid = String(md.tenantId);
          const cur = await getSetting(`t:${tid}:billing`);
          const prev = cur ? JSON.parse(cur) : {};
          await setSetting(`t:${tid}:billing`, JSON.stringify({
            ...prev, status: "active", plan: String(md.plan), period: String(md.period || "month"),
            stripeCustomerId: d.customer || prev.stripeCustomerId || "",
            subscriptionId: d.subscription || prev.subscriptionId || "",
            startedAt: prev.startedAt || Date.now(),
          }));
        }
        return json(res, 200, { ok: true });
      }

      case "respond": {
        if (!body.token) return err(res, 401, "Invalid link.");
        const rows = await sql("SELECT id, data FROM records WHERE kind='customer' AND data->>'portalToken'=$1 LIMIT 1", [String(body.token)]);
        if (!rows.length) return err(res, 401, "Invalid link.");
        const customer = withId(rows[0]);
        const est = await getRecord("estimate", String(body.estimateId || ""));
        if (!est || est.customerId !== customer.id) return err(res, 404, "Estimate not found.");
        const action = String(body.action || "");
        if (action === "accept") {
          est.status = "accepted";
          await putRecord("estimate", est.id, est);
          await putRecord("request", uid(), {
            tenantId: est.tenantId, customerId: est.customerId, estimateId: est.id,
            note: "Customer accepted estimate — pick a date", status: "pending", createdAt: Date.now(),
          });
        } else if (action === "decline") {
          est.status = "declined";
          await putRecord("estimate", est.id, est);
        }
        return json(res, 200, { ok: true });
      }

      case "message": {
        if (body.token) {
          const rows = await sql("SELECT id, data FROM records WHERE kind='customer' AND data->>'portalToken'=$1 LIMIT 1", [String(body.token)]);
          if (!rows.length) return err(res, 401, "Invalid link.");
          const customer = withId(rows[0]);
          const text = String(body.text || "").trim();
          if (!text) return err(res, 400, "Message is empty.");
          await putRecord("message", uid(), { tenantId: customer.tenantId, customerId: customer.id, from: "customer", text, createdAt: Date.now() });
          return json(res, 200, { ok: true });
        }
        const auth = await readAuth(req);
        if (!auth) return err(res, 401, "Please log in");
        const customerId = String(body.customerId || "");
        const cust = await getRecord("customer", customerId);
        if (!cust || cust.tenantId !== auth.tenantId) return err(res, 404, "Customer not found.");
        const text = String(body.text || "").trim();
        if (!text) return err(res, 400, "Message is empty.");
        await putRecord("message", uid(), { tenantId: auth.tenantId, customerId, from: "office", text, createdAt: Date.now() });
        return json(res, 200, { ok: true });
      }

      case "upload": {
        let tenantId, customerId, filename, mime, data, category;
        if (body.token) {
          const rows = await sql("SELECT id, data FROM records WHERE kind='customer' AND data->>'portalToken'=$1 LIMIT 1", [String(body.token)]);
          if (!rows.length) return err(res, 401, "Invalid link.");
          const customer = withId(rows[0]);
          tenantId = customer.tenantId; customerId = customer.id;
          filename = body.filename; mime = body.mime; data = body.data; category = body.category || "photo";
        } else {
          const auth = await readAuth(req);
          if (!auth) return err(res, 401, "Please log in");
          tenantId = auth.tenantId; customerId = String(body.customerId || "");
          const cust = await getRecord("customer", customerId);
          if (!cust || cust.tenantId !== tenantId) return err(res, 404, "Customer not found.");
          filename = body.filename; mime = body.mime; data = body.data; category = body.category || "document";
        }
        if (!data || typeof data !== "string") return err(res, 400, "No file data.");
        const size = Math.floor(data.length * 0.75);
        if (size > 10_000_000) return err(res, 400, "That file is larger than 3MB.");
        const fileId = uid();
        await putRecord("file", fileId, { tenantId, customerId, filename: String(filename || "file"), mime: String(mime || "application/octet-stream"), category, size, data, createdAt: Date.now() });
        return json(res, 200, { ok: true, id: fileId });
      }

      case "file": {
        let allowed = false, tenantId = null;
        if (t) {
          const rows = await sql("SELECT id, data FROM records WHERE kind='customer' AND data->>'portalToken'=$1 LIMIT 1", [t]);
          if (rows.length) { tenantId = withId(rows[0]).tenantId; allowed = true; }
        }
        if (!allowed) {
          const auth = await readAuth(req);
          if (!auth) return err(res, 401, "Please log in");
          tenantId = auth.tenantId; allowed = true;
        }
        const rec = await getRecord("file", id);
        if (!rec || rec.tenantId !== tenantId) return err(res, 404, "File not found.");
        return json(res, 200, { data: rec.data, mime: rec.mime, filename: rec.filename });
      }

      /* ---------- owner (cookie required) ---------- */
      default: {
        const auth = await readAuth(req);
        if (!auth && !["state"].includes(a)) return err(res, 401, "Please log in");
        const tenantId = auth ? auth.tenantId : null;

        switch (a) {
          case "state": {
            if (!auth) return err(res, 401, "Please log in");
            const [businessV, billingV, docstyleV, remindersV, reviewsV] = await Promise.all([
              getSetting(`t:${tenantId}:business`), getSetting(`t:${tenantId}:billing`), getSetting(`t:${tenantId}:docstyle`), getSetting(`t:${tenantId}:reminders`), getSetting(`t:${tenantId}:reviews`),
            ]);
            const business = businessV ? JSON.parse(businessV) : {};
            const billing = billingV ? JSON.parse(billingV) : (isDemoTenant(tenantId) ? { status: "active", plan: "best" } : { status: "free", plan: "free" });
            billing.entitlements = ENTITLEMENTS(billing.plan);
            const [customers, jobs, estimates, invoices, requests, reports, templates] = await Promise.all([
              listRecords("customer", tenantId), listRecords("job", tenantId), listRecords("estimate", tenantId), listRecords("invoice", tenantId), listRecords("request", tenantId),
              listRecords("report", tenantId), listRecords("template", tenantId),
            ]);
            const fileRows = await sql("SELECT data FROM records WHERE kind='file' AND data->>'tenantId'=$1", [tenantId]);
            const used = fileRows.reduce((s, r) => s + (r.data.size || 0), 0);
            return json(res, 200, {
              business, role: auth.role || "owner", billing,
              docstyle: docstyleV ? JSON.parse(docstyleV) : { template: "classic", accent: "" },
              reminders: remindersV ? JSON.parse(remindersV) : {},
              reviews: reviewsV ? JSON.parse(reviewsV) : {},
              customers: customers.map(withId).sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))),
              jobs: jobs.map(withId).sort((a, b) => String(a.date || "").localeCompare(String(b.date || ""))),
              estimates: estimates.map(withId),
              invoices: invoices.map(withId),
              requests: requests.map(withId),
              reports: reports.map(withId).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
              templates: templates.map(withId).sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))),
              storage: { used, limit: 1_000_000_000 },
              mail: !!process.env.RESEND_API_KEY,
              sms: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM),
              stripe: { configured: !!process.env.STRIPE_SECRET_KEY },
            });
          }

          case "save": {
            const b = body || {};
            const now = Date.now();
            if (kind === "customer") {
              const cust = b.id ? (await getRecord("customer", b.id) || { tenantId }) : { tenantId, createdAt: now, portalToken: crypto.randomBytes(12).toString("hex") };
              if (cust.tenantId !== tenantId) return err(res, 404, "Customer not found.");
              Object.assign(cust, { name: String(b.name || "").trim(), phone: String(b.phone || "").trim(), email: String(b.email || "").trim(), address: String(b.address || "").trim() });
              if (!cust.name) return err(res, 400, "Customer needs a name.");
              await putRecord("customer", b.id || uid(), cust);
              return json(res, 200, { ok: true });
            }
            if (kind === "note") {
              const cust = await getRecord("customer", String(b.customerId || ""));
              if (!cust || cust.tenantId !== tenantId) return err(res, 404, "Customer not found.");
              const text = String(b.text || "").trim();
              if (!text) return err(res, 400, "Note is empty.");
              await putRecord("note", uid(), { tenantId, customerId: cust.id, text, createdAt: now });
              return json(res, 200, { ok: true });
            }
            if (kind === "estimate") {
              let customerId = b.customerId ? String(b.customerId) : null;
              if (!customerId && b.customer && b.customer.name) {
                customerId = uid();
                await putRecord("customer", customerId, {
                  tenantId, name: String(b.customer.name).trim(), phone: String(b.customer.phone || "").trim(),
                  email: String(b.customer.email || "").trim(), address: "", createdAt: now,
                  portalToken: crypto.randomBytes(12).toString("hex"),
                });
              }
              if (!customerId) return err(res, 400, "Pick a customer.");
              const est = b.id ? (await getRecord("estimate", b.id) || { tenantId, createdAt: now }) : { tenantId, createdAt: now };
              if (est.tenantId !== tenantId) return err(res, 404, "Estimate not found.");
              Object.assign(est, {
                customerId, title: String(b.title || "Estimate"), items: Array.isArray(b.items) ? b.items : [],
                tax: b.tax != null ? Number(b.tax) : est.tax, total: b.total != null ? Number(b.total) : est.total,
              });
              if (!est.total) est.total = (est.items || []).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0) + (Number(est.tax) || 0);
              if (b.status) est.status = String(b.status);
              if (!est.status) est.status = "draft";
              await putRecord("estimate", b.id || uid(), est);
              return json(res, 200, { ok: true });
            }
            if (kind === "job") {
              const j = b.id ? (await getRecord("job", b.id) || { tenantId, createdAt: now }) : { tenantId, createdAt: now };
              if (j.tenantId !== tenantId) return err(res, 404, "Job not found.");
              for (const f of ["customerId", "date", "time", "type", "title", "notes", "status", "recur", "estimateId", "price"]) {
                if (b[f] !== undefined) j[f] = b[f];
              }
              if (!j.customerId) j.customerId = await inlineCustomer(tenantId, b.customer, now);
              if (!j.customerId) return err(res, 400, "Pick a customer.");
              if (!j.status) j.status = "scheduled";
              await putRecord("job", b.id || uid(), j);
              return json(res, 200, { ok: true });
            }
            if (kind === "invoice") {
              const inv = b.id ? (await getRecord("invoice", b.id) || { tenantId, createdAt: now }) : { tenantId, createdAt: now };
              if (inv.tenantId !== tenantId) return err(res, 404, "Invoice not found.");
              for (const f of ["customerId", "title", "total", "status", "due", "items", "notes", "estimateId", "jobId", "paidAt", "paidMethod"]) {
                if (b[f] !== undefined) inv[f] = b[f];
              }
              if (!inv.customerId) inv.customerId = await inlineCustomer(tenantId, b.customer, now);
              if (!inv.customerId) return err(res, 400, "Pick a customer.");
              if (!inv.status) inv.status = "unpaid";
              await putRecord("invoice", b.id || uid(), inv);
              return json(res, 200, { ok: true });
            }
            if (kind === "template") {
              if (!(await tenantEntitlements(tenantId)).reports) return err(res, 403, "Inspection reports are on the Growth plan.");
              const tpl = b.id ? (await getRecord("template", b.id) || { tenantId, createdAt: now }) : { tenantId, createdAt: now };
              if (tpl.tenantId !== tenantId) return err(res, 404, "Template not found.");
              tpl.name = clip(b.name, 120);
              if (!tpl.name) return err(res, 400, "Give the template a name.");
              tpl.questions = cleanQuestions(b.questions);
              if (!tpl.questions.length) return err(res, 400, "Add at least one question.");
              if (tpl.questions.some(q => q.type === "select" && !q.options.length)) return err(res, 400, "Pick lists need at least one option.");
              tpl.updatedAt = now;
              const tplId = b.id || uid();
              await putRecord("template", tplId, tpl);
              return json(res, 200, { ok: true, id: tplId });
            }
            if (kind === "report") {
              if (!(await tenantEntitlements(tenantId)).reports) return err(res, 403, "Inspection reports are on the Growth plan.");
              const rep = b.id ? (await getRecord("report", b.id) || { tenantId, createdAt: now }) : { tenantId, createdAt: now };
              if (rep.tenantId !== tenantId) return err(res, 404, "Report not found.");
              let customerId = b.customerId ? String(b.customerId) : (rep.customerId || null);
              if (customerId) {
                const cust = await getRecord("customer", customerId);
                if (!cust || cust.tenantId !== tenantId) return err(res, 404, "Customer not found.");
              } else customerId = await inlineCustomer(tenantId, b.customer, now);
              if (!customerId) return err(res, 400, "Pick a customer.");
              let jobId = b.jobId !== undefined ? (b.jobId ? String(b.jobId) : "") : (rep.jobId || "");
              if (jobId) {
                const job = await getRecord("job", jobId);
                if (!job || job.tenantId !== tenantId) return err(res, 404, "Job not found.");
              }
              const questions = cleanQuestions(b.questions !== undefined ? b.questions : rep.questions);
              if (!questions.length) return err(res, 400, "This report has no questions.");
              const answers = cleanAnswers(questions, b.answers !== undefined ? b.answers : rep.answers);
              Object.assign(rep, {
                customerId, jobId,
                templateId: clip(b.templateId !== undefined ? b.templateId : rep.templateId, 80),
                title: clip(b.title !== undefined ? b.title : rep.title, 160) || "Inspection report",
                date: /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || "")) ? String(b.date) : (rep.date || new Date(now).toISOString().slice(0, 10)),
                notes: clip(b.notes !== undefined ? b.notes : rep.notes, 4000),
                questions, answers, summary: reportSummary(answers), updatedAt: now,
              });
              const repId = b.id || uid();
              await putRecord("report", repId, rep);
              return json(res, 200, { ok: true, id: repId, customerId });
            }
            return err(res, 400, "Unknown kind.");
          }

          case "del": {
            if (!id) return err(res, 400, "Missing id.");
            if (kind === "file" || kind === "note" || kind === "report" || kind === "template") {
              const rec = await getRecord(kind, id);
              if (!rec || rec.tenantId !== tenantId) return err(res, 404, "Not found.");
              await delRecord(kind, id);
              return json(res, 200, { ok: true });
            }
            const rec = await getRecord(kind, id);
            if (!rec || rec.tenantId !== tenantId) return err(res, 404, "Not found.");
            await delRecord(kind, id);
            return json(res, 200, { ok: true });
          }

          case "thread": {
            const cust = await getRecord("customer", id);
            if (!cust || cust.tenantId !== tenantId) return err(res, 404, "Customer not found.");
            const [msgs, notes, files] = await Promise.all([
              listRecords("message", tenantId), listRecords("note", tenantId), listRecords("file", tenantId),
            ]);
            const cid = cust.id;
            return json(res, 200, {
              customer: { id: cust.id, name: cust.name, portalToken: cust.portalToken },
              messages: msgs.map(withId).filter(x => x.customerId === cid).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)),
              notes: notes.map(r => ({ id: r.id, customerId: r.data.customerId, text: r.data.text, createdAt: r.data.createdAt })).filter(x => x.customerId === cid).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
              files: files.map(r => { const d = r.data; return { id: r.id, customerId: d.customerId, filename: d.filename, mime: d.mime, category: d.category, size: d.size, createdAt: d.createdAt }; }).filter(x => x.customerId === cid),
            });
          }

          case "send-estimate": {
            const est = await getRecord("estimate", String(body.estimateId || ""));
            if (!est || est.tenantId !== tenantId) return err(res, 404, "Estimate not found.");
            const cust = await getRecord("customer", est.customerId);
            est.status = est.status === "accepted" ? est.status : "sent";
            await putRecord("estimate", est.id, est);
            const business = await tenantBusiness(tenantId);
            if (cust && cust.email && !isDemoTenant(tenantId)) {
              const link = `${baseUrl(req)}/p/${cust.portalToken}`;
              await sendEmail(cust.email, `${business.name || "Your contractor"} sent you an estimate`, `<p>${business.name || "We"} sent you an estimate: <strong>${est.title || "Estimate"}</strong> — $${Number(est.total || 0).toFixed(2)}.</p><p>View and respond: <a href="${link}">${link}</a></p>`);
            }
            return json(res, 200, { ok: true });
          }

          case "send-portal": {
            const cust = await getRecord("customer", String(body.customerId || ""));
            if (!cust || cust.tenantId !== tenantId) return err(res, 404, "Customer not found.");
            const business = await tenantBusiness(tenantId);
            const link = `${baseUrl(req)}/p/${cust.portalToken}`;
            if (cust.email && !isDemoTenant(tenantId)) await sendEmail(cust.email, `Your ${business.name || "service"} portal`, `<p>Your customer portal: <a href="${link}">${link}</a></p>`);
            return json(res, 200, { ok: true, link });
          }

          case "send-review": {
            const cust = await getRecord("customer", String(body.customerId || ""));
            if (!cust || cust.tenantId !== tenantId) return err(res, 404, "Customer not found.");
            if (isDemoTenant(tenantId)) return json(res, 200, { ok: true, via: ["demo mode (nothing was actually sent)"] });
            const reviewsV = await getSetting(`t:${tenantId}:reviews`);
            const reviews = reviewsV ? JSON.parse(reviewsV) : {};
            const business = await tenantBusiness(tenantId);
            const link = reviews.link || "";
            const via = [];
            if (cust.email && process.env.RESEND_API_KEY) {
              const ok = await sendEmail(cust.email, `How did we do, ${cust.name}?`, link ? `<p>Thanks for choosing ${business.name || "us"}! Would you leave us a quick review?</p><p><a href="${link}">${link}</a></p>` : `<p>Thanks for choosing ${business.name || "us"}!</p>`);
              if (ok) via.push("email");
            }
            if (cust.phone && process.env.TWILIO_ACCOUNT_SID) {
              const ok = await sendSms(cust.phone, `Thanks for choosing ${business.name || "us"}! ${link ? "Review us: " + link : "We'd love your feedback!"}`);
              if (ok) via.push("sms");
            }
            if (!via.length) return err(res, 500, "No way to reach this customer — add an email or phone, and connect email/SMS in Settings.", { contact: business });
            return json(res, 200, { ok: true, via });
          }

          case "schedule": {
            const reqRec = await getRecord("request", String(body.requestId || ""));
            if (!reqRec || reqRec.tenantId !== tenantId) return err(res, 404, "Request not found.");
            const jobId = uid();
            await putRecord("job", jobId, {
              tenantId, customerId: reqRec.customerId, estimateId: reqRec.estimateId,
              date: String(body.date || ""), time: String(body.time || ""), notes: String(body.notes || ""),
              status: "scheduled", createdAt: Date.now(),
            });
            reqRec.status = "scheduled";
            await putRecord("request", reqRec.id, reqRec);
            return json(res, 200, { ok: true, jobId });
          }

          case "decline-request": {
            const reqRec = await getRecord("request", String(body.requestId || ""));
            if (!reqRec || reqRec.tenantId !== tenantId) return err(res, 404, "Request not found.");
            reqRec.status = "declined";
            await putRecord("request", reqRec.id, reqRec);
            return json(res, 200, { ok: true });
          }

          case "complete-job": {
            const j = await getRecord("job", String(body.jobId || ""));
            if (!j || j.tenantId !== tenantId) return err(res, 404, "Job not found.");
            j.status = "done"; j.doneAt = Date.now();
            await putRecord("job", j.id, j);
            let invoiceId = null;
            if (body.createInvoice) {
              invoiceId = uid();
              await putRecord("invoice", invoiceId, {
                tenantId, customerId: j.customerId, jobId: j.id, estimateId: j.estimateId,
                title: j.title || j.type || "Job", total: Number(j.price || 0),
                status: "unpaid", createdAt: Date.now(),
              });
            }
            return json(res, 200, { ok: true, invoiceId });
          }

          case "savesettings": {
            const b = body || {};
            if (b.business) {
              const cur = await tenantBusiness(tenantId);
              await setSetting(`t:${tenantId}:business`, JSON.stringify(Object.assign(cur, {
                name: String(b.business.name || "").trim(), phone: String(b.business.phone || "").trim(),
                email: String(b.business.email || "").trim(), address: String(b.business.address || "").trim(),
              })));
            }
            if (b.style) await setSetting(`t:${tenantId}:docstyle`, JSON.stringify({ template: b.style.template || "classic", accent: b.style.accent || "" }));
            if (b.reviews) {
              const cur = await getSetting(`t:${tenantId}:reviews`);
              await setSetting(`t:${tenantId}:reviews`, JSON.stringify(Object.assign(cur ? JSON.parse(cur) : {}, { link: String(b.reviews.link || "").trim() })));
            }
            if (b.reminders) await setSetting(`t:${tenantId}:reminders`, JSON.stringify({
              email24h: !!b.reminders.email24h, email2h: !!b.reminders.email2h, sms24h: !!b.reminders.sms24h, sms2h: !!b.reminders.sms2h,
            }));
            if (b.stripe) await setSetting(`t:${tenantId}:stripe`, JSON.stringify({ publicKey: String(b.stripe.publicKey || "").trim(), secretKey: String(b.stripe.secretKey || "").trim() }));
            return json(res, 200, { ok: true });
          }

          case "change-password": {
            if (isDemoTenant(tenantId)) return err(res, 400, "Passwords can't be changed in the demo.");
            const authV = await getSetting(`t:${tenantId}:auth`);
            const auth = authV ? JSON.parse(authV) : {};
            if (!auth.hash || hashPassword(String(body.currentPassword || ""), auth.salt) !== auth.hash) return err(res, 401, "Current password is wrong.");
            if (String(body.newPassword || "").length < 6) return err(res, 400, "New password must be at least 6 characters.");
            auth.hash = hashPassword(String(body.newPassword), auth.salt);
            await setSetting(`t:${tenantId}:auth`, JSON.stringify(auth));
            return json(res, 200, { ok: true });
          }

          case "team-list": {
            const v = await getSetting(`t:${tenantId}:users`);
            return json(res, 200, { users: v ? JSON.parse(v) : [] });
          }

          case "team-add": {
            const usersV = await getSetting(`t:${tenantId}:users`);
            const users = usersV ? JSON.parse(usersV) : [];
            const email = String(body.email || "").trim().toLowerCase();
            const password = String(body.password || "");
            if (!email || password.length < 6) return err(res, 400, "Team member needs an email and a 6+ character password.");
            if (users.some(u => (u.email || "").toLowerCase() === email)) return err(res, 400, "That email is already on the team.");
            const salt = crypto.randomBytes(16).toString("hex");
            users.push({ id: uid(), name: String(body.name || "").trim(), email, role: String(body.role || "crew"), salt, hash: hashPassword(password, salt), createdAt: Date.now() });
            await setSetting(`t:${tenantId}:users`, JSON.stringify(users));
            return json(res, 200, { ok: true });
          }

          case "team-remove": {
            const usersV = await getSetting(`t:${tenantId}:users`);
            let users = usersV ? JSON.parse(usersV) : [];
            users = users.filter(u => u.id !== String(body.userId || ""));
            await setSetting(`t:${tenantId}:users`, JSON.stringify(users));
            return json(res, 200, { ok: true });
          }

          case "subscribe": {
            if (isDemoTenant(tenantId)) return err(res, 400, "Billing is disabled in the demo — every plan is already unlocked.");
            const sk = process.env.STRIPE_SECRET_KEY;
            if (!sk) return err(res, 500, "Billing is not connected yet.");
            const planBase = { good: "STRIPE_PRICE_ID_GOOD", better: "STRIPE_PRICE_ID_BETTER", best: "STRIPE_PRICE_ID_BEST" }[String(body.plan || "")];
            const prepaid = String(body.period || "") === "6mo";
            const price = planBase ? process.env[prepaid ? planBase : planBase + "_MONTHLY"] : null;
            const origin = baseUrl(req);
            const form = new URLSearchParams({
              mode: "subscription",
              "line_items[0][price]": price,
              "line_items[0][quantity]": "1",
              success_url: `${origin}/settings?session_id={CHECKOUT_SESSION_ID}&sub=ok`,
              cancel_url: `${origin}/settings?canceled=1`,
              "metadata[tenantId]": tenantId,
            });
            const r = await fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { Authorization: "Bearer " + sk, "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
            const d = await r.json();
            if (!r.ok) return err(res, 500, "Billing provider error.");
            return json(res, 200, { url: d.url });
          }

          case "billing-portal": {
            if (isDemoTenant(tenantId)) return err(res, 400, "Billing is disabled in the demo — every plan is already unlocked.");
            const sk = process.env.STRIPE_SECRET_KEY;
            if (!sk) return err(res, 500, "Billing is not connected yet.");
            const curB = await getSetting(`t:${tenantId}:billing`);
            const b = curB ? JSON.parse(curB) : {};
            if (!b.stripeCustomerId) return err(res, 400, "No billing profile yet — subscribe to a plan first.");
            const originB = baseUrl(req);
            const rb = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
              method: "POST",
              headers: { Authorization: "Bearer " + sk, "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ customer: String(b.stripeCustomerId), return_url: `${originB}/settings` }),
            });
            const db = await rb.json();
            if (!rb.ok || !db.url) return err(res, 500, "Billing provider error.");
            return json(res, 200, { url: db.url });
          }

          case "export": {
            const [customers, jobs, estimates, invoices] = await Promise.all([
              listRecords("customer", tenantId), listRecords("job", tenantId), listRecords("estimate", tenantId), listRecords("invoice", tenantId),
            ]);
            let out = "", name = kind;
            if (kind === "customers") { name = "customers"; out = csv(customers.map(withId), ["name", "email", "phone", "address", "createdAt"]); }
            else if (kind === "jobs") out = csv(jobs.map(withId), ["date", "time", "status", "type", "title", "price", "notes", "customerId"]);
            else if (kind === "estimates") out = csv(estimates.map(withId), ["title", "total", "status", "createdAt", "customerId"]);
            else if (kind === "invoices") out = csv(invoices.map(withId), ["title", "total", "status", "createdAt", "customerId", "paidAt", "paidMethod"]);
            else return err(res, 400, "Unknown kind.");
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/csv; charset=utf-8");
            res.setHeader("Content-Disposition", `attachment; filename="ledgerline-${name}-${new Date().toISOString().slice(0, 10)}.csv"`);
            return res.end(out);
          }

          default:
            return err(res, 404, "Unknown action.");
        }
      }
    }
  } catch (e) {
    console.error("api error", a, e);
    return err(res, 500, "Something went wrong on our end. Try again.", { contact: { name: "Ledgerline", email: "info@leonlink.net" } });
  }
};
