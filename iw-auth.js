/* ============================================================
   Implanted Wisdom — Partner Portal auth (Supabase)
   ------------------------------------------------------------
   SETUP (one time, ~5 min):
   1. Create a free project at https://supabase.com
   2. Project Settings → API → copy "Project URL" and the
      "anon public" key.
   3. Paste them below. (The anon key is SAFE to ship in the
      page — it only allows what your Row-Level-Security rules
      permit. Never paste the "service_role" key here.)
   4. Auth → Providers → enable Email. For invite-only access,
      Auth → turn OFF "Allow new users to sign up" and create
      partners yourself under Auth → Users (or via invite).
   5. (Optional) create a table "access_requests" for the
      Request Access form:
        create table access_requests (
          id uuid default gen_random_uuid() primary key,
          created_at timestamptz default now(),
          practice text, name text, email text, role text, surgeons text
        );
        alter table access_requests enable row level security;
        create policy "anon can insert" on access_requests
          for insert to anon with check (true);

   Until URL + key are filled in, the portal falls back to the
   open preview (any credentials) so demos keep working.
   ============================================================ */

window.IW_SUPABASE_URL = "https://ntyrmagxwvtnknswofku.supabase.co";
window.IW_SUPABASE_ANON_KEY = "sb_publishable_pigfbwaBd8NyTmhr68tAkA_qyjRgnj-";  /* publishable key — safe to ship. NEVER put the sb_secret_ key here. */

window.iwAuth = (function(){
  var sb = null, ready = false;
  try{
    if (window.IW_SUPABASE_URL && window.IW_SUPABASE_ANON_KEY && window.supabase) {
      sb = window.supabase.createClient(window.IW_SUPABASE_URL, window.IW_SUPABASE_ANON_KEY);
      ready = true;
    }
  }catch(e){ ready = false; }

  return {
    enabled: function(){ return ready; },
    client:  function(){ return sb; },

    /* redirect to login if no active session (only when configured) */
    requireSession: function(redirect){
      if(!ready) return Promise.resolve(null);
      var dest = redirect || 'login.html';
      return sb.auth.getSession().then(function(res){
        if(!res.data.session){ location.href = dest; return null; }
        /* if 2FA is enrolled but not yet satisfied this session, block */
        return sb.auth.mfa.getAuthenticatorAssuranceLevel().then(function(a){
          if(a && a.data && a.data.nextLevel==='aal2' && a.data.currentLevel!=='aal2'){ location.href = dest; return null; }
          return res.data.session;
        }).catch(function(){ return res.data.session; });
      });
    },

    signIn: function(email, pw){
      if(!ready) return Promise.resolve({ fallback:true });
      return sb.auth.signInWithPassword({ email:email, password:pw });
    },

    signOut: function(){
      var go = function(){ location.href = 'login.html'; };
      if(ready){ sb.auth.signOut().then(go, go); } else { go(); }
    },

    requestAccess: function(payload){
      if(!ready) return Promise.resolve({ fallback:true });
      return sb.from('access_requests').insert(payload);
    },

    currentUser: function(){
      if(!ready) return Promise.resolve(null);
      return sb.auth.getUser().then(function(res){ return res.data.user; });
    },

    /* the signed-in user's access token — sent to /api/leads so the
       server can confirm this is a real logged-in partner before
       returning any patient data */
    accessToken: function(){
      if(!ready) return Promise.resolve(null);
      return sb.auth.getSession().then(function(res){
        return res.data.session ? res.data.session.access_token : null;
      }).catch(function(){ return null; });
    },

    /* ---- Two-factor (TOTP / authenticator app) ---- */
    /* Assurance level: tells us if a signed-in user still owes a 2FA code */
    aal: function(){
      if(!ready) return Promise.resolve(null);
      return sb.auth.mfa.getAuthenticatorAssuranceLevel();
    },
    listFactors: function(){
      if(!ready) return Promise.resolve({data:{totp:[]}});
      return sb.auth.mfa.listFactors();
    },
    challenge: function(factorId){
      return sb.auth.mfa.challenge({ factorId: factorId });
    },
    verify: function(factorId, challengeId, code){
      return sb.auth.mfa.verify({ factorId: factorId, challengeId: challengeId, code: code });
    },
    /* enrollment: returns a QR (SVG data-URI) + secret to show the user */
    enroll: function(){
      return sb.auth.mfa.enroll({ factorType: 'totp' });
    },
    unenroll: function(factorId){
      return sb.auth.mfa.unenroll({ factorId: factorId });
    }
  };
})();
