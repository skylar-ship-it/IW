/* ============================================================
   IW Partner Portal — Call & Text Report Card
   Vercel serverless function.  URL: /api/comms?location=<id>
   ------------------------------------------------------------
   Pulls the most recent conversations from GoHighLevel and builds
   a per-lead communication report card:

     • calls: count, connected vs no-answer, last call time
     • transcript: pulled from GHL call transcription (recording ON)
     • texts: in/out counts, response-time, unanswered inbound
     • flags: rules-based coaching flags (e.g. price texted before
       consult, inbound text unanswered >24h, lead never called)
     • aiNotes: optional — if ANTHROPIC_API_KEY is set in Vercel,
       each transcript/text thread is graded by Claude. Without a
       key this field is simply omitted (rules still work).

   SECRETS (Vercel → Environment Variables):
     GHL_PULVER_TOKEN / GHL_PULVER_LOCATION   (already set)
     GHL_WMOS_TOKEN / GHL_WMOS_LOCATION       (later)
     SUPABASE_URL / SUPABASE_ANON             (login check)
     ANTHROPIC_API_KEY                        (optional AI grading)
   ============================================================ */

const CONVO_LIMIT = 20;       /* conversations per refresh */
const MSG_LIMIT   = 60;       /* messages per conversation */
const UNANSWERED_HOURS = 24;  /* inbound text with no reply flag */

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

function H(token, json){
  var h = { Authorization: 'Bearer ' + token, Version: '2021-07-28', Accept: 'application/json' };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

function ts(v){ if(v==null) return null; if(typeof v==='number') return v; var n=Date.parse(v); return isNaN(n)?null:n; }

function fmtCDT(ms){
  if (!ms) return null;
  try{
    return new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(ms))+' CDT';
  }catch(e){ return null; }
}

/* ---- fetch helpers ---- */
async function getConversations(location, token){
  var u = 'https://services.leadconnectorhq.com/conversations/search?locationId='+encodeURIComponent(location)+
          '&limit='+CONVO_LIMIT+'&sortBy=last_message_date&sort=desc';
  var r = await fetch(u, { headers: H(token) });
  if (!r.ok) return [];
  var j = await r.json();
  return j.conversations || [];
}

async function getMessages(convoId, token){
  var u = 'https://services.leadconnectorhq.com/conversations/'+encodeURIComponent(convoId)+'/messages?limit='+MSG_LIMIT;
  var r = await fetch(u, { headers: H(token) });
  if (!r.ok) return [];
  var j = await r.json();
  var m = (j.messages && j.messages.messages) || j.messages || [];
  return Array.isArray(m) ? m : [];
}

async function getTranscript(location, messageId, token){
  var u = 'https://services.leadconnectorhq.com/conversations/locations/'+encodeURIComponent(location)+
          '/messages/'+encodeURIComponent(messageId)+'/transcription';
  try{
    var r = await fetch(u, { headers: H(token) });
    if (!r.ok) return null;
    var j = await r.json();
    var segs = Array.isArray(j) ? j : (j.transcriptions || j.data || []);
    if (!segs.length) return null;
    var text = segs
      .sort(function(a,b){ return (a.sentenceIndex||0)-(b.sentenceIndex||0); })
      .map(function(s){ return (s.transcript||'').trim(); })
      .filter(Boolean).join(' ');
    return text || null;
  }catch(e){ return null; }
}

/* ---- optional AI grading (only if key present) ---- */
async function aiGrade(kind, content){
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key || !content) return null;
  var prompt = kind === 'call'
    ? 'You are a treatment-coordinator coach for a full-arch dental implant practice. Grade this call transcript. Reply in <=3 short bullet lines: 1) one thing done well, 2) one improvement, 3) grade A-F. Transcript:\n\n'
    : 'You are a treatment-coordinator coach for a full-arch dental implant practice. Review this SMS thread (out = practice, in = patient). Reply in <=3 short bullet lines: 1) one thing done well, 2) one improvement, 3) grade A-F. Thread:\n\n';
  try{
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'x-api-key': key, 'anthropic-version':'2023-06-01', 'content-type':'application/json' },
      body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:220,
        messages:[{ role:'user', content: prompt + content.slice(0, 6000) }] })
    });
    if (!r.ok) return null;
    var j = await r.json();
    var t = j.content && j.content[0] && j.content[0].text;
    return t ? t.trim() : null;
  }catch(e){ return null; }
}

/* ---- rules-based analysis ---- */
function analyze(convo, msgs, now){
  var calls=[], textsIn=0, textsOut=0, firstInbound=null, firstReplyAfterInbound=null;
  var lastInbound=null, lastOutbound=null, pricingTexted=false, thread=[];

  msgs.slice().reverse().forEach(function(m){          /* oldest → newest */
    var t = ts(m.dateAdded);
    var type = m.messageType || '';
    if (type === 'TYPE_CALL'){
      var meta = (m.meta && m.meta.call) || {};
      calls.push({ id: m.id, at: t, atCDT: fmtCDT(t), direction: m.direction,
                   status: meta.status || m.status || 'unknown', duration: meta.duration || null });
    } else if (type === 'TYPE_SMS' || type === 'TYPE_FACEBOOK' || type === 'TYPE_INSTAGRAM' || type === 'TYPE_LIVE_CHAT' || type === 'TYPE_WHATSAPP'){
      var body = (m.body||'').trim();
      if (m.direction === 'inbound'){
        textsIn++; lastInbound = t;
        if (!firstInbound) firstInbound = t;
      } else {
        textsOut++; lastOutbound = t;
        if (firstInbound && !firstReplyAfterInbound && t > firstInbound) firstReplyAfterInbound = t;
        if (/\$\s?\d{2}|\d{2},\d{3}|price|pricing|cost/i.test(body)) pricingTexted = true;
      }
      if (body) thread.push((m.direction==='inbound'?'in: ':'out: ') + body.slice(0,300));
    }
  });

  var connected = calls.filter(function(c){ return c.status==='completed' && (c.duration==null || c.duration>=30); }).length;
  var noAnswer  = calls.filter(function(c){ return /no-answer|busy|failed|voicemail/i.test(c.status||''); }).length;

  var responseMins = (firstInbound && firstReplyAfterInbound)
      ? Math.round((firstReplyAfterInbound - firstInbound)/60000) : null;

  var unansweredInbound = !!(lastInbound && (!lastOutbound || lastOutbound < lastInbound) &&
      (now - lastInbound) > UNANSWERED_HOURS*3600*1000);

  var flags = [];
  if (!calls.length && (textsIn+textsOut) > 0) flags.push({ level:'warn', text:'Never called — texts only. Full-arch closes on the phone.' });
  if (unansweredInbound) flags.push({ level:'bad', text:'Patient texted and has waited over '+UNANSWERED_HOURS+'h with no reply.' });
  if (responseMins != null && responseMins > 60) flags.push({ level:'warn', text:'First reply took '+Math.round(responseMins/60)+'h — aim for under 5 minutes.' });
  if (responseMins != null && responseMins <= 5) flags.push({ level:'good', text:'Fast first response ('+responseMins+' min) — this is what wins cases.' });
  if (pricingTexted) flags.push({ level:'warn', text:'Pricing was quoted over text — better saved for the consult where value is framed.' });
  if (connected > 0) flags.push({ level:'good', text: connected + ' live conversation'+(connected>1?'s':'')+' on the phone.' });

  return {
    contactId: convo.contactId,
    name: convo.fullName || convo.contactName || 'Lead',
    phone: convo.phone || null,
    lastMessageAt: convo.lastMessageDate || null,
    lastMessageCDT: fmtCDT(convo.lastMessageDate),
    calls: calls.length, connected: connected, noAnswer: noAnswer,
    callLog: calls.slice(-5),
    textsIn: textsIn, textsOut: textsOut,
    responseMins: responseMins,
    unansweredInbound: unansweredInbound,
    flags: flags,
    thread: thread.slice(-12),
    transcripts: []            /* filled below for recent calls */
  };
}

module.exports = async function handler(req, res){
  try{
    var location = (req.query && req.query.location) || process.env.GHL_PULVER_LOCATION;
    var token = tokenFor(location);
    if (!token){ res.status(400).json({ ok:false, error:'No token configured for this location.' }); return; }

    var okUser = await verifyLogin(req);
    if (!okUser){ res.status(401).json({ ok:false, error:'Not signed in.' }); return; }

    var now = Date.now();
    var convos = await getConversations(location, token);

    /* analyze each conversation (small concurrent batches) */
    var cards = [];
    for (var i=0;i<convos.length;i+=5){
      var batch = await Promise.all(convos.slice(i,i+5).map(async function(cv){
        var msgs = await getMessages(cv.id, token);
        var card = analyze(cv, msgs, now);

        /* transcripts for up to 2 most recent calls */
        var callMsgs = msgs.filter(function(m){ return m.messageType==='TYPE_CALL'; }).slice(0,2);
        for (var k=0;k<callMsgs.length;k++){
          var txt = await getTranscript(location, callMsgs[k].id, token);
          if (txt) card.transcripts.push({ at: fmtCDT(ts(callMsgs[k].dateAdded)), text: txt.slice(0, 2200) });
        }

        /* optional AI notes */
        if (process.env.ANTHROPIC_API_KEY){
          if (card.transcripts.length) card.aiNotes = await aiGrade('call', card.transcripts[0].text);
          else if (card.thread.length >= 2) card.aiNotes = await aiGrade('text', card.thread.join('\n'));
        }
        return card;
      }));
      cards = cards.concat(batch);
    }

    /* summary */
    var sum = {
      conversations: cards.length,
      calls: cards.reduce(function(s,c){ return s+c.calls; },0),
      connected: cards.reduce(function(s,c){ return s+c.connected; },0),
      textsIn: cards.reduce(function(s,c){ return s+c.textsIn; },0),
      textsOut: cards.reduce(function(s,c){ return s+c.textsOut; },0),
      unanswered: cards.filter(function(c){ return c.unansweredInbound; }).length,
      withTranscripts: cards.filter(function(c){ return c.transcripts.length; }).length,
      aiEnabled: !!process.env.ANTHROPIC_API_KEY
    };
    var respTimes = cards.map(function(c){ return c.responseMins; }).filter(function(v){ return v!=null; });
    sum.medianResponseMins = respTimes.length ? respTimes.sort(function(a,b){return a-b;})[Math.floor(respTimes.length/2)] : null;

    /* worst problems first */
    cards.sort(function(a,b){
      var ab=(b.unansweredInbound?2:0)+(b.flags.some(function(f){return f.level==='bad';})?1:0);
      var aa=(a.unansweredInbound?2:0)+(a.flags.some(function(f){return f.level==='bad';})?1:0);
      return ab-aa || (b.lastMessageAt||0)-(a.lastMessageAt||0);
    });

    res.setHeader('Cache-Control','no-store');
    res.status(200).json({ ok:true, location:location, generatedAtCDT: fmtCDT(now), summary: sum, cards: cards });
  }catch(e){
    res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
};
