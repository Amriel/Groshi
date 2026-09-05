
/* ── підключення WebGL-скла ──────────────────────────────────────
   Один шар на всю сторінку: він сам малює сцену і заломлює її під
   кожним [data-glass]. Поверхні лише позначаються й отримують clip-path
   із тим самим радіусом, що в CSS — інакше вміст вилазить за скло.

   Головна складність — СКРОЛ. Перерахунок кадру коштує сотні мілісекунд:
   карта світла (тіні й каустики) трасується променями, а не малюється.
   Робити це на кожен піксель прокрутки неможливо — саме звідси бралися
   завмирання і стрибки.

   Рішення: полотно прибите до ДОКУМЕНТА (position:absolute), а не до
   вікна. Тоді прокрутка не коштує НІЧОГО: браузер везе полотно разом зі
   сторінкою, як звичайний фон, піксель у піксель, без жодного JS. Скло і
   фон їдуть із контентом самі собою, бо це один і той самий шар.

   Полотно вище за вікно на MARGIN з кожного боку. Поки вікно лишається
   всередині цього запасу, не робиться взагалі нічого. Коли запас
   вичерпано — шар перестрибує на нову ділянку й перемальовується. Сцена
   при цьому рахується в координатах документа, тож на стику картинка
   сходиться шов у шов і перестрибування не видно.
   ────────────────────────────────────────────────────────────────── */
(function liquidGlass(){
  /* Підказки сюди не входять навмисно: #tip їде за курсором, а плиту
     шейдер малює за прямокутником, зафіксованим на попередньому кадрі —
     скло відставало від тексту й висіло поруч окремим прямокутником. */
  const SEL = '.glass, .card, .det, nav.tabs.glass';
  /* Запас полотна згори й знизу. Був 700 — при швидкій прокрутці вікно
     вилітало за нього кілька разів на секунду, і кожен виліт тягнув
     повний кадр із трасуванням світла. Півтори тисячі пікселів — це
     приблизно ще один екран у кожен бік, тобто на звичайному
     «прокрутити колесом до кінця» шар перестрибує один раз, а не сім. */
  /* У софтверному рендері (headless-проби, віртуалки без GPU)
     композиція канваса коштує пропорційно площі: буфер на 3900 px
     давав 15-секундні черги кадрів на старті. Там запас не потрібен —
     скрол однаково не апаратний. На справжньому GPU лишається повний. */
  const soft = (() => {
    try {
      const c = document.createElement('canvas').getContext('webgl');
      const d = c && c.getExtension('WEBGL_debug_renderer_info');
      const r = d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : '';
      const l = c && c.getExtension('WEBGL_lose_context'); if (l) l.loseContext();
      return /swiftshader|llvmpipe|software/i.test(r);
    } catch (e) { return false; }
  })();
  /* Запас навмисно великий: на «Операціях» документ буває 20 000+ px,
     і з малим запасом шар перестрибує кілька разів за один рух колеса —
     а кожен стрибок коштує повного кадру з трасуванням світла. */
  const MARGIN = soft ? 0 : 2400;
  const PARAMS = {                    // точні значення з макета
    ior:138, thickness:14, bevel:5, gap:30, frost:11, tint:74, milk:12,
    glint:50, glintangle:32, glintfall:0, glintspread:20, glintnoise:0,
    hotspot:0, hotspotwidth:25, lightangle:36, lightpitch:14,
    ambient:40, lightpower:100, shadow:15, shadowsoft:10,
    transmit:70, transmitsoft:20, bglevel:50,
  };
  if(!document.createElement('canvas').getContext('webgl')) return;

  const gg = document.createElement('glass-gl');
  gg.setAttribute('overscan', MARGIN);   // буфер полотна не залежить від висоти вкладки
  for(const k in PARAMS) gg.setAttribute(k, PARAMS[k]);
  document.body.insertBefore(gg, document.body.firstChild);
  gg.style.cssText = 'position:absolute;left:0;width:100%;display:block;overflow:hidden;'
    + 'pointer-events:none;z-index:0;top:0;height:100vh';

  /* Сцену під склом малює сам шейдер, тож тему треба переказати йому. */
  const syncTheme = ()=>{
    const light = document.documentElement.dataset.theme === 'light';
    if(light) gg.setAttribute('theme','light'); else gg.removeAttribute('theme');
    /* У світлій сцені плита мусить бути СВІТЛІШОЮ за тло, інакше читається
       сірим пластиком: більше пропускання, менше молока, слабша тінь. */
    gg.setAttribute('bglevel', light ? 112 : PARAMS.bglevel);
    gg.setAttribute('tint',    light ? 96  : PARAMS.tint);
    gg.setAttribute('milk',    light ? 7   : PARAMS.milk);
    gg.setAttribute('frost',   light ? 8   : PARAMS.frost);
    gg.setAttribute('shadow',  light ? 22  : PARAMS.shadow);
    gg.setAttribute('transmit',light ? 88  : PARAMS.transmit);
    gg.scene = null; lastSig=''; commit();
  };

  const seen = new WeakMap();
  /* Шейдер тримає обмежену кількість плит в uniform-масиві (26). Якщо
     поверхонь більше — зайві просто не малюються, і кнопки зникають без
     жодного попередження. Тому спершу збираємо кандидатів, сортуємо за
     віддаленістю від центру екрана й беремо стільку, скільки шейдер
     осилить; решта отримує звичайну CSS-підкладку. */
  const MAX_PANES = 26;

  let mark = function(){
    const top = -MARGIN, bot = innerHeight + MARGIN, mid = innerHeight / 2;
    const cand = [], rest = [];
    document.querySelectorAll(SEL).forEach(n=>{
      const cs = getComputedStyle(n);
      const b  = n.getBoundingClientRect();
      /* Шейдер малює плиту за прямокутником і нічого не знає ні про
         видимість елемента, ні про те, що він за межами полотна. */
      let ok = b.width>4 && b.height>4 && b.bottom>top && b.top<bot
            && cs.visibility!=='hidden' && parseFloat(cs.opacity) > 0.02;

      /* Активний чіп періоду й активна вкладка плити не отримують: під ними
         вже їде лаймовий індикатор (.chip-ind / .tab-ind). Якщо малювати
         ще й плиту, під час перемикання видно ДВІ лаймові пігулки — стару
         на місці індикатора, що ще летить, і нову на місці чіпа. Саме це
         й читалося як стрибок меню. */
      if(ok && n.matches('.periodbar .chip[aria-pressed="true"], nav.tabs button[aria-current="true"]'))
        ok = false;

      /* Модальне вікно висить над усім і має власне тло. Полотно скла
         прив'язане до документа, тож для fixed-елемента прямокутник
         рахувався б від прокрутки — плита поїхала б повз вікно. */
      if(ok && n.closest('#modal')) ok = false;

      /* Довгі панелі (список операцій — це 4 000 px) плитою БУТИ МОЖУТЬ.
         Раніше вони відсіювались, і «Операції» єдині лишались без скла —
         сторінка виглядала чужою серед решти. Проблема була не в самій
         панелі, а в тому, що шейдер отримував прямокутник на всю її
         довжину: така плита перекривала світло на весь кадр. Тепер
         прямокутник обрізається по краях полотна (див. glassgl draw),
         тож плита завжди приблизно з екран заввишки. */

      const r = Math.round(parseFloat(cs.borderTopLeftRadius)||0);
      if(ok) cand.push({n, r, d:Math.abs((b.top+b.bottom)/2 - mid), b, cs});
      else   rest.push({n, b});
    });

    cand.sort((a,b)=> a.d - b.d);
    const win = cand.slice(0, MAX_PANES);
    const out = cand.slice(MAX_PANES).concat(rest);

    /* Порядок у DOM важливий: у шейдері «перемагає» пізніша плита, тож
       вкладена кнопка мусить іти після своєї панелі. Сортування за
       близькістю це ламає — тому позначаємо в порядку документа. */
    win.sort((a,b)=> (a.n.compareDocumentPosition(b.n) & 4) ? -1 : 1);

    const glass = [];
    for(const it of win){
      /* Дві плити одна над одною складаються за яскравістю, і поверхня
         стає молочною й брудною. Різниця не в розмірі, а в ролі: дрібний
         елемент керування всередині панелі читається окремою деталлю
         (так і в макеті), а ПАНЕЛЬ усередині панелі лише подвоює
         матовість — їй лишається звичайна CSS-підкладка. */
      let ok = true;
      if(it.n.matches('.card, .det, nav.tabs.glass'))
        for(const g of glass) if(g.contains(it.n)){ ok = false; break; }
      if(!ok){ out.push(it); continue; }
      glass.push(it.n);
      if(seen.get(it.n) !== it.r){
        seen.set(it.n, it.r);
        it.n.setAttribute('data-glass','1');
        it.n.classList.remove('lg-flat');
        it.n.style.clipPath = `inset(0 round ${it.r}px)`;
      }
    }
    for(const it of out){
      if(seen.get(it.n) === -1) continue;
      seen.set(it.n, -1);
      it.n.removeAttribute('data-glass');
      it.n.classList.toggle('lg-flat', it.b.width>4 && it.b.height>4);
    }
  }

  /* Розмір і положення шару в координатах ДОКУМЕНТА. Висота обмежена
     висотою контенту, інакше абсолютний елемент додав би сторінці зайвої
     прокрутки на коротких вкладках. */
  let top = null, curH = 0;
  function place(){
    const wrap = document.querySelector('.wrap');
    /* Беремо БІЛЬШУ з двох висот. Раніше тут була лише висота .wrap, і
       коли під нею опинялось іще щось (у десктопній збірці — зайвих
       135 px), полотно не дотягувало до кінця документа: унизу лишалась
       чорна смуга без сцени. */
    /* Висоту рахуємо по ВМІСТУ, свідомо не питаючи scrollHeight: шар
       скла лежить у body як absolute, тож він сам входить у scrollHeight —
       виходила петля. Шар на 3 900 px розтягував документ до 3 900 px,
       з того виводилась така сама висота шару, і на вкладці з екраном
       вмісту лишалась тисяча порожніх пікселів унизу. */
    let content = 0;
    for(const n of document.body.children){
      if(n === gg || n.hidden) continue;
      const cs = getComputedStyle(n);
      if(cs.position === 'fixed' || cs.display === 'none') continue;
      const b = n.getBoundingClientRect();
      content = Math.max(content, b.bottom + scrollY);
    }
    const docH = Math.max(
      wrap ? wrap.offsetTop + wrap.offsetHeight : 0,
      Math.round(content),
      innerHeight);
    let H = Math.min(innerHeight + 2 * MARGIN, Math.max(innerHeight, docH));
    /* Висота полотна змінюється НЕОХОЧЕ. Кожна зміна скидає текстуру сцени,
       а це найдорожча частина кадру. Вкладки різняться висотою на сотні
       пікселів, тож без цього запасу кожне перемикання перемальовувало
       сцену заново — звідси й пауза перед появою вікон. */
    if(curH && Math.abs(H - curH) < 320) H = curH;
    /* Запас угору — MARGIN, але не ціною низу. Якщо полотно нижче за
       innerHeight + MARGIN, відняти цілий MARGIN означає лишити нижню
       частину вікна поза сценою — саме це й давало смугу біля підвалу.
       Тому спершу вимагаємо, щоб вікно ЦІЛКОМ лежало всередині шару. */
    let t = Math.round(scrollY) - MARGIN;
    t = Math.max(t, Math.round(scrollY) + innerHeight - H);   // низ вікна всередині
    t = Math.min(t, Math.round(scrollY));                     // верх вікна всередині
    t = Math.max(0, Math.min(t, Math.max(0, docH - H)));
    /* Зміна висоти ЕЛЕМЕНТА сцену не чіпає: буфер полотна сталого
       розміру, коротша вкладка лише обрізає його. Сцена скидається
       тільки коли шар справді переїхав (top змінився). */
    if(H !== curH){ curH = H; gg.style.height = H + 'px'; }
    if(top !== t){
      top = t;
      gg.style.top = t + 'px';
      gg.sceneY = t;            // сцена малює свій зріз довгого полотна
      gg.scene = null;          // тому її треба перемалювати під нове місце
      /* ПРИВИДИ. Полотно щойно переїхало, але на ньому досі СТАРІ плити —
         намальовані для попереднього положення сторінки. Доки не прийде
         новий кадр (а він важкий, тож іде наступним тиком), ці плити
         видно на новому місці: кнопки-двійники, картки, що наїжджають
         одна на одну. Саме це й читалось як «вікна лишаються на місці».
         Ховаємо полотно до готового кадру: краще пів секунди без скла,
         ніж пів секунди чужих плит поверх вмісту. */
      if(gg.canvas) gg.canvas.style.visibility = 'hidden';
      stale = true;
    }
  }
  let stale = false;

  /* Підпис кадру: положення шару плюс геометрія всіх плит. Якщо він не
     змінився, малювати нема чого — а перемальовування коштує сотні мілісекунд
     трасування світла. Саме зайві перемальовування смикали вікна при зміні
     періоду: розмітка мінялась кілька разів поспіль, і кожна зміна тягла
     повний кадр. */
  function sig(){
    let out = top + '|' + curH;
    for(const n of document.querySelectorAll('[data-glass]')){
      const b = n.getBoundingClientRect();
      out += `;${b.left|0},${b.top|0},${b.width|0},${b.height|0}`;
    }
    return out;
  }
  let lastSig = '';

  /* Повний перерахунок: пересунути шар, позначити панелі, перемалювати. */
  function commit(){
    place();
    mark();
    const sg = sig();
    if(sg === lastSig){ show(); return; }
    lastSig = sg;
    if(gg.draw) gg.draw();
    show();
  }
  /* Кадр готовий — полотно можна показувати. Окремою функцією, бо шляхів
     сюди два: намалювали заново або зрозуміли, що малювати нічого. */
  function show(){
    if(!stale) return;
    stale = false;
    if(gg.canvas) gg.canvas.style.visibility = '';
  }

  /* Чи вікно ще всередині запасу. Поки так — прокрутка безкоштовна. */
  function covered(){
    if(top === null) return false;
    return scrollY >= top - 4 && scrollY + innerHeight <= top + curH + 4;
  }

  let idle=null, force=false;
  /* Поки палець на колесі, скляний шар мовчить. Причина не лише в
     самому скролі: «Операції» дорендеровують рядки на льоту, кожна
     порція — мутація DOM, а кожна мутація тягла повний кадр. Виходило
     до двох десятків важких кадрів за одне протягування списку — саме
     це відчувалось як «вкладка лагає». */
  let lastScroll = 0;
  const SCROLLING = () => performance.now() - lastScroll < 130;
  /* Затримка коротка навмисно: 110 мс після зміни вкладки читалися як
     «вікна зʼявляються згодом». Кадр усе одно склеюється з пачки змін —
     rAF-крок їх коалесціює. */
  const later = (f)=>{ force = force || !!f; clearTimeout(idle); idle = setTimeout(()=>{
    /* Рух ще триває — переносимо кадр, не втрачаючи прапорця force. */
    if(SCROLLING()){ later(false); return; }
    const need = force || !covered() || top === null;
    force = false;
    if(need) requestAnimationFrame(commit);
  }, 24); };

  /* Під час самої прокрутки не робиться нічого, доки вікно не вийшло за
     межі намальованої ділянки. Тоді перестрибуємо негайно — інакше нижче
     краю шару скла просто немає. */
  /* Прокрутка НЕ малює. Раніше тут стояв повний `commit()`, і на швидкому
     скролі кожен виліт за межі шару зупиняв сторінку на сотні мілісекунд —
     фон «не встигав завантажитись». Тепер спершу дешеве: пересунути шар
     (це просто style.top, браузер везе його разом зі сторінкою) — вікно
     одразу накрите, а старі пікселі на полотні лишаються, бо буфер не
     очищається. Дороге малювання йде наступним кадром, коли рука вже
     відпустила колесо. */
  /* Апка знає про свої перемальовування точно, а спостерігач за DOM —
     із запізненням на таймер. Тому render() кличе це сам, і скло
     зʼявляється В ТОМУ Ж кадрі, що й вміст, а не «трохи згодом». */
  window.__glassNow = ()=>{ clearTimeout(idle); force = false; commit(); };


  /* Прокрутка: спершу ДЕШЕВЕ — пересунути шар (це просто style.top) і
     сховати полотно, щоб не світились плити з попереднього положення.
     Дорогий кадр іде тільки коли рух стих: інакше на довгій вкладці
     одне протягування колеса давало п'ять повних кадрів поспіль, і
     сторінка відчутно спотикалась. */
  let scrollIdle = null;
  addEventListener('scroll', ()=>{
    lastScroll = performance.now();
    if(!covered()){
      place();
      clearTimeout(idle); clearTimeout(scrollIdle);
      /* Чекаємо не «90 мс від останньої події», а справжньої зупинки:
         події скролу браузер коалесціює як йому зручно, і за таймером
         кадр щоразу проскакував усередину руху. Порівнюємо положення —
         зрушило, отже рука ще на колесі, переносимо. */
      const armDraw = ()=>{
        const at = scrollY;
        scrollIdle = setTimeout(()=>{
          if(scrollY !== at || SCROLLING()) return armDraw();
          requestAnimationFrame(commit);
        }, 130);
      };
      armDraw();
    } else later(false);
  }, {passive:true});
  addEventListener('resize', ()=>{ top = null; curH = 0; lastSig=''; later(true); });
  new MutationObserver(()=>later(true)).observe(document.documentElement,{childList:true,subtree:true});
  /* Картка може змінити ВИСОТУ без жодної зміни розмітки: дозавантажився
     шрифт, підтягнувся логотип, розкрилась група клієнта. Спостерігач за
     DOM такого не бачить — і плити лишаються там, де були, наїжджаючи на
     сусідні картки. Саме це було видно у «Кошторисах»: плита «Рахунків
     для клієнтів» стояла поверх «Проєктів». */
  if(window.ResizeObserver){
    const ro = new ResizeObserver(()=>later(true));
    const wrap = document.querySelector('.wrap');
    if(wrap) ro.observe(wrap);
    /* Плити зʼявляються й зникають разом із вкладками, тож перепідписка
       йде тим самим тиком, що й перемальовування. */
    const rewatch = ()=>{
      document.querySelectorAll(SEL).forEach(n=>{ if(!n._roOn){ n._roOn = 1; ro.observe(n); } });
    };
    const oldMark = mark;
    mark = function(){ const r = oldMark.apply(this, arguments); rewatch(); return r; };
  }
  /* Перемикання періоду не додає й не прибирає вузлів — воно лише міняє
     aria-pressed. Без цього спостерігача плита лишалась би на старому чіпі. */
  new MutationObserver(()=>later(true)).observe(document.documentElement,
    {subtree:true, attributes:true,
     /* hidden — обовʼязково. Оверлей «перегляд на телефоні» ховається
        саме ним, розмітка при цьому не змінюється, тож спостерігач за
        дітьми мовчав — і плити його кнопок лишались намальованими
        поверх сторінки як порожні пігулки-привиди. */
     attributeFilter:['aria-pressed','aria-current','hidden']});
  new MutationObserver(syncTheme).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  syncTheme();
  if(document.fonts && document.fonts.ready) document.fonts.ready.then(()=>later(true));
  setTimeout(commit, 400);
})();
