/* ============================================================
   IW Portal — server-side authorization (shared by all API routes)
   ------------------------------------------------------------
   Frontend checks are UX. THIS is enforcement. Every API route:

     const { authorize } = require('./_lib/access.js');
     const auth = await authorize(req, 'psp');
     if (!auth.ok) { res.status(auth.status).json({ok:false,error:auth.error}); return; }
     // auth.location = the GHL location this user may query
     // auth.user     = { email, role, practices }

   Role/practice source of truth: the Supabase JWT's app_metadata
   (server-controlled). DIRECTORY is a dev fallback only.
   Swapping to Google Cloud later: replace verifyUser() with a
   Google Identity token check that returns the same shape.
   ============================================================ */

const PRACTICES = {
  pulver: { ghlEnv: 'GHL_PULVER_LOCATION' },
  wmos:   { ghlEnv: 'GHL_WMOS_LOCATION' }
};

/* dev fallback — mirror of iw-access.js; remove as app_metadata is set */
const DIRECTORY = {
  'skylar@pulveroralsurgery.com': { role:'iw_admin',        practices:['pulver','wmos'] },
  'eric@implantedwisdom.com':     { role:'iw_admin',        practices:['pulver','wmos'] },
  'wmos@iw.com':                  { role:'practice_doctor', practices:['wmos'] },
  'doctor@wmos.test':             { role:'practice_doctor', practices:['wmos'] },
  'staff@wmos.test':              { role:'practice_staff',  practices:['wmos'] }
};

const FEATURE_ACCESS = {
  leads:        ['iw_admin','practice_doctor','practice_staff'],
  comms:        ['iw_admin','practice_doctor','practice_staff'],
  appointments: ['iw_admin','practice_doctor','practice_staff'],
  consults:     ['iw_admin','practice_doctor','practice_staff'],
  notes:        ['iw_admin','practice_doctor','practice_staff'],
  nurture:      ['iw_admin','practice_doctor','practice_staff'],
  psp:          ['iw_admin','practice_doctor'],   /* PSP Case Review — never staff */
  analyze:      ['iw_admin','practice_doctor']    /* clinical AI on patient photos */
};

async function verifyUser(req){
  const url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON;
  if (!url || !anon) return null;                       /* auth not configured yet */
  const auth = req.headers['authorization'] || '';
  if (!auth) return false;
  try{
    const r = await fetch(url.replace(/\/$/,'') + '/auth/v1/user', { headers: { apikey: anon, Authorization: auth } });
    if (!r.ok) return false;
    return await r.json();
  }catch(e){ return false; }
}

function resolveProfile(user){
  const email = String(user.email||'').toLowerCase();
  const app = user.app_metadata || {};
  if (app.iw_role && Array.isArray(app.iw_practices) && app.iw_practices.length){
    return { role:String(app.iw_role), practices:app.iw_practices, source:'app_metadata' };
  }
  const d = DIRECTORY[email];
  return d ? { role:d.role, practices:d.practices, source:'directory' } : null;
}

function ghlOf(practiceId){
  const p = PRACTICES[practiceId];
  return p ? (process.env[p.ghlEnv] || null) : null;
}

function log(email, event, detail){
  /* audit-ready hook: swap console for a log sink later */
  try{ console.log(JSON.stringify({ t:new Date().toISOString(), who:email, event, ...detail })); }catch(e){}
}

async function authorize(req, feature){
  const user = await verifyUser(req);
  if (user === null){
    /* auth not configured (open preview) — allow, unrestricted, dev only */
    return { ok:true, user:{ email:'preview', role:'iw_admin', practices:Object.keys(PRACTICES) },
             location: (req.query && req.query.location) || process.env.GHL_PULVER_LOCATION };
  }
  if (!user){ return { ok:false, status:401, error:'Not signed in.' }; }

  const profile = resolveProfile(user);
  if (!profile){
    log(user.email,'authz_denied',{ reason:'no_assignment', feature });
    return { ok:false, status:403, error:'This login has no practice assignment.' };
  }

  const allowed = FEATURE_ACCESS[feature];
  if (allowed && allowed.indexOf(profile.role) === -1){
    log(user.email,'authz_denied',{ reason:'role', feature, role:profile.role });
    return { ok:false, status:403, error:'Your role does not have access to this feature.' };
  }

  /* resolve which GHL location this user may query */
  const practiceIds = profile.role === 'iw_admin' ? Object.keys(PRACTICES) : profile.practices;
  const allowedLocs = practiceIds.map(ghlOf).filter(Boolean);
  const requested = (req.query && req.query.location) || null;

  let location = null;
  if (requested){
    if (allowedLocs.indexOf(requested) === -1){
      log(user.email,'authz_denied',{ reason:'location', feature, requested });
      return { ok:false, status:403, error:'You are not assigned to that practice.' };
    }
    location = requested;
  } else {
    location = allowedLocs[0] || null;
  }

  log(user.email,'authz_ok',{ feature, role:profile.role, location });
  return { ok:true, user:{ email:user.email, role:profile.role, practices:practiceIds }, location };
}

module.exports = { authorize };
