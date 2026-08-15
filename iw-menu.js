/* ============================================================
   IW Partner Portal — shared hamburger menu (upper right)
   Include on any portal page:
     <script src="iw-menu.js"></script>
   Optional, before the include:
     <script>window.IW_MENU_THEME='cream';</script>  // 'cream' lines (dark pages)
     <script>window.IW_MENU_THEME='ink';</script>    // dark lines (light pages)
   If not set, it picks based on the page background.
   Skips injection if the page already has its own #menuBtn.
   ============================================================ */
(function(){
  if (document.getElementById('menuBtn')) return;   /* page has its own menu */

  var EASE='cubic-bezier(0.22,1,0.36,1)';
  var theme=window.IW_MENU_THEME;
  if(!theme){
    try{
      var bg=getComputedStyle(document.body).backgroundColor.match(/\d+/g)||[255,255,255];
      var lum=(0.299*bg[0]+0.587*bg[1]+0.114*bg[2])/255;
      theme=lum<0.5?'cream':'ink';
    }catch(e){ theme='ink'; }
  }
  var line = theme==='cream' ? '#F2EEE7' : '#17110d';

  var css=''+
  '.iwm-btn{position:fixed;top:22px;right:26px;z-index:900;width:44px;height:44px;border:0;background:transparent;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:0}'+
  '.iwm-btn span{display:block;width:26px;height:2px;background:'+line+';border-radius:2px;transition:transform .45s '+EASE+',background .25s}'+
  '.iwm-btn:hover span{background:#C9A96E}'+
  '.iwm-btn.open span{background:#F2EEE7}'+
  '.iwm-btn.open span:nth-child(1){transform:translateY(4.5px) rotate(45deg)}'+
  '.iwm-btn.open span:nth-child(2){transform:translateY(-4.5px) rotate(-45deg)}'+
  '.iwm-overlay{position:fixed;inset:0;z-index:890;background:rgba(11,8,7,.98);display:flex;align-items:center;justify-content:center;opacity:0;visibility:hidden;transition:opacity .5s '+EASE+',visibility 0s .5s}'+
  '.iwm-overlay.open{opacity:1;visibility:visible;transition:opacity .5s '+EASE+'}'+
  '.iwm-nav{text-align:center;display:flex;flex-direction:column;gap:24px}'+
  '.iwm-label{font-family:Jost,system-ui,sans-serif;font-size:.7rem;font-weight:500;letter-spacing:.4em;text-transform:uppercase;color:#C9A96E;margin-bottom:4px}'+
  '.iwm-nav a{font-family:"Cormorant Garamond",Georgia,serif;font-weight:400;font-size:clamp(1.6rem,4.2vw,2.4rem);color:#F2EEE7;line-height:1.25;text-decoration:none;opacity:0;transform:translateY(-16px);transition:opacity .5s '+EASE+',transform .5s '+EASE+',color .25s}'+
  '.iwm-nav a:hover{color:#C9A96E}'+
  '.iwm-nav a.iwm-small{font-family:Jost,system-ui,sans-serif;font-weight:400;font-size:.84rem;letter-spacing:.22em;text-transform:uppercase;color:rgba(242,238,231,.75);margin-top:8px}'+
  '.iwm-nav a.iwm-small:hover{color:#C9A96E}'+
  '.iwm-overlay.open .iwm-nav a{opacity:1;transform:translateY(0)}'+
  '.iwm-overlay.open .iwm-nav a:nth-of-type(1){transition-delay:.06s}'+
  '.iwm-overlay.open .iwm-nav a:nth-of-type(2){transition-delay:.12s}'+
  '.iwm-overlay.open .iwm-nav a:nth-of-type(3){transition-delay:.18s}'+
  '.iwm-overlay.open .iwm-nav a:nth-of-type(4){transition-delay:.24s}'+
  '.iwm-overlay.open .iwm-nav a:nth-of-type(5){transition-delay:.30s}'+
  '.iwm-overlay.open .iwm-nav a:nth-of-type(6){transition-delay:.36s}'+
  '@media (max-width:900px), (pointer:coarse){.iwm-btn{width:76px;height:76px;top:max(calc(env(safe-area-inset-top,0px) + 8px),14px);right:8px;gap:11px;background:rgba(11,8,7,.8);border:1.5px solid rgba(201,169,110,.55);border-radius:50%;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}.iwm-btn span{width:38px;height:4px;background:#C9A96E}}'+
  '@media (display-mode: standalone) and (pointer:coarse){.iwm-btn{top:max(calc(env(safe-area-inset-top,0px) + 8px),54px)}}'+
  '@media (prefers-reduced-motion: reduce){.iwm-overlay,.iwm-nav a,.iwm-btn span{transition:none!important}.iwm-overlay.open .iwm-nav a{transform:none}}';

  var style=document.createElement('style');
  style.textContent=css;
  document.head.appendChild(style);

  var btn=document.createElement('button');
  btn.className='iwm-btn'; btn.id='menuBtn'; btn.type='button';
  btn.setAttribute('aria-label','Open menu'); btn.setAttribute('aria-expanded','false');
  btn.innerHTML='<span></span><span></span>';

  var overlay=document.createElement('div');
  overlay.className='iwm-overlay'; overlay.id='iwmOverlay';
  overlay.innerHTML=
    '<nav class="iwm-nav">'+
      '<div class="iwm-label">Implanted Wisdom</div>'+
      '<a href="portal.html">Dashboard</a>'+
      '<a href="onboarding.html">Onboarding</a>'+
      '<a href="surgeon-assessment.html">Surgeon Experience</a>'+
      '<a href="marketing-assessment.html">Current Marketing</a>'+
      '<a href="inner-circle-assessment.html">Inner Circle</a>'+
      '<a class="iwm-small" href="login.html" id="iwmLogout">Log out</a>'+
    '</nav>';

  function mount(){
    document.body.appendChild(btn);
    document.body.appendChild(overlay);
    /* portal topbar: clear space so the avatar/menu don't collide */
    var ctrl=document.querySelector('.topbar .topctrl');
    if(ctrl){ ctrl.style.marginRight='52px'; }
    var lo=document.getElementById('iwmLogout');
    if(lo){ lo.addEventListener('click',function(e){
      if(window.iwAuth){ e.preventDefault(); iwAuth.signOut(); }
    }); }
    function setMenu(open){
      btn.classList.toggle('open',open);
      overlay.classList.toggle('open',open);
      btn.setAttribute('aria-expanded',open?'true':'false');
    }
    btn.addEventListener('click',function(){ setMenu(!overlay.classList.contains('open')); });
    overlay.addEventListener('click',function(e){ if(e.target===overlay) setMenu(false); });
    document.addEventListener('keydown',function(e){ if(e.key==='Escape') setMenu(false); });
  }
  if(document.body){ mount(); } else { document.addEventListener('DOMContentLoaded',mount); }
})();
