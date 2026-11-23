# Ledgerline — How to Use

White-label estimates, invoices, a job dashboard and a customer portal.
**Live app:** https://app.leonlink.net · **Full guide (PDF):** https://app.leonlink.net/guide.pdf

---

## Quick start

1. **Create your workspace** — app.leonlink.net → *Create free workspace*. Business name, email, password. No card needed.
2. **Add your business details** — Settings → Business: name, phone, email, address. These print on every document.
3. **Connect Stripe** (5 min) — so customers can pay invoices by card. See below.
4. **Book your first job** — *+ Job* button, pick a date, done.

## Connecting Stripe (so customers can pay by card)

1. Create a free account at [dashboard.stripe.com/register](https://dashboard.stripe.com/register). Add your business details and your payout bank account.
2. In the Stripe Dashboard: **Developers → API keys**.
3. Copy the **Publishable key** (`pk_live_…`).
4. Click **Reveal** on the **Secret key** (`sk_live_…`) and copy it. It shows once.
5. In Ledgerline: **Settings → Card payments**, paste both, **Save settings**.

Every invoice now shows a **Pay now** button. Want to practice first? Use Stripe's Test mode keys (`pk_test_…` / `sk_test_…`).

## Daily flow

- **Book:** *+ Job* → customer name (auto-creates the customer), date, time, price. Set *Repeats* for recurring work.
- **Estimates:** *Estimates → New estimate* → send to customer → they accept online → *Accept & schedule* turns it into a job.
- **Get paid:** send the invoice; card customers pay via the *Pay now* button, cash/check gets marked paid.
- **Reminders:** automatic email notices ~24h and ~2h before each job. Toggle in Settings → Reminders.
- **Reviews:** after a job, *Request review* sends your Google review link.

## White label

Your business name, phone, email and address print at the top of every estimate, invoice and report, and the customer portal is headed with your business name and initial. Choose the document template and accent colour under **Settings → Documents**. Nothing from LeonLink appears on your customer's copy.

## Team access levels

Add people under **Settings → Team** (unlimited seats):

| Level | Can do | Can't do |
|---|---|---|
| **Owner** (you) | Everything, including billing and subscription | — |
| **Admin** | Everything except billing/subscription | Change plans, manage billing |
| **Dispatcher** | Run the day: jobs, customers, estimates, invoices, files, messages | Settings, team, billing |
| **Crew** | See the schedule and customers, complete jobs, upload photos, message | See money (invoices, estimates, revenue), settings, delete anything |

## Customer portal

Every customer gets their own link (no app to install): estimates to accept, invoices to pay, photos and files, and a message thread with you. Find it on any customer's page — *Copy portal link* or *Email portal link*.

## Data

One-click CSV export of all your data under **Settings → Your data**. No add-ons, no lock-in.

## FAQ

- **Hired someone?** Add them under Settings → Team.
- **Data?** Yours. Download everything anytime, leave anytime.
- **Help?** info@leonlink.net

© 2026 Ledgerline
