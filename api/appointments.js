/* ============================================================
   IW Partner Portal — Appointments feed
   Vercel serverless function.  URL: /api/appointments?location=<id>
   ------------------------------------------------------------
   Primary source: calendar events for the location (last 7 days
   through the next 60). If the calendar API returns nothing —
   which happens on some location configurations — falls back to
   scanning recent conversations for appointment activity.

   SECRETS (Vercel → Environment Variables):
     GHL_PULVER_TOKEN / GHL_PULVER_LOCATION   (already set)
     GHL_WMOS_TOKEN / GHL_WMOS_LOCATION       (later)
     SUPABASE_URL / SUPABASE_ANON             (login check)
   ============================================================ */
const { authorize } = require('./_lib/access.js');

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

function H(token){
  return { Authorization: 'Bearer ' + token, Version: '2021-04-15', Accept: 'application/json' };
}

function ts(v){ if(v==null) return null; if(typeof v==='number') return v; var n=Date.parse(v); return isNaN(n)?null:n; }

function fmtCT(ms, withDay){
  if (!ms) return null;
  try{
    var opts = withDay
      ? {timeZone:'America/Chicago',weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}
      : {timeZone:'America/Chicago',hour:'numeric',minute:'2-digit'};
    return new Intl.DateTimeFormat('en-US',opts).format(new Date(ms));
  }catch(e){ return null; }
}
function dayKeyCT(ms){
  try{
    return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));
  }catch(e){ return ''; }
}

async function getCalendars(location, token){
  try{
    var r = await fetch('https://services.leadconnectorhq.com/calendars/?locationId='+encodeURIComponent(location), { headers: H(token) });
    if (!r.ok) return [];
    var j = await r.json();
    return j.calendars || [];
  }catch(e){ return []; }
}

async function getEvents(location, token, startMs, endMs, calendarId){
  var u = 'https://services.leadconnectorhq.com/calendars/events?locationId='+encodeURIComponent(location)+
          '&startTime='+startMs+'&endTime='+endMs+(calendarId?('&calendarId='+encodeURIComponent(calendarId)):'');
  try{
    var r = await fetch(u, { headers: H(token) });
    if (!r.ok) return [];
    var j = await r.json();
    return j.events || j.appointments || [];
  }catch(e){ return []; }
}

async function getContactName(id, token, cache){
  if (!id) return null;
  if (cache[id] !== undefined) return cache[id];
  try{
    var r = await fetch('https://services.leadconnectorhq.com/contacts/'+encodeURIComponent(id), { headers: { Authorization:'Bearer '+token, Version:'2021-07-28', Accept:'application/json' } });
    if (!r.ok){ cache[id]=null; return null; }
    var j = await r.json();
    var c = j.contact || j;
    var name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.contactName || null;
    cache[id] = { name: name, phone: c.phone || null };
    return cache[id];
  }catch(e){ cache[id]=null; return null; }
}

/* fallback: appointment activity inside recent conversations */
async function fromConversations(location, token){
  try{
    var r = await fetch('https://services.leadconnectorhq.com/conversations/search?locationId='+encodeURIComponent(location)+
      '&limit=20&sortBy=last_message_date&sort=desc', { headers: { Authorization:'Bearer '+token, Version:'2021-07-28', Accept:'application/json' } });
    if (!r.ok) return [];
    var j = await r.json();
    var convos = j.conversations || [];
    var out = [];
    for (var i=0;i<convos.length;i++){
      var cv = convos[i];
      try{
        var mr = await fetch('https://services.leadconnectorhq.com/conversations/'+encodeURIComponent(cv.id)+'/messages?limit=40',
          { headers: { Authorization:'Bearer '+token, Version:'2021-07-28', Accept:'application/json' } });
        if (!mr.ok) continue;
        var mj = await mr.json();
        var msgs = (mj.messages && mj.messages.messages) || mj.messages || [];
        (Array.isArray(msgs)?msgs:[]).forEach(function(m){
          if (m.messageType === 'TYPE_ACTIVITY_APPOINTMENT'){
            out.push({
              id: m.id,
              title: (m.body||'Appointment').slice(0,140),
              who: cv.fullName || cv.contactName || 'Lead',
              phone: cv.phone || null,
              startMs: ts(m.dateAdded),
              endMs: null,
              status: 'scheduled',
              source: 'activity'
            });
          }
        });
      }catch(e){}
    }
    return out;
  }catch(e){ return []; }
}

module.exports = async function handler(req, res){
  try{
    var auth = await authorize(req, 'appointments');
    if (!auth.ok){ res.status(auth.status).json({ ok:false, error:auth.error }); return; }
    var location = auth.location;
    var token = tokenFor(location);
    if (!token){ res.status(400).json({ ok:false, error:'No scheduler configured for this practice yet.' }); return; }

    var now = Date.now();
    var startMs = now - 7*24*3600*1000, endMs = now + 60*24*3600*1000;

    /* primary: every calendar in the location */
    var cals = await getCalendars(location, token);
    var calName = {};
    cals.forEach(function(c){ calName[c.id] = c.name; });

    var raw = [];
    if (cals.length){
      for (var i=0;i<cals.length;i++){
        var evs = await getEvents(location, token, startMs, endMs, cals[i].id);
        raw = raw.concat(evs);
      }
    } else {
      raw = await getEvents(location, token, startMs, endMs, null);
    }

    var events = [];
    var cache = {};
    for (var k=0;k<Math.min(raw.length,60);k++){
      var e = raw[k];
      var st = ts(e.startTime), en = ts(e.endTime);
      var who = e.contactName || e.title || null, phone = null;
      if (e.contactId){
        var c = await getContactName(e.contactId, token, cache);
        if (c){ who = c.name || who; phone = c.phone; }
      }
      events.push({
        id: e.id,
        title: e.title || calName[e.calendarId] || 'Appointment',
        calendar: calName[e.calendarId] || null,
        who: who || 'Patient',
        phone: phone,
        contactId: e.contactId || null,
        startMs: st, endMs: en,
        status: (e.appointmentStatus || e.status || 'confirmed').toLowerCase(),
        source: 'calendar'
      });
    }

    /* fallback if the calendar API gave us nothing */
    if (!events.length){
      events = await fromConversations(location, token);
    }

    events = events.filter(function(e){ return e.startMs; });
    events.sort(function(a,b){ return a.startMs-b.startMs; });
    events.forEach(function(e){
      e.startCT = fmtCT(e.startMs, true);
      e.timeCT  = fmtCT(e.startMs, false) + (e.endMs?('–'+fmtCT(e.endMs,false)):'');
      e.dayKey  = dayKeyCT(e.startMs);
    });

    var todayKey = dayKeyCT(now);
    var weekEnd = now + 7*24*3600*1000;
    var sum = {
      today: events.filter(function(e){ return e.dayKey===todayKey && e.startMs>=now-12*3600*1000; }).length,
      week: events.filter(function(e){ return e.startMs>=now && e.startMs<=weekEnd; }).length,
      upcoming: events.filter(function(e){ return e.startMs>=now; }).length,
      cancelled: events.filter(function(e){ return /cancel/.test(e.status); }).length,
      source: events.length ? events[0].source : 'none'
    };

    res.setHeader('Cache-Control','no-store');
    res.status(200).json({ ok:true, location:location, generatedCT: fmtCT(now,true), summary: sum, events: events });
  }catch(e){
    res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
};
