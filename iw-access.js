/* ============================================================
   Implanted Wisdom — role & practice access module (frontend)
   ------------------------------------------------------------
   Single source of truth for WHO can see WHAT in the portal.

   Roles:      iw_admin | practice_doctor | practice_staff
   Assignment: app_metadata on the auth user is authoritative
               (server-controlled — users cannot edit it):
                 { "iw_role": "practice_staff", "iw_practices": ["wmos"] }
               The DIRECTORY below is a development fallback for
               users whose app_metadata isn't set yet.

   This module is deliberately auth-provider-agnostic: it only
   needs { email, app_metadata } — swapping Supabase for Google
   Cloud Identity later means feeding it the same shape.

   NOTE: this is the UI layer of enforcement. The API layer
   (api/_lib/access.js) and database policies enforce the same
   matrix server-side. Frontend checks are UX, not security.
   ============================================================ */
(function(){

  var PRACTICES = {
    pulver: { name:'Pulver Oral Surgery · IW', tag:'Implanted Wisdom · Home Practice',
              accent:'#245C5C', ghl:'ua1JQW5n2yE3u80HvuUs' },
    wmos:   { name:'West Michigan Oral Surgery', tag:'Partner Practice',
              accent:'#7c5e3b', ghl:'' }   /* GHL id added when WMOS location exists */
  };

  /* dev fallback — remove entries as app_metadata gets set on each user */
  var DIRECTORY = {
    'skylar@pulveroralsurgery.com': { role:'iw_admin',        practices:['pulver','wmos'], label:'IW Admin' },
    'eric@implantedwisdom.com':     { role:'iw_admin',        practices:['pulver','wmos'], label:'Surgeon' },
    'wmos@iw.com':                  { role:'practice_doctor', practices:['wmos'] },
    /* test users for the role checklist */
    'doctor@wmos.test':             { role:'practice_doctor', practices:['wmos'] },
    'staff@wmos.test':              { role:'practice_staff',  practices:['wmos'] }
  };

  /* which roles may open which portal view (least privilege) */
  var VIEW_ACCESS = {
    dashboard:  ['iw_admin','practice_doctor','practice_staff'],
    leadscore:  ['iw_admin','practice_doctor','practice_staff'],
    comms:      ['iw_admin','practice_doctor','practice_staff'],
    appts:      ['iw_admin','practice_doctor','practice_staff'],
    consults:   ['iw_admin','practice_doctor','practice_staff'],
    casereview: ['iw_admin','practice_doctor'],                  /* PSP — never staff */
    smile:      ['iw_admin','practice_doctor'],                  /* clinical imagery */
    library:    ['iw_admin','practice_doctor','practice_staff'],
    setupguide: ['iw_admin','practice_doctor','practice_staff'],
    equipment:  ['iw_admin','practice_doctor'],
    labdeals:   ['iw_admin','practice_doctor'],
    program:    ['iw_admin','practice_doctor','practice_staff'],
    settings:   ['iw_admin','practice_doctor','practice_staff'],
    onboarding: ['iw_admin','practice_doctor','practice_staff']
  };

  var DEFAULT_LABEL = { iw_admin:'IW Admin', practice_doctor:'Surgeon', practice_staff:'Team' };
  /* map to the portal's legacy role names so existing renderers keep working */
  var LEGACY = { iw_admin:'owner', practice_doctor:'surgeon', practice_staff:'coordinator' };

  var state = { ready:false, role:null, label:'', practices:[], practiceId:null, email:null };

  function resolveProfile(user){
    if (!user) return null;
    var email = String(user.email||'').toLowerCase();
    var app = user.app_metadata || {};
    if (app.iw_role && Array.isArray(app.iw_practices) && app.iw_practices.length){
      return { role:String(app.iw_role), practices:app.iw_practices.slice(), label:app.iw_label||null, source:'app_metadata' };
    }
    var d = DIRECTORY[email];
    return d ? { role:d.role, practices:d.practices.slice(), label:d.label||null, source:'directory' } : null;
  }

  window.iwAccess = {
    PRACTICES: PRACTICES,
    /* initialise from an auth user; returns false if the user has no assignment */
    init: function(user){
      var p = resolveProfile(user);
      if (!p){ state.ready=false; return false; }
      state.role = p.role;
      state.label = p.label || DEFAULT_LABEL[p.role] || p.role;
      state.email = user.email || null;
      state.practices = p.practices.filter(function(id){ return PRACTICES[id]; });
      if (!state.practices.length) { state.ready=false; return false; }
      state.practiceId = state.practices[0];
      state.ready = true;
      this.audit('login', { role:state.role, practices:state.practices, source:p.source });
      return true;
    },
    ready: function(){ return state.ready; },
    role: function(){ return state.role; },
    label: function(){ return state.label; },
    legacyRole: function(){ return LEGACY[state.role] || 'coordinator'; },
    isAdmin: function(){ return state.role==='iw_admin'; },
    /* can this user open this portal view? */
    can: function(view){
      if (!state.ready) return false;
      var allowed = VIEW_ACCESS[view];
      return !!(allowed && allowed.indexOf(state.role) !== -1);
    },
    /* practices this user may see (admin: all configured) */
    assignedPractices: function(){
      return (state.role==='iw_admin' ? Object.keys(PRACTICES) : state.practices)
        .map(function(id){ var p=PRACTICES[id]; return { id:id, name:p.name, tag:p.tag, ghl:p.ghl, accent:p.accent }; });
    },
    canSwitchPractice: function(){ return this.assignedPractices().length > 1; },
    currentPractice: function(){
      var p = PRACTICES[state.practiceId];
      return p ? { id:state.practiceId, name:p.name, tag:p.tag, ghl:p.ghl, accent:p.accent } : null;
    },
    setPractice: function(id){
      var allowed = this.assignedPractices().some(function(p){ return p.id===id; });
      if (!allowed){ this.audit('practice_switch_denied',{ attempted:id }); return false; }
      state.practiceId = id;
      this.audit('practice_switch',{ to:id });
      return true;
    },
    /* audit hook — console for now; point at a logging endpoint later */
    audit: function(event, detail){
      try{ console.info('[iw-audit]', new Date().toISOString(), state.email||'anon', event, detail||{}); }catch(e){}
    }
  };
})();
