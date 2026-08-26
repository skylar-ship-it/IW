/* ============================================================
   IW Partner Portal — one-click gentle-nurture enrollment
   Vercel serverless function.  URL: /api/nurture
   ------------------------------------------------------------
   POST /api/nurture  { contact_id, contact_name, location? }

   What it does:
     1. Adds the 'gentle-nurture' tag to the contact in GoHighLevel.
        → Your GHL workflow (trigger: Tag Added = gentle-nurture)
          starts the therapeutic email/SMS sequence.
     2. Logs the enrollment as a note in the portal database, so
        the daily report shows who enrolled whom, and when.

   SECRETS (Vercel env vars): GHL_PULVER_TOKEN, GHL_PULVER_LOCATION,
   SUPABASE_URL, SUPABASE_ANON, SUPABASE_SERVICE_ROLE.
   ============================================================ */
const { authorize } = require('./_lib/access.js');

const NURTURE_TAG = 'gentle-nurture';

async function currentUser(req){
  var url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON;
  if (!url || !anon) return { email: 'preview' };
  var auth = req.headers['authorization'] || '';
  if (!auth) return null;
  try{
    var r = await fetch(url.replace(/\/$/,'') + '/auth/v1/user', { headers: { apikey: anon, Authorization: auth } });
    if (!r.ok) return null;
    var j = await r.json();
    return { email: j.email || (j.user && j.user.email) || 'partner' };
  }catch(e){ return null; }
}

function tokenFor(location){
  var map = {};
  if (process.env.GHL_PULVER_LOCATION) map[process.env.GHL_PULVER_LOCATION] = process.env.GHL_PULVER_TOKEN;
  if (process.env.GHL_WMOS_LOCATION)   map[process.env.GHL_WMOS_LOCATION]   = process.env.GHL_WMOS_TOKEN;
  return map[location] || null;
}

module.exports = async function handler(req, res){
  try{
    if (req.method !== 'POST'){ res.status(405).json({ ok:false, error:'Method not allowed.' }); return; }

    var user = await currentUser(req);
    if (!user){ res.status(401).json({ ok:false, error:'Not signed in.' }); return; }
    var authz = await authorize(req, 'nurture');
    if (!authz.ok){ res.status(authz.status).json({ ok:false, error:authz.error }); return; }

    var b = req.body || {};
    if (typeof b === 'string'){ try{ b = JSON.parse(b); }catch(e){ b = {}; } }
    if (!b.contact_id){ res.status(400).json({ ok:false, error:'contact_id is required.' }); return; }

    var location = b.location || process.env.GHL_PULVER_LOCATION;
    var token = tokenFor(location);
    if (!token){ res.status(400).json({ ok:false, error:'No token configured for this location.' }); return; }

    /* 1 — add the tag in GHL (idempotent: adding twice is harmless) */
    var r = await fetch('https://services.leadconnectorhq.com/contacts/' + encodeURIComponent(b.contact_id) + '/tags', {
      method: 'POST',
      headers: { Authorization:'Bearer '+token, Version:'2021-07-28', 'Content-Type':'application/json', Accept:'application/json' },
      body: JSON.stringify({ tags: [NURTURE_TAG] })
    });
    if (!r.ok){
      var t = await r.text();
      res.status(502).json({ ok:false, error:'GoHighLevel error ' + r.status, detail: t.slice(0,300) });
      return;
    }

    /* 2 — log it in the portal database (best-effort) */
    if (process.env.SUPABASE_SERVICE_ROLE && process.env.SUPABASE_URL){
      try{
        var k = process.env.SUPABASE_SERVICE_ROLE;
        await fetch(process.env.SUPABASE_URL.replace(/\/$/,'') + '/rest/v1/portal_notes', {
          method:'POST',
          headers:{ apikey:k, Authorization:'Bearer '+k, 'Content-Type':'application/json' },
          body: JSON.stringify({
            contact_id: String(b.contact_id),
            contact_name: b.contact_name ? String(b.contact_name).slice(0,120) : null,
            kind: 'nurture',
            body: 'Enrolled in gentle nurture sequence',
            author: user.email
          })
        });
      }catch(e){ /* non-fatal */ }
    }

    res.status(200).json({ ok:true, tagged: NURTURE_TAG });
  }catch(e){
    res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
};
