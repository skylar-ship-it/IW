/* ============================================================
   IW Partner Portal — AI Analysis for the PSP Esthetic &
   Functional Workup.  POST /api/analyze
   ------------------------------------------------------------
   Receives the labeled photo series (base64 JPEGs, resized in the
   browser) and returns structured ESTIMATES matching the workup
   form fields. Estimates only — the surgeon verifies everything.

   Requires (Vercel → Environment Variables):
     ANTHROPIC_API_KEY   — enables this + call coaching
     SUPABASE_URL / SUPABASE_ANON — login check (already set)
   ============================================================ */
const { authorize } = require('./_lib/access.js');

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

const FIELD_SPEC = `
Return ONLY a JSON object, no other text. Shape (include "views" only if asked to classify):
{"views":{"Photo 1":"<view name>", ...}, "estimates": { <field label>: <value>, ... }, "summary": "<2-3 sentence overall esthetic impression>", "cautions": "<1-2 sentences on photo-quality limits or low-confidence items>"}

Allowed field labels and their value rules (include ONLY fields you can genuinely assess from the provided photos; omit anything uncertain):
- "Tooth show at rest (mm)": number, 0-6, steps of 0.5
- "Tooth show at max smile (mm)": number, 0-14, steps of 0.5
- "Gingiva show at full smile (mm)": number, 0-8, steps of 0.5
- "Maxillary midline": exactly one of "On with facial midline" | "Move to left" | "Move to right"
- "Maxillary midline move (mm)": number, only if midline is off
- "Mandibular midline on": "Yes" | "No" (only if lower dentition visible)
- "Mandibular CANT": "Yes" | "No" (the tongue-blade view is for this)
- "Gingival progression R symmetrical": "Yes" | "No"
- "Gingival progression L symmetrical": "Yes" | "No"
- "Upper lip support": "Normal" | "Deficient" | "Excessive"
- "Incisal edge horizontal": "Good" | "Move forward" | "Move back" (profile view)
- "Incisal edge move (mm)": number, only if not Good
- "Buccal corridor left": "Good" | "Widen" | "Narrow"
- "Buccal corridor left (mm)": number, only if not Good
- "Buccal corridor right": "Good" | "Widen" | "Narrow"
- "Buccal corridor right (mm)": number, only if not Good
- "Tooth shape": "Square" | "Ovoid" | "Tapered" | "Square-tapered"
- "Level plane of occlusion": "Yes" | "No" (only if clearly visible)
- "Curve of Spee excessive": "Yes" | "No" (only if clearly visible)

NEVER estimate: overjet, overbite, vertical dimension, bone loss, soft tissue loss, opposing dentition stability — these require scans or clinical exam. Calibrate mm estimates against average maxillary central incisor width (~8.5 mm). These are photographic estimates for the surgeon to verify, not measurements.`;

module.exports = async function handler(req, res){
  try{
    if (req.method !== 'POST'){ res.status(405).json({ ok:false, error:'POST only' }); return; }
    var key = process.env.ANTHROPIC_API_KEY;
    if (!key){ res.status(503).json({ ok:false, error:'AI Analysis is not enabled yet — the IW team is activating it.' }); return; }

    var auth = await authorize(req, 'analyze');
    if (!auth.ok){ res.status(auth.status).json({ ok:false, error:auth.error }); return; }

    var body = req.body || {};
    var images = Array.isArray(body.images) ? body.images.slice(0, 10) : [];
    if (!images.length){ res.status(400).json({ ok:false, error:'No photos provided.' }); return; }

    var content = [];
    images.forEach(function(img){
      if (!img || !img.data) return;
      content.push({ type:'text', text:'View: ' + String(img.label||'unlabeled').slice(0,80) });
      content.push({ type:'image', source:{ type:'base64', media_type:'image/jpeg', data: String(img.data) } });
    });
    var classify = !!body.classify;
    var classifySpec = classify ? (
      'FIRST, classify EVERY photo above into exactly one view. In your JSON include "views": an object mapping each photo label (e.g. "Photo 1") to exactly one of: '+
      '"Frontal full face — in repose" | "Maximum smile" | "Exaggerated smile" | "Tongue blade (horizontal) — CANT" | "Profile view" | "Left lateral" | "Right lateral" | "Miscellaneous" | "Unreadable". '+
      'Use "Unreadable" only when the photo is too blurry, dark, or off-subject to use clinically. THEN produce the estimates.\n') : '';
    content.push({ type:'text', text:
      'You are a prosthodontic treatment-planning assistant supporting a full-arch (All-on-X) esthetic and functional workup. '+
      'The patient arch under consideration: ' + String(body.arch||'unspecified') + '. '+
      classifySpec +
      'Analyze the photos above and estimate what you can for the workup form.\n' + FIELD_SPEC });

    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'x-api-key': key, 'anthropic-version':'2023-06-01', 'content-type':'application/json' },
      body: JSON.stringify({ model:'claude-sonnet-5', max_tokens:1200,
        messages:[{ role:'user', content: content }] })
    });
    if (!r.ok){
      var t = await r.text();
      res.status(502).json({ ok:false, error:'Analysis service error ' + r.status, detail:t.slice(0,200) });
      return;
    }
    var j = await r.json();
    var text = (j.content && j.content[0] && j.content[0].text) || '';
    var m = text.match(/\{[\s\S]*\}/);
    if (!m){ res.status(500).json({ ok:false, error:'Could not read the analysis result.' }); return; }
    var parsed;
    try{ parsed = JSON.parse(m[0]); }catch(e){ res.status(500).json({ ok:false, error:'Analysis result was malformed.' }); return; }

    res.setHeader('Cache-Control','no-store');
    res.status(200).json({ ok:true,
      views: parsed.views || null,
      estimates: parsed.estimates || {},
      summary: parsed.summary || '',
      cautions: parsed.cautions || '' });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
};
