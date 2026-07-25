/* ============================================================
   IW Partner Portal — TC notes & call log
   Vercel serverless function.  URL: /api/notes
   ------------------------------------------------------------
   Storage: Supabase Postgres table `portal_notes`
   (schema in IW_Portal_Database_Setup_EASY.md).

   GET  /api/notes?contact=<ghl-contact-id>   → notes for one lead
   GET  /api/notes?today=1                    → all notes since local midnight (for the daily report)
   POST /api/notes  {contact_id, contact_name, kind, body}
        kind = 'note' | 'call' | 'nurture'
        call bodies: 'Answered' | 'No answer' | 'Voicemail'

   SECRETS (Vercel env vars):
     SUPABASE_URL          = https://<project>.supabase.co
     SUPABASE_ANON         = publishable/anon key (login check)
     SUPABASE_SERVICE_ROLE = sb_secret_... key (server-only DB access)
   ============================================================ */

async function currentUser(req){
  var url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON;
  if (!url || !anon) return { email: 'preview' };            /* pilot fallback */
  var auth = req.headers['authorization'] || '';
  if (!auth) return null;
  try{
    var r = await fetch(url.replace(/\/$/,'') + '/auth/v1/user', { headers: { apikey: anon, Authorization: auth } });
    if (!r.ok) return null;
    var j = await r.json();
    return { email: j.email || (j.user && j.user.email) || 'partner' };
  }catch(e){ return null; }
}

function db(path){
  return process.env.SUPABASE_URL.replace(/\/$/,'') + '/rest/v1/' + path;
}
function dbHeaders(json){
  var k = process.env.SUPABASE_SERVICE_ROLE;
  var h = { apikey: k, Authorization: 'Bearer ' + k };
  if (json){ h['Content-Type'] = 'application/json'; h['Prefer'] = 'return=representation'; }
  return h;
}

/* midnight today in America/Chicago, as ISO */
function chicagoMidnightISO(){
  var now = new Date();
  var chi = new Date(now.toLocaleString('en-US', { timeZone:'America/Chicago' }));
  var offMs = now - chi;                       /* UTC minus Chicago wall-clock */
  var mid = new Date(chi.getFullYear(), chi.getMonth(), chi.getDate());
  return new Date(mid.getTime() + offMs).toISOString();
}

module.exports = async function handler(req, res){
  try{
    if (!process.env.SUPABASE_SERVICE_ROLE || !process.env.SUPABASE_URL){
      res.status(200).json({ ok:false, error:'Database not configured yet — add SUPABASE_SERVICE_ROLE in Vercel.', notes: [] });
      return;
    }
    var user = await currentUser(req);
    if (!user){ res.status(401).json({ ok:false, error:'Not signed in.' }); return; }

    if (req.method === 'GET'){
      var q = req.query || {};
      var url;
      if (q.contact){
        url = db('portal_notes') + '?contact_id=eq.' + encodeURIComponent(q.contact) + '&order=created_at.desc&limit=100';
      } else if (q.today){
        url = db('portal_notes') + '?created_at=gte.' + encodeURIComponent(chicagoMidnightISO()) + '&order=created_at.desc&limit=500';
      } else {
        url = db('portal_notes') + '?order=created_at.desc&limit=200';
      }
      var r = await fetch(url, { headers: dbHeaders() });
      if (!r.ok){ res.status(502).json({ ok:false, error:'DB error ' + r.status, detail:(await r.text()).slice(0,300) }); return; }
      res.setHeader('Cache-Control','no-store');
      res.status(200).json({ ok:true, notes: await r.json() });
      return;
    }

    if (req.method === 'POST'){
      var b = req.body || {};
      if (typeof b === 'string'){ try{ b = JSON.parse(b); }catch(e){ b = {}; } }
      if (!b.contact_id || !b.body){ res.status(400).json({ ok:false, error:'contact_id and body are required.' }); return; }
      var row = {
        contact_id: String(b.contact_id),
        contact_name: b.contact_name ? String(b.contact_name).slice(0,120) : null,
        kind: ['note','call','nurture','consult'].indexOf(b.kind) > -1 ? b.kind : 'note',
        body: String(b.body).slice(0, 4000),
        author: user.email
      };
      var r2 = await fetch(db('portal_notes'), { method:'POST', headers: dbHeaders(true), body: JSON.stringify(row) });
      if (!r2.ok){ res.status(502).json({ ok:false, error:'DB error ' + r2.status, detail:(await r2.text()).slice(0,300) }); return; }
      var saved = await r2.json();
      res.status(200).json({ ok:true, note: saved[0] || row });
      return;
    }

    res.status(405).json({ ok:false, error:'Method not allowed.' });
  }catch(e){
    res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
};
