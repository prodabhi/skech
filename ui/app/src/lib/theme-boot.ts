/**
 * Runs before paint, so the stored theme and palette are the first ones painted (src/app/layout.tsx). The
 * page's Content-Security-Policy allows it by its hash (src/proxy.ts), so any change here is allowed with it.
 */
export const THEME_BOOT = `(function(){try{var r=document.documentElement;var t=localStorage.getItem("theme");r.classList.toggle("dark",t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches);var s=JSON.parse(localStorage.getItem("skech:settings")||"{}");r.dataset.palette=s.palette||"classic"}catch(e){}})()`;
