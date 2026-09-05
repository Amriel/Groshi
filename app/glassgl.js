// <glass-gl> — physically-modelled liquid glass for DOM panels.
// It paints the scene UNDER the glass (background) itself, then renders every
// [data-glass] element in the document as a refracting slab at its live rect.
(() => {
  const VS = 'attribute vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }';
  const MAX = 26;
  const FS = `
precision highp float;
uniform vec2 uRes;
uniform vec4 uRects[${MAX}];
uniform float uRadii[${MAX}];
uniform int uCount;
uniform float uIOR, uThick, uFrost, uTint, uLightA, uShadow, uGlint, uTransmit, uMilk, uLightPow, uBg, uBevelHard, uGlintFall, uHot, uHotHard, uGlintSpread, uGlintNoise;
uniform float uShadowSoft, uTransmitSoft, uTrOff, uTrAng, uTrSize, uTrStretch, uTrAbs, uShadowA, uGlintA, uAmb;
uniform sampler2D uScene;
uniform vec2 uPaneOff;


float sdBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return min(max(q.x,q.y),0.0) + length(max(q,0.0)) - r; }
/* Полотно НЕРУХОМЕ і прибите до вікна, тому сцена читається просто за
   координатою пікселя — фон не може поїхати за прокруткою в принципі.
   Рухаються натомість самі ПЛИТИ: їх зсуває uPaneOff, і разом із ними
   зсувається карта тіней та каустик. Так фон стоїть, а скло лишається
   приклеєним до своїх панелей. */
vec3 tex(vec2 px){ return texture2D(uScene, clamp(px / uRes, 0.0, 1.0)).rgb; }

float caustic(vec2 p){
  float n  = sin(p.x * 0.0075 + p.y * 0.005) * sin(p.y * 0.006 - p.x * 0.0035);
  n += 0.4 * sin((p.x + p.y * 1.3) * 0.011 + 1.2);
  return clamp(0.9 + 0.16 * n, 0.65, 1.15);
}

// every slab casts a shadow and pools the light it transmits onto the surface below
float h21(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1,0)), f.x),
             mix(h21(i + vec2(0,1)), h21(i + vec2(1,1)), f.x), f.y);
}
float fbm2(vec2 p){ return vnoise(p) * 0.62 + vnoise(p * 2.17 + 8.3) * 0.38; }

// point and outward normal at arc-length position sd along a rounded rect's rim
void rimAt(float sd, vec2 inr, float rr, out vec2 p, out vec2 n){
  float ax = 2.0 * inr.x, ay = 2.0 * inr.y, ar = 1.5707963 * rr;
  float u = sd;
  if (u < ay){                p = vec2(inr.x + rr, -inr.y + u);        n = vec2(1.0, 0.0); return; } u -= ay;
  if (u < ar){ float a = (ar > 0.0 ? u / max(rr, 1e-4) : 0.0); n = vec2(cos(a), sin(a)); p = inr + rr * n; return; } u -= ar;
  if (u < ax){                p = vec2(inr.x - u, inr.y + rr);         n = vec2(0.0, 1.0); return; } u -= ax;
  if (u < ar){ float a = 1.5707963 + u / max(rr, 1e-4); n = vec2(cos(a), sin(a)); p = vec2(-inr.x, inr.y) + rr * n; return; } u -= ar;
  if (u < ay){                p = vec2(-inr.x - rr, inr.y - u);        n = vec2(-1.0, 0.0); return; } u -= ay;
  if (u < ar){ float a = 3.1415927 + u / max(rr, 1e-4); n = vec2(cos(a), sin(a)); p = -inr + rr * n; return; } u -= ar;
  if (u < ax){                p = vec2(-inr.x + u, -inr.y - rr);       n = vec2(0.0, -1.0); return; } u -= ax;
  float a = 4.712389 + u / max(rr, 1e-4); n = vec2(cos(a), sin(a)); p = vec2(inr.x, -inr.y) + rr * n;
}

vec2 nrmDir(vec2 q, vec2 hs, float rr){
  vec2 inner = max(vec2(0.0), hs - rr);
  vec2 n = q - clamp(q, -inner, inner);
  float l = length(n);
  return l > 0.0001 ? n / l : vec2(0.0);
}

/* Тінь і зібране світло рахуються АНАЛІТИЧНО тут же, з тих самих
   прямокутників, що й самі плити. Раніше їх трасував CPU у карту-текстуру
   (~300 мс на кожну зміну розкладки) — і карта завжди спізнювалась за
   вмістом: «тіні доїжджають» було невиліковним наслідком архітектури.
   Аналітичне світло зшите з геометрією в тому самому кадрі за побудовою:
   переходів не існує. Ціна — простіші тіні (без справжніх каустик),
   але це чесна ціна за мертву тишу кадру. */
float gOcc = 0.0;   // скільки прямого світла тут перехопили плити
float gPho = 0.0;   // скільки пропущеного світла сюди стеклось

vec3 lit(vec2 px, vec2 ldir){
  float photons = gPho;
  float direct = 1.0 - uShadow * gOcc + uTransmit * uLightPow * photons;
  // real scenes are also lit by the whole sky, which is what keeps a contact shadow from
  // going black — without it the directional term alone drops to nothing at the contact
  float illum = uAmb + (1.0 - uAmb) * direct;
  vec3 col = tex(px) * uBg * max(0.0, illum);
  // refracted light carries a faint spread of colour where it piles up
  col += caustic(px + uPaneOff) * 0.10 * max(0.0, photons - gOcc);
  return col;
}

/* Один прохід по плитах: м'яка тінь, зсунута за напрямком світла, і
   смуга «зібраного» світла з протилежного боку — груба, але правильна
   форма того, що давало трасування. */
void lightField(vec2 pxG, vec2 ldir){
  float pen = 26.0 + 120.0 * uShadowSoft;            // широка півтінь: тінь, а не двійник
  vec2 off = ldir * (10.0 + uThick * 0.4);
  float occ = 0.0, pho = 0.0;
  for (int i = 0; i < ${MAX}; i++){
    if (i >= uCount) break;
    vec4 R = uRects[i];
    /* Дрібні елементи (чіпи, кнопки) тіні не кидають: їхні зсунуті
       сірі копії читались як бруд, а не як світло. Тінь — привілей
       великих панелей. */
    float wSize = smoothstep(22.0, 60.0, min(R.z, R.w));
    if (wSize <= 0.0) continue;
    /* Плита не затіняє власний пʼятачок: крізь скло її тінь була б
       видна як загальне потемніння всієї панелі (світла тема ставала
       сірим пластиком). Контактна тінь живе ЗОВНІ, по краях. */
    float dHere = sdBox(pxG - R.xy, R.zw, uRadii[i]);
    float ds = sdBox(pxG + off - R.xy, R.zw, uRadii[i]);
    if (dHere > 0.0) occ = max(occ, wSize * (1.0 - smoothstep(-pen * 0.4, pen, ds)));
    float dp = sdBox(pxG - off - R.xy, R.zw, uRadii[i]);
    if (dp > 0.0) pho += wSize * exp(-dp / max(pen, 10.0)) * 0.35;
  }
  gOcc = occ;
  gPho = min(pho, 1.0) * 0.33;
}

vec3 litBlur(vec2 px, float r, vec2 ldir){
  if (r < 0.75) return lit(px, ldir);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 10; i++){
    float f = (float(i) + 0.5) / 10.0;
    float ang = float(i) * 2.39996323;
    acc += lit(px + vec2(cos(ang), sin(ang)) * r * sqrt(f), ldir);
  }
  return acc / 10.0;
}

void main(){
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 pxG = px + uPaneOff;            // координати плит: їдуть із панелями
  vec2 ldir = vec2(cos(uLightA), sin(uLightA));
  lightField(pxG, ldir);               // тінь і світло — з тих самих прямокутників
  vec3 col = lit(px, ldir);

  // topmost slab under this pixel (later in DOM order wins)
  int hit = -1;
  float d = 1e9;
  vec4 Rc = vec4(0.0);
  float rad = 0.0;
  for (int i = 0; i < ${MAX}; i++){
    if (i >= uCount) break;
    vec4 R = uRects[i];
    float dd = sdBox(pxG - R.xy, R.zw, uRadii[i]);
    if (dd < 0.6){ hit = i; d = dd; Rc = R; rad = uRadii[i]; }
  }

  if (hit >= 0){
    vec2 q = pxG - Rc.xy;
    vec2 half_ = Rc.zw;
    float thick = min(uThick, min(half_.x, half_.y) * 0.62);
    float t = clamp(-d / thick, 0.0, 1.0);
    float e = 1.5;
    vec2 g = normalize(vec2(
      sdBox(q + vec2(e,0.0), half_, rad) - sdBox(q - vec2(e,0.0), half_, rad),
      sdBox(q + vec2(0.0,e), half_, rad) - sdBox(q - vec2(0.0,e), half_, rad)) + 1e-6);
    float ts = mix(smoothstep(0.0, 1.0, t), t, uBevelHard);
    float soft = 0.5 + 0.5 * cos(3.14159265 * ts);
    float hard = sqrt(max(0.0, 1.0 - ts * ts));
    float bevel = mix(soft, hard, uBevelHard);
    vec3 N = normalize(vec3(g * bevel * 1.5, 1.0));
    vec3 V = vec3(0.0, 0.0, 1.0);

    float travel = mix(thick * 1.5, thick * 0.22, ts);
    vec3 R0 = refract(-V, N, 1.0 / uIOR);
    vec3 Rr = refract(-V, N, 1.0 / (uIOR * 0.988));
    vec3 Rb = refract(-V, N, 1.0 / (uIOR * 1.012));
    float scatter = uFrost * mix(0.5, 1.3, ts);
    vec3 refr;
    refr.r = litBlur(px + Rr.xy / max(0.14, abs(Rr.z)) * travel, scatter, ldir).r;
    refr.g = litBlur(px + R0.xy / max(0.14, abs(R0.z)) * travel, scatter, ldir).g;
    refr.b = litBlur(px + Rb.xy / max(0.14, abs(Rb.z)) * travel, scatter, ldir).b;
    refr *= uTint;

    float plateHalf = min(half_.x, half_.y);
    float gw = min(mix(3.0, 150.0, uGlintFall), 0.34 * plateHalf);
    float rim = exp(-(-d) / gw);
    rim = rim * rim * (3.0 - 2.0 * rim);
    float F = 0.04 + 0.7 * pow(1.0 - clamp(N.z, 0.0, 1.0), 3.2);
    vec3 env = lit(px - g * 70.0, ldir) * 1.12 + 0.05;
    // Fresnel reflection is what was lighting the whole rim evenly — weight it toward the
    // side the light actually comes from so the band stays one-sided
    vec2 gdir0 = vec2(cos(uGlintA), sin(uGlintA));
    vec2 dir0 = normalize(q / max(half_, vec2(1.0)) + 1e-5);
    float side0 = 0.20 + 0.80 * max(0.0, dot(dir0, -gdir0));
    col = mix(refr, env, clamp(F * 0.55 * side0, 0.0, 0.8));
    // one-sided: computed after dirF below

    vec2 dirF = normalize(q / max(half_, vec2(1.0)) + 1e-5);
    // two lobes along the light axis: bright on the lit side, weaker opposite,
    // both fading to nothing on the two perpendicular sides
    vec2 gdir = vec2(cos(uGlintA), sin(uGlintA));
    float ax   = dot(dirF, -gdir);
    float lobe = pow(abs(ax), mix(9.0, 0.15, uGlintSpread));
    float face = lobe * mix(0.34, 1.0, smoothstep(-0.3, 0.3, ax));
    col += env * rim * 0.55 * face * uGlint * uLightPow * 0.55;
    // the highlight and its arc have to come from ONE direction, or the two factors peak on
    // opposite rims and their product is identically zero — which is what killed the hotspot
    vec3 L = normalize(vec3(-gdir, 0.62));
    vec3 H = normalize(L + V);
    float sp = max(dot(N, H), 0.0);
    // optional unevenness along the perimeter (0 = perfectly even light)
    float ang = atan(dirF.y, dirF.x);
    float wob = (0.5 + 0.5 * sin(ang * 3.0 + 0.9)) * (0.55 + 0.45 * sin(ang * 7.0 - 2.1));
    float uneven = 1.0 - uGlintNoise * (1.0 - wob);
    col += uGlint * uLightPow * 0.34 * face * rim * uneven;
    float hw = min(mix(2.0, 220.0, uHotHard * uHotHard), 0.26 * plateHalf);
    float hmask = exp(-(-d) / hw);
    hmask = pow(hmask, 1.4);
    // feathered: a tight core plus a wide diffuse halo, so it fades out instead of ending
    float core = pow(sp, mix(22.0, 5.0, uHotHard));
    float halo = pow(sp, mix(6.0, 2.0, uHotHard));
    // narrow arc on the lit side only — never a full ring
    float harc = pow(max(dot(dirF, -gdir), 0.0), mix(14.0, 4.0, uHotHard));
    col += uHot * uLightPow * hmask * harc * (0.55 * core + 0.28 * halo);
    col = mix(col, vec3(1.0), uMilk * (0.55 + 0.45 * pow(1.0 - t, 2.1)));
    col = mix(lit(px, ldir), col, smoothstep(0.7, -0.7, d));
  }

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

  const NUM = ['theme','ior','thickness','bevel','frost','tint','milk','glint','glintfall','glintspread','glintnoise','hotspot','hotspotwidth','shadow','shadowsoft','transmit','transmitsoft','troff','trang','trsize','trstretch','trabs','lightangle','glintangle','lightpitch','gap','ambient','lightpower','bglevel'];

  class GlassGL extends HTMLElement {
    static get observedAttributes(){ return NUM; }

    connectedCallback(){
      if (this.canvas) return;
      this.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;pointer-events:none;z-index:0;overflow:hidden';
      this.canvas = document.createElement('canvas');
      this.canvas.style.cssText = 'width:100%;display:block';
      this.appendChild(this.canvas);
      addEventListener('resize', () => this.resize());
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(document.documentElement);
      this.ro.observe(this);
      this.resize();
      // panels appear as the DC streams in
      /* Постійного опитування немає навмисно. Кадр перемальовує designer:
         він знає про зміни розмітки, прокрутку, зміну розміру й теми, і
         пропускає кадр, якщо геометрія плит не змінилась. Таймер на 1.5 с
         натомість перемальовував шар вічно — звідси й відчуття, що «щось
         постійно міняється». Лишаються два разові кадри на осідання
         шрифтів і початкової розкладки. */
      setTimeout(() => this.draw(), 120);
      setTimeout(() => this.draw(), 700);
    }
    disconnectedCallback(){ clearInterval(this.poll); this.ro && this.ro.disconnect(); }
    /* Кожен повний кадр — це растеризація всього буфера (5+ млн px).
       syncTheme ставить шість атрибутів поспіль, і кожен викликав draw:
       шість повних кадрів у черзі GPU там, де потрібен один. Тому зміни
       атрибутів і resize лише ПОЗНАЧАЮТЬ кадр брудним, а малює його один
       rAF — до наступного показу все одно встигає. */
    queueDraw(){
      if (this._qd) return;
      this._qd = true;
      requestAnimationFrame(() => { this._qd = false; this.draw(); });
    }
    attributeChangedCallback(){ this.scene = null; if (this.canvas) this.queueDraw(); }

    num(n, d){ const v = parseFloat(this.getAttribute(n)); return isFinite(v) ? v : d; }

    paintScene(w, h){
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const x = c.getContext('2d');
      if (this.getAttribute('theme') === 'light'){
        // studio grey sweep: brightest above and left of centre, falling off to the corners
        // Форма світла — по висоті ВІКНА: сцена прибита до екрана.
        const lvh = this.sceneVH || h;
        const lspan = Math.max(900, Math.round(lvh * 1.37));
        const lbase = -((((this.sceneY || 0) % lspan) + lspan) % lspan);
        const lg = x.createLinearGradient(0, 0, w, lvh);
        lg.addColorStop(0, '#fbfcfc'); lg.addColorStop(.5, '#f0f2f3'); lg.addColorStop(1, '#b8bdc2');
        x.fillStyle = lg; x.fillRect(0, 0, w, h);
        [['rgba(255,255,255,.55)', .38, .26, 1.45],
         ['rgba(255,255,255,.22)', .22, .48, .72],
         ['rgba(104,112,120,.20)', 1.04, 1.02, .70],
         ['rgba(104,112,120,.14)', -.06, .60, .40],
         ['rgba(104,112,120,.10)', .48, 1.06, .48]].forEach(([col, fx, fy, fr]) => {
          for (let k = -1; k * lspan + lbase < h + lspan; k++){
            const cy = lbase + k * lspan + lspan * fy;
            const r = x.createRadialGradient(w * fx, cy, 0, w * fx, cy, w * fr);
            r.addColorStop(0, col); r.addColorStop(1, 'rgba(0,0,0,0)');
            x.fillStyle = r; x.fillRect(0, 0, w, h);
          }
        });
        return c;
      }
      // light runs across the width, so every row of the page has a lit and a dark side
      // horizontal, so every row of the viewport keeps a lit and a dark side
      const g = x.createLinearGradient(0, 0, w, 0);
      // на 20% темніше за початкові #4e545b/#363c43/#22262b/#171a1d
      g.addColorStop(0, '#3e4349'); g.addColorStop(.38, '#2b3036');
      g.addColorStop(.74, '#1b1e22'); g.addColorStop(1, '#121517');
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      /* Сцена — це ДОВГЕ полотно документа, а полотно WebGL малює лише його
         поточний зріз. Тому плями розкладаються у координатах документа й
         зсуваються на sceneY: коли шар перестрибує на нову ділянку, картинка
         сходиться шов у шов, і видно суцільний фон, по якому їде сторінка. */
      const vh = this.sceneVH || h;
      /* Плями світла ПОВТОРЮЮТЬСЯ по висоті документа. Якби вони лежали
         лише вгорі, нижче першого екрана фон ставав би пласким — а це
         полотно, по якому їде сторінка, і воно мусить жити на всю довжину.
         Крок трохи більший за екран, тож візерунок не читається як плитка. */
      const span = Math.max(900, Math.round(vh * 1.37));
      const base = -((((this.sceneY || 0) % span) + span) % span);
      x.save();
      // Тільки форма світла по краях: ліва сторона світліша, права темніша.
      // Кольорових плям усередині немає — вони читались як зайве світіння
      // посеред фону і сварились із лаймовим акцентом.
      const pools = [
        ['rgba(255,255,255,.30)', .06, .10, .44],
        ['rgba(255,255,255,.22)', .00, .48, .42],
        ['rgba(255,255,255,.24)', .12, .86, .42],
        ['rgba(0,0,0,.44)', 1.00, .22, .44],
        ['rgba(0,0,0,.40)', .94, .76, .42],
      ];
      for (let k = -1; k * span + base < h + span; k++){
        const oy = base + k * span;
        pools.forEach(([col, fx, fy, fr]) => {
          const cy = oy + span * fy;
          const r = x.createRadialGradient(w * fx, cy, 0, w * fx, cy, w * fr);
          r.addColorStop(0, col); r.addColorStop(1, 'rgba(0,0,0,0)');
          x.fillStyle = r; x.fillRect(0, 0, w, h);
        });
      }
      x.restore();
      // fine structure so refraction and frost have something to bend
      x.strokeStyle = 'rgba(255,255,255,.05)';
      x.lineWidth = Math.max(1, w / 1400);
      /* Крок сітки — від висоти ВІКНА, не полотна. Полотно тепер вище за
         екран у кілька разів (запас на прокрутку), і крок h/18 давав
         клітинку втроє більшу, ніж задумано. */
      const step = Math.max(22, Math.round((this.sceneVH || h) / 26));
      /* Горизонтальні лінії теж у координатах документа: інакше при
         перестрибуванні шару сітка зсувалась би на випадкову долю кроку. */
      const y0 = -(((this.sceneY || 0) % step) + step) % step;
      for (let y = y0; y < h + step; y += step){ x.beginPath(); x.moveTo(0, y); x.lineTo(w, y); x.stroke(); }
      for (let xx = step; xx < w; xx += step){ x.beginPath(); x.moveTo(xx, 0); x.lineTo(xx, h); x.stroke(); }
      return c;
    }


    // Forward ray trace, run on the CPU because caustics have to be SPLATTED (you cannot ask
    // a pixel where its light came from). For every little patch of a slab's top surface:
    // refract the incoming ray in through the real surface normal of the rolled rim, cross
    // the glass, refract out through the flat underside, and land it on the backdrop. The
    // patches that land on top of each other ARE the bright caustic; the light they left
    // behind IS the shadow. Nothing here is drawn by hand.
    resize(){
      const dpr = 1;
      const box = this.getBoundingClientRect();
      const w = Math.max(1, Math.round(box.width * dpr));
      /* Висота БУФЕРА стала: вікно плюс запас з обох боків. Елемент може
         бути нижчим (коротка вкладка) — тоді зайве полотно просто
         обрізається overflow:hidden. Доти буфер повторював висоту
         елемента, і кожне перемикання вкладок міняло розмір canvas —
         а це скидання текстури сцени й синхронне завантаження ~20 МБ
         у GPU на кожен клік. */
      const over = parseFloat(this.getAttribute('overscan')) || 0;
      const h = Math.max(1, Math.round((innerHeight + 2 * over) * dpr));
      if (!this.canvas) return;
      this.dpr = dpr;
      this.canvas.style.height = h + 'px';
      if (this.canvas.width !== w || this.canvas.height !== h){
        this.canvas.width = w; this.canvas.height = h;
        this.scene = null;
      }
      this.queueDraw();
    }

    init(){
      /* MSAA вмикаємо лише там, де є справжній GPU. У софтверному
         рендері (headless-проби, віртуалки) resolve повного буфера
         коштує секунди на кожен кадр — старт застигав на пів хвилини. */
      let aa = true;
      try {
        const probe = document.createElement('canvas').getContext('webgl');
        const dbg = probe && probe.getExtension('WEBGL_debug_renderer_info');
        const rnd = dbg ? probe.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
        if (/swiftshader|llvmpipe|software/i.test(rnd)) aa = false;
        const lose = probe && probe.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      } catch (e) {}
      const gl = this.canvas.getContext('webgl', { antialias: aa, preserveDrawingBuffer: true });
      if (!gl) return null;
      const sh = (ty, src) => { const s = gl.createShader(ty); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s; };
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(p); gl.useProgram(p);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(p, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.gl = gl; this.prog = p;
      return gl;
    }

    /* Геометрія кадру: прямокутники плит + підпис. Окремим методом,
       бо нею користується не лише draw — прогрівання знімає її з
       тимчасово показаної вкладки, щоб трасувати світло наперед. */
    frame(){
      const dpr = this.dpr || 1;
      const H = this.canvas ? this.canvas.height : 0;
      const rects = [], radii = [], panes = [];
      const origin = this.getBoundingClientRect();
      document.querySelectorAll('[data-glass]').forEach((el) => {
        if (radii.length >= MAX) return;
        const b = el.getBoundingClientRect();
        const r = { left: b.left - origin.left, top: b.top - origin.top, width: b.width, height: b.height };
        if (r.width < 4 || r.height < 4) return;
        /* Обрізаємо плиту по краях полотна із запасом. Панель на 4 000 px
           (список операцій) інакше приходить у шейдер прямокутником на всю
           довжину: вона перекриває світло на весь кадр і сцена навколо
           гасне. Запас 400 px — щоб заокруглені кути, які й так за межами
           видимого, не вилазили в кадр рівним зрізом. */
        const lim = H / dpr;
        const y0 = Math.max(r.top, -400), y1 = Math.min(r.top + r.height, lim + 400);
        if (y1 - y0 < 4) return;
        r.top = y0; r.height = y1 - y0;
        const cs = getComputedStyle(el);
        let rad = parseFloat(cs.borderTopLeftRadius) || 0;
        rad = Math.min(rad, Math.min(r.width, r.height) / 2);
        rects.push(
          (r.left + r.width / 2) * dpr, (r.top + r.height / 2) * dpr,
          (r.width / 2) * dpr, (r.height / 2) * dpr
        );
        radii.push(rad * dpr);
        panes.push({ cx: (r.left + r.width / 2) * dpr, cy: (r.top + r.height / 2) * dpr,
          hx: (r.width / 2) * dpr, hy: (r.height / 2) * dpr, r: rad * dpr });
      });
      const count = radii.length;
      while (radii.length < MAX){ rects.push(0,0,0,0); radii.push(0); }
      const W = this.canvas ? this.canvas.width : 0;
      /* Підпис — за КВАНТОВАНОЮ геометрією (крок 4 px). Активна вкладка
         жирніша за сусідів, і панель навігації ширшає на частки пікселя;
         без квантування це плодило «різні» кадри для того самого
         вигляду, і кеш карт світла промахувався. Карта рахується в
         половинній розділці — 4 px вона однаково не розрізняє. */
      const q = (v) => Math.round(v / 4) * 4;
      const sigPanes = panes.map((pn) => [q(pn.cx), q(pn.cy), q(pn.hx), q(pn.hy), q(pn.r)]);
      const sig = JSON.stringify([sigPanes, NUM.map((k) => this.getAttribute(k)), W, H]);
      return { rects, radii, panes, count, sig };
    }

    draw(){
      if (!this.canvas) return;
      const gl = this.gl || this.init();
      if (!gl) return;
      const p = this.prog, dpr = this.dpr || 1;
      const W = this.canvas.width, H = this.canvas.height;
      const M = this.sceneMargin || 0;
      if (!this.scene){
        const t = this._sceneTex || (this._sceneTex = gl.createTexture());
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, t);
        this.sceneVH = Math.round(innerHeight);
        this.sceneShift = M;               // верх вікна лежить на рядку M полотна
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.paintScene(W, H));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.uniform1i(gl.getUniformLocation(p, 'uScene'), 0);
        this.scene = t;
      }
      const fr = this.frame();
      const rects = fr.rects, radii = fr.radii, panes = fr.panes;
      this.panes = panes;
      const count = fr.count;

      gl.viewport(0, 0, W, H);
      const u = (n) => gl.getUniformLocation(p, n);
      gl.uniform2f(u('uRes'), W, H);
      gl.uniform2f(u('uPaneOff'), 0, 0);   // полотно їде з документом, зсув не потрібен
      gl.uniform4fv(u('uRects[0]'), new Float32Array(rects));
      gl.uniform1fv(u('uRadii[0]'), new Float32Array(radii));
      gl.uniform1i(u('uCount'), count);
      gl.uniform1f(u('uIOR'), this.num('ior', 152) / 100);
      gl.uniform1f(u('uThick'), this.num('thickness', 40) * dpr);
      gl.uniform1f(u('uFrost'), this.num('frost', 6) * dpr);
      gl.uniform1f(u('uTint'), this.num('tint', 100) / 100);
      gl.uniform1f(u('uMilk'), this.num('milk', 8) / 100);
      gl.uniform1f(u('uShadow'), this.num('shadow', 45) / 100);
      gl.uniform1f(u('uTransmit'), this.num('transmit', 22) / 100);
      gl.uniform1f(u('uShadowSoft'), this.num('shadowsoft', 100) / 100);
      gl.uniform1f(u('uTransmitSoft'), this.num('transmitsoft', 100) / 100);
      gl.uniform1f(u('uTrOff'), this.num('troff', 0));
      gl.uniform1f(u('uTrAng'), this.num('trang', 0) * Math.PI / 180);
      gl.uniform1f(u('uTrSize'), this.num('trsize', 100) / 100);
      gl.uniform1f(u('uTrStretch'), this.num('trstretch', 100) / 100);
      gl.uniform1f(u('uTrAbs'), this.num('trabs', 0) / 100);
      gl.uniform1f(u('uBevelHard'), this.num('bevel', 30) / 100);
      gl.uniform1f(u('uGlintFall'), this.num('glintfall', 18) / 100);
      gl.uniform1f(u('uGlintSpread'), this.num('glintspread', 45) / 100);
      gl.uniform1f(u('uGlintNoise'), this.num('glintnoise', 0) / 100);
      gl.uniform1f(u('uGlint'), this.num('glint', 70) / 100);
      gl.uniform1f(u('uHot'), this.num('hotspot', 40) / 100);
      gl.uniform1f(u('uHotHard'), this.num('hotspotwidth', 40) / 100);
      gl.uniform1f(u('uLightPow'), this.num('lightpower', 100) / 100);
      gl.uniform1f(u('uBg'), this.num('bglevel', 110) / 100);
      gl.uniform1f(u('uLightA'), (this.num('lightangle', 52) * Math.PI) / 180);

      /* Світло рахує сам шейдер із тих самих прямокутників — жодних
         карт, кешів і «доїздів»: воно зшите з геометрією за побудовою. */
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.scene);
      gl.uniform1f(u('uAmb'), this.num('ambient', 55) / 100);
      gl.uniform1f(u('uGlintA'), (this.num('glintangle', this.num('lightangle', 52)) * Math.PI) / 180);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }
  if (!customElements.get('glass-gl')) customElements.define('glass-gl', GlassGL);
})();
