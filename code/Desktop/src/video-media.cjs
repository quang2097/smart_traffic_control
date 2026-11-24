// Serve authenticated catalog videos through the app origin to keep canvas untainted.
function videoMedia(apiSession, getBackend) {
  const active = new Set();
  const error = status => new Response('', {status});
  return {
    cancelAll() { for (const controller of active) controller.abort(); active.clear(); },
    async handle(request) {
      const url = new URL(request.url), base = getBackend();
      if (!base || request.method !== 'GET' || url.search || !/^\/api\/demo\/videos\/[a-f0-9]{24}\/stream$/.test(url.pathname)) return error(403);
      const range = request.headers.get('Range');
      if (range && !/^bytes=\d*-\d*$/.test(range)) return error(400);
      const controller = new AbortController(); active.add(controller);
      const abort = () => controller.abort(); request.signal.addEventListener('abort',abort,{once:true});
      const cleanup = () => { active.delete(controller); request.signal.removeEventListener('abort',abort); };
      try {
        const response = await apiSession.fetch(base + url.pathname, { method:'GET',credentials:'include',redirect:'error',headers:range?{Range:range}:{},signal:controller.signal });
        if (![200,206].includes(response.status) || !/^video\/(mp4|webm)(;|$)/i.test(response.headers.get('content-type')||'') || !response.body) { await response.body?.cancel();cleanup();return error(response.status===401?401:502); }
        const reader = response.body.getReader(); let bytes=0;
        const body = new ReadableStream({
          async pull(target) { try { const result=await reader.read(); if(result.done){cleanup();target.close();return;} bytes+=result.value.length; if(bytes>2*1024**3 || base!==getBackend())throw new Error('Video stream limit');target.enqueue(result.value); } catch(error){controller.abort();cleanup();target.error(error);} },
          async cancel(){controller.abort();cleanup();await reader.cancel().catch(()=>{});},
        });
        const headers = new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
        for(const key of ['Content-Type','Content-Length','Content-Range','Accept-Ranges']) { const value=response.headers.get(key);if(value)headers.set(key,value); }
        return new Response(body,{status:response.status,headers});
      }catch{controller.abort();cleanup();return error(502);}
    },
  };
}
module.exports={videoMedia};
