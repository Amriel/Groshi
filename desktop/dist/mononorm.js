/* ═══════════ РОЗБІР ВИПИСКИ MONOBANK ═══════════
   Банк віддає сирі елементи; апці потрібні записи свого вигляду.
   Раніше це робив mono_sync.py, і категоризація жила в Python. Тут вона
   переїхала в інтерфейс з однієї причини: правила міняються частіше за
   все інше, і міняти їх треба без перезбирання застосунку. Сирі відповіді
   на диску лишаються недоторканими — перекатегоризувати можна будь-коли.  */
(function () {
  const MCC = {
    "5411": ["Продукти", "Супермаркети"], "5499": ["Продукти", "Міні-маркети"],
    "5462": ["Продукти", "Пекарні"], "5451": ["Продукти", "Молочне"],
    "5441": ["Продукти", "Солодощі"], "5422": ["Продукти", "М'ясо"],
    "5811": ["Кафе і доставка", "Доставка їжі"], "5812": ["Кафе і доставка", "Ресторани"],
    "5813": ["Кафе і доставка", "Бари"], "5814": ["Кафе і доставка", "Фастфуд"],
    "5734": ["AI та софт", "ПЗ і сервіси"], "5817": ["AI та софт", "Цифрові товари"],
    "5818": ["AI та софт", "Цифрові товари"], "7372": ["AI та софт", "Розробка ПЗ"],
    "5816": ["Ігри", "Ігри"], "5815": ["Підписки", "Медіа"], "4899": ["Підписки", "Стрімінг"],
    "4814": ["Зв'язок", "Мобільний"], "4816": ["Зв'язок", "Інтернет"],
    "4812": ["Зв'язок", "Обладнання"], "4813": ["Зв'язок", "Телеком"],
    "4121": ["Транспорт", "Таксі"], "4111": ["Транспорт", "Громадський"],
    "4131": ["Транспорт", "Автобуси"], "5541": ["Транспорт", "АЗС"],
    "5542": ["Транспорт", "АЗС"], "7523": ["Транспорт", "Паркінг"],
    "4511": ["Подорожі", "Авіа"], "4722": ["Подорожі", "Турагенції"], "7011": ["Подорожі", "Готелі"],
    "4215": ["Доставка", "Пошта і кур'єри"], "4214": ["Доставка", "Вантажні"],
    "5262": ["Покупки", "Маркетплейси"], "5311": ["Покупки", "Універмаги"],
    "5399": ["Покупки", "Різні товари"], "5300": ["Покупки", "Гуртівні"],
    "5722": ["Техніка", "Побутова техніка"], "5732": ["Техніка", "Електроніка"],
    "5045": ["Техніка", "Комп'ютери"], "5047": ["Здоровʼя", "Медтехніка"],
    "5651": ["Одяг", "Одяг"], "5621": ["Одяг", "Жіночий одяг"], "5691": ["Одяг", "Одяг"],
    "5661": ["Одяг", "Взуття"], "5641": ["Одяг", "Дитячий одяг"], "5944": ["Одяг", "Ювелірні"],
    "5977": ["Краса", "Косметика"], "7230": ["Краса", "Салони"],
    "5945": ["Хобі", "Хобі і подарунки"], "5943": ["Хобі", "Канцтовари"],
    "5971": ["Хобі", "Мистецтво"], "5192": ["Хобі", "Книги"], "5941": ["Хобі", "Спорттовари"],
    "5992": ["Хобі", "Квіти"],
    "5912": ["Здоровʼя", "Аптеки"], "8062": ["Здоровʼя", "Лікарні"],
    "8011": ["Здоровʼя", "Лікарі"], "8021": ["Здоровʼя", "Стоматологія"],
    "8043": ["Здоровʼя", "Оптика"],
    "4900": ["Житло", "Комуналка"], "6513": ["Житло", "Оренда"],
    "5200": ["Житло", "Товари для дому"], "5211": ["Житло", "Будматеріали"],
    "5712": ["Житло", "Меблі"],
    "7832": ["Розваги", "Кіно"], "7922": ["Розваги", "Театр і концерти"],
    "7997": ["Розваги", "Спортклуби"], "7996": ["Розваги", "Атракціони"],
    "4829": ["Перекази", "Перекази"], "6012": ["Перекази", "Фінпослуги"],
    "6051": ["Перекази", "Квазі-кеш"], "6540": ["Перекази", "Поповнення"],
    "6010": ["Готівка", "Каса банку"], "6011": ["Готівка", "Банкомат"],
    "7392": ["Послуги", "Консалтинг"], "7399": ["Послуги", "Бізнес-послуги"],
    "7379": ["Послуги", "Комп'ютерні послуги"], "7311": ["Послуги", "Реклама"],
    "7276": ["Послуги", "Податки і звітність"], "8999": ["Послуги", "Профпослуги"],
    "8299": ["Освіта", "Освіта"], "8220": ["Освіта", "Університети"], "8211": ["Освіта", "Школи"],
    "9211": ["Держава", "Суди і штрафи"], "9222": ["Держава", "Штрафи"],
    "9223": ["Держава", "Застава"], "9311": ["Держава", "Податки"],
    "9399": ["Держава", "Держпослуги"], "9402": ["Держава", "Пошта"],
    "8398": ["Донати", "Благодійність"], "7995": ["Інше", "Ставки"]
  };

  const RULES = [
    [/runpod|simplepod|vast\.ai|runcomfy|comfy\.org|higgsfield|midjourney|claude|openai|dreamina|luma ai|runway|fal features|magnific|suno|ebsynth|sjinn|enhancor|martiniart|frame\.io|capcut|adobe|gumroad|prompt|studio-y|leman|mformula|novella/, "AI та софт", "AI-сервіси"],
    [/make\.com|cloudflare|notion|figma|github|jetbrains|malwarebytes|reincubate/, "AI та софт", "Інструменти"],
    [/^google$|google play/, "AI та софт", "Google"],
    [/^apple$|itunes|icloud/, "AI та софт", "Apple"],
    [/microsoft/, "AI та софт", "Microsoft"],
    [/^youtube/, "Підписки", "YouTube"],
    [/patreon/, "Підписки", "Patreon"],
    [/oculus|meta quest/, "Ігри", "VR"],
    [/^steam|g2a\.com|epic games|playstation|xbox/, "Ігри", "Ігри"],
    [/telemart|^mta\.ua|^ya\.ua|allo|comfy\b|ecoflow|absoluts/, "Техніка", "Електроніка"],
    [/rozetka/, "Покупки", "Rozetka"],
    [/aliexpress|prom\.ua|^olx|temu|amazon|ebay/, "Покупки", "Маркетплейси"],
    [/нова пошта|укрпошта|meest|justin/, "Доставка", "Пошта і кур'єри"],
    [/сільпо|silpo|атб|фора|varus|варус|novus|ашан|метро|експрес маркет|zakaz\.ua|supermarket|мегамаркет/, "Продукти", "Супермаркети"],
    [/^glovo|bolt food|raketa|uber eats/, "Кафе і доставка", "Доставка їжі"],
    [/кава|cafe|coffee|croissant|mcdonald|sushi|pesto|kitaika|karnivora|aiurveda|завертайло|annco|food spot|siba|corner|mozgus|osokor/, "Кафе і доставка", "Кафе"],
    [/uklon|uber|bolt\b|opti taxi|таксі/, "Транспорт", "Таксі"],
    [/^дія$|резерв\+/, "Держава", "Держпослуги"],
    [/провадження/, "Держава", "Виконавче провадження"],
    [/lifecell|kyivstar|київстар|vodafone/, "Зв'язок", "Мобільний"],
    [/prtmn|internet|treytekh/, "Зв'язок", "Інтернет"],
    [/portmone|easypay|liqpay|vchasno|rpay/, "Послуги", "Платіжні сервіси"],
    [/^paypal/, "Покупки", "PayPal"],
    [/аптек|apteka|garmoniya|garmonija|гармонi|medichnij|anak|notino/, "Здоровʼя", "Аптеки і клініки"],
    [/кінотеатр|kinoteatr|жовтень/, "Розваги", "Кіно"],
    [/zara|bershka|sinsay|gepur|under wonder|cher|noname|cubi shop|h&m|reserved|pull&bear/, "Одяг", "Одяг"],
    [/оренда/, "Житло", "Оренда"],
    [/^каса\b|банкомат/, "Готівка", "Готівка"],
    [/поповнення/, "Перекази", "Банки і цілі"],
    [/переказ на картку|^\d{6}\*{4}\d{4}$/, "Перекази", "На свої картки"],
    [/^фоп |^тов |^пп /, "Послуги", "ФОП і компанії"],
    [/освітні послуги/, "Освіта", "Освіта"]
  ];

  const PERSON = /^[А-ЯІЇЄҐ][а-яіїєґ']+ [А-ЯІЇЄҐ]\.$|^[А-ЯІЇЄҐ][а-яіїєґ']+ [А-ЯІЇЄҐ][а-яіїєґ']+$|^[A-Z][a-z]+ [A-Z]\.$/;
  const INCOME_HINTS = /зарплат|аванс|premi|премі|виплат|повернення|кешбек|відсотк|депозит/i;
  const CCY = { 980: "UAH", 840: "USD", 978: "EUR", 985: "PLN", 826: "GBP", 756: "CHF", 124: "CAD" };

  const norm = s => (s || "").normalize("NFC").split("\n")[0].trim();

  function categorize(descr, mcc, isIncome) {
    const m = norm(descr), low = m.toLowerCase();
    if (isIncome) {
      if (INCOME_HINTS.test(low)) return ["Дохід", "Зарплата і виплати"];
      if (PERSON.test(m)) return ["Дохід", "Від людей"];
      if (/^каса|банкомат/.test(low)) return ["Готівка", "Внесення готівки"];
      return ["Дохід", "Надходження"];
    }
    for (const [re, cat, sub] of RULES) if (re.test(low)) return [cat, sub];
    if (PERSON.test(m)) return ["Перекази", "Людям"];
    return MCC[mcc] || ["Інше", "Інше"];
  }

  const pad = n => String(n).padStart(2, "0");
  function stamp(ts) {
    const d = new Date(ts * 1000);
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      time: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    };
  }
  const r2 = n => Math.round(n * 100) / 100;

  /* ── КУРСИ ─────────────────────────────────────────────────────────
     Monobank у виписці дає дві суми: `amount` — у валюті РАХУНКУ, і
     `operationAmount` + `currencyCode` — у валюті ОПЕРАЦІЇ. Коли з
     гривневої картки платять доларами, ці дві суми разом і є курсом
     банку на той день. Збираємо їх у таблицю — і завдяки їй уміємо
     перерахувати в гривню операції з доларового чи єврового рахунку,
     не питаючи нікого й нічого не вигадуючи.
     Якщо курсу на потрібну дату немає — беремо найближчий відомий.  */
  function buildRates(recsRaw, byId) {
    const t = {};                            // {USD: [[дата, курс], …]}
    for (const [accId, list] of Object.entries(recsRaw)) {
      const acc = byId[accId];
      if (!acc || acc.currency !== 980) continue;   // курс видно лише з гривневого
      for (const it of list) {
        const oc = CCY[it.currencyCode];
        if (!oc || oc === "UAH") continue;
        const uah = Math.abs(it.amount || 0), own = Math.abs(it.operationAmount || 0);
        if (!uah || !own) continue;
        const rate = uah / own;
        if (!(rate > 0.5) || rate > 500) continue;  // сміття й копійчані округлення
        (t[oc] = t[oc] || []).push([Math.floor(it.time / 86400), rate]);
      }
    }
    for (const k of Object.keys(t)) {
      t[k].sort((a, b) => a[0] - b[0]);
      // кілька операцій за день — беремо медіану, щоб одна дивна не тягла
      const byDay = new Map();
      for (const [d, r] of t[k]) { if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(r); }
      t[k] = [...byDay.entries()].map(([d, rs]) => {
        rs.sort((a, b) => a - b);
        return [d, rs[rs.length >> 1]];
      });
    }
    return t;
  }
  let RATES = {};
  function rateFor(ccy, day) {
    if (ccy === "UAH") return 1;
    const arr = RATES[ccy];
    if (!arr || !arr.length) return null;
    let best = arr[0], bd = Math.abs(arr[0][0] - day);
    for (const p of arr) {
      const d = Math.abs(p[0] - day);
      if (d < bd) { bd = d; best = p; }
    }
    return best[1];
  }
  window.monoRates = () => RATES;

  function one(item, acc) {
    const amt = (item.amount || 0) / 100;   // у валюті РАХУНКУ, не завжди гривня
    const isIncome = amt > 0;
    const descr = norm(item.description);
    const mcc = String(item.mcc || "");
    const [cat, sub] = categorize(descr, mcc, isIncome);
    const s = stamp(item.time);
    const opCcy = CCY[item.currencyCode] || String(item.currencyCode || "");
    /* Головне поле `amount` завжди В ГРИВНІ — на ньому тримаються всі
       підсумки, бюджети, графіки й підписки. Для валютного рахунку це
       перерахунок за курсом того дня; оригінал зберігається поруч, і
       саме він показується в списку та картці. */
    const accCcy = CCY[acc ? acc.currency : 980] || "UAH";
    const own = r2(Math.abs(amt));
    const rate = accCcy === "UAH" ? 1 : rateFor(accCcy, Math.floor(item.time / 86400));
    const rec = {
      id: item.id, date: s.date, time: s.time,
      merchant: descr || "Без опису",
      amount: rate ? r2(own * rate) : own,
      dir: isIncome ? "income" : "expense",
      conf: "mono",
      balance: r2((item.balance || 0) / 100),
      mcc, cat, sub,
      account: acc ? acc.title : "",
      acctype: acc ? acc.kind : ""
    };
    if (accCcy !== "UAH") {
      rec.accCcy = accCcy;        // валюта рахунку
      rec.accAmount = own;        // сума в ній
      if (rate) rec.accRate = Math.round(rate * 100) / 100;
      else rec.noRate = true;     // курсу немає — сума лишилась у валюті
    }
    if (item.comment) rec.comment = item.comment;
    if (item.counterName) rec.counterName = item.counterName;
    if (item.counterIban) rec.counterIban = item.counterIban;
    if (item.counterEdrpou) rec.counterEdrpou = item.counterEdrpou;
    if (item.invoiceId) rec.invoiceId = item.invoiceId;
    if (item.receiptId) rec.receipt = item.receiptId;
    if (item.cashbackAmount) rec.cashback = r2(item.cashbackAmount / 100);
    if (item.commissionRate) rec.commission = r2(item.commissionRate / 100);
    if (item.hold) rec.hold = true;
    if (opCcy && opCcy !== "UAH") {
      rec.currency = opCcy;
      rec.opAmount = r2(Math.abs(item.operationAmount || 0) / 100);
    }
    return rec;
  }

  /* ── рух коштів між своїми рахунками ──
     Переказ із чорної на ФОП — це не витрата й не дохід, а одна операція
     з двома ногами. Якщо їх не злити, місяць «витрачає» вдвічі більше.
     Шукаємо трьома способами: за власним IBAN, за парою протилежних сум
     у вузькому вікні часу, і за маскою власної картки в описі.          */
  function pairUp(recs, accounts, owner) {
    const ownIban = new Set(accounts.map(a => a.iban).filter(Boolean));
    const ownMask = new Set(accounts.flatMap(a => a.masked || []));
    /* Переказ самому собі банк підписує вашим же іменем. Без цього
       знання зарахування з власного ФОП виглядає як дохід ззовні — і
       місяць «заробляє» стільки ж, скільки ви просто переклали. */
    const me = (owner || '').trim().toLowerCase();
    const isMe = v => {
      const x = (v || '').trim().toLowerCase();
      if (!x || !me) return false;
      if (x === me) return true;
      // «Іваненко Іван» проти «Іван Іваненко» — банк пише і так, і так
      const a = me.split(/\s+/).filter(Boolean).sort().join(' ');
      const b = x.split(/\s+/).filter(Boolean).sort().join(' ');
      return a === b;
    };
    /* `why` — на підставі ЧОГО ми вирішили, що це рух коштів. Потрібно
       для чесної діагностики: доказ (свій IBAN, своя картка, власне
       імʼя, знайдена пара) — це одне, а здогад за текстом опису —
       зовсім інше, і саме здогади варто показувати людині. */
    const mark = (r, sub, pair, why) => {
      r.cat = "Між рахунками"; r.sub = sub; r.internal = true;
      r.moveWhy = why || r.moveWhy || 'guess';
      if (pair) r.pair = pair;
    };
    /* Готівка — фізична дія, а не переказ, і «другою ногою» бути не може.
       Без цього захисту зняття в касі осідало в «Між рахунками» трьома
       шляхами одразу: каса підписує операцію імʼям власника (isMe),
       банкомат інколи пише маску вашої ж картки, а пошук пар хапав
       зняття як «списання тут» до випадкового надходження тієї ж суми
       в шестигодинному вікні. */
    const isCash = r => r.mcc === '6010' || r.mcc === '6011'
      || /^каса\b|банкомат/i.test(r.merchant || '');

    for (const r of recs) {
      if (isCash(r)) continue;
      if (r.counterIban && ownIban.has(r.counterIban)) mark(r, "Свої рахунки", null, 'iban');
      else if (ownMask.has(r.merchant)) mark(r, "Свої картки", null, 'mask');
      else if (isMe(r.counterName) || isMe(r.merchant)) mark(r, "Свої рахунки", null, 'name');
    }
    /* ── повернення, а не переказ ──
       Скасоване замовлення приходить як ЗАРАХУВАННЯ від того самого
       мерчанта й на ту саму суму. Для пошуку пар нижче це виглядало як
       переказ між своїми рахунками — і служби доставки з ігровими
     крамницями осідали в «Між
       рахунками». Тому повернення розпізнаємо ПЕРШИМИ й виводимо
       з-під пошуку пар.

       Ознака: зарахування має MCC (тобто прийшло від торговця, а не
       від людини чи з іншого рахунку) і в історії є витрата з такою
       самою назвою. Зарплата, переказ від людини чи поповнення так не
       виглядають — у них або немає MCC, або немає витрати-двійника. */
    /* Назва повернення рідко збігається з назвою покупки: банк пише
       «Скасування. PayPal» проти «PayPal». Тому порівнюємо ОЧИЩЕНІ
       назви — без слів про скасування й без розділових знаків — і
       вважаємо їх спорідненими, якщо одна міститься в іншій. */
    const RFW = /(скасуванн\w*|поверненн\w*|возврат\w*|повернуто|refund\w*|reversal|cancel\w*|chargeback)/gi;
    const key = s => (s || '').toLowerCase().replace(RFW, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const akin = (a, b) => {
      a = key(a); b = key(b);
      if (!a || !b) return false;
      return a === b || a.includes(b) || b.includes(a);
    };
    /* Сума збігається, якщо збігається сума В ВАЛЮТІ ОПЕРАЦІЇ (499,99 USD
       туди й назад — найнадійніший доказ; у гривні ті самі 499,99 дадуть
       різні числа, бо курс за тиждень зʼїхав) або гривневі суми в межах
       півтора відсотка. */
    const sameSum = (a, b) => {
      if (a.opAmount && b.opAmount && a.currency && a.currency === b.currency)
        return Math.abs(a.opAmount - b.opAmount) <= 0.02;
      return Math.abs(a.amount - b.amount) <= Math.max(0.02, a.amount * 0.015);
    };
    const WIN = 90 * 86400e3;                 // повернення приходить і за місяць
    const spends = recs.filter(r => r.dir === "expense" && !r.internal);
    for (const r of recs) {
      if (r.dir !== "income" || r.internal || !r.mcc) continue;
      const t = new Date(r.time || r.date);
      /* Кандидати: витрата тим самим (спорідненим) мерчантом, раніша за
         зарахування, у межах вікна, з тією ж сумою. Обидві умови разом —
         інакше в повернення легко записати випадковий дохід. */
      const cand = spends.filter(x => {
        const tx = new Date(x.time || x.date);
        return tx <= t && t - tx < WIN && akin(x.merchant, r.merchant) && sameSum(x, r);
      });
      const src = cand.length ? cand[cand.length - 1]
        : spends.filter(x => {
            const tx = new Date(x.time || x.date);
            return tx <= t && t - tx < WIN && akin(x.merchant, r.merchant);
          }).pop();
      if (!src) continue;
      r.refund = true;
      r.refundOf = src.id;
      r.pair = src.id;              // щоб пошук пар нижче їх не чіпав
      r.cat = src.cat; r.sub = src.sub;   // повернення належить тій же категорії
      src.refunded = r.id;
      src.pair = r.id;              // ця витрата вже пояснена — не переказ
    }

    const out = recs.filter(r => r.dir === "expense" && !r.pair && !isCash(r));
    const inn = recs.filter(r => r.dir === "income" && !r.pair && !r.refund && !isCash(r));
    for (const o of out) {
      if (o.pair) continue;
      /* Допуск у гривні: після перерахунку валютної ноги копійка в
         копійку не збігається ніколи, тож жорсткі 2 копійки лишали б
         переказ між доларовим і гривневим рахунком нерозпізнаним. */
      const tol = (o.accCcy || 1) === 1 ? 0.02 : Math.max(0.02, o.amount * 0.01);
      /* Шість годин, а не одна. Переказ між своїми рахунками зазвичай
         миттєвий, але міжбанк і вихідні вміють затримати; сума при цьому
         збігається до копійки, тож ширше вікно нічого не псує. */
      const c = inn.find(x => !x.pair && x.id !== o.id
        && Math.abs(x.amount - o.amount) <= Math.max(tol, x.accCcy ? x.amount * 0.01 : 0.02)
        && Math.abs(new Date(x.time || x.date) - new Date(o.time || o.date)) < 6 * 36e5);
      if (!c) continue;
      mark(o, "Свої рахунки", c.id, 'pair');
      mark(c, "Свої рахунки", o.id, 'pair');
    }
    for (const r of recs) {
      if (r.internal || isCash(r)) continue;
      if (/^поповнення|переказ на картку|^з картки/i.test(r.merchant)) mark(r, "Перекази собі", null, 'guess');
    }
    return recs;
  }

  /* ── Notion + банк без дублів ──────────────────────────────────────
     Записи з Notion лишаються, доки банк не віддасть той самий період:
     інакше після переходу на десктоп зникла б уся давніша історія.

     Межа — дата найдавнішої банківської операції. Усе, що з Notion і
     НЕ старіше за неї, викидається: цей проміжок банк уже покрив, і
     тримати обидві версії означало б рахувати кожну витрату двічі.

     Ідентифікатори тут не допоможуть: у Notion свої id, у банку свої,
     і та сама покупка має різні. Тому додатково — звірка за змістом
     (дата + сума + мерчант). Це страховка на випадок, коли межа не
     спрацює: наприклад, з'явився давній рахунок і зсунув її назад. */
  function merge(mono, legacy) {
    if (!legacy || !legacy.length) return { tx: mono, kept: 0, dropped: 0, since: null };
    const since = mono.length
      ? mono.reduce((m, t) => (t.date < m ? t.date : m), "9999-12-31")
      : "9999-12-31";

    const sig = t => `${t.date}|${Math.round(t.amount * 100)}|${(t.merchant || '').toLowerCase()}`;
    const seen = new Set(mono.map(sig));
    const ids = new Set(mono.map(t => t.id));

    const keep = legacy.filter(t =>
      t.date < since && !ids.has(t.id) && !seen.has(sig(t)));
    return { tx: keep.concat(mono), kept: keep.length,
             dropped: legacy.length - keep.length, since: mono.length ? since : null };
  }

  window.monoNormalize = function (raw, legacy) {
    raw = raw || {};
    const accounts = raw.accounts || [];
    const byId = Object.fromEntries(accounts.map(a => [a.id, a]));
    const owner = raw.owner || '';
    RATES = buildRates(raw.items || {}, byId);
    const recs = [];
    for (const [accId, list] of Object.entries(raw.items || {}))
      for (const it of list) recs.push(one(it, byId[accId]));
    recs.sort((a, b) => (a.time || a.date) < (b.time || b.date) ? -1 : 1);
    pairUp(recs, accounts, owner);
    const m = merge(recs, legacy);
    window.monoMerge = { kept: m.kept, dropped: m.dropped, since: m.since, bank: recs.length };
    return m.tx;
  };
})();
