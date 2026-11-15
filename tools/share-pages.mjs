// Builds the shop's site for GitHub Pages: the files of this repository as they are, plus one small page for every
// item customers can see, so that a link shared on WhatsApp or Telegram shows the item's photo and name. Each small
// page sends the visitor straight on to the item in the shop's page.
//
// Run by .github/workflows/site.yml with plain Node: nothing to install. Made by the app's build from the app's own
// code, so the item numbers here are always the app's. Do not edit by hand: change the app and build again.
//
//   node tools/share-pages.mjs [repository folder] [output folder]
//
// Whatever happens with the cloud, the site itself is always written, so a deployment never fails because of it.

import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(process.argv[2] || '.');
const OUT = path.resolve(process.argv[3] || path.join(REPO, '_site'));
const SKIP = new Set(['tools', '_site', 'node_modules']);
const PAGE = 1000;

/* From the app: how an offer becomes an item number, exactly as the shop's page works it out. */
function toLatinDigits(s) {
  return String(s)
    .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
    .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); })
    .replace(/٫/g, '.').replace(/٬/g, ',');
}
function normalize(s) {
  return toLatinDigits(s).toLowerCase()
    .replace(/[ً-ْـ]/g, '')        // diacritics and tatweel
    .replace(/[آأإ]/g, 'ا')   // alef variants
    .replace(/ى/g, 'ي')                 // alef maqsura -> ya
    .replace(/ة/g, 'ه')                 // ta marbuta -> ha
    .replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ').trim();
}
function readNote(note) {
  var out = { no: 0, cpu: '', ram: '', disk: '', diskKind: '', screen: '', gpu: '', notes: [] };
  String(note || '').split(/\s*\u00B7\s*/).forEach(function (p) {
    var m;
    if (!p) return;
    if ((m = /^#(\d{1,4})$/.exec(p)) && !out.no) out.no = Number(m[1]);
    else if ((m = /^CPU (.+)$/.exec(p)) && !out.cpu) out.cpu = m[1];
    else if ((m = /^RAM (.+)$/.exec(p)) && !out.ram) out.ram = m[1];
    else if ((m = /^(SSD|HDD|STORAGE) (.+)$/.exec(p)) && !out.disk) { out.diskKind = m[1]; out.disk = m[2]; }
    else if ((m = /^DISPLAY (.+)$/.exec(p)) && !out.screen) out.screen = m[1];
    else if ((m = /^GPU (.+)$/.exec(p)) && !out.gpu) out.gpu = m[1];
    else out.notes.push(p);
  });
  return out;
}
function offerKey(o) { var sp = readNote(o.note); return normalize([o.cond === 'used' ? 'used' : 'new', o.name, sp.cpu, sp.ram, sp.disk, sp.screen, sp.gpu].join('|')); }
function offerNum(key) {
  var h = 0, i;
  for (i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 8796093022208;   // 2^43
  return 1e12 + h;
}

/* From the app's Arabic texts. */
const TEXT = { cond_new: 'جديد', cond_used: 'مستعمل', share_tail: 'السعر والصور على الموقع' };

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* The repository's own files, as the site served them before. */
function copySite() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  for (const name of fs.readdirSync(REPO)) {
    if (SKIP.has(name) || name.startsWith('.') || path.join(REPO, name) === OUT) continue;
    fs.cpSync(path.join(REPO, name), path.join(OUT, name), { recursive: true });
  }
}

/* The site's own address: given by the workflow, or read from the CNAME file. */
function siteUrl() {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, '');
  try {
    const host = fs.readFileSync(path.join(REPO, 'CNAME'), 'utf8').split('\n')[0].trim();
    if (host) return 'https://' + host;
  } catch (e) { /* no CNAME file */ }
  return '';
}

/* The cloud the shop's page talks to, read from the page itself. */
function cloud() {
  const page = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const url = /RAFF_CLOUD_URL = '([^']+)'/.exec(page), key = /RAFF_CLOUD_KEY = '([^']+)'/.exec(page);
  if (!url || !key) throw new Error('index.html does not name its cloud');
  return { url: url[1].replace(/\/+$/, ''), key: key[1] };
}

/* A whole list, page by page, the way a customer's phone reads it. */
async function list(c, p) {
  const out = [];
  for (let off = 0; ; off += PAGE) {
    const r = await fetch(c.url + p + (p.includes('?') ? '&' : '?') + 'limit=' + PAGE + '&offset=' + off,
      { headers: { apikey: c.key }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(p + ' answered ' + r.status);
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error(p + ' did not give a list');
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}
async function soft(c, p) { try { return await list(c, p); } catch (e) { console.warn('skipped: ' + e.message); return []; } }

/* What customers can see, as the shop's page shows it to them: one entry per item number. */
async function catalog(c) {
  const [items, offers, media, notes, settings] = await Promise.all([
    list(c, '/rest/v1/rpc/catalog?order=id'), soft(c, '/rest/v1/rpc/catalog_offers?order=name,id'),
    soft(c, '/rest/v1/rpc/catalog_media?order=item_id'), soft(c, '/rest/v1/rpc/catalog_notes?order=item_id'),
    soft(c, '/rest/v1/app_settings?select=key,value&key=eq.shop')]);
  const photos = new Map(media.filter(m => m.photo).map(m => [Number(m.item_id), String(m.photo).split(',')[0]]));
  const notesOf = new Map(notes.filter(n => n.note).map(n => [Number(n.item_id), String(n.note).split('\n')[0].trim()]));
  const shop = ((settings[0] || {}).value || {}).name || 'Kouki Technology';
  const out = new Map();
  for (const r of items) out.set(Number(r.id), { name: String(r.name), parts: [] });
  for (const o of offers) {
    if (!(Number(o.sell) > 0)) continue;
    const id = offerNum(offerKey(o));
    if (out.has(id)) continue;
    const sp = readNote(o.note);
    out.set(id, { name: String(o.name), parts: [o.cond === 'used' ? TEXT.cond_used : TEXT.cond_new, sp.cpu, sp.ram, sp.disk, sp.screen].filter(Boolean) });
  }
  for (const [id, it] of out) {
    it.photo = photos.get(id) || '';
    if (notesOf.get(id)) it.parts.push(notesOf.get(id));
  }
  return { shop, items: out };
}

/* One item's page: what WhatsApp and Telegram read for the preview, then straight on to the item. */
function itemPage(site, c, shop, id, it) {
  const to = '/#p' + id, image = it.photo
    ? c.url + '/storage/v1/object/public/items/' + encodeURIComponent(it.photo) + '-s.jpg'   // the small copy: well within WhatsApp's limits
    : site + '/icon-512.png';
  const desc = (it.parts.length ? it.parts.join(' · ') + ' — ' : '') + TEXT.share_tail;
  return '<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n<meta charset="utf-8">\n' +
    '<title>' + esc(it.name + ' | ' + shop) + '</title>\n' +
    '<meta name="robots" content="noindex">\n' +
    '<meta name="description" content="' + esc(desc.slice(0, 300)) + '">\n' +
    '<meta property="og:type" content="product">\n' +
    '<meta property="og:site_name" content="' + esc(shop) + '">\n' +
    '<meta property="og:locale" content="ar_SY">\n' +
    '<meta property="og:title" content="' + esc(it.name) + '">\n' +
    '<meta property="og:description" content="' + esc(desc.slice(0, 300)) + '">\n' +
    '<meta property="og:url" content="' + esc(site + '/p/' + id) + '">\n' +
    '<meta property="og:image" content="' + esc(image) + '">\n' +
    '<meta property="og:image:alt" content="' + esc(it.name) + '">\n' +
    '<meta name="twitter:card" content="summary_large_image">\n' +
    '<meta http-equiv="refresh" content="0; url=' + to + '">\n' +
    '<script>location.replace(' + JSON.stringify(to) + ');</script>\n' +
    '</head>\n<body><p><a href="' + to + '">' + esc(it.name) + '</a></p></body>\n</html>\n';
}

/* Any other address on the site: an item link of an item without its page yet still opens the item. */
function notFoundPage() {
  return '<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n<meta charset="utf-8">\n<meta name="robots" content="noindex">\n' +
    '<script>var m = /^\\/p\\/(\\d{1,16})(?:\\.html)?\\/?$/.exec(location.pathname); location.replace(m ? \'/#p\' + m[1] : \'/\');</script>\n' +
    '</head>\n<body><p><a href="/">Kouki Technology</a></p></body>\n</html>\n';
}

async function main() {
  copySite();
  fs.writeFileSync(path.join(OUT, '404.html'), notFoundPage());
  let count = 0;
  try {
    const site = siteUrl(), c = cloud();
    if (!site) throw new Error('the site address is not known (no CNAME file and no SITE_URL)');
    const { shop, items } = await catalog(c);
    fs.mkdirSync(path.join(OUT, 'p'), { recursive: true });
    for (const [id, it] of items) fs.writeFileSync(path.join(OUT, 'p', id + '.html'), itemPage(site, c, shop, id, it));
    count = items.size;
  } catch (e) {
    console.warn('item pages left out this time: ' + e.message);
  }
  fs.writeFileSync(path.join(OUT, 'share.json'), JSON.stringify({ at: new Date().toISOString(), count }) + '\n');
  console.log('site written to ' + OUT + ' with ' + count + ' item pages');
}

main();
