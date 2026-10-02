#!/usr/bin/env node
/* Prerenders /alternatives/<slug>.html from index.html + alternatives-data.js.
 *
 *   node tools/build-alternatives.js
 *
 * index.html is the master template. alternatives-data.js is the ONLY place
 * competitor content lives (the app reads the same file at runtime, so the
 * static page and the client render can never disagree).
 *
 * To add a competitor: add one entry to alternatives-data.js, run this, deploy.
 * It creates the page, fixes the head tags, and adds it to the sitemap.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const write = (f, s) => { fs.writeFileSync(path.join(root, f), s); console.log('  wrote ' + f + ' (' + s.length + ' bytes)'); };

global.window = {};
eval(read('alternatives-data.js'));
const ALTS = global.window.LL_ALTS;
const slugs = Object.keys(ALTS);
if (!slugs.length) throw new Error('alternatives-data.js has no competitors');

const master = read('index.html');
const template = read('tools/alt-template.html');
const SITE = 'https://app.leonlink.net';

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => esc(s).replace(/"/g, '&quot;');

function fixHead(html, slug, d) {
  const url = SITE + '/alternatives/' + slug;
  const subs = [
    [/<title>[\s\S]*?<\/title>/, '<title>' + esc(d.title) + '</title>'],
    [/<meta name="description" content="[\s\S]*?">/, '<meta name="description" content="' + escAttr(d.desc) + '">'],
    [/<meta property="og:title" content="[\s\S]*?">/, '<meta property="og:title" content="' + escAttr(d.title) + '">'],
    [/<meta property="og:description" content="[\s\S]*?">/, '<meta property="og:description" content="' + escAttr(d.desc) + '">'],
    [/<meta property="og:url" content="[\s\S]*?">/, '<meta property="og:url" content="' + url + '">'],
    [/<meta property="og:type" content="[\s\S]*?">/, '<meta property="og:type" content="article">'],
    [/<link rel="canonical" href="[\s\S]*?">/, '<link rel="canonical" href="' + url + '">']
  ];
  for (const [re, to] of subs) {
    if (!re.test(html)) throw new Error(slug + ': head anchor missing for ' + re);
    html = html.replace(re, to);
  }
  if (html.indexOf('https://app.leonlink.net/">') > -1) throw new Error(slug + ': canonical still points at the homepage');
  return html;
}

function buildBlock(d) {
  let t = template;
  const sub = (from, to) => {
    if (t.indexOf(from) < 0) throw new Error('template anchor missing: ' + from.slice(0, 60));
    t = t.split(from).join(to);
  };
  sub('Why small crews are switching from Jobber', esc(d.h1));
  sub('Same core loop \u2014 scheduling, estimates, invoices, card payments, customer portal. One flat price. Your whole crew included. No per-user fees, no add-ons, no annual prepay.', esc(d.lede));
  sub('<strong>Jobber vs Ledgerline</strong><span>3-person crew</span>',
      '<strong>' + esc(d.name) + ' vs Ledgerline</strong><span>' + esc(d.crew || '3-person crew') + '</span>');
  sub('<div class="v">$167-187/mo</div><div class="l">Jobber, per-user fees in</div>',
      '<div class="v">' + esc(d.theirPrice) + '</div><div class="l">' + esc(d.theirLabel) + '</div>');
  sub('<div class="v">$46.50</div><div class="l">Ledgerline Command, everything on</div>',
      '<div class="v">' + esc(d.ourPrice) + '</div><div class="l">' + esc(d.ourLabel) + '</div>');
  sub('<strong>~$2,400+/yr</strong><span>stays with you</span>',
      '<strong>' + esc(d.savings) + '</strong><span>' + esc(d.savingsLabel || 'stays with you') + '</span>');

  const cards = t.match(/<div class="rant-card">[\s\S]*?<\/div>/g) || [];
  if (cards.length !== 4) throw new Error('expected 4 rant cards, found ' + cards.length);
  if (d.points.length !== 4) throw new Error(d.name + ': needs exactly 4 points, has ' + d.points.length);
  cards.forEach((card, i) => {
    const m = card.match(/^(<div class="rant-card"><h3[^>]*>)[\s\S]*?(<\/h3><p[^>]*>)[\s\S]*?(<\/p><\/div>)$/);
    if (!m) throw new Error('rant card ' + i + ' has an unexpected shape');
    t = t.replace(card, m[1] + esc(d.points[i][0]) + m[2] + esc(d.points[i][1]) + m[3]);
  });

  const mathRe = /<p>A 3-person crew on Jobber Connect[\s\S]*?<\/p>/;
  if (!mathRe.test(t)) throw new Error('math paragraph anchor missing');
  t = t.replace(mathRe, '<p>' + esc(d.math) + '</p>');

  const noteRe = /<p style="margin-top:6px;font-size:12\.5px;color:var\(--faint\)">[\s\S]*?<\/p>/;
  if (!noteRe.test(t)) throw new Error('price-note anchor missing');
  t = t.replace(noteRe, '<p style="margin-top:6px;font-size:12.5px;color:var(--faint)">' + esc(d.theirPriceNote) + '. ' + esc(d.noteTail) + '</p>');

  const footRe = /<div class="foot-copy">[\s\S]*?<\/div>/;
  if (!footRe.test(t)) throw new Error('footer anchor missing');
  t = t.replace(footRe, '<div class="foot-copy">' + esc(d.name) + ' is a trademark of its respective owner, used for comparison only. Prices are published 2026 figures.</div>');

  return t;
}

const PLACEHOLDER = '<div id="app"><div class="center-screen"><div style="text-align:center"><img src="/mascot.png" alt="Ledgerline" style="width:72px;height:72px;border-radius:16px"><div style="margin-top:12px;font-weight:700;font-size:18px">Ledgerline</div><div class="faint" style="margin-top:4px;font-size:14px">Flat price. Whole crew.</div></div></div></div>';

// Guard: an extension-less file at alternatives/<slug> beats the rewrite in Vercel's
// static match, so it silently serves an older copy of the page. These duplicates are
// always a mistake (they carried pre-offline builds for months). Remove them.
let removed = 0;
for (const slug of slugs) {
  const dup = path.join(root, 'alternatives', slug);
  if (fs.existsSync(dup) && fs.statSync(dup).isFile()) {
    const stale = fs.readFileSync(dup, 'utf8');
    fs.unlinkSync(dup);
    removed++;
    console.log('  removed duplicate alternatives/' + slug + ' (' + stale.length + ' bytes, shadowed the rewrite)');
  }
}
// Any leftover extension-less file for a slug we no longer generate is also suspect.
for (const f of fs.readdirSync(path.join(root, 'alternatives'))) {
  const full = path.join(root, 'alternatives', f);
  if (fs.statSync(full).isFile() && !f.endsWith('.html') && !f.endsWith('.md') && !slugs.includes(f)) {
    fs.unlinkSync(full); removed++;
    console.log('  removed orphaned alternatives/' + f);
  }
}

console.log('  building ' + slugs.length + ' alternatives pages from index.html');
for (const slug of slugs) {
  const d = ALTS[slug];
  let html = fixHead(master, slug, d);
  if (html.indexOf(PLACEHOLDER) < 0) throw new Error('loading placeholder not found in index.html (did its markup change?)');
  html = html.replace(PLACEHOLDER, '<div id="app">' + buildBlock(d) + '</div>');
  write('alternatives/' + slug + '.html', html);
}

// sitemap
const sm = read('sitemap.xml');
const want = slugs.map(s => SITE + '/alternatives/' + s);
const missing = want.filter(u => sm.indexOf('<loc>' + u + '</loc>') < 0);
let out = sm;
if (missing.length) {
  out = out.replace('</urlset>', missing.map(u => '  <url>\n    <loc>' + u + '</loc>\n    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>').join('\n') + '\n</urlset>');
}
if (out !== sm) write('sitemap.xml', out);
else console.log('  sitemap.xml already lists every slug');

// report
console.log('\n  verification');
for (const slug of slugs) {
  const h = read('alternatives/' + slug + '.html');
  const title = (h.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
  const canon = (h.match(/<link rel="canonical" href="([^"]*)"/) || [])[1] || '';
  const h1 = (h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '';
  const inSm = read('sitemap.xml').indexOf('<loc>' + canon + '</loc>') > -1;
  const ok = canon === SITE + '/alternatives/' + slug;
  console.log('  ' + (ok && inSm ? 'OK  ' : 'BAD ') + slug.padEnd(14) + ' canonical=' + canon.replace(SITE, '') + (inSm ? ' inSitemap=yes' : ' inSitemap=NO'));
  console.log('       title: ' + title.slice(0, 78));
  console.log('       h1   : ' + h1.slice(0, 78));
}
