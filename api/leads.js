/* ============================================================
   IW Partner Portal — live leads from GoHighLevel (v2)
   Vercel serverless function.  URL: /api/leads?location=<id>
   ------------------------------------------------------------
   v2 adds, per lead:
     • credit          — "700+", "620-699", "Under 620" or "—"
     • lastActivity    — most recent activity timestamp (ms)
     • lastActivityCDT — formatted in America/Chicago
     • daysInactive    — whole days since last activity
     • isNew           — added within the last 48 hours
     • callToday       — NEW + high credit → call 2x today
     • needsNurture    — high score/credit but gone quiet ≥5 days
     • nurtureEnrolled — already tagged 'gentle-nurture'
     • id, phone       — so the portal can log calls & notes

   SECRETS (Vercel → Project Settings → Environment Variables):
     GHL_PULVER_TOKEN     = Private Integration token (pit-...)
     GHL_PULVER_LOCATION  = ua1JQW5n2yE3u80HvuUs
     GHL_WMOS_TOKEN / GHL_WMOS_LOCATION = (later)
     SUPABASE_URL         = https://<project>.supabase.co
     SUPABASE_ANON        = publishable/anon key (login check)
   ============================================================ */
const { authorize } = require('./_lib/access.js');

const SCORE_PROFILE_ID = '6a2318dce606719d3a50d701';
const BANDS = { hot: 20, warm: 5, nurture: 0 };

/* GHL custom-field ids (Pulver location) */
const CF_CREDIT_RANGE = '4LIGZNquXiHK51kxwMxD';   /* IW Credit Score Range: 700+ / 620-699 / Under 620 */
const CF_CREDIT_TEXT  = 'IyAFLts8rhzbozCwWdNu';   /* legacy free-text Credit Scores */

/* Flag thresholds */
const NEW_HOURS   = 48;   /* "new lead" window */
const QUIET_DAYS  = 5;    /* days of silence before the nurture flag */
const HIGH_SCORE  = 5;    /* engagement score considered "high" (Warm+) */
const NURTURE_TAG = 'gentle-nurture';

function bandFor(score){
  if (score >= BANDS.hot)     return 'Hot';
  if (score >= BANDS.warm)    return 'Warm';
  if (score >= BANDS.nurture) return 'Nurture';
  return 'Cold';
}

function engagementScore(c){
  var s = c && c.scoring;
  if (!s || typeof s !== 'object') return 0;
  if (typeof s[SCORE_PROFILE_ID] === 'number') return s[SCORE_PROFILE_ID];
  var vals = Object.keys(s).map(function(k){ return Number(s[k]); }).filter(function(n){ return !isNaN(n); });
  return vals.length ? Math.max.apply(null, vals) : 0;
}

function customFieldValue(c, id){
  var arr = c.customFields || c.customField || [];
  for (var i=0;i<arr.length;i++){
    if (arr[i] && arr[i].id === id){
      var v = arr[i].value != null ? arr[i].value : arr[i].fieldValue;
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
  }
  return null;
}

function creditFor(contact){
  var v = customFieldValue(contact, CF_CREDIT_RANGE);
  if (v) return v;                                  /* normalized: "700+" | "620-699" | "Under 620" */
  var tags = contact.tags || [];
  if (tags.indexOf('fit-credit-700') > -1) return '700+';
  if (tags.indexOf('fit-credit-650') > -1) return '650-699';
  if (tags.indexOf('fit-credit-600') > -1) return '600-650';
  if (tags.indexOf('fit-credit-low') > -1) return 'Under 600';
  var t = customFieldValue(contact, CF_CREDIT_TEXT);
  if (t){
    var s = String(t);
    /* prefer an explicit range like "600-650 (Below Average)" — use the LOWER bound */
    var range = s.match(/(\d{3})\s*[-–]\s*(\d{3})/);
    if (range){
      var lo = parseInt(range[1], 10);
      if (lo >= 700) return '700+';
      if (lo >= 650) return '650-699';
      if (lo >= 600) return '600-650';
      return 'Under 600';
    }
    /* single number, e.g. "Below 600" */
    var one = s.match(/\d{3}/);
    if (one){
      var n = parseInt(one[0], 10);
      if (/below|under|less/i.test(s)) return (n <= 600 ? 'Under 600' : '600-650');
      if (n >= 700) return '700+';
      if (n >= 650) return '650-699';
      if (n >= 600) return '600-650';
      return 'Under 600';
    }
    return s;                                       /* free text like "Good" — show as-is */
  }
  return null;
}

function ts(v){
  if (v == null) return null;
  if (typeof v === 'number') return v;
  var n = Date.parse(v);
  return isNaN(n) ? null : n;
}

/* Most recent sign of life we can see on the contact record */
function lastActivityMs(c){
  var cands = [ts(c.lastActivity), ts(c.dateUpdated), ts(c.lastSessionActivityAt)];
  var best = null;
  cands.forEach(function(t){ if (t && (!best || t > best)) best = t; });
  return best;
}

function fmtCDT(ms){
  if (!ms) return '—';
  try{
    return new Intl.DateTimeFormat('en-US', {
      timeZone:'America/Chicago', month:'short', day:'numeric', hour:'numeric', minute:'2-digit'
    }).format(new Date(ms)) + ' CDT';
  }catch(e){ return new Date(ms).toISOString(); }
}

function signalsFrom(contact){
  var tags = contact.tags || [];
  var out = [];
  if (tags.indexOf('fit-asap') > -1) out.push('ASAP');
  var credit = creditFor(contact);
  if (credit) out.push('Credit ' + credit);
  return out.join(' · ');
}

function tokenFor(location){
  var map = {};
  if (process.env.GHL_PULVER_LOCATION) map[process.env.GHL_PULVER_LOCATION] = process.env.GHL_PULVER_TOKEN;
  if (process.env.GHL_WMOS_LOCATION)   map[process.env.GHL_WMOS_LOCATION]   = process.env.GHL_WMOS_TOKEN;
  return map[location] || null;
}

async function verifyLogin(req){
  var url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON;
  if (!url || !anon) return true;
  var auth = req.headers['authorization'] || '';
  if (!auth) return false;
  try{
    var r = await fetch(url.replace(/\/$/,'') + '/auth/v1/user', { headers: { apikey: anon, Authorization: auth } });
    return r.ok;
  }catch(e){ return false; }
}

function ghlHeaders(token, json){
  var h = { Authorization: 'Bearer ' + token, Version: '2021-07-28', Accept: 'application/json' };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

function mapContact(c, now){
  var score  = engagementScore(c);
  var credit = creditFor(c);
  var creditHigh = credit === '700+';
  var creditMid  = credit === '620-699' || credit === '650-699';
  var tags   = c.tags || [];
  var added  = ts(c.dateAdded);
  var lastA  = lastActivityMs(c);
  var isNew  = !!(added && (now - added) <= NEW_HOURS*3600*1000);
  var daysInactive = lastA ? Math.floor((now - lastA)/(24*3600*1000)) : null;
  var nurtureEnrolled = tags.indexOf(NURTURE_TAG) > -1;
  var needsNurture = !nurtureEnrolled && !isNew &&
        (score >= HIGH_SCORE || creditHigh) &&
        daysInactive != null && daysInactive >= QUIET_DAYS;
  var callToday = isNew && (creditHigh || creditMid);

  var first = c.firstName || (c.contactName ? c.contactName.split(' ')[0] : '') || 'Lead';
  var lastN = c.lastName || '';
  return {
    id: c.id,
    name: first + (lastN ? (' ' + lastN.charAt(0) + '.') : ''),
    fullName: (first + ' ' + lastN).trim(),
    phone: c.phone || null,
    score: score,
    band: bandFor(score),
    signals: signalsFrom(c),
    credit: credit || '—',
    creditHigh: creditHigh,
    creditMid: creditMid,
    addedAt: added,
    isNew: isNew,
    lastActivity: lastA,
    lastActivityCDT: fmtCDT(lastA),
    daysInactive: daysInactive,
    callToday: callToday,
    needsNurture: needsNurture,
    nurtureEnrolled: nurtureEnrolled
  };
}

function hasAnyScoring(contacts){
  for (var i=0;i<contacts.length;i++){
    var s = contacts[i].scoring;
    if (s && typeof s === 'object' && Object.keys(s).length) return true;
  }
  return false;
}

async function enrichRecent(location, token, limit){
  var listRes = await fetch('https://services.leadconnectorhq.com/contacts/?locationId=' + encodeURIComponent(location) + '&limit=' + limit, { headers: ghlHeaders(token) });
  if (!listRes.ok) return [];
  var list = (await listRes.json()).contacts || [];
  var out = [];
  for (var i=0;i<list.length;i+=8){
    var slice = list.slice(i, i+8);
    var got = await Promise.all(slice.map(function(c){
      return fetch('https://services.leadconnectorhq.com/contacts/' + c.id, { headers: ghlHeaders(token) })
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(j){ return j && j.contact ? j.contact : c; })
        .catch(function(){ return c; });
    }));
    out = out.concat(got);
  }
  return out;
}

module.exports = async function handler(req, res){
  try{
    var auth = await authorize(req, 'leads');
    if (!auth.ok){ res.status(auth.status).json({ ok:false, error:auth.error }); return; }
    var location = auth.location;
    var token = tokenFor(location);
    if (!token){ res.status(400).json({ ok:false, error:'No scheduler configured for this practice yet.' }); return; }

    var ghl = await fetch('https://services.leadconnectorhq.com/contacts/search', {
      method: 'POST',
      headers: ghlHeaders(token, true),
      body: JSON.stringify({ locationId: location, pageLimit: 100 })
    });
    if (!ghl.ok){
      var t = await ghl.text();
      res.status(502).json({ ok:false, error:'GoHighLevel error ' + ghl.status, detail: t.slice(0,300) });
      return;
    }
    var contacts = (await ghl.json()).contacts || [];

    var enriched = false;
    if (contacts.length && !hasAnyScoring(contacts)){
      var deep = await enrichRecent(location, token, 40);
      if (deep.length){ contacts = deep; enriched = true; }
    }

    var now = Date.now();
    var leads = contacts.map(function(c){ return mapContact(c, now); })
                        .sort(function(a,b){ return b.score - a.score; });

    var counts = { Hot:0, Warm:0, Nurture:0, Cold:0 };
    leads.forEach(function(l){ counts[l.band]++; });

    var MS30 = 30*24*3600*1000;
    var new30 = leads.filter(function(l){ return l.addedAt && (now - l.addedAt) <= MS30; }).length;

    var priority = leads.filter(function(l){ return l.callToday; })
                        .sort(function(a,b){ return (b.creditHigh?1:0)-(a.creditHigh?1:0) || b.score-a.score; });
    var quiet    = leads.filter(function(l){ return l.needsNurture; })
                        .sort(function(a,b){ return (b.daysInactive||0)-(a.daysInactive||0); });

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok:true, location: location, count: leads.length, counts: counts, new30: new30,
      source: enriched ? 'enriched' : 'search',
      generatedAt: now, generatedAtCDT: fmtCDT(now),
      priority: priority, quiet: quiet,
      leads: leads.slice(0, 100)
    });
  }catch(e){
    res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
};
