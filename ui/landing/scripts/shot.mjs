/**
 * Screenshots one section at native scale, scrolled into view.
 *
 *   bun scripts/shot.mjs <url> <selector> <out.png> [width]
 *
 * Full-page captures get downscaled for review, which quietly hides hairlines, * a 1.5px stroke vanishes at 2x reduction and reads as a rendering bug that
 * isn't there. Reviewing a section at 1:1 avoids that. Scrolling also lets the
 * scroll-triggered strokes actually fire.
 */
const [url, sel, out, w = "1440"] = process.argv.slice(2);
const WIDTH = Number(w);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9600 + Math.floor(Math.random()*150);
const proc = Bun.spawn([CHROME,"--headless","--disable-gpu","--hide-scrollbars",`--remote-debugging-port=${PORT}`,`--window-size=${WIDTH},900`,"--user-data-dir=/tmp/skech-shotat","about:blank"],{stdout:"ignore",stderr:"ignore"});
async function ep(){for(let i=0;i<120;i++){try{const t=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const p=t.find(x=>x.type==="page");if(p?.webSocketDebuggerUrl)return p.webSocketDebuggerUrl;}catch{}await Bun.sleep(100);}throw new Error("no ep");}
const ws=new WebSocket(await ep());await new Promise(r=>ws.addEventListener("open",r,{once:true}));
let id=0;const pend=new Map();
ws.addEventListener("message",e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}});
const send=(m,p={})=>new Promise(r=>{id++;pend.set(id,r);ws.send(JSON.stringify({id,method:m,params:p}));});
await send("Page.enable");await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride",{width:WIDTH,height:900,deviceScaleFactor:2,mobile:WIDTH<768});
await send("Page.navigate",{url});await Bun.sleep(2000);
await send("Runtime.evaluate",{expression:`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({block:"start"})`});
await Bun.sleep(3000);
const s=await send("Page.captureScreenshot",{format:"png"});
await Bun.write(out, Buffer.from(s.result.data,"base64"));
console.log("ok", out);
ws.close();proc.kill();
