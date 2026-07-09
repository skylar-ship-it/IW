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

window.IW_SUPABASE_URL = "";       /* e.g. https://xxxx.supabase.co */
window.IW_SUPABASE_ANON_KEY = "";  /* e.g. eyJhbGciOi... (anon public) */

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
      return sb.auth.getSession().then(function(res){
        if(!res.data.session){ location.href = redirect || 'login.html'; return null; }
        return res.data.session;
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
    }
  };
})();
