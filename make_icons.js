const { chromium } = require('playwright');
(async () => {
  const svg = s => `<html><body style="margin:0;background:#17191c"><svg width="${s}" height="${s}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" fill="#17191c"/>
  <rect y="150" width="512" height="70" fill="#2a2d33"/><rect y="220" width="512" height="70" fill="#202328"/>
  <rect y="290" width="512" height="70" fill="#2a2d33"/>
  <rect x="96" y="220" width="190" height="70" rx="6" fill="#e8890c"/>
  <rect x="286" y="150" width="130" height="70" rx="6" fill="#e8890c"/>
  <path d="M70 262 C130 250 170 268 230 252 L286 246 C300 200 330 190 350 186 C380 180 400 188 440 182" fill="none" stroke="#fff" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="440" y="0" width="72" height="512" fill="#c6cadb"/>
  <rect x="440" y="80" width="72" height="70" fill="#3ccf7a"/>
  <rect x="440" y="220" width="72" height="70" fill="#17191c"/><rect x="440" y="360" width="72" height="70" fill="#17191c"/>
  </svg></body></html>`;
  const b = await chromium.launch();
  for (const [name, s] of [['icon-192', 192], ['icon-512', 512], ['apple-touch-icon', 180]]) {
    const p = await b.newPage({ viewport: { width: s, height: s } });
    await p.setContent(svg(s)); await p.screenshot({ path: `icons/${name}.png` }); await p.close();
  }
  await b.close();
})();
