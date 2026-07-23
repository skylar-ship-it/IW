/* ============================================================
   IW Partner Portal — live "hottest leads" from GoHighLevel
   Vercel serverless function.  URL: /api/leads?location=<id>
   ------------------------------------------------------------
   Ranks leads by GHL's native ENGAGEMENT SCORE (the number you
   see on the contact card under Actions → Engagement Score, and
   in your "My Hottest Leads" smart list).

   The engagement score lives on each contact as:
       contact.scoring = { "<scoreProfileId>": <number> }
   It is NOT returned by the bulk list endpoint — only by the
   search endpoint — so this function uses POST /contacts/search.

   SECRETS live in Vercel → Project Settings → Environment Variables
   (never in this file, never in the repo):

     GHL_PULVER_TOKEN     = the Private Integration token (pit-...) for Pulver / IW
     GHL_PULVER_LOCATION  = ua1JQW5n2yE3u80HvuUs
     GHL_WMOS_TOKEN       = (later) West Michigan's token
     GHL_WMOS_LOCATION    = (later) West Michigan's location id
     SUPABASE_URL         = https://ntyrmagxwvtnknswofku.supabase.co   (optional; verifies login)
     SUPABASE_ANON        = your publishable/anon key                   (optional)
   ============================================================ */

/* The Engagement Score profile id for the Implanted Wisdom location.
   If GHL ever changes it, the code falls back to the highest score
   value present, so the tracker keeps working. */
const SCORE_PROFILE_ID = '6a2318dce606719d3a50d701';

/* Band cut-offs on the engagement-score scale (signed points).
   Tune these as scores grow — today leads land roughly -10..+10. */
const BANDS = { hot: 20, warm: 5, nurture: 0 };

function bandFor(score){
  if (score >= BANDS.hot)     return 'Hot';
  if (score >= BANDS.warm)    return 'Warm';
  if (score >= BANDS.nurture) return 'Nurture';
  return 'Cold';
}

/* Pull the engagement score out of contact.scoring */
function engagementScore(c){
  var s = c && c.scoring;
  if (!s || typeof s !== 'object') return 0;
  if (typeof s[SCORE_PROFILE_ID] === 'number') return s[SCORE_PROFILE_ID];
  var vals = Object.keys(s).map(function(k){ return Number(s[k]); }).filter(function(n){ return !isNaN(n); });
  return vals.length ? Math.max.apply(null, vals) : 0;
}

/* Short, human "why call them" line from the qualification tags */
function signalsFrom(contact){
  var tags = contact.tags || [];
  var out = [];
  if (tags.indexOf('fit-asap') > -1) out.push('ASAP');
  if (tags.indexOf('fit-credit-700') > -1) out.push('Credit 700+');
  else if (tags.indexOf('fit-credit-650') > -1) out.push('Credit 650+');
  else if (tags.indexOf('fit-credit-low') > -1) out.push('Credit <600');
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
  if (!url || !anon) return true; // not configured here → pilot fallback
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

function mapContact(c){
  var score = engagementScore(c);
  var first = c.firstName || (c.contactName ? c.contactName.split(' ')[0] : '') || 'Lead';
  var lastI = c.lastName ? (' ' + c.lastName.charAt(0) + '.') : '';
  return { name: first + lastI, score: score, band: bandFor(score), signals: signalsFrom(c) };
}

function hasAnyScoring(contacts){
  for (var i=0;i<contacts.length;i++){
    var s = contacts[i].scoring;
    if (s && typeof s === 'object' && Object.keys(s).length) return true;
  }
  return false;
}

/* Fallback: the search results carried no scoring, so read it the way
   we know works — one contact at a time — for the most recent leads. */
async function enrichRecent(location, token, limit){
  var listRes = await fetch('https://services.leadconnectorhq.com/contacts/?locationId=' + encodeURIComponent(location) + '&limit=' + limit, { headers: ghlHeaders(token) });
  if (!listRes.ok) return [];
  var list = (await listRes.json()).contacts || [];
  var out = [];
  for (var i=0;i<list.length;i+=8){                     // small concurrent batches
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
    var location = (req.query && req.query.location) || process.env.GHL_PULVER_LOCATION;
    var token = tokenFor(location);
    if (!token){ res.status(400).json({ ok:false, error:'No token configured for this location.' }); return; }

    var okUser = await verifyLogin(req);
    if (!okUser){ res.status(401).json({ ok:false, error:'Not signed in.' }); return; }

    // Search returns the full contact doc — usually including the scoring object.
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

    // If search stripped the scoring object, enrich the most recent leads individually.
    var enriched = false;
    if (contacts.length && !hasAnyScoring(contacts)){
      var deep = await enrichRecent(location, token, 40);
      if (deep.length){ contacts = deep; enriched = true; }
    }

    var leads = contacts.map(mapContact).sort(function(a,b){ return b.score - a.score; });

    var counts = { Hot:0, Warm:0, Nurture:0, Cold:0 };
    leads.forEach(function(l){ counts[l.band]++; });

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok:true, location: location, count: leads.length, counts: counts, source: enriched ? 'enriched' : 'search', leads: leads.slice(0, 50) });
  }catch(e){
    res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
};
