/* ============================================================
   IW Partner Portal — post-consult reports + Kelly's review queue
   Vercel serverless function.  URL: /api/consults
   ------------------------------------------------------------
   Storage: Supabase Postgres table `consult_reports`
   (schema in IW_Portal_Database_Setup_EASY.md).

   No videos and no clinical detail are stored — this is a
   coaching self-report, kept deliberately PHI-light.

   GET   /api/consults                → newest 100 reports
   GET   /api/consults?status=Awaiting%20Review
   POST  /api/consults  {patient_ref, consult_date, outcome, went_well,
                         objections, next_step, self_score}
   PATCH /api/consults  {id, kelly_feedback, coach_score?} → marks Reviewed

   SECRETS (Vercel env vars): SUPABASE_URL, SUPABASE_ANON,
   SUPABASE_SERVICE_ROLE — same three as /api/notes.
   ============================================================ */

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

function db(path){
  return process.env.SUPABASE_URL.replace(/\/$/,'') + '/rest/v1/' + path;
}
function dbHeaders(json){
  var k = process.env.SUPABASE_SERVICE_ROLE;
  var h = { apikey: k, Authorization: 'Bearer ' + k };
  if (json){ h['Content-Type'] = 'application/json'; h['Prefer'] = 'return=representation'; }
  return h;
}

module.exports = async function handler(req, res){
  try{
    if (!process.env.SUPABASE_SERVICE_ROLE || !process.env.SUPABASE_URL){
      res.status(200).json({ ok:false, error:'Database not configured yet — add SUPABASE_SERVICE_ROLE in Vercel.', reports: [] });
      return;
    }
    var user = await currentUser(req);
    if (!user){ res.status(401).json({ ok:false, error:'Not signed in.' }); return; }

    if (req.method === 'GET'){
      var q = req.query || {};
      var url = db('consult_reports') + '?order=created_at.desc&limit=100';
      if (q.status) url += '&status=eq.' + encodeURIComponent(q.status);
      var r = await fetch(url, { headers: dbHeaders() });
      if (!r.ok){ res.status(502).json({ ok:false, error:'DB error ' + r.status, detail:(await r.text()).slice(0,300) }); return; }
      res.setHeader('Cache-Control','no-store');
      res.status(200).json({ ok:true, reports: await r.json() });
      return;
    }

    var b = req.body || {};
    if (typeof b === 'string'){ try{ b = JSON.parse(b); }catch(e){ b = {}; } }

    if (req.method === 'POST'){
      if (!b.patient_ref){ res.status(400).json({ ok:false, error:'patient_ref is required.' }); return; }
      var row = {
        patient_ref:  String(b.patient_ref).slice(0,120),
        contact_id:   b.contact_id ? String(b.contact_id) : null,
        tc_name:      user.email,
        consult_date: b.consult_date || null,
        outcome:      b.outcome ? String(b.outcome).slice(0,60) : null,
        went_well:    b.went_well ? String(b.went_well).slice(0,4000) : null,
        objections:   b.objections ? String(b.objections).slice(0,4000) : null,
        next_step:    b.next_step ? String(b.next_step).slice(0,2000) : null,
        self_score:   (b.self_score != null && !isNaN(+b.self_score)) ? Math.max(1, Math.min(5, +b.self_score)) : null,
        status: 'Awaiting Review'
      };
      var r2 = await fetch(db('consult_reports'), { method:'POST', headers: dbHeaders(true), body: JSON.stringify(row) });
      if (!r2.ok){ res.status(502).json({ ok:false, error:'DB error ' + r2.status, detail:(await r2.text()).slice(0,300) }); return; }
      var saved = await r2.json();
      res.status(200).json({ ok:true, report: saved[0] || row });
      return;
    }

    if (req.method === 'PATCH'){
      if (!b.id){ res.status(400).json({ ok:false, error:'id is required.' }); return; }
      var patch = {
        kelly_feedback: b.kelly_feedback ? String(b.kelly_feedback).slice(0,4000) : null,
        coach_score:    (b.coach_score != null && !isNaN(+b.coach_score)) ? Math.max(1, Math.min(5, +b.coach_score)) : null,
        status: 'Reviewed',
        reviewed_by: user.email,
        reviewed_at: new Date().toISOString()
      };
      var r3 = await fetch(db('consult_reports') + '?id=eq.' + encodeURIComponent(b.id), {
        method:'PATCH', headers: dbHeaders(true), body: JSON.stringify(patch)
      });
      if (!r3.ok){ res.status(502).json({ ok:false, error:'DB error ' + r3.status, detail:(await r3.text()).slice(0,300) }); return; }
      var updated = await r3.json();
      res.status(200).json({ ok:true, report: updated[0] || null });
      return;
    }

    res.status(405).json({ ok:false, error:'Method not allowed.' });
  }catch(e){
    res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
};
