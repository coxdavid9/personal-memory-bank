const TTL=15*60*1000;const cache=new Map();
function decodeXml(s=''){return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');}
function tag(block,name){const m=block.match(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+name+'>','i'));return m?decodeXml(m[1]).trim():'';}
function parseYahooRss(xml){return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m=>({title:tag(m[1],'title'),url:tag(m[1],'link'),publishedAt:tag(m[1],'pubDate'),source:tag(m[1],'source')||'Yahoo Finance'})).filter(x=>x.title);}
async function getTickerNews(ticker,limit=8){const key=String(ticker).toUpperCase();const c=cache.get(key);if(c&&c.expires>Date.now())return c.items.slice(0,limit);
 const url='https://feeds.finance.yahoo.com/rss/2.0/headline?s='+encodeURIComponent(key)+'&region=US&lang=en-US';
 const r=await fetch(url,{headers:{'User-Agent':'Personal-Agent/1.0','Accept':'application/rss+xml,application/xml,text/xml'},signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw new Error('Market news service returned '+r.status+'.');const items=parseYahooRss(await r.text());cache.set(key,{items,expires:Date.now()+TTL});return items.slice(0,limit);}
module.exports={parseYahooRss,getTickerNews};
