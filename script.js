
/* ══════════════════════════════════════════════════════════════
   DATA ARCHITECTURE  v5 — Google Sheets CSV-Backed CMS
   ─────────────────────────────────────────────────────────────
   Data now lives in a published Google Sheet (CSV export), parsed
   client-side with PapaParse. This lets non-technical founders add
   1000+ places by editing a spreadsheet — zero code changes needed.

   Every place object has:
     id         → unique identifier (string)
     city[]     → city names (multi-city allowed)
     mood[]     → مزاج: أدرينالين | استرخاء | اجتماعي | ثقافي | رومانسي | مغامرة
     budget[]   → مجاني | أقل من 5 دنانير | 5-15 دينار | 15+ دينار
     time[]     → morning | evening | night
     audience[] → local | tourist | both
                  local   = Jordanians, casual, discount-focused
                  tourist = visitors, premium, cultural, landmark-rich
                  both    = universally appealing

   STRICT FILTER (AND): city ∩ mood ∩ budget ∩ time ∩ audience
   Country Engine: country === 'الأردن' (or null) → 'local', else → 'tourist'

   ⚠️ CSV CAVEAT: Papa Parse with header:true returns every column
   as a plain string. filterStrict() calls .includes() on city/mood/
   budget/time/audience, and the result renderer calls .concat() on
   pills — both require real arrays. normalizeRow() below splits
   each multi-value column on '|' (recommended in the sheet) so a
   cell like "عمّان|إربد" becomes ['عمّان', 'إربد']. Single-value
   cells (no '|') still split cleanly into a 1-item array.
══════════════════════════════════════════════════════════════ */

const BUDGETS = ['مجاني', 'أقل من 5 دنانير', '5-15 دينار', '15+ دينار'];

/* Published Google Sheet CSV export URL — the live, real-time database.
   File → Share → Publish to web → select sheet → CSV → copy link */
const GOOGLE_SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vTtEK0jPMEdAJYXPNwFs21UgDNZh6OUORX-JAgUW9rt59SNmWPjnXx3wPBfWkHn21bH2eWOZVsnAp7t/pub?output=csv";

/* ── Travel Engine v4.0 — Google Sheets (Sheet 2 / same file, second tab) ──
   ✅ الرابط معبأ. لو حبيت تغيّره لاحقاً، استبدل القيمة أدناه فقط. */
const GOOGLE_SHEET_TRAVEL_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vTtEK0jPMEdAJYXPNwFs21UgDNZh6OUORX-JAgUW9rt59SNmWPjnXx3wPBfWkHn21bH2eWOZVsnAp7t/pub?gid=2131725278&single=true&output=csv";

/* ══════════════════════════════════════════════════════════════
   GLOBAL STATE — populated asynchronously by loadPlacesDatabase()
   `places`            → used by filterStrict() and every filter consumer
   `window.placesDatabase` → public alias for external/future access
   Both point to the same normalized array after each parse completes.
══════════════════════════════════════════════════════════════ */
var places = [];
window.placesDatabase = [];
var placesLoaded = false;

/* ══════════════════════════════════════════════════════════════
   NORMALISE — strip every class of invisible/whitespace character
   that survives copy-paste from Google Sheets into CSV:
     \u200B zero-width space       \uFEFF BOM / zero-width no-break
     \u200C zero-width non-joiner  \u200D zero-width joiner
     \u00A0 non-breaking space     \u202F narrow no-break space
   Also collapses runs of regular whitespace and removes Arabic
   diacritics (تشكيل) so "أدرينالين" vs "أدرينالين" always match.
══════════════════════════════════════════════════════════════ */
function normaliseStr(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    /* strip BOM & zero-width chars */
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
    /* normalise all whitespace variants to a plain space */
    .replace(/[\u00A0\u202F\u2009\u2008\u2007\u2006\u2005\u2004\u2003\u2002\u2001]/g, ' ')
    /* remove Arabic diacritics (harakat + shadda + tatweel) */
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u0640]/g, '')
    /* collapse repeated spaces, then trim */
    .replace(/\s+/g, ' ')
    .trim();
}

/* ══════════════════════════════════════════════════════════════
   MOOD SYNONYM MAP — bridges Google Sheet vocabulary to UI labels.
   Add rows here whenever the sheet uses a term the UI doesn't.
   Format: 'شيت-term' → 'UI-term'
══════════════════════════════════════════════════════════════ */
var MOOD_SYNONYMS = {
  'حماس':      'أدرينالين',
  'إثارة':     'أدرينالين',
  'نشاط':      'أدرينالين',
  'راحة':      'استرخاء',
  'هدوء':      'استرخاء',
  'ترفيه':     'اجتماعي',
  'شلة':       'اجتماعي',
  'مجموعة':    'اجتماعي',
  'تعليم':     'ثقافي',
  'تاريخ':     'ثقافي',
  'معرفة':     'ثقافي',
  'رومانس':    'رومانسي',
  'عشاء رومانسي': 'رومانسي',
  'طبيعة':     'مغامرة',
  'رحلة':      'مغامرة',
  'استكشاف':   'مغامرة'
};

/* AUDIENCE SYNONYM MAP */
var AUDIENCE_SYNONYMS = {
  'محلي':       'local',
  'سياحي':      'tourist',
  'الجميع':     'both',
  'all':         'both',
  'everyone':    'both'
};

/* Normalise a raw value then resolve any synonym mapping.
   mapObj is optional — pass null to skip synonym resolution. */
function resolveValue(raw, mapObj) {
  var clean = normaliseStr(raw);
  if (!mapObj) return clean;
  return mapObj.hasOwnProperty(clean) ? mapObj[clean] : clean;
}

/* ══════════════════════════════════════════════════════════════
   SPLIT A CSV MULTI-VALUE CELL
   Accepts '|' as primary delimiter, falls back to ','
   Applies normaliseStr to every token.
   mapObj is optional for synonym resolution per-token.
══════════════════════════════════════════════════════════════ */
function splitCsvField(rawValue, mapObj) {
  if (!rawValue || typeof rawValue !== 'string') return [];
  var delimiter = rawValue.indexOf('|') !== -1 ? '|' : ',';
  return rawValue
    .split(delimiter)
    .map(function(v) { return resolveValue(v, mapObj || null); })
    .filter(function(v) { return v.length > 0; });
}

/* ══════════════════════════════════════════════════════════════
   NORMALISE ONE PAPAPARSE ROW → typed place object
══════════════════════════════════════════════════════════════ */
function normalizeRow(row) {
  return {
    id:           normaliseStr(row.id   || ''),
    city:         splitCsvField(row.city),          /* no synonym map — exact city names */
    mood:         splitCsvField(row.mood,     MOOD_SYNONYMS),
    budget:       splitCsvField(row.budget),        /* budget labels used verbatim in UI */
    time:         splitCsvField(row.time),          /* morning/evening/night — exact */
    audience:     splitCsvField(row.audience, AUDIENCE_SYNONYMS),
    pills:        row.pills
                    ? row.pills.split(',').map(function(p) { return normaliseStr(p); })
                    : [],
    title:        normaliseStr(row.title        || ''),
    desc:         normaliseStr(row.desc         || ''),
    mapQuery:     normaliseStr(row.mapQuery     || ''),
    discount:     normaliseStr(row.discount     || ''),
    discountNote: normaliseStr(row.discountNote || '')
  };
}

/* ══════════════════════════════════════════════════════════════
   ASYNC DATA LOADER v2
   Uses fetch() directly instead of Papa.parse(download:true) so:
     • The Service Worker can intercept, cache, and serve offline
     • We get proper CORS error messages in DevTools
     • Fallback to data/places.json if Sheet is unreachable
══════════════════════════════════════════════════════════════ */
function setDiscoverButtonLoading(isLoading) {
  var btn = document.getElementById('discover-btn');
  if (!btn) return;
  if (isLoading) {
    btn.disabled = true;
    btn.style.opacity = '0.65';
    btn.style.cursor  = 'not-allowed';
    var inner = btn.querySelector('.cta-inner');
    if (inner) inner.innerHTML = '<span class="spinner">⏳</span> جاري تحميل البيانات...';
  } else {
    btn.disabled = false;
    btn.style.opacity = '';
    btn.style.cursor  = '';
    var inner2 = btn.querySelector('.cta-inner');
    if (inner2) inner2.innerHTML = 'اكتشف طلعتك <svg class="cta-arrow" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 10h12M10 4l6 6-6 6" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
}

function commitPlaces(data, source) {
  places             = data;
  window.placesDatabase = data;
  placesLoaded       = data.length > 0;
  console.log('[Talaty] Loaded ' + data.length + ' places from ' + source);
}

/* Parse a CSV text string using PapaParse (already on the page) */
function parseCsvText(csvText) {
  var result = Papa.parse(csvText, {
    header:         true,
    skipEmptyLines: true
  });
  if (!result || !Array.isArray(result.data)) return [];
  return result.data
    .filter(function(row) { return row && row.title; })
    .map(normalizeRow);
}

/* Fallback: load the bundled JSON file */
function tryFallbackJson() {
  return fetch('./data/places.json')
    .then(function(r) {
      if (!r.ok) throw new Error('places.json HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      if (!Array.isArray(data)) throw new Error('Not an array');
      commitPlaces(data, 'places.json (offline fallback)');
    });
}

function loadPlacesDatabase() {
  setDiscoverButtonLoading(true);

  /* Use a 7-second timeout race in case fetch hangs silently */
  var timeoutSignal = new Promise(function(_, reject) {
    setTimeout(function() { reject(new Error('timeout')); }, 7000);
  });

  return Promise.race([
    fetch(GOOGLE_SHEET_CSV_URL, { mode: 'cors', cache: 'no-cache' }),
    timeoutSignal
  ])
  .then(function(response) {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.text();
  })
  .then(function(csvText) {
    var rows = parseCsvText(csvText);
    if (rows.length === 0) throw new Error('Empty or unparseable CSV');
    commitPlaces(rows, 'Google Sheet CSV');
  })
  .catch(function(sheetErr) {
    console.warn('[Talaty] Sheet unavailable (' + sheetErr.message + ') — trying local fallback');
    return tryFallbackJson().catch(function(jsonErr) {
      console.error('[Talaty] Fallback also failed:', jsonErr.message);
      commitPlaces([], 'none');
      showToastSafe('التطبيق يعمل بوضع محدود — تحقق من الاتصال', 'danger', 4000);
    });
  })
  .finally(function() {
    setDiscoverButtonLoading(false);
  });
}

/* Uses showToast() if already defined at call time, otherwise no-ops
   silently (showToast is declared later in this file but the loader
   may resolve before that point during initial parse). */
function showToastSafe(message, type, duration) {
  if (typeof showToast === 'function') {
    showToast(message, type, duration);
  } else {
    console.warn('[Talaty] ' + message);
  }
}

/* Kick off the fetch/parse as soon as the DOM is ready */
document.addEventListener('DOMContentLoaded', function() {
  loadPlacesDatabase();   /* Sheet 1 — local places  */
  loadTravelDatabase();   /* Sheet 2 — travel engine */
});


/* ══════════════════════════════════════════════════════════════
   INTERNATIONAL TRAVEL DATABASE — "سفر للخارج" mode  (v4.0)
   ─────────────────────────────────────────────────────────────
   Destinations are now loaded dynamically from Google Sheets
   (Sheet 2) via loadTravelDatabase(). Internal schema per row:
     title, desc, country, flag, mapQuery
     mood[]    → same vocabulary as local places
     budget[]  → اقتصادي | متوسط | فخم | VIP
     allowed[] → nationalities/countries permitted, or ['all']
     pills[], discount, discountNote
   If the sheet URL is a placeholder or the fetch fails, the app
   falls back to TRAVEL_FALLBACK_DESTINATIONS so Travel Mode
   never breaks.
══════════════════════════════════════════════════════════════ */
const TRAVEL_BUDGETS = ['اقتصادي', 'متوسط', 'فخم', 'VIP'];

var travelDestinations = [];   /* filterTravelDestinations() reads this */
var travelLoaded = false;      /* true once loading settles (success OR fallback) */

/* Country display name → emoji flag (fallback '✈️' for anything missing) */
var COUNTRY_FLAGS = {
  'جورجيا':'🇬🇪','تركيا':'🇹🇷','أذربيجان':'🇦🇿','ماليزيا':'🇲🇾','إندونيسيا':'🇮🇩',
  'تايلاند':'🇹🇭','المالديف':'🇲🇻','جزر المالديف':'🇲🇻','سيشل':'🇸🇨','موريشيوس':'🇲🇺',
  'سريلانكا':'🇱🇰','نيبال':'🇳🇵','فيتنام':'🇻🇳','كمبوديا':'🇰🇭','الهند':'🇮🇳',
  'قيرغيزستان':'🇰🇬','كازاخستان':'🇰🇿','أوزبكستان':'🇺🇿','أرمينيا':'🇦🇲','طاجيكستان':'🇹🇯',
  'عُمان':'🇴🇲','الإمارات':'🇦🇪','قطر':'🇶🇦','البحرين':'🇧🇭','السعودية':'🇸🇦',
  'الكويت':'🇰🇼','الأردن':'🇯🇴','العراق':'🇮🇶','مصر':'🇪🇬','لبنان':'🇱🇧',
  'المغرب':'🇲🇦','تونس':'🇹🇳','كوسوفو':'🇽🇰','البوسنة والهرسك':'🇧🇦','ألبانيا':'🇦🇱',
  'الجبل الأسود':'🇲🇪','صربيا':'🇷🇸','روسيا':'🇷🇺','بيلاروسيا':'🇧🇾','الصين':'🇨🇳',
  'كوريا الجنوبية':'🇰🇷','اليابان':'🇯🇵','سنغافورة':'🇸🇬','هونغ كونغ':'🇭🇰','ماكاو':'🇲🇴',
  'الفلبين':'🇵🇭','بروناي':'🇧🇳','لاوس':'🇱🇦','بوتان':'🇧🇹','باكستان':'🇵🇰',
  'تنزانيا':'🇹🇿','كينيا':'🇰🇪','رواندا':'🇷🇼','إثيوبيا':'🇪🇹','مدغشقر':'🇲🇬',
  'جزر القمر':'🇰🇲','جيبوتي':'🇩🇯','زيمبابوي':'🇿🇼','زامبيا':'🇿🇲','أوغندا':'🇺🇬',
  'موزمبيق':'🇲🇿','السنغال':'🇸🇳','بالاو':'🇵🇼','اليونان':'🇬🇷','قبرص':'🇨🇾',
  'إيطاليا':'🇮🇹','فرنسا':'🇫🇷','إسبانيا':'🇪🇸','بريطانيا':'🇬🇧','هولندا':'🇳🇱',
  'النمسا':'🇦🇹','سويسرا':'🇨🇭','التشيك':'🇨🇿','المجر':'🇭🇺','البرتغال':'🇵🇹',
  'ألمانيا':'🇩🇪','بولندا':'🇵🇱','كرواتيا':'🇭🇷','سلوفينيا':'🇸🇮','آيسلندا':'🇮🇸',
  'النرويج':'🇳🇴','الدنمارك':'🇩🇰','البرازيل':'🇧🇷','الأرجنتين':'🇦🇷','تشيلي':'🇨🇱',
  'البيرو':'🇵🇪','المكسيك':'🇲🇽'
};

/* Country name (profile dropdown) → nationality adjective (sheet column).
   The matcher accepts BOTH forms so the sheet can use either. */
var COUNTRY_TO_NATIONALITY = {
  'الأردن':'أردني','السعودية':'سعودي','الإمارات':'إماراتي','قطر':'قطري',
  'الكويت':'كويتي','عُمان':'عُماني','البحرين':'بحريني','مصر':'مصري',
  'فلسطين':'فلسطيني','لبنان':'لبناني','سوريا':'سوري','العراق':'عراقي',
  'اليمن':'يمني','ليبيا':'ليبي','تونس':'تونسي','الجزائر':'جزائري',
  'المغرب':'مغربي','السودان':'سوداني','موريتانيا':'موريتاني','الصومال':'صومالي'
};

/* Built-in fallback (the original 15 curated destinations) —
   used automatically when the travel sheet is unreachable. */
var TRAVEL_FALLBACK_DESTINATIONS = [
  { country:'جورجيا', flag:'🇬🇪', mood:['مغامرة','استرخاء'], budget:['اقتصادي','متوسط'], allowed:['all'],
    title:'تبليسي وكازبيغي — جورجيا',
    desc:'جبال القوقاز الخلابة، تبليسي القديمة بحماماتها الكبريتية، وقرية كازبيغي عند سفح الجبل المهيب. وجهة اقتصادية ومذهلة بصرياً.',
    pills:['🏔️ جبال','♨️ حمامات','🍷 نبيذ'], mapQuery:'Tbilisi Georgia',
    discount:'TALATY15', discountNote:'وفّر 15% على باقة الطيران والفندق!' },
  { country:'تركيا', flag:'🇹🇷', mood:['اجتماعي','ثقافي'], budget:['متوسط','فخم'], allowed:['all'],
    title:'إسطنبول — ملتقى القارتين',
    desc:'آيا صوفيا، البازار الكبير، والبوسفور الساحر. مدينة تجمع التاريخ العثماني بالحياة الحديثة على ضفتي القارتين.',
    pills:['🕌 عثماني','🛍️ بازار','🌉 بوسفور'], mapQuery:'Istanbul Turkey',
    discount:'TALATY10', discountNote:'وفّر 10% على جولاتك السياحية!' },
  { country:'تركيا', flag:'🇹🇷', mood:['استرخاء','رومانسي'], budget:['فخم','VIP'], allowed:['all'],
    title:'بودروم — الريفييرا التركية',
    desc:'شواطئ تركواز، يخوت فاخرة، ومنتجعات راقية على بحر إيجة. الوجهة المثالية لشهر العسل أو رحلة استرخاء فاخرة.',
    pills:['🛥️ يخوت','🏖️ شواطئ','✨ فاخر'], mapQuery:'Bodrum Turkey',
    discount:'TALATY15', discountNote:'وفّر 15% على إقامتك الفاخرة!' },
  { country:'جزر المالديف', flag:'🇲🇻', mood:['رومانسي','استرخاء'], budget:['VIP'], allowed:['all'],
    title:'المالديف — فلل فوق الماء',
    desc:'فلل خشبية فاخرة فوق مياه فيروزية صافية. شهر عسل أو احتفال خاص لا يُنسى في واحدة من أجمل الجزر في العالم.',
    pills:['🏝️ فلل مائية','🤿 غوص','💎 VIP'], mapQuery:'Maldives',
    discount:'TALATY15', discountNote:'وفّر 15% على إقامة الفلل الفاخرة!' },
  { country:'مصر', flag:'🇪🇬', mood:['ثقافي','مغامرة'], budget:['اقتصادي','متوسط'],
    allowed:['الأردن','السعودية','الإمارات','الكويت','قطر','البحرين','عُمان','فلسطين','لبنان'],
    title:'القاهرة والأقصر — أرض الفراعنة',
    desc:'أهرامات الجيزة، معابد الأقصر، ونهر النيل الخالد. رحلة في عمق الحضارة المصرية القديمة بأسعار اقتصادية مناسبة.',
    pills:['🔺 أهرامات','🛶 نيل','🏛️ معابد'], mapQuery:'Cairo Egypt',
    discount:'TALATY10', discountNote:'وفّر 10% على جولة الأهرامات!' },
  { country:'مصر', flag:'🇪🇬', mood:['استرخاء','مغامرة'], budget:['متوسط','فخم'],
    allowed:['الأردن','السعودية','الإمارات','الكويت','قطر','البحرين','عُمان','فلسطين','لبنان'],
    title:'الغردقة وشرم الشيخ — البحر الأحمر',
    desc:'شعاب مرجانية عالمية، غوص استثنائي، ومنتجعات شاطئية. الوجهة المفضلة لمحبي البحر الأحمر من العرب.',
    pills:['🤿 غوص','🐠 شعاب','☀️ شمس'], mapQuery:'Hurghada Egypt',
    discount:'TALATY10', discountNote:'وفّر 10% على باقة الغوص!' },
  { country:'لبنان', flag:'🇱🇧', mood:['اجتماعي','رومانسي'], budget:['متوسط','فخم'],
    allowed:['الأردن','السعودية','الإمارات','الكويت','قطر','مصر'],
    title:'بيروت وجبل لبنان',
    desc:'حياة ليلية نابضة، مطاعم عالمية، وجبال خلابة على بعد دقائق من البحر. تجربة اجتماعية وثقافية لا تُضاهى.',
    pills:['🌃 حياة ليلية','🍽️ مطاعم','🏔️ جبال'], mapQuery:'Beirut Lebanon',
    discount:'TALATY10', discountNote:'وفّر 10% على حجز المطاعم!' },
  { country:'الإمارات', flag:'🇦🇪', mood:['أدرينالين','اجتماعي'], budget:['فخم','VIP'], allowed:['all'],
    title:'دبي — مدينة المستقبل',
    desc:'برج خليفة، سفاري صحراوي، وأسواق فاخرة. مزيج من الإثارة العصرية والفخامة المطلقة في قلب الخليج.',
    pills:['🏙️ ناطحات سحاب','🏜️ سفاري','🛍️ تسوق فاخر'], mapQuery:'Dubai UAE',
    discount:'TALATY15', discountNote:'وفّر 15% على تذكرة برج خليفة!' },
  { country:'الإمارات', flag:'🇦🇪', mood:['ثقافي','استرخاء'], budget:['متوسط','فخم'], allowed:['all'],
    title:'أبوظبي — جامع الشيخ زايد واللوفر',
    desc:'جامع الشيخ زايد المهيب ومتحف اللوفر أبوظبي. مزيج فريد بين الروحانية والفن العالمي في عاصمة الإمارات.',
    pills:['🕌 جامع','🖼️ متحف','✨ معماري'], mapQuery:'Abu Dhabi UAE',
    discount:'TALATY10', discountNote:'وفّر 10% على الجولات الثقافية!' },
  { country:'جورجيا', flag:'🇬🇪', mood:['ثقافي','اجتماعي'], budget:['اقتصادي'], allowed:['all'],
    title:'باتومي — لؤلؤة البحر الأسود',
    desc:'مدينة ساحلية حديثة بحدائق نباتية ومطاعم على البحر الأسود. وجهة اقتصادية مليئة بالحياة والثقافة المعاصرة.',
    pills:['🌊 بحر أسود','🌳 حدائق','💰 اقتصادي'], mapQuery:'Batumi Georgia',
    discount:'TALATY10', discountNote:'وفّر 10% على فندقك في باتومي!' },
  { country:'اليونان', flag:'🇬🇷', mood:['رومانسي','استرخاء'], budget:['فخم','VIP'], allowed:['all'],
    title:'سانتوريني — جزيرة الغروب الذهبي',
    desc:'منازل بيضاء وقباب زرقاء فوق منحدرات بركانية، وغروب شمس أسطوري. الوجهة الرومانسية الأشهر في العالم.',
    pills:['🌅 غروب','🏛️ يوناني','💑 رومانسي'], mapQuery:'Santorini Greece',
    discount:'TALATY15', discountNote:'وفّر 15% على إقامتك المطلة على البحر!' },
  { country:'إندونيسيا', flag:'🇮🇩', mood:['استرخاء','مغامرة'], budget:['متوسط','فخم'], allowed:['all'],
    title:'بالي — جزيرة الآلهة',
    desc:'معابد هندوسية، حقول أرز خضراء، وشواطئ استوائية. ملاذ روحي وطبيعي يجمع المغامرة بالاسترخاء التام.',
    pills:['🛕 معابد','🌾 حقول أرز','🏄 شواطئ'], mapQuery:'Bali Indonesia',
    discount:'TALATY10', discountNote:'وفّر 10% على فيلتك في أوبود!' },
  { country:'السعودية', flag:'🇸🇦', mood:['مغامرة','ثقافي'], budget:['متوسط','فخم'], allowed:['all'],
    title:'العُلا — متحف مفتوح في الصحراء',
    desc:'مدائن صالح الأثرية وتشكيلات صخرية عمرها آلاف السنين. وجهة سعودية جديدة تجمع التاريخ بالمغامرة الصحراوية.',
    pills:['🏜️ صحراء','🗿 آثار','🚙 مغامرة'], mapQuery:'AlUla Saudi Arabia',
    discount:'TALATY10', discountNote:'وفّر 10% على جولة مدائن صالح!' },
  { country:'قبرص', flag:'🇨🇾', mood:['استرخاء','اجتماعي'], budget:['متوسط'], allowed:['all'],
    title:'ليماسول — شواطئ المتوسط',
    desc:'شواطئ متوسطية صافية ومدينة قديمة نابضة بالحياة. وجهة قريبة ومريحة للهروب القصير من صخب الحياة.',
    pills:['🏖️ شواطئ','🍴 مأكولات','😌 استرخاء'], mapQuery:'Limassol Cyprus',
    discount:'TALATY10', discountNote:'وفّر 10% على باقة الإقامة!' },
  { country:'المغرب', flag:'🇲🇦', mood:['ثقافي','مغامرة'], budget:['اقتصادي','متوسط'], allowed:['all'],
    title:'مراكش — المدينة الحمراء',
    desc:'أسواق المدينة القديمة، رياضات تقليدية، وجبال الأطلس القريبة. تجربة ثقافية ساحرة بألوان وروائح المغرب الأصيلة.',
    pills:['🕌 مدينة قديمة','🏔️ أطلس','🎨 ألوان'], mapQuery:'Marrakech Morocco',
    discount:'TALATY10', discountNote:'وفّر 10% على الرياض الذي تقيم به!' }
];

/* ── Normalise one CSV row from Sheet 2 into the internal schema ── */
function normalizeTravelRow(row) {
  var country  = (row.country || '').trim();
  var discount = (row.discount || '').trim();

  return {
    id:      (row.id || '').trim(),
    title:   (row.title || '').trim(),
    desc:    (row.desc || '').trim(),
    country: country,
    flag:    (row.flag || '').trim() || COUNTRY_FLAGS[country] || '✈️',
    mapQuery:(row.mapQuery || '').trim(),

    /* mood/budget: single value in the sheet, but pipe-separated
       multi-values are also accepted (e.g. "استرخاء|رومانسي") */
    mood: (row.mood || '').split('|')
      .map(function(m){ return normaliseStr(MOOD_SYNONYMS[normaliseStr(m)] || m); })
      .filter(function(m){ return m.length > 0; }),
    budget: (row.budget || '').split('|')
      .map(function(b){ return normaliseStr(b); })
      .filter(function(b){ return b.length > 0; }),

    /* pipe-separated nationality list → clean array.
       Empty cell → ['all'] so an unfilled row never disappears. */
    allowed: (function() {
      var list = (row.allowed_nationalities || '').split('|')
        .map(function(n){ return normaliseStr(n); })
        .filter(function(n){ return n.length > 0; });
      return list.length > 0 ? list : ['all'];
    })(),

    /* comma-separated pills → clean array */
    pills: (row.pills || '').split(',')
      .map(function(p){ return p.trim(); })
      .filter(function(p){ return p.length > 0; }),

    discount: discount,
    discountNote: (row.discountNote || '').trim() ||
                  (discount ? 'استخدم الكود عند الحجز!' : '')
  };
}

/* ── Loader: fetch Sheet 2 → Papa.parse → normalise → commit ──
   Any failure (placeholder URL, network, empty sheet) falls back
   to TRAVEL_FALLBACK_DESTINATIONS — Travel Mode never breaks. */
function loadTravelDatabase() {
  /* URL not configured yet → use built-in fallback immediately */
  if (!GOOGLE_SHEET_TRAVEL_CSV_URL || GOOGLE_SHEET_TRAVEL_CSV_URL.indexOf('PLACEHOLDER') !== -1) {
    travelDestinations = TRAVEL_FALLBACK_DESTINATIONS;
    travelLoaded = true;
    if (window.TALATY_DEBUG) {
      console.warn('[Talaty Travel] Sheet URL not set — using ' + travelDestinations.length + ' fallback destinations');
    }
    return Promise.resolve();
  }

  var controller = new AbortController();
  var timeoutId = setTimeout(function(){ controller.abort(); }, 7000); /* same 7s policy as local engine */

  return fetch(GOOGLE_SHEET_TRAVEL_CSV_URL, { mode:'cors', cache:'no-cache', signal:controller.signal })
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    })
    .then(function(csvText) {
      var parsed = Papa.parse(csvText, { header:true, skipEmptyLines:true });
      var rows = (parsed.data || []).map(normalizeTravelRow)
        .filter(function(d){ return d.title.length > 0 && d.mood.length > 0; });

      if (rows.length === 0) throw new Error('empty sheet');

      travelDestinations = rows;
      travelLoaded = true;
      if (window.TALATY_DEBUG) {
        console.log('[Talaty Travel] Loaded ' + rows.length + ' destinations from Sheet 2');
      }
    })
    .catch(function(err) {
      travelDestinations = TRAVEL_FALLBACK_DESTINATIONS;
      travelLoaded = true;
      if (window.TALATY_DEBUG) {
        console.warn('[Talaty Travel] Load failed (' + err.message + ') — using fallback destinations');
      }
    })
    .finally(function() {
      clearTimeout(timeoutId);
    });
}

/* ══════════════════════════════════════════════════════════════
   RESOLVE USER COUNTRY — for visa-free filtering
   Bridges both the literal localStorage key requested in spec
   ('talaty_profile_country') and the actual profile object key
   already used across the app ('talaty_profile_v1').
══════════════════════════════════════════════════════════════ */
function resolveUserCountry() {
  try {
    var direct = localStorage.getItem('talaty_profile_country');
    if (direct && direct.trim()) return direct.trim();
  } catch(e) {}

  try {
    var profileRaw = localStorage.getItem('talaty_profile_v1');
    if (profileRaw) {
      var profile = JSON.parse(profileRaw);
      if (profile && profile.country && profile.country.trim()) {
        return profile.country.trim();
      }
    }
  } catch(e) {}

  return 'الأردن'; /* default fallback */
}

/* ══════════════════════════════════════════════════════════════
   TRAVEL FILTER ENGINE v4.0 — mood ∩ budget ∩ nationality
   Reads the dynamic travelDestinations array (Sheet 2).
   The nationality check accepts BOTH the country name (الأردن)
   and the nationality adjective (أردني), so either format works
   in the sheet's allowed_nationalities column.
══════════════════════════════════════════════════════════════ */
function filterTravelDestinations(moodKey, budgetKey) {
  var nMood   = normaliseStr(MOOD_SYNONYMS[normaliseStr(moodKey)] || moodKey);
  var nBudget = normaliseStr(budgetKey);

  /* Build the user's identity tokens: country + nationality forms */
  var userCountry = resolveUserCountry();
  var userTokens  = [normaliseStr(userCountry)];
  var natForm     = COUNTRY_TO_NATIONALITY[userCountry];
  if (natForm) userTokens.push(normaliseStr(natForm));

  return travelDestinations.filter(function(d) {
    if (d.mood.indexOf(nMood) === -1) {
      if (window.TALATY_DEBUG) {
        console.log('[Talaty Travel] SKIP "' + d.title + '" — mood: UI="' + nMood + '" | DB=' + JSON.stringify(d.mood));
      }
      return false;
    }
    if (d.budget.indexOf(nBudget) === -1) {
      if (window.TALATY_DEBUG) {
        console.log('[Talaty Travel] SKIP "' + d.title + '" — budget: UI="' + nBudget + '" | DB=' + JSON.stringify(d.budget));
      }
      return false;
    }
    var natOk = d.allowed.indexOf('all') !== -1 ||
                userTokens.some(function(t){ return d.allowed.indexOf(t) !== -1; });
    if (!natOk) {
      if (window.TALATY_DEBUG) {
        console.log('[Talaty Travel] SKIP "' + d.title + '" — nationality ' + JSON.stringify(userTokens) + ' not in ' + JSON.stringify(d.allowed));
      }
      return false;
    }
    return true;
  });
}

/* ══════════════════════════════════════════════════════════════
   GLOBAL TRAVEL MODE STATE
══════════════════════════════════════════════════════════════ */
var isTravelMode = false;

/* ══════════════════════════════════════════════════════════════
   COUNTRY → AUDIENCE ENGINE
   Reads profile localStorage key to determine audience tier
══════════════════════════════════════════════════════════════ */
function resolveAudience() {
  try {
    var profileRaw = localStorage.getItem('talaty_profile_v1');
    if (!profileRaw) return 'local';
    var profile = JSON.parse(profileRaw);
    var country = (profile && profile.country) ? profile.country.trim() : '';
    if (!country || country === 'الأردن') return 'local';
    return 'tourist';
  } catch(e) { return 'local'; }
}

/* ══════════════════════════════════════════════════════════════
   FILTER ENGINE v2 — AND Operator with debug logging + normalisation
   Normalises both the UI keys AND the DB values before comparing,
   eliminating invisible-char / diacritic / whitespace mismatches.
   Set TALATY_DEBUG = true in the browser console to see per-place
   exclusion reasons (e.g. why "لعبة الهروب" was skipped).
══════════════════════════════════════════════════════════════ */
window.TALATY_DEBUG = false; /* flip to true in console to diagnose mismatches */

function filterStrict(cityKey, moodKey, budgetKey, timeKey, audience) {
  /* Normalise all UI-supplied keys once up-front */
  var nCity     = normaliseStr(cityKey);
  var nMood     = normaliseStr(MOOD_SYNONYMS[normaliseStr(moodKey)] || moodKey);
  var nBudget   = normaliseStr(budgetKey);
  var nTime     = timeKey ? normaliseStr(timeKey) : null;
  var nAudience = normaliseStr(audience);

  var matched = [];

  places.forEach(function(p) {
    /* --- city check ------------------------------------------------ */
    var cityOk = p.city.some(function(c) {
      return normaliseStr(c) === nCity;
    });
    if (!cityOk) {
      if (window.TALATY_DEBUG) {
        console.log(
          '[Talaty Filter] SKIP "' + p.title + '" — ' +
          'city mismatch: UI="' + nCity + '" | DB=' + JSON.stringify(p.city)
        );
      }
      return;
    }

    /* --- mood check ------------------------------------------------- */
    var moodOk = p.mood.some(function(m) {
      return normaliseStr(MOOD_SYNONYMS[normaliseStr(m)] || m) === nMood;
    });
    if (!moodOk) {
      if (window.TALATY_DEBUG) {
        console.log(
          '[Talaty Filter] SKIP "' + p.title + '" — ' +
          'mood mismatch: UI="' + nMood + '" | DB=' + JSON.stringify(p.mood)
        );
      }
      return;
    }

    /* --- budget check ----------------------------------------------- */
    var budgetOk = p.budget.some(function(b) {
      return normaliseStr(b) === nBudget;
    });
    if (!budgetOk) {
      if (window.TALATY_DEBUG) {
        console.log(
          '[Talaty Filter] SKIP "' + p.title + '" — ' +
          'budget mismatch: UI="' + nBudget + '" | DB=' + JSON.stringify(p.budget)
        );
      }
      return;
    }

    /* --- time check (skipped in travel mode where timeKey is null,
           and bypassed if the place has no time data at all) -------- */
    if (nTime !== null) {
      var timeOk = (!p.time || p.time.length === 0) ? true : p.time.some(function(t) {
        return normaliseStr(t) === nTime;
      });
      if (!timeOk) {
        if (window.TALATY_DEBUG) {
          console.log(
            '[Talaty Filter] SKIP "' + p.title + '" — ' +
            'time mismatch: UI="' + nTime + '" | DB=' + JSON.stringify(p.time)
          );
        }
        return;
      }
    }

    /* --- audience check (bypassed if the place has no audience data) */
    var audienceOk = (!p.audience || p.audience.length === 0) ? true : p.audience.some(function(a) {
      var na = normaliseStr(AUDIENCE_SYNONYMS[normaliseStr(a)] || a);
      return na === nAudience || na === 'both';
    });
    if (!audienceOk) {
      if (window.TALATY_DEBUG) {
        console.log(
          '[Talaty Filter] SKIP "' + p.title + '" — ' +
          'audience mismatch: UI="' + nAudience + '" | DB=' + JSON.stringify(p.audience)
        );
      }
      return;
    }

    /* --- all checks passed ----------------------------------------- */
    if (window.TALATY_DEBUG) {
      console.log('[Talaty Filter] MATCH "' + p.title + '" ✓');
    }
    matched.push(p);
  });

  return matched;
}

function shuffleArray(arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/* ══════════════════════════════════════════════════════════════
   Legacy helper kept for compatibility — now wraps strict filter
══════════════════════════════════════════════════════════════ */
function findSuggestion(cityKey, moodKey, budgetKey, timeKey) {
  var audience = resolveAudience();
  var matches  = shuffleArray(filterStrict(cityKey, moodKey, budgetKey, timeKey, audience));
  return matches.length > 0 ? matches[0] : null;
}

/* ══════════════════════════════════════════
   STEP DOTS
   Budget is always "selected" via the slider (has a default value),
   so dot-1 is treated as always done once the user touches it,
   or we just mark it done from the start since slider is pre-set.
══════════════════════════════════════════ */
function updateDots() {
  var hasCity   = isTravelMode ? true : !!document.querySelector('[data-group="city"].active');
  var hasBudget = true; // slider always has a value
  var hasTime   = isTravelMode ? true : !!document.querySelector('[data-group="time"].active');
  var hasMood   = !!document.querySelector('[data-group="mood"].active');

  var states = [hasCity, hasBudget, hasTime, hasMood, false];
  states.forEach(function(done, i) {
    var dot = document.getElementById('dot-' + i);
    if (!dot) return;
    dot.classList.remove('active', 'done');
    if (done) {
      dot.classList.add('done');
    } else {
      var prev = states.slice(0, i);
      if (prev.every(Boolean)) dot.classList.add('active');
    }
  });
}

/* ══════════════════════════════════════════
   TOGGLE BUTTONS (city / time / mood)
   Budget is now a range slider — see BUDGET SLIDER section below.
══════════════════════════════════════════ */
document.querySelectorAll('.city-pill, .chip, .mood-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var group = btn.dataset.group;
    document.querySelectorAll('[data-group="' + group + '"]')
            .forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');

    var card = btn.closest('.filter-card');
    if (card) {
      card.classList.remove('error');
      card.classList.add('focused');
      setTimeout(function() { card.classList.remove('focused'); }, 600);
    }

    if (navigator.vibrate) navigator.vibrate(8);
    updateDots();
  });
});

/* ══════════════════════════════════════════
   BUDGET STEPPED SLIDER
   4 steps: 0=مجاني  1=أقل من 5 دنانير  2=5-15 دينار  3=15+ دينار
   direction:ltr on .slider-wrap so value 0→3 moves left→right.
══════════════════════════════════════════ */
var BUDGET_STEPS = ['مجاني', 'أقل من 5 دنانير', '5-15 دينار', '15+ دينار'];
var BUDGET_BADGES = ['مجاني 🆓', 'اقتصادي 💵', 'معتدل 💳', 'فاخر 🔥'];
var BUDGET_STEP_CLASSES = ['step-0', 'step-1', 'step-2', 'step-3'];

var budgetSlider     = document.getElementById('budget-slider');
var budgetLabelText  = document.getElementById('budget-label-text');
var budgetLabelBadge = document.getElementById('budget-label-badge');

function updateBudgetSlider() {
  var step = parseInt(budgetSlider.value, 10);
  var pct  = (step / 3) * 100;

  /* Filled track — blue left, grey right */
  budgetSlider.style.background =
    'linear-gradient(to right, #4361EE ' + pct + '%, #E5E7EB ' + pct + '%)';

  /* Dynamic label */
  budgetLabelText.textContent = BUDGET_STEPS[step];

  /* Badge */
  budgetLabelBadge.textContent = BUDGET_BADGES[step];
  BUDGET_STEP_CLASSES.forEach(function(c) { budgetLabelBadge.classList.remove(c); });
  budgetLabelBadge.classList.add(BUDGET_STEP_CLASSES[step]);

  /* ARIA */
  budgetSlider.setAttribute('aria-valuetext', BUDGET_STEPS[step]);

  /* Mark card focused briefly on change */
  var card = document.getElementById('card-1');
  if (card) {
    card.classList.remove('error');
    card.classList.add('focused');
    clearTimeout(card._focusTimer);
    card._focusTimer = setTimeout(function() { card.classList.remove('focused'); }, 600);
  }
}

budgetSlider.addEventListener('input', function() {
  if (navigator.vibrate) navigator.vibrate(5);
  updateBudgetSlider();
  updateDots();
});
updateBudgetSlider(); /* run once on load to set initial state */

/* Helper used by discover button to get current budget key */
function getSelectedBudget() {
  return BUDGET_STEPS[parseInt(budgetSlider.value, 10)];
}

/* ══════════════════════════════════════════════════════════════
   TRAVEL MODE TOGGLE — "طلعة محلية" vs "سفر للخارج"
══════════════════════════════════════════════════════════════ */
var toggleLocalBtn  = document.getElementById('toggle-local');
var toggleTravelBtn = document.getElementById('toggle-travel');
var toggleWrap      = document.querySelector('.travel-toggle-wrap');
var citySection      = document.getElementById('city-filter-section');
var timeSection       = document.getElementById('time-filter-section');
var distanceSection   = document.getElementById('distance-filter-section');
var budgetQuestionEl = document.getElementById('budget-question-text');

function applyTravelModeUI() {
  if (isTravelMode) {
    /* — Switch to travel mode — */
    toggleWrap.classList.add('mode-travel');
    toggleTravelBtn.classList.add('active');
    toggleLocalBtn.classList.remove('active');

    /* Hide city bar — irrelevant for international travel */
    if (citySection) citySection.classList.add('is-hidden');

    /* Hide Time & Distance filters — irrelevant for international travel */
    if (timeSection)     timeSection.classList.add('hidden-filter');
    if (distanceSection) distanceSection.classList.add('hidden-filter');

    /* Swap budget vocabulary */
    BUDGET_STEPS  = TRAVEL_BUDGETS.slice();
    BUDGET_BADGES = ['اقتصادي 🎒', 'متوسط 🧳', 'فخم 🛎️', 'VIP 💎'];
    if (budgetQuestionEl) budgetQuestionEl.textContent = 'مستوى رفاهيتك بالسفر؟';
    var tickEls = ['tick-0','tick-1','tick-2','tick-3'].map(function(id){ return document.getElementById(id); });
    TRAVEL_BUDGETS.forEach(function(label, i) { if (tickEls[i]) tickEls[i].textContent = label; });

  } else {
    /* — Switch to local mode — */
    toggleWrap.classList.remove('mode-travel');
    toggleLocalBtn.classList.add('active');
    toggleTravelBtn.classList.remove('active');

    /* Restore city bar */
    if (citySection) citySection.classList.remove('is-hidden');

    /* Restore Time & Distance filters */
    if (timeSection)     timeSection.classList.remove('hidden-filter');
    if (distanceSection) distanceSection.classList.remove('hidden-filter');

    /* Restore local budget vocabulary */
    BUDGET_STEPS  = ['مجاني', 'أقل من 5 دنانير', '5-15 دينار', '15+ دينار'];
    BUDGET_BADGES = ['مجاني 🆓', 'اقتصادي 💵', 'معتدل 💳', 'فاخر 🔥'];
    if (budgetQuestionEl) budgetQuestionEl.textContent = 'كم ميزانيتك؟';
    var localTicks = ['مجاني', 'اقتصادي', 'معتدل', 'فاخر'];
    var tickEls2 = ['tick-0','tick-1','tick-2','tick-3'].map(function(id){ return document.getElementById(id); });
    localTicks.forEach(function(label, i) { if (tickEls2[i]) tickEls2[i].textContent = label; });
  }

  /* Refresh the dynamic label/badge text immediately to match new vocabulary */
  updateBudgetSlider();
  updateDots();
}

function setTravelMode(mode) {
  isTravelMode = (mode === 'travel');
  applyTravelModeUI();
  if (navigator.vibrate) navigator.vibrate(15);
}

if (toggleLocalBtn && toggleTravelBtn) {
  toggleLocalBtn.addEventListener('click', function() { setTravelMode('local'); });
  toggleTravelBtn.addEventListener('click', function() { setTravelMode('travel'); });
}

/* ══════════════════════════════════════════
   DISTANCE SLIDER
   Input is forced LTR (direction:ltr on .slider-wrap).
   Value increases left→right, so fill goes left→right too.
══════════════════════════════════════════ */
const slider = document.getElementById('distance');
const kmVal  = document.getElementById('km-val');

function updateSlider() {
  const pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
  slider.style.background =
    `linear-gradient(to right, #4361EE ${pct}%, #E5E7EB ${pct}%)`;
  kmVal.textContent = slider.value;
}

slider.addEventListener('input', updateSlider);
updateSlider();

/* ══════════════════════════════════════════
   SHAKE HELPER
══════════════════════════════════════════ */
function shakeCard(cardId) {
  const card = document.getElementById(cardId);
  if (!card) return;
  card.classList.remove('error');
  void card.offsetWidth;
  card.classList.add('error');
  card.addEventListener('animationend', () => card.classList.remove('error'), { once: true });
}

/* ══════════════════════════════════════════
   DISCOVER BUTTON — Local Engine (Path A) + Travel Engine (Path B)
══════════════════════════════════════════ */
document.getElementById('discover-btn').addEventListener('click', function() {
  /* Note: button is disabled via setDiscoverButtonLoading() while the CSV
     fetch is in progress, so placesLoaded is always true by the time any
     click can fire. Guard kept as a belt-and-suspenders safety check only. */
  if (!isTravelMode && !placesLoaded) return; /* silent — button was already disabled */

  var time = document.querySelector('[data-group="time"].active');
  var mood = document.querySelector('[data-group="mood"].active');
  var distance = slider.value;

  /* ── Validation differs by mode: travel mode hides City, Time & Distance ── */
  var hasError = false;
  var city = null;
  if (!isTravelMode) {
    city = document.querySelector('[data-group="city"].active');
    if (!city) { shakeCard('card-0'); hasError = true; }
    if (!time) { shakeCard('card-2'); hasError = true; }
  }
  if (!mood) { shakeCard('card-3'); hasError = true; }
  if (hasError) return;

  var budgetKey = getSelectedBudget();  /* always valid — slider has default */
  var timeKey   = time ? time.dataset.val : null;
  var moodKey   = mood.dataset.val;
  var cityKey   = city ? city.dataset.val : null;

  var sug          = null;
  var travelResult = null;
  var audience     = null;

  if (isTravelMode) {
    /* ─── PATH B: TRAVEL MODE ─── */
    var travelMatches = shuffleArray(filterTravelDestinations(moodKey, budgetKey));
    travelResult = travelMatches.length > 0 ? travelMatches[0] : null;
  } else {
    /* ─── PATH A: LOCAL MODE (existing engine, untouched) ─── */
    audience = resolveAudience();
    var matches = shuffleArray(filterStrict(cityKey, moodKey, budgetKey, timeKey, audience));
    sug = matches.length > 0 ? matches[0] : null;
  }

  if (navigator.vibrate) navigator.vibrate(20);

  // CTA loading state
  var discoverBtn = document.getElementById('discover-btn');
  var ctaInner    = discoverBtn.querySelector('.cta-inner');
  ctaInner.innerHTML = '<span class="spinner">⏳</span> جاري التحليل...';
  discoverBtn.classList.add('is-loading');

  // Open sheet showing skeleton
  var skeleton    = document.getElementById('sheet-skeleton');
  var resultCard  = document.getElementById('result-card');
  var noMatchCard = document.getElementById('no-match-card');
  skeleton.classList.add('visible');
  resultCard.style.display   = 'none';
  noMatchCard.classList.remove('show');

  document.getElementById('sheet-overlay').classList.add('show');
  document.getElementById('bottom-sheet').classList.add('show');

  /* ── Cycling AI thinking texts ── */
  var aiTexts = isTravelMode ? [
    'جاري تحليل وجهتك المثالية...',
    'فحص متطلبات الفيزا لجنسيتك...',
    'استخراج أفضل الوجهات العالمية...'
  ] : [
    'جاري تحليل مزاجك...',
    'مطابقة الميزانية والدولة...',
    'استخراج أفضل التوصيات...'
  ];
  var aiEl       = document.getElementById('ai-cycle-text');
  var aiIndex    = 0;
  var cycleTimer = null;

  function cycleText() {
    if (!aiEl) return;
    aiEl.classList.add('fade-out');
    setTimeout(function() {
      aiIndex = (aiIndex + 1) % aiTexts.length;
      aiEl.textContent = aiTexts[aiIndex];
      aiEl.classList.remove('fade-out');
      aiEl.classList.add('fade-in');
      setTimeout(function() { aiEl.classList.remove('fade-in'); }, 300);
    }, 300);
  }

  if (aiEl) aiEl.textContent = aiTexts[0];
  cycleTimer = setInterval(cycleText, 500);

  /* ── After 1500ms: reveal result or no-match ── */
  setTimeout(function() {
    clearInterval(cycleTimer);

    // Reset CTA
    ctaInner.innerHTML = 'اكتشف طلعتك <svg class="cta-arrow" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 10h12M10 4l6 6-6 6" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    discoverBtn.classList.remove('is-loading');

    skeleton.classList.remove('visible');

    var hasResult = isTravelMode ? !!travelResult : !!sug;

    if (!hasResult) {
      /* ── No match: show intelligent fallback ── */
      var noMatchDesc = document.querySelector('.no-match-desc');
      if (noMatchDesc) {
        noMatchDesc.textContent = isTravelMode
          ? 'لا توجد وجهة سفر تطابق مزاجك وميزانيتك وجنسيتك حالياً. جرّب تغيير الميزانية أو المزاج.'
          : 'لا يوجد تطابق 100% لمعاييرك الدقيقة جداً. جرّب تغيير الميزانية أو الوقت وسيبهرك الذكاء الاصطناعي.';
      }
      noMatchCard.classList.remove('show');
      void noMatchCard.offsetWidth;
      noMatchCard.classList.add('show');
      if (navigator.vibrate) navigator.vibrate([20, 30, 20]);
      return;
    }

    var mapsBtn   = document.getElementById('res-maps-btn');
    var badgeEl   = document.getElementById('res-badge-text');
    var pillsEl   = document.getElementById('res-pills');
    var saveBtn   = document.getElementById('save-wallet-btn');
    var copyBtn   = document.getElementById('copy-btn');

    if (isTravelMode) {
      /* ── TRAVEL RESULT ── */
      document.getElementById('res-city-tag').textContent = travelResult.flag + ' ' + travelResult.country;
      document.getElementById('res-title').textContent     = travelResult.title;
      document.getElementById('res-desc').textContent      = travelResult.desc;
      document.getElementById('res-discount-code').textContent = travelResult.discount;
      document.getElementById('res-discount-note').textContent = travelResult.discountNote;

      /* Hide the whole discount box when this destination has no code */
      var discountBoxT = document.querySelector('.discount-box');
      if (discountBoxT) discountBoxT.style.display = travelResult.discount ? '' : 'none';

      if (badgeEl) { badgeEl.textContent = '✈️ وجهة سفرك المثالية'; badgeEl.classList.add('is-travel'); }

      /* Hide Google Maps button — not relevant for international travel */
      if (mapsBtn) mapsBtn.style.display = 'none';

      copyBtn.textContent = 'نسخ';
      copyBtn.classList.remove('copied');

      saveBtn.dataset.title    = travelResult.flag + ' ' + travelResult.title;
      saveBtn.dataset.discount = travelResult.discount;
      saveBtn.dataset.note     = travelResult.discountNote;
      saveBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="1" y="4" width="22" height="16" rx="3" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M1 10h22" stroke="currentColor" stroke-width="1.8"/><circle cx="7.5" cy="15" r="1.2" fill="currentColor"/><path d="M12 15h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> احفظ في المحفظة';
      saveBtn.classList.remove('saved');

      var waBtn = document.getElementById('whatsapp-share-btn');
      if (waBtn) waBtn.onclick = function() { shareToWhatsApp(travelResult.flag + ' ' + travelResult.title); };

      pillsEl.innerHTML = '';
      var travelPills = [].concat(travelResult.pills, ['💰 ' + budgetKey, '🛂 خالي من الفيزا']);
      travelPills.forEach(function(text) {
        var span = document.createElement('span');
        span.className = 'result-pill';
        span.textContent = text;
        pillsEl.appendChild(span);
      });

      if (typeof gtag === 'function') {
        gtag('event', 'travel_discover_clicked', {
          mood: moodKey, budget: budgetKey, country: travelResult.country
        });
      }

    } else {
      /* ── LOCAL RESULT (unchanged logic) ── */
      document.getElementById('res-city-tag').textContent     = '📍 ' + cityKey;
      document.getElementById('res-title').textContent         = sug.title;
      document.getElementById('res-desc').textContent          = sug.desc;
      document.getElementById('res-discount-code').textContent = sug.discount;
      document.getElementById('res-discount-note').textContent = sug.discountNote;

      /* Hide the whole discount box when this place has no code */
      var discountBoxL = document.querySelector('.discount-box');
      if (discountBoxL) discountBoxL.style.display = sug.discount ? '' : 'none';

      if (badgeEl) { badgeEl.textContent = '🎯 اقتراحك المثالي'; badgeEl.classList.remove('is-travel'); }

      /* Restore Google Maps button for local results */
      if (mapsBtn) {
        mapsBtn.style.display = '';
        mapsBtn.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(sug.mapQuery);
      }

      copyBtn.textContent = 'نسخ';
      copyBtn.classList.remove('copied');

      saveBtn.dataset.title    = sug.title;
      saveBtn.dataset.discount = sug.discount;
      saveBtn.dataset.note     = sug.discountNote;
      saveBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="1" y="4" width="22" height="16" rx="3" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M1 10h22" stroke="currentColor" stroke-width="1.8"/><circle cx="7.5" cy="15" r="1.2" fill="currentColor"/><path d="M12 15h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> احفظ في المحفظة';
      saveBtn.classList.remove('saved');

      var waBtn2 = document.getElementById('whatsapp-share-btn');
      if (waBtn2) waBtn2.onclick = function() { shareToWhatsApp(sug.title); };

      pillsEl.innerHTML = '';
      var timeLabel = { morning: '🌅 صباحي', evening: '🌇 مسائي', night: '🌙 سهرة' };
      var audienceLabel = audience === 'tourist' ? '✈️ سياحي' : '🏠 محلي';
      var allPills = [].concat(sug.pills, ['💰 ' + budgetKey, timeLabel[timeKey] || timeKey, audienceLabel, '📍 أقل من ' + distance + ' كم']);
      allPills.forEach(function(text) {
        var span = document.createElement('span');
        span.className = 'result-pill';
        span.textContent = text;
        pillsEl.appendChild(span);
      });

      if (typeof gtag === 'function') {
        gtag('event', 'discover_clicked', {
          city: cityKey, mood: moodKey, budget: budgetKey,
          time: timeKey, audience: audience, place: sug.title
        });
      }
    }

    // Step dot
    document.getElementById('dot-4').classList.remove('active', 'done');
    document.getElementById('dot-4').classList.add('done');

    // Show result card with animation
    resultCard.style.display = '';
    resultCard.classList.remove('show');
    void resultCard.offsetWidth;
    resultCard.classList.add('show');

    if (navigator.vibrate) navigator.vibrate([30, 50, 30]);

  }, 1500);
});

/* ══════════════════════════════════════════
   WHATSAPP VIRAL SHARE
══════════════════════════════════════════ */
function shareToWhatsApp(placeTitle) {
  var appUrl  = 'https://talaty-app.com';
  var message =
    'لقيتلنا طلعة رهيبة! 🚀\n' +
    'المكان: ' + placeTitle + '\n\n' +
    'اكتشف طلعتك ومزاجك على تطبيق طلعتك:\n' +
    appUrl;

  var waUrl = 'https://wa.me/?text=' + encodeURIComponent(message);
  window.open(waUrl, '_blank', 'noopener,noreferrer');

  if (navigator.vibrate) navigator.vibrate([15, 30, 15]);

  if (typeof gtag === 'function') {
    gtag('event', 'whatsapp_share', { place: placeTitle });
  }
}

/* ══════════════════════════════════════════
   إغلاق الـ Bottom Sheet
══════════════════════════════════════════ */
function closeSheet() {
  document.getElementById('sheet-overlay').classList.remove('show');
  document.getElementById('bottom-sheet').classList.remove('show');
  var nm = document.getElementById('no-match-card');
  if (nm) nm.classList.remove('show');
}

document.getElementById('sheet-overlay').addEventListener('click', closeSheet);
document.getElementById('close-sheet-btn').addEventListener('click', closeSheet);

/* ══════════════════════════════════════════
   COPY DISCOUNT CODE
══════════════════════════════════════════ */
document.getElementById('copy-btn').addEventListener('click', () => {
  const code = document.getElementById('res-discount-code').textContent.trim();
  const btn  = document.getElementById('copy-btn');

  const done = () => {
    btn.textContent = '✓ تم النسخ';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'نسخ';
      btn.classList.remove('copied');
    }, 2200);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(done).catch(done);
  } else {
    try {
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch(e) {}
    done();
  }
});

/* ══════════════════════════════════════════
   WALLET — localStorage persistence
══════════════════════════════════════════ */
const WALLET_KEY = 'talaty_wallet_v1';

function getWalletItems() {
  try {
    return JSON.parse(localStorage.getItem(WALLET_KEY) || '[]');
  } catch(e) { return []; }
}

function saveWalletItems(items) {
  try { localStorage.setItem(WALLET_KEY, JSON.stringify(items)); } catch(e) {}
}

/* ══════════════════════════════════════════
   GAMIFICATION — Visited Places (core storage)
   Declared early because renderWallet() reads it on initial page load.
══════════════════════════════════════════ */
const VISITED_KEY = 'talaty_places_visited';

function getVisitedPlaceIds() {
  try { return JSON.parse(localStorage.getItem(VISITED_KEY) || '[]'); } catch(e) { return []; }
}

function saveVisitedPlaceIds(ids) {
  try { localStorage.setItem(VISITED_KEY, JSON.stringify(ids)); } catch(e) {}
}

function getVisitedCount() {
  return getVisitedPlaceIds().length;
}

function markPlaceVisited(itemKey) {
  if (!itemKey) return;
  var ids = getVisitedPlaceIds();
  if (ids.indexOf(itemKey) === -1) {
    ids.push(itemKey);
    saveVisitedPlaceIds(ids);
  }
}

/* Rank thresholds:
   0 visits      → مكتشف مبتدئ
   1–3 visits    → طشّاش محترف
   4+ visits     → خبير سياحي              */
function getRank() {
  var visited = getVisitedCount();
  if (visited >= 4) return 'خبير سياحي';
  if (visited >= 1) return 'طشّاش محترف';
  return 'مكتشف مبتدئ';
}

function copyCodeToClipboard(code, btn) {
  const done = () => {
    btn.textContent = '✓ تم';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'نسخ';
      btn.classList.remove('copied');
    }, 2200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(done).catch(done);
  } else {
    try {
      const ta = document.createElement('textarea');
      ta.value = code; ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    } catch(e) {}
    done();
  }
}

function renderWallet() {
  const items   = getWalletItems();
  const empty   = document.getElementById('wallet-empty');
  const list    = document.getElementById('wallet-list');

  if (!empty || !list) return;

  if (items.length === 0) {
    empty.style.display = 'flex';
    list.style.display  = 'none';
    list.innerHTML = '';
    return;
  }

  empty.style.display = 'none';
  list.style.display  = 'flex';
  list.innerHTML = '';

  var visitedIds = getVisitedPlaceIds();

  items.forEach((item, idx) => {
    var itemKey   = item.title + '|' + item.discount; /* stable unique id */
    var isVisited = visitedIds.indexOf(itemKey) !== -1;

    const card = document.createElement('div');
    card.className = 'wallet-card' + (isVisited ? ' is-visited' : '');
    card.style.setProperty('--stagger-i', idx); /* stagger animation */
    card.dataset.itemKey = itemKey;
    card.innerHTML = `
      ${isVisited ? `
        <span class="wallet-card-visited-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
      ` : ''}
      <div class="wallet-card-title">${item.title}</div>
      <div class="wallet-card-code-row">
        <span class="wallet-card-code">${item.discount}</span>
        <button class="wallet-copy-btn" data-code="${item.discount}">نسخ</button>
      </div>
      <div class="wallet-card-note">${item.note}</div>
      <div class="wallet-card-actions">
        <button class="wallet-visit-btn ${isVisited ? 'is-visited' : ''}" data-key="${itemKey}">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          ${isVisited ? 'تمت الزيارة' : 'تمت الزيارة ✅'}
        </button>
        <button class="wallet-delete-btn" data-key="${itemKey}" aria-label="حذف من المحفظة">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><polyline points="3 6 5 6 21 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    `;

    /* Wire copy button */
    card.querySelector('.wallet-copy-btn').addEventListener('click', function() {
      copyCodeToClipboard(this.dataset.code, this);
      if (navigator.vibrate) navigator.vibrate(15);
    });

    /* Wire "تمت الزيارة" button */
    var visitBtn = card.querySelector('.wallet-visit-btn');
    visitBtn.addEventListener('click', function() {
      markPlaceVisited(this.dataset.key);
      if (navigator.vibrate) navigator.vibrate([20, 30, 20]);
      renderWallet();
      syncProfileUI();
    });

    /* Wire delete button */
    card.querySelector('.wallet-delete-btn').addEventListener('click', function() {
      removeFromWallet(this.dataset.key);
      if (navigator.vibrate) navigator.vibrate(15);
      renderWallet();
      syncProfileUI();
    });

    list.appendChild(card);
  });
}

function saveToWallet(title, discount, note) {
  const items = getWalletItems();
  // منع التكرار — إذا كان الكود موجوداً بالفعل لنفس المكان
  const exists = items.some(i => i.title === title && i.discount === discount);
  if (!exists) {
    items.unshift({ title, discount, note, savedAt: Date.now() });
    saveWalletItems(items);
  }
  renderWallet();
}

function removeFromWallet(itemKey) {
  var items = getWalletItems().filter(function(i) {
    return (i.title + '|' + i.discount) !== itemKey;
  });
  saveWalletItems(items);
}

// تهيئة المحفظة عند تحميل الصفحة
renderWallet();

/* ══════════════════════════════════════════
   SAVE TO WALLET BUTTON
══════════════════════════════════════════ */
document.getElementById('save-wallet-btn').addEventListener('click', function() {
  const title    = this.dataset.title;
  const discount = this.dataset.discount;
  const note     = this.dataset.note;
  if (!title || !discount) return;

  saveToWallet(title, discount, note);

  // Haptic + تغيير حالة الزر
  if (navigator.vibrate) navigator.vibrate([20, 30, 20]);
  this.innerHTML = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> تم الحفظ في المحفظة`;
  this.classList.add('saved');
});
/* ══════════════════════════════════════════════════════════════
   BOTTOM NAV — SPA NAVIGATION
   منطق التنقل بين الشاشات بدون إعادة تحميل الصفحة
══════════════════════════════════════════════════════════════ */
(function initNav() {
  const navButtons = document.querySelectorAll('.nav-item');
  const screens    = document.querySelectorAll('.screen');

  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {

      // 1. Haptic feedback — اهتزاز لمسي
      if (navigator.vibrate) navigator.vibrate(40);

      // 2. الهدف: id الشاشة من data-target
      const targetId = btn.dataset.target;
      if (!targetId) return;

      // 3. إزالة is-active من كل الأزرار والشاشات
      navButtons.forEach(b => {
        b.classList.remove('is-active');
        b.removeAttribute('aria-current');
      });
      screens.forEach(s => s.classList.remove('is-active'));

      // 4. تفعيل الزر المنقور والشاشة المرتبطة
      btn.classList.add('is-active');
      btn.setAttribute('aria-current', 'page');

      const targetScreen = document.getElementById(targetId);
      if (targetScreen) targetScreen.classList.add('is-active');

      // 5. تحديث المحفظة عند الانتقال إليها
      if (targetId === 'screen-wallet') renderWallet();

      // 6. تمرير للأعلى بنعومة
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
})();

/* ══════════════════════════════════════════════════════════════
   TOAST HELPER
══════════════════════════════════════════════════════════════ */
let _toastTimer = null;
function showToast(message, type, duration) {
  type     = type     || 'success';
  duration = duration || 3000;
  const toast = document.getElementById('global-toast');
  if (!toast) return;
  toast.className = 'toast';
  if (type === 'success') toast.classList.add('toast-success');
  if (type === 'danger')  toast.classList.add('toast-danger');
  toast.textContent = message;
  void toast.offsetWidth; // force reflow
  toast.classList.add('show');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function() {
    toast.classList.remove('show');
  }, duration);
  if (navigator.vibrate) navigator.vibrate(30);
}

/* ══════════════════════════════════════════════════════════════
   SETTINGS — صندوق الاقتراحات
══════════════════════════════════════════════════════════════ */
document.getElementById('suggestions-submit-btn').addEventListener('click', function() {
  var textarea = document.getElementById('suggestions-textarea');
  var text = (textarea.value || '').trim();

  if (!text) {
    textarea.style.borderColor = 'rgba(255,107,107,0.70)';
    textarea.style.boxShadow   = '0 0 0 3px rgba(255,107,107,0.10)';
    setTimeout(function() {
      textarea.style.borderColor = '';
      textarea.style.boxShadow   = '';
    }, 1200);
    textarea.focus();
    return;
  }

  textarea.value = '';
  showToast('تم إرسال اقتراحك بنجاح، شكراً لك!', 'success', 3200);

  if (typeof gtag === 'function') {
    gtag('event', 'suggestion_submitted', { text_length: text.length });
  }
});

/* ══════════════════════════════════════════════════════════════
   SETTINGS — تفريغ المحفظة
══════════════════════════════════════════════════════════════ */
document.getElementById('clear-wallet-btn').addEventListener('click', function() {
  var items = getWalletItems();
  if (items.length === 0) {
    showToast('المحفظة فارغة أصلاً!', 'danger', 2200);
    return;
  }
  try { localStorage.removeItem(WALLET_KEY); } catch(e) {}
  renderWallet();
  showToast('تم تفريغ المحفظة بنجاح', 'danger', 2800);
  if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
  if (typeof gtag === 'function') { gtag('event', 'wallet_cleared'); }
});

/* ══════════════════════════════════════════════════════════════
   PROFILE — localStorage keys & helpers
══════════════════════════════════════════════════════════════ */
const PROFILE_KEY  = 'talaty_profile_v1';
const DISCOVER_KEY = 'talaty_discover_count_v1';

function getProfile() {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null'); } catch(e) { return null; }
}
function saveProfile(data) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(data)); } catch(e) {}
}
function getDiscoverCount() {
  try { return parseInt(localStorage.getItem(DISCOVER_KEY) || '0', 10); } catch(e) { return 0; }
}
function incrementDiscoverCount() {
  try { localStorage.setItem(DISCOVER_KEY, String(getDiscoverCount() + 1)); } catch(e) {}
}

/* Note: VISITED_KEY, getVisitedPlaceIds(), markPlaceVisited(), getRank()
   are declared earlier (near WALLET_KEY) so renderWallet() can use them
   safely on the very first page-load call. */

/* Extract up to 2 uppercase initials from an Arabic/Latin name */
function getInitials(name) {
  if (!name) return '';
  var parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return parts[0].slice(0, 2).toUpperCase();
}

/* ── Sync ALL profile UI elements with current saved data ── */
function syncProfileUI() {
  var profile  = getProfile();
  var name     = (profile && profile.name)    ? profile.name.trim() : '';
  var country  = (profile && profile.country) ? profile.country     : '';
  var initials = getInitials(name);

  /* ── Header profile button ── */
  var profileBtn    = document.getElementById('profile-btn');
  var btnInitials   = document.getElementById('profile-btn-initials');
  if (profileBtn) {
    if (name) {
      profileBtn.classList.add('has-data');
      if (btnInitials) btnInitials.textContent = initials;
    } else {
      profileBtn.classList.remove('has-data');
      if (btnInitials) btnInitials.textContent = '';
    }
  }

  /* ── Avatar ring & display name on profile screen ── */
  var avatarRing   = document.getElementById('profile-avatar-ring');
  var bigInitials  = document.getElementById('profile-big-initials');
  var avatarNameEl = document.getElementById('profile-avatar-name');
  if (avatarRing) {
    if (name) {
      avatarRing.classList.add('has-name');
      if (bigInitials) bigInitials.textContent = initials;
    } else {
      avatarRing.classList.remove('has-name');
      if (bigInitials) bigInitials.textContent = '';
    }
  }
  if (avatarNameEl) avatarNameEl.textContent = name || 'مستخدم طلعتك';

  /* ── Pre-fill form fields ── */
  var nameInput      = document.getElementById('profile-name-input');
  var countrySelect  = document.getElementById('profile-country-select');
  if (nameInput     && name)    nameInput.value    = name;
  if (countrySelect && country) countrySelect.value = country;

  /* ── Stats counters (hero row) ── */
  var walletCount   = getWalletItems().length;
  var discoverCount = getDiscoverCount();
  var statWallet    = document.getElementById('stat-wallet-count');
  var statDiscover  = document.getElementById('stat-discover-count');
  if (statWallet)   statWallet.textContent  = walletCount;
  if (statDiscover) statDiscover.textContent = discoverCount;

  /* ── Gamification stats (إحصائياتي section) ── */
  var visitedCount   = getVisitedCount();
  var rank           = getRank();
  var gamiDiscoverEl = document.getElementById('gami-discover-count');
  var gamiVisitedEl  = document.getElementById('gami-visited-count');
  var gamiRankEl     = document.getElementById('gami-rank-text');
  if (gamiDiscoverEl) gamiDiscoverEl.textContent = discoverCount;
  if (gamiVisitedEl)  gamiVisitedEl.textContent  = visitedCount;
  if (gamiRankEl)      gamiRankEl.textContent     = rank;
}

/* ── Profile screen activation via top-left header button ── */
document.getElementById('profile-btn').addEventListener('click', function() {
  if (navigator.vibrate) navigator.vibrate(40);

  /* Deactivate all bottom-nav items */
  document.querySelectorAll('.nav-item').forEach(function(b) {
    b.classList.remove('is-active');
    b.removeAttribute('aria-current');
  });

  /* Hide all screens */
  document.querySelectorAll('.screen').forEach(function(s) {
    s.classList.remove('is-active');
  });

  /* Show profile screen */
  var profileScreen = document.getElementById('screen-profile');
  if (profileScreen) profileScreen.classList.add('is-active');

  /* Refresh stats & form values */
  syncProfileUI();

  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* ── Save profile data ── */
document.getElementById('profile-save-btn').addEventListener('click', function() {
  var nameInput    = document.getElementById('profile-name-input');
  var countryEl    = document.getElementById('profile-country-select');
  var name         = nameInput   ? nameInput.value.trim() : '';
  var country      = countryEl   ? countryEl.value        : '';

  /* Require a name */
  if (!name) {
    if (nameInput) {
      nameInput.style.borderColor = 'rgba(255,107,107,0.70)';
      nameInput.style.boxShadow   = '0 0 0 3px rgba(255,107,107,0.10)';
      setTimeout(function() {
        nameInput.style.borderColor = '';
        nameInput.style.boxShadow   = '';
      }, 1300);
      nameInput.focus();
    }
    return;
  }

  saveProfile({ name: name, country: country, savedAt: Date.now() });
  syncProfileUI();

  if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
  showToast('تم حفظ بيانات الملف الشخصي بنجاح!', 'success', 3200);

  if (typeof gtag === 'function') {
    gtag('event', 'profile_saved', { has_name: !!name, has_country: !!country });
  }
});

/* ── Live avatar preview while user types name ── */
(function initLivePreview() {
  var nameInputEl = document.getElementById('profile-name-input');
  if (!nameInputEl) return;
  nameInputEl.addEventListener('input', function() {
    var val        = this.value.trim();
    var avatarEl   = document.getElementById('profile-avatar-name');
    var bigInit    = document.getElementById('profile-big-initials');
    var avatarRing = document.getElementById('profile-avatar-ring');
    if (avatarEl) avatarEl.textContent = val || 'مستخدم طلعتك';
    if (val) {
      if (avatarRing) avatarRing.classList.add('has-name');
      if (bigInit)    bigInit.textContent = getInitials(val);
    } else {
      if (avatarRing) avatarRing.classList.remove('has-name');
    }
  });
})();

/* ── Patch discover counter: increment on each valid discover ── */
(function patchDiscoverCount() {
  var origBtn = document.getElementById('discover-btn');
  if (!origBtn) return;
  origBtn.addEventListener('click', function() {
    var city   = document.querySelector('[data-group="city"].active');
    var budget = document.querySelector('[data-group="budget"].active');
    var time   = document.querySelector('[data-group="time"].active');
    var mood   = document.querySelector('[data-group="mood"].active');
    if (city && budget && time && mood) {
      setTimeout(function() {
        incrementDiscoverCount();
        var statDiscover = document.getElementById('stat-discover-count');
        if (statDiscover) statDiscover.textContent = getDiscoverCount();
      }, 820);
    }
  }, true); /* capture phase — fires before main discover handler */
})();

/* ── Initialise profile UI on first page load ── */
syncProfileUI();
