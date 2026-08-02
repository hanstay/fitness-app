// Service-worker registration + "update available — tap to refresh" banner.
// Shared by every page. Replaces the old one-line register snippet.
// Pairs with sw.js: the new worker WAITS (no auto-skipWaiting) so we can prompt;
// tapping Refresh messages it to skipWaiting, then controllerchange reloads.
(function(){
  if(!('serviceWorker' in navigator)) return;
  var refreshing=false, accepted=false;

  // Reload ONLY after the user taps Refresh (not on the first-install claim, which
  // also fires controllerchange — reloading there would flash on the very first visit).
  navigator.serviceWorker.addEventListener('controllerchange',function(){
    if(!accepted || refreshing) return; refreshing=true; location.reload();
  });

  function showBanner(reg){
    if(document.getElementById('sw-update-banner')) return;
    var b=document.createElement('div');
    b.id='sw-update-banner';
    b.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:10000;background:#16c79a;color:#04130d;'+
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-weight:700;'+
      'font-size:.9rem;display:flex;align-items:center;gap:10px;padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px));'+
      'box-shadow:0 -2px 14px #0007;';
    var msg=document.createElement('span');
    msg.style.cssText='flex:1'; msg.textContent='Update available — a newer version was published.';
    var btn=document.createElement('button');
    btn.textContent='Refresh';
    btn.style.cssText='background:#04130d;color:#fff;border:0;border-radius:8px;padding:8px 16px;font-weight:700;'+
      'font-size:.88rem;cursor:pointer;font-family:inherit;flex:none;';
    btn.addEventListener('click',function(){
      accepted=true;
      var w=reg.waiting;
      if(w){ w.postMessage('skipWaiting'); }
      // Fallback if controllerchange doesn't fire (e.g. no waiting worker).
      setTimeout(function(){ if(!refreshing){ refreshing=true; location.reload(); } },600);
    });
    var close=document.createElement('button');
    close.textContent='✕'; close.setAttribute('aria-label','Dismiss');
    close.style.cssText='background:none;border:0;color:#04130d;font-size:1rem;cursor:pointer;flex:none;opacity:.7;';
    close.addEventListener('click',function(){ b.remove(); });
    b.appendChild(msg); b.appendChild(btn); b.appendChild(close);
    document.body.appendChild(b);
  }

  window.addEventListener('load',function(){
    navigator.serviceWorker.register('sw.js').then(function(reg){
      // A worker already downloaded and waiting from a previous visit.
      if(reg.waiting && navigator.serviceWorker.controller) showBanner(reg);
      // A new worker starts installing now.
      reg.addEventListener('updatefound',function(){
        var nw=reg.installing; if(!nw) return;
        nw.addEventListener('statechange',function(){
          if(nw.state==='installed' && navigator.serviceWorker.controller) showBanner(reg);
        });
      });
      // Force an update check on load and every time the app is re-opened/foregrounded.
      // The visibility check is the key fix for installed iOS PWAs, which resume a frozen
      // snapshot instead of re-fetching — this nudges them to look for a new sw.js.
      reg.update().catch(function(){});
      document.addEventListener('visibilitychange',function(){
        if(document.visibilityState==='visible') reg.update().catch(function(){});
      });
    }).catch(function(){});
  });
})();
