/* IW Portal service worker — app shell cache */
var CACHE='iw-app-v2';
var SHELL=['login.html','welcome.html','onboarding.html','portal.html',
  'surgeon-assessment.html','marketing-assessment.html','inner-circle-assessment.html',
  'iw-auth.js','iw-menu.js','iw-icon-192.png','iw-icon-512.png','manifest.webmanifest'];
self.addEventListener('install',function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(SHELL).catch(function(){}); }));
  self.skipWaiting();
});
self.addEventListener('activate',function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));
  }));
  self.clients.claim();
});
self.addEventListener('fetch',function(e){
  var url=new URL(e.request.url);
  if(e.request.method!=='GET') return;                     /* never touch uploads/submits */
  if(url.pathname.indexOf('/api/')>-1) return;             /* live data always network */
  if(url.origin!==location.origin) return;                 /* CDN/fonts: browser default */
  /* network-first for pages (so deploys show up), cache fallback offline */
  e.respondWith(
    fetch(e.request).then(function(r){
      var copy=r.clone();
      caches.open(CACHE).then(function(c){ c.put(e.request,copy); });
      return r;
    }).catch(function(){ return caches.match(e.request); })
  );
});
