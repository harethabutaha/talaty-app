
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
   WEGO AFFILIATE INTEGRATION — first revenue channel
   ────────────────────────────────────────────────────────────
   ACTIVATION (do this once you're accepted into the program):
   1. Sign up as a "Non-API Partner" via Wego's affiliate network
      (currently Admitad or DCMnetwork depending on your region —
      see https://company.wego.com/affiliate-program). No backend
      needed for this path; it's just a tracked outbound link.
   2. Once approved, the network gives you a base tracking link
      that looks like: https://ad.admitad.com/g/XXXXXXXXXX/?ulp=
      Paste that exact prefix into WEGO_TRACKING_BASE below.
   3. That's it — every "قارن الأسعار على Wego" button on travel
      results will start earning commission immediately. Nothing
      else in the app needs to change.
   ────────────────────────────────────────────────────────────
   WEGO_ENABLED stays false (button hidden) until a real tracking
   base is pasted in, so nothing half-broken ever ships to users. */
const WEGO_AFFILIATE_CONFIG = {
  /* Paste the tracking link prefix your affiliate network gives you.
     Leave empty to keep the button hidden until you're approved. */
  trackingBase: '',

  /* Wego's own destination-search URL — the "ulp" (final landing
     page) the tracking link redirects through after logging the
     click. {query} is replaced with the destination name. */
  wegoSearchUrl: 'https://www.wego.com/flights?destination={query}',

  /* Appended so Wego/Admitad reporting tells you WHICH in-app
     surface drove the click — useful once you have more than one
     Wego touchpoint (e.g. a future "أفكار سفر" feed). */
  subIdParam: 'utm_source=talaty_app&utm_medium=referral&utm_campaign=travel_result'
};
var WEGO_ENABLED = !!WEGO_AFFILIATE_CONFIG.trackingBase;

/* Builds the final outbound URL: [network tracking link] wrapping
   [Wego search URL for this destination] + attribution params.
   Falls back gracefully to a plain Wego search link (no commission,
   but never a broken link) if trackingBase hasn't been set yet. */
function buildWegoReferralUrl(destinationQuery) {
  var landingUrl = WEGO_AFFILIATE_CONFIG.wegoSearchUrl.replace(
    '{query}', encodeURIComponent(destinationQuery || '')
  );
  var landingWithAttribution = landingUrl +
    (landingUrl.indexOf('?') === -1 ? '?' : '&') +
    WEGO_AFFILIATE_CONFIG.subIdParam;

  if (!WEGO_ENABLED) return landingWithAttribution; /* safe fallback, no tracking yet */

  return WEGO_AFFILIATE_CONFIG.trackingBase + encodeURIComponent(landingWithAttribution);
}

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
   DEMOGRAPHICS ENGINE v1.0 — Age & Gender Hyper-Personalization
   Reads user Age/Gender (profile OR legacy keys) and matches them
   against the sheet's `target_age` / `target_gender` columns.
   Defensive by design: any missing/unknown value ⇒ PASS.
══════════════════════════════════════════════════════════════ */

/* Sheet vocabulary → canonical gender restriction */
var TARGET_GENDER_SYNONYMS = {
  'شباب فقط':  'male',
  'رجال فقط':  'male',
  'ذكور فقط':  'male',
  'ذكور':      'male',
  'بنات فقط':  'female',
  'نساء فقط':  'female',
  'إناث فقط':  'female',
  'إناث':      'female',
  'سيدات فقط': 'female',
  'للجميع':    'all',
  'الجميع':    'all',
  'all':       'all'
};

/* User-facing gender labels → canonical */
var USER_GENDER_SYNONYMS = {
  'ذكر':    'male',
  'male':   'male',
  'أنثى':   'female',
  'انثى':   'female',
  'female': 'female'
};

/* Age bands for each sheet category. Categories not listed here
   (unknown vocabulary) are treated as 'للجميع' — never exclude. */
var TARGET_AGE_BANDS = {
  'أطفال':  { min: 0,  max: 12  },
  'شباب':   { min: 13, max: 29  },
  'عائلات': { min: 25, max: 150 }
};

/* ── Resolve the user's demographics once per filter run ──
   Priority: literal spec keys (talaty_user_age / talaty_user_gender)
   → profile v1 (ageGroup / gender). Returns nulls when unknown. */
function resolveUserDemographics() {
  var out = { ageMin: null, ageMax: null, gender: null };
  try {
    /* 1. Literal keys from spec (highest priority) */
    var rawAge    = localStorage.getItem('talaty_user_age');
    var rawGender = localStorage.getItem('talaty_user_gender');

    /* 2. Fallback: profile v1 */
    if (!rawAge || !rawGender) {
      var profileRaw = localStorage.getItem('talaty_profile_v1');
      if (profileRaw) {
        var profile = JSON.parse(profileRaw);
        if (!rawAge    && profile && profile.ageGroup) rawAge    = profile.ageGroup;
        if (!rawGender && profile && profile.gender)   rawGender = profile.gender;
      }
    }

    /* Parse age: accepts "22", "18-24", "45+" */
    if (rawAge) {
      var a = normaliseStr(String(rawAge));
      var range = a.match(/^(\d{1,3})\s*-\s*(\d{1,3})$/);
      var plus  = a.match(/^(\d{1,3})\s*\+$/);
      var exact = a.match(/^(\d{1,3})$/);
      if (range)      { out.ageMin = +range[1]; out.ageMax = +range[2]; }
      else if (plus)  { out.ageMin = +plus[1];  out.ageMax = 150;       }
      else if (exact) { out.ageMin = +exact[1]; out.ageMax = +exact[1]; }
    }

    /* Parse gender via synonym map */
    if (rawGender) {
      var g = normaliseStr(String(rawGender));
      out.gender = USER_GENDER_SYNONYMS[g] || null;
    }
  } catch (e) { /* corrupted storage ⇒ stay null ⇒ everything passes */ }
  return out;
}

/* ── Gender gate ──  true = place allowed */
function matchesGender(placeGenders, userGender) {
  if (!userGender) return true;                          /* unknown user   */
  if (!placeGenders || placeGenders.length === 0) return true; /* empty cell */
  return placeGenders.some(function(t) {
    var restriction = TARGET_GENDER_SYNONYMS[normaliseStr(t)];
    if (!restriction || restriction === 'all') return true; /* unknown/all */
    return restriction === userGender;
  });
}

/* ── Age gate ──  true = place allowed.
   Uses RANGE-OVERLAP so a "25-34" user matches BOTH شباب (13-29)
   and عائلات (25+) — never punishes boundary users. */
function matchesAge(placeAges, userDemo) {
  if (userDemo.ageMin === null) return true;             /* unknown user   */
  if (!placeAges || placeAges.length === 0) return true; /* empty cell     */
  return placeAges.some(function(t) {
    var key = normaliseStr(t);
    if (key === 'للجميع' || key === 'الجميع' || key === 'all') return true;
    var band = TARGET_AGE_BANDS[key];
    if (!band) return true;                              /* unknown vocab  */
    return userDemo.ageMin <= band.max && userDemo.ageMax >= band.min;
  });
}

/* ── Combined gate used by BOTH engines ── */
function passesDemographics(place, userDemo) {
  if (!matchesGender(place.targetGender, userDemo.gender)) {
    if (window.TALATY_DEBUG) {
      console.log('[Talaty Demo] SKIP "' + place.title + '" — gender: user="' +
        userDemo.gender + '" | DB=' + JSON.stringify(place.targetGender));
    }
    return false;
  }
  if (!matchesAge(place.targetAge, userDemo)) {
    if (window.TALATY_DEBUG) {
      console.log('[Talaty Demo] SKIP "' + place.title + '" — age: user=[' +
        userDemo.ageMin + '-' + userDemo.ageMax + '] | DB=' + JSON.stringify(place.targetAge));
    }
    return false;
  }
  return true;
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
    /* v8 demographics — empty cell ⇒ [] ⇒ treated as 'للجميع' */
    targetAge:    splitCsvField(row.target_age),
    targetGender: splitCsvField(row.target_gender),
    /* Map View (Day 3) — coordinates from the sheet's lat/lng columns.
       parseFloat tolerates "31.95 " etc.; anything non-numeric or out
       of range ⇒ null ⇒ that place simply gets no map pin (never breaks). */
    lat: (function(v){ var n = parseFloat(v); return (isFinite(n) && n >= -90  && n <= 90)  ? n : null; })(row.lat),
    lng: (function(v){ var n = parseFloat(v); return (isFinite(n) && n >= -180 && n <= 180) ? n : null; })(row.lng),
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
    if (inner) inner.innerHTML = '<span class="spinner">⏳</span> ' + t('discover.loading_data');
  } else {
    btn.disabled = false;
    btn.style.opacity = '';
    btn.style.cursor  = '';
    var inner2 = btn.querySelector('.cta-inner');
    if (inner2) inner2.innerHTML = '<span data-i18n="discover.cta">' + t('discover.cta') + '</span> <svg class="cta-arrow" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 10h12M10 4l6 6-6 6" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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

    /* v8 demographics — pipe/comma multi-value, empty ⇒ pass-all */
    targetAge:    splitCsvField(row.target_age || ''),
    targetGender: splitCsvField(row.target_gender || ''),

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
  /* Accepts either a single mood string or an array of moods
     (multi-select) — normalised to an array either way. */
  var moodList = Array.isArray(moodKey) ? moodKey : [moodKey];
  var nMoods   = moodList.map(function(mk) {
    return normaliseStr(MOOD_SYNONYMS[normaliseStr(mk)] || mk);
  });
  var nBudget = normaliseStr(budgetKey);

  /* Build the user's identity tokens: country + nationality forms */
  var userCountry = resolveUserCountry();
  var userTokens  = [normaliseStr(userCountry)];
  var natForm     = COUNTRY_TO_NATIONALITY[userCountry];
  if (natForm) userTokens.push(normaliseStr(natForm));
  var userDemo = resolveUserDemographics(); /* v8 demographics */

  return travelDestinations.filter(function(d) {
    /* OR — matches if the place has ANY of the user's selected moods */
    var moodOk = d.mood.some(function(m) { return nMoods.indexOf(normaliseStr(m)) !== -1; });
    if (!moodOk) {
      if (window.TALATY_DEBUG) {
        console.log('[Talaty Travel] SKIP "' + d.title + '" — mood: UI=' + JSON.stringify(nMoods) + ' | DB=' + JSON.stringify(d.mood));
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
    if (!passesDemographics(d, userDemo)) return false;
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
  /* moodKey accepts either a single string or an array (multi-select) */
  var moodList  = Array.isArray(moodKey) ? moodKey : [moodKey];
  var nMoods    = moodList.map(function(mk) {
    return normaliseStr(MOOD_SYNONYMS[normaliseStr(mk)] || mk);
  });
  var nBudget   = normaliseStr(budgetKey);
  var nTime     = timeKey ? normaliseStr(timeKey) : null;
  var nAudience = normaliseStr(audience);
  var userDemo  = resolveUserDemographics(); /* v8: read once per run */

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

    /* --- mood check (OR — matches if ANY selected mood is on this place) --- */
    var moodOk = p.mood.some(function(m) {
      var nm = normaliseStr(MOOD_SYNONYMS[normaliseStr(m)] || m);
      return nMoods.indexOf(nm) !== -1;
    });
    if (!moodOk) {
      if (window.TALATY_DEBUG) {
        console.log(
          '[Talaty Filter] SKIP "' + p.title + '" — ' +
          'mood mismatch: UI=' + JSON.stringify(nMoods) + ' | DB=' + JSON.stringify(p.mood)
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

    /* --- demographics check (age + gender, defensive) --------------- */
    if (!passesDemographics(p, userDemo)) return;

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
   TOGGLE BUTTONS — City & Time (single-select)
   Budget is now a range slider — see BUDGET SLIDER section below.
══════════════════════════════════════════ */
document.querySelectorAll('.city-pill, .chip').forEach(function(btn) {
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
   MOOD BUTTONS — multi-select (toggle on/off)
   A user can pick more than one mood at once
   (e.g. اجتماعي + ثقافي) — results match ANY
   of the selected moods (OR logic).
══════════════════════════════════════════ */
document.querySelectorAll('.mood-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    btn.classList.toggle('active');

    var card = btn.closest('.filter-card');
    if (card) {
      card.classList.remove('error');
      if (btn.classList.contains('active')) {
        card.classList.add('focused');
        setTimeout(function() { card.classList.remove('focused'); }, 600);
      }
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
var budgetLabelWrap  = document.getElementById('budget-label-wrap');

/* Reads the live theme tokens so slider fills stay correct in both
   light and dark mode (and update instantly if the theme flips). */
function getSliderTrackColors() {
  var cs = getComputedStyle(document.documentElement);
  return {
    fill:  (cs.getPropertyValue('--ocean-sky') || '#0EA5E9').trim(),
    track: (cs.getPropertyValue('--line')      || '#E5E7EB').trim()
  };
}

/* Floats the label directly above the thumb's actual rendered
   position — native range inputs center the thumb within
   (trackWidth - thumbWidth), offset by half the thumb width, so a
   naive "percentage of track width" calc drifts at both ends. */
function positionBudgetLabel() {
  if (!budgetLabelWrap || !budgetSlider) return;
  var min = parseFloat(budgetSlider.min) || 0;
  var max = parseFloat(budgetSlider.max) || 3;
  var val = parseFloat(budgetSlider.value);
  var pct = (max > min) ? (val - min) / (max - min) : 0;

  var trackWidth = budgetSlider.offsetWidth;
  var thumbWidth = 30; /* matches #budget-slider::-webkit-slider-thumb width */
  /* .budget-slider-wrap has 4px left padding (see CSS); absolutely-
     positioned children measure `left` from the padding EDGE, while
     the slider itself (normal flow) starts 4px further in — add that
     back so the two coordinate systems line up exactly. */
  var wrapLeftPadding = 4;
  var centerX = wrapLeftPadding + (thumbWidth / 2) + pct * (trackWidth - thumbWidth);

  budgetLabelWrap.style.left = centerX + 'px';
}

function updateBudgetSlider() {
  var step = parseInt(budgetSlider.value, 10);
  var pct  = (step / 3) * 100;

  /* Filled track — ocean-sky left, theme-aware grey right */
  var colors = getSliderTrackColors();
  budgetSlider.style.background =
    'linear-gradient(to right, ' + colors.fill + ' ' + pct + '%, ' + colors.track + ' ' + pct + '%)';

  /* Dynamic label */
  budgetLabelText.textContent = BUDGET_STEPS[step];

  /* Badge */
  budgetLabelBadge.textContent = BUDGET_BADGES[step];
  BUDGET_STEP_CLASSES.forEach(function(c) { budgetLabelBadge.classList.remove(c); });
  budgetLabelBadge.classList.add(BUDGET_STEP_CLASSES[step]);

  /* Keep the label floating exactly above the thumb */
  positionBudgetLabel();

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

/* Recalculate the label position on resize/orientation change,
   since it depends on the slider's actual rendered pixel width. */
window.addEventListener('resize', positionBudgetLabel);

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

    /* Swap budget vocabulary (language-aware) */
    var travelTicks = currentLang === 'en'
      ? ['Budget', 'Mid-range', 'Upscale', 'VIP']
      : TRAVEL_BUDGETS.slice();
    BUDGET_STEPS  = travelTicks.slice();
    BUDGET_BADGES = currentLang === 'en'
      ? ['Budget 🎒','Mid-range 🧳','Upscale 🛎️','VIP 💎']
      : ['اقتصادي 🎒', 'متوسط 🧳', 'فخم 🛎️', 'VIP 💎'];
    if (budgetQuestionEl) budgetQuestionEl.textContent = t('discover.budget_question_travel');
    var tickEls = ['tick-0','tick-1','tick-2','tick-3'].map(function(id){ return document.getElementById(id); });
    travelTicks.forEach(function(label, i) { if (tickEls[i]) tickEls[i].textContent = label; });

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

    /* Restore local budget vocabulary (language-aware) */
    BUDGET_STEPS  = currentLang === 'en'
      ? ['Free', 'Under 5 JOD', '5-15 JOD', '15+ JOD']
      : ['مجاني', 'أقل من 5 دنانير', '5-15 دينار', '15+ دينار'];
    BUDGET_BADGES = currentLang === 'en'
      ? ['Free 🆓','Budget 💵','Moderate 💳','Luxury 🔥']
      : ['مجاني 🆓', 'اقتصادي 💵', 'معتدل 💳', 'فاخر 🔥'];
    if (budgetQuestionEl) budgetQuestionEl.textContent = t('discover.budget_question');
    var localTicks = currentLang === 'en'
      ? ['Free', 'Budget', 'Moderate', 'Luxury']
      : ['مجاني', 'اقتصادي', 'معتدل', 'فاخر'];
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
  const colors = getSliderTrackColors();
  slider.style.background =
    `linear-gradient(to right, ${colors.fill} ${pct}%, ${colors.track} ${pct}%)`;
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
  var moodBtns = document.querySelectorAll('[data-group="mood"].active');
  var distance = slider.value;

  /* ── Validation differs by mode: travel mode hides City, Time & Distance ── */
  var hasError = false;
  var city = null;
  if (!isTravelMode) {
    city = document.querySelector('[data-group="city"].active');
    if (!city) { shakeCard('card-0'); hasError = true; }
    if (!time) { shakeCard('card-2'); hasError = true; }
  }
  if (moodBtns.length === 0) { shakeCard('card-3'); hasError = true; }
  if (hasError) return;

  var budgetKey = getSelectedBudget();  /* always valid — slider has default */
  var timeKey   = time ? time.dataset.val : null;
  var moodKeys  = Array.prototype.map.call(moodBtns, function(m) { return m.dataset.val; });
  var moodKey   = moodKeys; /* array — filter functions accept single val or array */
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
  ctaInner.innerHTML = '<span class="spinner">⏳</span> ' + t('discover.analyzing');
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
    t('result.ai_cycle_travel_1'),
    t('result.ai_cycle_travel_2'),
    t('result.ai_cycle_travel_3')
  ] : [
    t('result.ai_cycle_local_1'),
    t('result.ai_cycle_local_2'),
    t('result.ai_cycle_local_3')
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
    ctaInner.innerHTML = '<span data-i18n="discover.cta">' + t('discover.cta') + '</span> <svg class="cta-arrow" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 10h12M10 4l6 6-6 6" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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

      if (badgeEl) { badgeEl.textContent = t('result.badge_travel'); badgeEl.classList.add('is-travel'); }

      /* Hide Google Maps button — not relevant for international travel */
      if (mapsBtn) mapsBtn.style.display = 'none';

      /* Show the Wego referral button — first monetized touchpoint.
         Stays hidden automatically until WEGO_ENABLED is true. */
      var wegoBtn = document.getElementById('res-wego-btn');
      var wegoDisclosure = document.getElementById('res-wego-disclosure');
      if (wegoBtn && WEGO_ENABLED) {
        wegoBtn.href = buildWegoReferralUrl(travelResult.country);
        wegoBtn.style.display = '';
        if (wegoDisclosure) wegoDisclosure.style.display = '';
        wegoBtn.onclick = function() {
          if (typeof gtag === 'function') {
            gtag('event', 'wego_referral_click', {
              destination: travelResult.country, mood: moodKeys.join('|'), budget: budgetKey
            });
          }
        };
      } else if (wegoBtn) {
        wegoBtn.style.display = 'none';
        if (wegoDisclosure) wegoDisclosure.style.display = 'none';
      }

      copyBtn.textContent = t('result.copy_btn');
      copyBtn.classList.remove('copied');

      saveBtn.dataset.title    = travelResult.flag + ' ' + travelResult.title;
      saveBtn.dataset.discount = travelResult.discount;
      saveBtn.dataset.note     = travelResult.discountNote;
      saveBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="1" y="4" width="22" height="16" rx="3" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M1 10h22" stroke="currentColor" stroke-width="1.8"/><circle cx="7.5" cy="15" r="1.2" fill="currentColor"/><path d="M12 15h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> ' + t('result.save_wallet_btn');
      saveBtn.classList.remove('saved');

      var waBtn = document.getElementById('whatsapp-share-btn');
      if (waBtn) waBtn.onclick = function() { shareToWhatsApp(travelResult.flag + ' ' + travelResult.title); };

      pillsEl.innerHTML = '';
      var visaFreeLabel = currentLang === 'en' ? '🛂 Visa-free' : '🛂 خالي من الفيزا';
      var travelPills = [].concat(travelResult.pills, ['💰 ' + budgetKey, visaFreeLabel]);
      travelPills.forEach(function(text) {
        var span = document.createElement('span');
        span.className = 'result-pill';
        span.textContent = text;
        pillsEl.appendChild(span);
      });

      if (typeof gtag === 'function') {
        gtag('event', 'travel_discover_clicked', {
          mood: moodKeys.join("|"), budget: budgetKey, country: travelResult.country
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

      if (badgeEl) { badgeEl.textContent = t('result.badge_default'); badgeEl.classList.remove('is-travel'); }

      /* Restore Google Maps button for local results */
      if (mapsBtn) {
        mapsBtn.style.display = '';
        mapsBtn.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(sug.mapQuery);
      }

      /* Wego referral is travel-only — never relevant for local outings */
      var wegoBtnLocal = document.getElementById('res-wego-btn');
      var wegoDisclosureLocal = document.getElementById('res-wego-disclosure');
      if (wegoBtnLocal) wegoBtnLocal.style.display = 'none';
      if (wegoDisclosureLocal) wegoDisclosureLocal.style.display = 'none';

      copyBtn.textContent = t('result.copy_btn');
      copyBtn.classList.remove('copied');

      saveBtn.dataset.title    = sug.title;
      saveBtn.dataset.discount = sug.discount;
      saveBtn.dataset.note     = sug.discountNote;
      saveBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="1" y="4" width="22" height="16" rx="3" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M1 10h22" stroke="currentColor" stroke-width="1.8"/><circle cx="7.5" cy="15" r="1.2" fill="currentColor"/><path d="M12 15h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> ' + t('result.save_wallet_btn');
      saveBtn.classList.remove('saved');

      var waBtn2 = document.getElementById('whatsapp-share-btn');
      if (waBtn2) waBtn2.onclick = function() { shareToWhatsApp(sug.title); };

      pillsEl.innerHTML = '';
      var timeLabel = currentLang === 'en'
        ? { morning: '🌅 Morning', evening: '🌇 Evening', night: '🌙 Night' }
        : { morning: '🌅 صباحي', evening: '🌇 مسائي', night: '🌙 سهرة' };
      var audienceLabel = currentLang === 'en'
        ? (audience === 'tourist' ? '✈️ Tourist' : '🏠 Local')
        : (audience === 'tourist' ? '✈️ سياحي' : '🏠 محلي');
      var distancePillLabel = currentLang === 'en' ? ('📍 Under ' + distance + ' km') : ('📍 أقل من ' + distance + ' كم');
      var allPills = [].concat(sug.pills, ['💰 ' + budgetKey, timeLabel[timeKey] || timeKey, audienceLabel, distancePillLabel]);
      allPills.forEach(function(text) {
        var span = document.createElement('span');
        span.className = 'result-pill';
        span.textContent = text;
        pillsEl.appendChild(span);
      });

      if (typeof gtag === 'function') {
        gtag('event', 'discover_clicked', {
          city: cityKey, mood: moodKeys.join("|"), budget: budgetKey,
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
    btn.textContent = t('result.copy_btn_done_full');
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = t('result.copy_btn');
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
  if (visited >= 4) return t('profile.rank_expert');
  if (visited >= 1) return t('profile.rank_pro');
  return t('profile.rank_beginner');
}

function copyCodeToClipboard(code, btn) {
  const done = () => {
    btn.textContent = t('result.copy_btn_done');
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = t('result.copy_btn');
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
  this.innerHTML = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> ${t('result.saved_to_wallet')}`;
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
      if (targetId === 'screen-wallet')   renderWallet();
      if (targetId === 'screen-settings') syncSettingsAccountCard();

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
(function initSuggestionsBox() {
  var textarea = document.getElementById('suggestions-textarea');
  var sendBtn  = document.getElementById('suggestions-submit-btn');
  var spinner  = document.getElementById('suggestions-spinner');
  var label    = document.getElementById('suggestions-submit-label');
  if (!textarea || !sendBtn) return;

  /* Send button stays disabled until there's real text — v2 UX */
  function updateSendState() {
    var hasText = textarea.value.trim().length > 0;
    sendBtn.disabled = !hasText || sendBtn.classList.contains('is-sending');
  }
  textarea.addEventListener('input', updateSendState);
  updateSendState(); /* set correct initial state on page load */

  sendBtn.addEventListener('click', function() {
    var text = textarea.value.trim();
    if (!text || sendBtn.classList.contains('is-sending')) return;

    sendBtn.classList.add('is-sending');
    sendBtn.disabled = true;
    if (spinner) spinner.style.display = 'inline-block';
    if (label)   label.textContent = t('settings.suggestions_sending');

    setTimeout(function() {
      sendBtn.classList.remove('is-sending');
      if (spinner) spinner.style.display = 'none';
      if (label)   label.textContent = t('settings.suggestions_send');
      textarea.value = '';
      updateSendState();
      showToast(t('toast.suggestion_sent'), 'success', 3200);

      if (typeof gtag === 'function') {
        gtag('event', 'suggestion_submitted', { text_length: text.length });
      }
    }, 850);
  });
})();

/* ══════════════════════════════════════════════════════════════
   SETTINGS — تفريغ المحفظة
══════════════════════════════════════════════════════════════ */
document.getElementById('clear-wallet-btn').addEventListener('click', function() {
  var items = getWalletItems();
  if (items.length === 0) {
    showToast(t('toast.wallet_already_empty'), 'danger', 2200);
    return;
  }
  try { localStorage.removeItem(WALLET_KEY); } catch(e) {}
  renderWallet();
  showToast(t('toast.wallet_cleared'), 'danger', 2800);
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

/* ── Segmented-pill helper (age group / gender) — v5.1 ──
   Activates the button matching `value` and slides the thumb to it.
   Safe no-op if the group/thumb elements are missing or value is empty. */
function setSegmentedActive(groupId, thumbId, attr, value, count) {
  var group = document.getElementById(groupId);
  var thumb = document.getElementById(thumbId);
  if (!group) return;

  var btns = group.querySelectorAll('.pf-segmented-btn');
  var activeIndex = -1;
  btns.forEach(function(btn, i) {
    var isMatch = value && btn.getAttribute(attr) === value;
    btn.classList.toggle('active', !!isMatch);
    if (isMatch) activeIndex = i;
  });

  if (thumb) {
    thumb.style.opacity = activeIndex === -1 ? '0' : '1';
    if (activeIndex !== -1) {
      thumb.style.transform = 'translateX(' + (activeIndex * 100) + '%)';
    }
  }
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
  if (avatarNameEl) avatarNameEl.textContent = name || t('profile.default_name');

  /* ── Pre-fill form fields ── */
  var nameInput      = document.getElementById('profile-name-input');
  var countrySelect  = document.getElementById('profile-country-select');
  if (nameInput     && name)    nameInput.value    = name;
  if (countrySelect && country) countrySelect.value = country;

  /* ── Pre-fill age group / gender segmented pills (v5.1) ── */
  var ageGroup = (profile && profile.ageGroup) ? profile.ageGroup : '';
  var gender   = (profile && profile.gender)   ? profile.gender   : '';
  setSegmentedActive('profile-age-group', 'pf-age-thumb', 'data-age-val', ageGroup, 5);
  setSegmentedActive('profile-gender', 'pf-gender-thumb', 'data-gender-val', gender, 2);

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

  /* ── Show the read-only summary if a profile is saved, else the form ── */
  if (typeof renderProfileMode === 'function') renderProfileMode();
}

/* ══════════════════════════════════════════════════════════════
   SETTINGS v2 — Account card sync
   Reflects the saved profile (name → avatar initials + copy)
   every time the Settings screen is opened. Fully defensive:
   every element lookup is null-checked, safe to call anytime.
══════════════════════════════════════════════════════════════ */
function syncSettingsAccountCard() {
  var profile = getProfile();
  var name    = (profile && profile.name) ? profile.name.trim() : '';

  var titleEl    = document.getElementById('stg-account-title');
  var descEl     = document.getElementById('stg-account-desc');
  var btnEl      = document.getElementById('stg-account-btn');
  var iconEl     = document.getElementById('stg-account-avatar-icon');
  var initialsEl = document.getElementById('stg-account-initials');

  if (name) {
    if (titleEl)    titleEl.textContent = name;
    if (descEl)     descEl.textContent  = t('settings.account_desc_named');
    if (btnEl)      btnEl.textContent   = t('settings.account_btn_named');
    if (iconEl)      iconEl.style.display = 'none';
    if (initialsEl) {
      initialsEl.textContent   = getInitials(name);
      initialsEl.style.display = 'flex';
    }
  } else {
    if (titleEl)    titleEl.textContent = t('settings.account_title_default');
    if (descEl)     descEl.textContent  = t('settings.account_desc_default');
    if (btnEl)      btnEl.textContent   = t('settings.account_btn_default');
    if (iconEl)      iconEl.style.display = 'block';
    if (initialsEl) initialsEl.style.display = 'none';
  }
}

/* ══════════════════════════════════════════════════════════════
   THEME SYSTEM — real, app-wide dark/light mode
   Applied via [data-theme="dark"] on <html>. The actual color
   repaint is 100% CSS (every screen already consumes the same
   tokens) — this JS only flips the attribute, persists the
   choice, and keeps a couple of JS-inline-styled elements
   (the two range sliders) in sync with the new palette.
══════════════════════════════════════════════════════════════ */
var THEME_KEY = 'talaty_theme';

function getStoredTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
}

function applyTheme(theme, opts) {
  opts = opts || {};
  var isDark = theme === 'dark';

  if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
  else        document.documentElement.removeAttribute('data-theme');

  try { localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light'); } catch (e) { /* storage unavailable */ }

  /* Browser chrome / status-bar tint */
  var metaColor = document.getElementById('meta-theme-color');
  if (metaColor) metaColor.setAttribute('content', isDark ? '#0F1220' : '#4361EE');

  /* Sync the Settings toggle's visual state */
  var toggle = document.getElementById('stg-dark-toggle');
  if (toggle) {
    toggle.classList.toggle('on', isDark);
    toggle.setAttribute('aria-checked', isDark ? 'true' : 'false');
  }

  /* Re-render the two inline-styled sliders so their fill color
     matches the new theme immediately (they read the live CSS
     tokens themselves — see getSliderTrackColors()) */
  if (budgetSlider) updateBudgetSlider();
  if (typeof slider !== 'undefined' && slider) updateSlider();

  if (!opts.silent && navigator.vibrate) navigator.vibrate(30);
}

/* Restore the saved preference on load — defaults to light,
   matching the app's original strict-light design if the user
   never touched the toggle. */
function initTheme() {
  applyTheme(getStoredTheme() === 'dark' ? 'dark' : 'light', { silent: true });
}
initTheme();

/* ══════════════════════════════════════════════════════════════
   LANGUAGE SYSTEM — real, app-wide Arabic/English switch
   Translates every static UI string (labels, buttons, headers,
   toasts, empty states). Place-specific content coming from the
   Google Sheet CMS (names, descriptions, discount notes) has no
   English column yet, so it stays Arabic in both languages —
   this is called out explicitly in the Settings language card.
══════════════════════════════════════════════════════════════ */
var LANG_KEY = 'talaty_lang';

var I18N = {
  ar: {
    'discover.logo_badge': '✨ طلعتك — الأردن',
    'discover.hero_title': 'وين تحب<br>تطلع اليوم؟',
    'discover.hero_sub': '5 أسئلة بس — وأحنا نلاقيلك طلعتك المثالية 🎯',
    'discover.toggle_local': 'طلعة محلية',
    'discover.toggle_travel': 'سفر للخارج',
    'discover.search_placeholder': 'ابحث عن مكان أو كود خصم...',
    'discover.city_question': 'وين أنت هلأ؟',
    'discover.city_amman': 'عمّان',
    'discover.city_irbid': 'إربد',
    'discover.city_aqaba': 'العقبة',
    'discover.city_deadsea': 'البحر الميت',
    'discover.city_salt': 'السلط',
    'discover.city_jerash': 'جرش',
    'discover.budget_question': 'كم ميزانيتك؟',
    'discover.budget_question_travel': 'مستوى رفاهيتك بالسفر؟',
    'discover.budget_choose': 'اختر ميزانيتك',
    'discover.budget_tick_0': 'مجاني',
    'discover.budget_tick_1': 'اقتصادي',
    'discover.budget_tick_2': 'معتدل',
    'discover.budget_tick_3': 'فاخر',
    'discover.time_question': 'وقت الطلعة؟',
    'discover.time_morning': 'صباحي',
    'discover.time_evening': 'مسائي',
    'discover.time_night': 'سهرة',
    'discover.mood_question': 'كيف مزاجك اليوم؟',
    'discover.mood_adrenaline': 'أدرينالين',
    'discover.mood_relax': 'استرخاء',
    'discover.mood_social': 'اجتماعي',
    'discover.mood_cultural': 'ثقافي',
    'discover.mood_romantic': 'رومانسي',
    'discover.mood_adventure': 'مغامرة',
    'discover.distance_question': 'المسافة المسموحة؟',
    'discover.distance_unit': 'كيلومتر منك',
    'discover.distance_tick_1': '1 كم',
    'discover.distance_tick_25': '25 كم',
    'discover.distance_tick_50': '50 كم',
    'discover.cta': 'اكتشف طلعتك',
    'discover.loading_data': 'جاري تحميل البيانات...',
    'discover.analyzing': 'جاري التحليل...',
    'discover.footer_hint': 'هذه نسخة أولية — الاقتراحات ستكون ذكية أكثر قريباً 🚀',
    'discover.view_list': 'عرض القائمة',
    'discover.view_map': 'عرض الخريطة',
    'discover.map_hint': '📍 اضغط على أي دبوس لمشاهدة تفاصيل المكان وكود الخصم',
    'discover.map_empty': 'لا توجد أماكن بإحداثيات على الخريطة بعد — جرّب مدينة أو فلاتر مختلفة',
    'discover.map_popup_btn': 'شوف التفاصيل والخصم',
    'discover.map_unavailable': 'الخريطة غير متاحة حالياً — تأكد من اتصالك بالإنترنت',

    'splash.title': 'وين بدك تطلع اليوم؟',
    'splash.sub': 'اكتشف أفضل الأماكن والوجهات المخصصة لمزاجك وميزانيتك',
    'splash.cta': 'ابدأ طلعتك',

    'saved.title': 'مفضلتي',
    'saved.sub': 'الأماكن التي أعجبتك تظهر هنا',
    'saved.empty_title': 'لا يوجد مفضلات بعد',
    'saved.empty_desc': 'اكتشف مكاناً واضغط على القلب لحفظه هنا',

    'wallet.title': 'المحفظة',
    'wallet.sub': 'كوبوناتك وعروضك الحصرية',
    'wallet.empty_title': 'محفظتك فارغة',
    'wallet.empty_desc': 'اكتشف مكاناً واضغط «احفظ في المحفظة» للحصول على كود خصم حصري',

    'settings.title': 'الإعدادات',
    'settings.sub': 'خصّص تجربتك وشاركنا أفكارك',
    'settings.account_title_default': 'ملفك الشخصي',
    'settings.account_desc_default': 'أنشئ ملفك لحفظ تفضيلاتك وتخصيص توصياتك',
    'settings.account_btn_default': 'إنشاء ملفي الشخصي',
    'settings.account_desc_named': 'عدّل بياناتك أو راجع إنجازاتك في أي وقت',
    'settings.account_btn_named': 'فتح ملفي الشخصي',
    'settings.suggestions_title': 'صندوق الاقتراحات',
    'settings.suggestions_desc': 'عندك مكان مميز أو فكرة تطوير؟ نبي نسمعك!',
    'settings.suggestions_placeholder': 'عندك مكان رهيب أو فكرة للتطبيق؟ شاركنا...',
    'settings.suggestions_send': 'إرسال',
    'settings.suggestions_sending': 'جارٍ الإرسال...',
    'settings.appearance_title': 'المظهر',
    'settings.appearance_desc': 'بدّل بين الفاتح والداكن حسب مزاجك 🌙',
    'settings.appearance_toggle_aria': 'تبديل الوضع الداكن',
    'settings.language_title': 'اللغة',
    'settings.language_desc': 'بدّل لغة الواجهة بضغطة — أسماء الأماكن لسا عربي',
    'settings.wallet_clear_title': 'تفريغ المحفظة',
    'settings.wallet_clear_desc': 'حذف جميع الكوبونات والأماكن المحفوظة بشكل نهائي',
    'settings.wallet_clear_btn': 'تفريغ المحفظة الآن',
    'settings.support_title': 'الدعم الفني',
    'settings.support_desc': 'عندك مشكلة أو استفسار؟ فريقنا جاهز يساعدك بأي وقت',
    'settings.support_btn': 'تواصل مع الدعم',
    'settings.footer_version': 'إصدار التطبيق: MVP v2.0',

    'profile.title': 'ملفي الشخصي',
    'profile.view_title': 'معلوماتك الشخصية',
    'profile.view_sub': 'بتساعدنا نخصصلك أفضل توصيات ممكنة 🎯',
    'profile.edit_btn': 'تعديل',
    'profile.default_name': 'مستخدم طلعتك',
    'profile.name_label': 'الاسم الكامل',
    'profile.country_label': 'الدولة / الجنسية',
    'profile.country_placeholder': 'اختر دولتك...',
    'profile.country_jo': '🇯🇴 الأردن', 'profile.country_ps': '🇵🇸 فلسطين',
    'profile.country_eg': '🇪🇬 مصر', 'profile.country_sa': '🇸🇦 السعودية',
    'profile.country_ae': '🇦🇪 الإمارات', 'profile.country_kw': '🇰🇼 الكويت',
    'profile.country_qa': '🇶🇦 قطر', 'profile.country_bh': '🇧🇭 البحرين',
    'profile.country_om': '🇴🇲 عُمان', 'profile.country_sy': '🇸🇾 سوريا',
    'profile.country_iq': '🇮🇶 العراق', 'profile.country_lb': '🇱🇧 لبنان',
    'profile.country_ye': '🇾🇪 اليمن', 'profile.country_ly': '🇱🇾 ليبيا',
    'profile.country_tn': '🇹🇳 تونس', 'profile.country_dz': '🇩🇿 الجزائر',
    'profile.country_ma': '🇲🇦 المغرب', 'profile.country_other': '🌍 أخرى',
    'profile.age_label': 'الفئة العمرية',
    'profile.gender_label': 'الجنس',
    'profile.gender_male': 'ذكر',
    'profile.gender_female': 'أنثى',
    'profile.stats_title': 'إنجازاتك',
    'profile.stat_wallet_label': 'كوبونات محفوظة',
    'profile.stat_discover_label': 'طلعات اكتُشفت',
    'profile.stat_visited_label': 'أماكن زرتها',
    'profile.stat_rank_label': 'رتبتك الحالية',
    'profile.rank_beginner': 'مكتشف مبتدئ',
    'profile.rank_pro': 'طشّاش محترف',
    'profile.rank_expert': 'خبير سياحي',
    'profile.save_btn': 'حفظ التغييرات',
    'profile.saving': 'جارٍ الحفظ...',

    'result.ai_thinking': 'جاري تحليل مزاجك...',
    'result.ai_cycle_local_1': 'جاري تحليل مزاجك...',
    'result.ai_cycle_local_2': 'مطابقة الميزانية والدولة...',
    'result.ai_cycle_local_3': 'استخراج أفضل التوصيات...',
    'result.ai_cycle_travel_1': 'جاري تحليل وجهتك المثالية...',
    'result.ai_cycle_travel_2': 'فحص متطلبات الفيزا لجنسيتك...',
    'result.ai_cycle_travel_3': 'استخراج أفضل الوجهات العالمية...',
    'result.no_match_title': 'بحثنا في كل مكان!',
    'result.no_match_desc': 'لا يوجد تطابق 100% لمعاييرك الدقيقة جداً. جرّب تغيير الميزانية أو الوقت وسيبهرك الذكاء الاصطناعي.',
    'result.no_match_tip': 'الفلتر الصارم يضمن لك دقة أعلى في التوصيات',
    'result.badge_default': '🎯 اقتراحك المثالي',
    'result.badge_travel': '✈️ وجهة سفرك المثالية',
    'result.badge_search': '🔍 نتيجة بحثك',
    'result.discount_label': '🎁 كود الخصم الحصري',
    'result.copy_btn': 'نسخ',
    'result.copy_btn_done': '✓ تم',
    'result.copy_btn_done_full': '✓ تم النسخ',
    'result.maps_btn': 'اذهب إلى هناك',
    'result.wego_btn': 'قارن الأسعار على Wego',
    'result.wego_disclosure': 'رابط إحالة — طلعتك ممكن ياخذ عمولة صغيرة بدون أي تكلفة إضافية عليك',
    'result.save_wallet_btn': 'احفظ في المحفظة',
    'result.saved_to_wallet': 'تم الحفظ في المحفظة',
    'result.whatsapp_btn': 'شارك الطلعة مع أصحابك',

    'nav.discover': 'اكتشف',
    'nav.saved': 'مفضلتي',
    'nav.wallet': 'المحفظة',
    'nav.settings': 'الإعدادات',

    'search.no_results': 'لا توجد نتائج لـ "{q}" — جرّب كلمة أخرى',

    'toast.suggestion_sent': 'تم إرسال اقتراحك بنجاح، شكراً لك!',
    'toast.wallet_already_empty': 'المحفظة فارغة أصلاً!',
    'toast.wallet_cleared': 'تم تفريغ المحفظة بنجاح',
    'toast.dark_on': 'الوضع الداكن مفعّل 🌙',
    'toast.dark_off': 'رجعنا للوضع الفاتح ☀️',
    'toast.support_redirect': 'لتواصل أسرع، استخدم صندوق الاقتراحات بالأعلى وسيصلنا فوراً 💬',
    'toast.profile_saved': 'تم حفظ بيانات الملف الشخصي بنجاح!',
    'toast.lang_en': 'صار التطبيق بالإنجليزي 🌍',
    'toast.lang_ar': 'رجع التطبيق بالعربي 🇯🇴'
  },

  en: {
    'discover.logo_badge': '✨ Talaty — Jordan',
    'discover.hero_title': 'Where do you<br>want to go today?',
    'discover.hero_sub': "Just 5 questions — we'll find your perfect outing 🎯",
    'discover.toggle_local': 'Local Outing',
    'discover.toggle_travel': 'Travel Abroad',
    'discover.search_placeholder': 'Search a place or discount code...',
    'discover.city_question': 'Where are you now?',
    'discover.city_amman': 'Amman',
    'discover.city_irbid': 'Irbid',
    'discover.city_aqaba': 'Aqaba',
    'discover.city_deadsea': 'Dead Sea',
    'discover.city_salt': 'Salt',
    'discover.city_jerash': 'Jerash',
    'discover.budget_question': "What's your budget?",
    'discover.budget_question_travel': 'Your travel comfort level?',
    'discover.budget_choose': 'Choose your budget',
    'discover.budget_tick_0': 'Free',
    'discover.budget_tick_1': 'Budget',
    'discover.budget_tick_2': 'Moderate',
    'discover.budget_tick_3': 'Luxury',
    'discover.time_question': 'What time?',
    'discover.time_morning': 'Morning',
    'discover.time_evening': 'Evening',
    'discover.time_night': 'Night Out',
    'discover.mood_question': "What's your mood today?",
    'discover.mood_adrenaline': 'Adrenaline',
    'discover.mood_relax': 'Relaxing',
    'discover.mood_social': 'Social',
    'discover.mood_cultural': 'Cultural',
    'discover.mood_romantic': 'Romantic',
    'discover.mood_adventure': 'Adventure',
    'discover.distance_question': 'Allowed distance?',
    'discover.distance_unit': 'km from you',
    'discover.distance_tick_1': '1 km',
    'discover.distance_tick_25': '25 km',
    'discover.distance_tick_50': '50 km',
    'discover.cta': 'Discover Your Outing',
    'discover.loading_data': 'Loading data...',
    'discover.analyzing': 'Analyzing...',
    'discover.footer_hint': "This is an early version — suggestions will get smarter soon 🚀",
    'discover.view_list': 'List View',
    'discover.view_map': 'Map View',
    'discover.map_hint': '📍 Tap any pin to see place details and its discount code',
    'discover.map_empty': 'No places with coordinates on the map yet — try a different city or filters',
    'discover.map_popup_btn': 'See details & discount',
    'discover.map_unavailable': 'Map unavailable right now — check your internet connection',

    'splash.title': 'Where do you want to go today?',
    'splash.sub': 'Discover the best places and destinations tailored to your mood and budget',
    'splash.cta': 'Start Exploring',

    'saved.title': 'Favorites',
    'saved.sub': 'Places you loved show up here',
    'saved.empty_title': 'No favorites yet',
    'saved.empty_desc': 'Discover a place and tap the heart to save it here',

    'wallet.title': 'Wallet',
    'wallet.sub': 'Your coupons and exclusive deals',
    'wallet.empty_title': 'Your wallet is empty',
    'wallet.empty_desc': 'Discover a place and tap "Save to Wallet" for an exclusive discount code',

    'settings.title': 'Settings',
    'settings.sub': 'Customize your experience and share your ideas',
    'settings.account_title_default': 'Your Profile',
    'settings.account_desc_default': 'Create your profile to save preferences and personalize recommendations',
    'settings.account_btn_default': 'Create My Profile',
    'settings.account_desc_named': 'Edit your info or check your achievements anytime',
    'settings.account_btn_named': 'Open My Profile',
    'settings.suggestions_title': 'Suggestion Box',
    'settings.suggestions_desc': "Got a great place or an idea to improve the app? We'd love to hear it!",
    'settings.suggestions_placeholder': 'Got an awesome place or an app idea? Tell us...',
    'settings.suggestions_send': 'Send',
    'settings.suggestions_sending': 'Sending...',
    'settings.appearance_title': 'Appearance',
    'settings.appearance_desc': "Switch between light and dark, whatever suits you 🌙",
    'settings.appearance_toggle_aria': 'Toggle dark mode',
    'settings.language_title': 'Language',
    'settings.language_desc': 'Switch the app language with one tap — place names stay in Arabic for now',
    'settings.wallet_clear_title': 'Clear Wallet',
    'settings.wallet_clear_desc': 'Permanently delete all saved coupons and places',
    'settings.wallet_clear_btn': 'Clear Wallet Now',
    'settings.support_title': 'Support',
    'settings.support_desc': 'Have an issue or question? Our team is ready to help anytime',
    'settings.support_btn': 'Contact Support',
    'settings.footer_version': 'App Version: MVP v2.0',

    'profile.title': 'My Profile',
    'profile.view_title': 'Your Personal Info',
    'profile.view_sub': 'Helps us tailor the best recommendations for you 🎯',
    'profile.edit_btn': 'Edit',
    'profile.default_name': 'Talaty User',
    'profile.name_label': 'Full Name',
    'profile.country_label': 'Country / Nationality',
    'profile.country_placeholder': 'Choose your country...',
    'profile.country_jo': '🇯🇴 Jordan', 'profile.country_ps': '🇵🇸 Palestine',
    'profile.country_eg': '🇪🇬 Egypt', 'profile.country_sa': '🇸🇦 Saudi Arabia',
    'profile.country_ae': '🇦🇪 UAE', 'profile.country_kw': '🇰🇼 Kuwait',
    'profile.country_qa': '🇶🇦 Qatar', 'profile.country_bh': '🇧🇭 Bahrain',
    'profile.country_om': '🇴🇲 Oman', 'profile.country_sy': '🇸🇾 Syria',
    'profile.country_iq': '🇮🇶 Iraq', 'profile.country_lb': '🇱🇧 Lebanon',
    'profile.country_ye': '🇾🇪 Yemen', 'profile.country_ly': '🇱🇾 Libya',
    'profile.country_tn': '🇹🇳 Tunisia', 'profile.country_dz': '🇩🇿 Algeria',
    'profile.country_ma': '🇲🇦 Morocco', 'profile.country_other': '🌍 Other',
    'profile.age_label': 'Age Group',
    'profile.gender_label': 'Gender',
    'profile.gender_male': 'Male',
    'profile.gender_female': 'Female',
    'profile.stats_title': 'Your Achievements',
    'profile.stat_wallet_label': 'Coupons Saved',
    'profile.stat_discover_label': 'Outings Discovered',
    'profile.stat_visited_label': 'Places Visited',
    'profile.stat_rank_label': 'Your Current Rank',
    'profile.rank_beginner': 'Beginner Explorer',
    'profile.rank_pro': 'Pro Wanderer',
    'profile.rank_expert': 'Travel Expert',
    'profile.save_btn': 'Save Changes',
    'profile.saving': 'Saving...',

    'result.ai_thinking': 'Analyzing your mood...',
    'result.ai_cycle_local_1': 'Analyzing your mood...',
    'result.ai_cycle_local_2': 'Matching budget and city...',
    'result.ai_cycle_local_3': 'Extracting the best picks...',
    'result.ai_cycle_travel_1': 'Analyzing your ideal destination...',
    'result.ai_cycle_travel_2': 'Checking visa requirements for your nationality...',
    'result.ai_cycle_travel_3': 'Extracting the best global destinations...',
    'result.no_match_title': 'We searched everywhere!',
    'result.no_match_desc': "No 100% match for your very specific criteria. Try changing the budget or time and let the AI surprise you.",
    'result.no_match_tip': 'Strict filtering guarantees more accurate recommendations',
    'result.badge_default': '🎯 Your Perfect Match',
    'result.badge_travel': '✈️ Your Perfect Destination',
    'result.badge_search': '🔍 Your Search Result',
    'result.discount_label': '🎁 Exclusive Discount Code',
    'result.copy_btn': 'Copy',
    'result.copy_btn_done': '✓ Done',
    'result.copy_btn_done_full': '✓ Copied',
    'result.maps_btn': 'Get Directions',
    'result.wego_btn': 'Compare Prices on Wego',
    'result.wego_disclosure': 'Referral link — Talaty may earn a small commission at no extra cost to you',
    'result.save_wallet_btn': 'Save to Wallet',
    'result.saved_to_wallet': 'Saved to Wallet',
    'result.whatsapp_btn': 'Share with Friends',

    'nav.discover': 'Discover',
    'nav.saved': 'Favorites',
    'nav.wallet': 'Wallet',
    'nav.settings': 'Settings',

    'search.no_results': 'No results for "{q}" — try another word',

    'toast.suggestion_sent': 'Your suggestion was sent, thank you!',
    'toast.wallet_already_empty': 'Your wallet is already empty!',
    'toast.wallet_cleared': 'Wallet cleared successfully',
    'toast.dark_on': 'Dark mode enabled 🌙',
    'toast.dark_off': 'Switched back to light mode ☀️',
    'toast.support_redirect': 'For faster contact, use the suggestion box above — it reaches us instantly 💬',
    'toast.profile_saved': 'Your profile was saved successfully!',
    'toast.lang_en': 'The app is now in English 🌍',
    'toast.lang_ar': 'التطبيق رجع بالعربي 🇯🇴'
  }
};

var currentLang = 'ar';

function getStoredLang() {
  try { return localStorage.getItem(LANG_KEY); } catch (e) { return null; }
}

/* t(key) — looks up the current-language string; falls back to
   Arabic, then to the key itself, so a missing translation never
   crashes the UI — it just silently shows Arabic instead. */
function t(key) {
  var dict = I18N[currentLang] || I18N.ar;
  if (dict[key] !== undefined) return dict[key];
  return (I18N.ar[key] !== undefined) ? I18N.ar[key] : key;
}

function applyLanguage(lang, opts) {
  opts = opts || {};
  var isEn = lang === 'en';
  currentLang = isEn ? 'en' : 'ar';

  document.documentElement.setAttribute('lang', isEn ? 'en' : 'ar');
  document.documentElement.setAttribute('dir', isEn ? 'ltr' : 'rtl');

  try { localStorage.setItem(LANG_KEY, currentLang); } catch (e) { /* storage unavailable */ }

  /* Static text nodes */
  document.querySelectorAll('[data-i18n]').forEach(function(el) {
    var key = el.getAttribute('data-i18n');
    var val = t(key);
    if (val.indexOf('<br>') !== -1) el.innerHTML = val;
    else el.textContent = val;
  });
  /* Placeholders */
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
  });
  /* Aria labels */
  document.querySelectorAll('[data-i18n-aria]').forEach(function(el) {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
  });

  /* Language segmented control visual state */
  var langToggle = document.getElementById('stg-lang-toggle');
  if (langToggle) langToggle.classList.toggle('is-en', isEn);

  /* Re-sync dynamic bits that don't live in data-i18n elements */
  var isTravelMode = document.getElementById('travel-toggle-wrap') ?
    document.querySelector('.travel-toggle-wrap').classList.contains('mode-travel') : false;
  var budgetQuestionEl = document.getElementById('budget-question-text');
  if (budgetQuestionEl) budgetQuestionEl.textContent = isTravelMode ? t('discover.budget_question_travel') : t('discover.budget_question');
  if (typeof BUDGET_STEPS !== 'undefined' && typeof updateBudgetSlider === 'function' && budgetSlider) {
    /* Re-derive the step arrays in the new language, preserving current step */
    if (isTravelMode && typeof TRAVEL_BUDGETS !== 'undefined') {
      BUDGET_STEPS = isEn ? ['Free', 'Budget', 'Mid-range', 'Luxury'] : ['مجاني', 'اقتصادي', 'متوسط', 'فاخر'];
      BUDGET_BADGES = isEn ? ['Budget 🎒','Mid-range 🧳','Upscale 🛎️','VIP 💎'] : ['اقتصادي 🎒', 'متوسط 🧳', 'فخم 🛎️', 'VIP 💎'];
    } else {
      BUDGET_STEPS  = isEn ? ['Free', 'Under 5 JOD', '5-15 JOD', '15+ JOD'] : ['مجاني', 'أقل من 5 دنانير', '5-15 دينار', '15+ دينار'];
      BUDGET_BADGES = isEn ? ['Free 🆓','Budget 💵','Moderate 💳','Luxury 🔥'] : ['مجاني 🆓', 'اقتصادي 💵', 'معتدل 💳', 'فاخر 🔥'];
    }
    updateBudgetSlider();
  }
  if (typeof syncSettingsAccountCard === 'function') syncSettingsAccountCard();
  if (typeof syncProfileUI === 'function') syncProfileUI();

  if (!opts.silent && navigator.vibrate) navigator.vibrate(30);
}

function initLanguage() {
  applyLanguage(getStoredLang() === 'en' ? 'en' : 'ar', { silent: true });
}
initLanguage();

var stgLangArBtn = document.getElementById('stg-lang-ar-btn');
if (stgLangArBtn) {
  stgLangArBtn.addEventListener('click', function() {
    if (currentLang === 'ar') return;
    applyLanguage('ar');
    showToast(t('toast.lang_ar'), 'success', 2200);
  });
}
var stgLangEnBtn = document.getElementById('stg-lang-en-btn');
if (stgLangEnBtn) {
  stgLangEnBtn.addEventListener('click', function() {
    if (currentLang === 'en') return;
    applyLanguage('en');
    showToast(t('toast.lang_en'), 'success', 2200);
  });
}

/* Account card button → reuse the exact same flow as the header
   profile button (deactivate nav, show screen-profile, sync UI) */
var stgAccountBtn = document.getElementById('stg-account-btn');
if (stgAccountBtn) {
  stgAccountBtn.addEventListener('click', function() {
    var headerProfileBtn = document.getElementById('profile-btn');
    if (headerProfileBtn) headerProfileBtn.click();
  });
}

/* ── Appearance card: real dark-mode toggle ── */
var stgDarkToggle = document.getElementById('stg-dark-toggle');
if (stgDarkToggle) {
  stgDarkToggle.addEventListener('click', function() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    applyTheme(isDark ? 'light' : 'dark');
    showToast(isDark ? t('toast.dark_off') : t('toast.dark_on'), 'success', 2000);
  });
}

var stgSupportBtn = document.getElementById('stg-support-btn');
if (stgSupportBtn) {
  stgSupportBtn.addEventListener('click', function() {
    showToast(t('toast.support_redirect'), 'success', 3200);
  });
}

/* ══════════════════════════════════════════════════════════════
   PROFILE VIEW / EDIT MODE
   Once a profile is saved, the screen shows a calm read-only
   summary instead of re-opening the form every visit. The user
   taps "Edit" to make changes; saving returns to the summary.
══════════════════════════════════════════════════════════════ */
var profileEditMode = false;

function enterProfileEditMode() {
  profileEditMode = true;
  renderProfileMode();
  var nameInput = document.getElementById('profile-name-input');
  if (nameInput) nameInput.focus();
}

function renderProfileMode() {
  var profile    = getProfile();
  var hasProfile = !!(profile && profile.name && profile.name.trim());
  var viewCard   = document.getElementById('pf-view-card');
  var formCard   = document.getElementById('pf-form-card');
  var showView   = hasProfile && !profileEditMode;

  if (viewCard) viewCard.style.display = showView ? '' : 'none';
  if (formCard) formCard.style.display = showView ? 'none' : '';

  if (showView) updateProfileViewCard(profile);
}

function updateProfileViewCard(profile) {
  var nameEl    = document.getElementById('pf-view-name');
  var countryEl = document.getElementById('pf-view-country');
  var ageEl     = document.getElementById('pf-view-age');
  var genderEl  = document.getElementById('pf-view-gender');

  if (nameEl) nameEl.textContent = profile.name || '—';

  if (countryEl) {
    var countrySelect = document.getElementById('profile-country-select');
    var opt = countrySelect ? countrySelect.querySelector('option[value="' + (profile.country || '').replace(/"/g,'\\"') + '"]') : null;
    countryEl.textContent = opt ? opt.textContent : (profile.country || '—');
  }

  if (ageEl) ageEl.textContent = profile.ageGroup || '—';

  if (genderEl) {
    genderEl.textContent = profile.gender === 'male' ? t('profile.gender_male')
                          : profile.gender === 'female' ? t('profile.gender_female')
                          : '—';
  }
}

var pfViewEditBtn = document.getElementById('pf-view-edit-btn');
if (pfViewEditBtn) {
  pfViewEditBtn.addEventListener('click', function() {
    if (navigator.vibrate) navigator.vibrate(15);
    enterProfileEditMode();
  });
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
  var ageGroupEl   = document.querySelector('#profile-age-group .pf-segmented-btn.active');
  var genderEl     = document.querySelector('#profile-gender .pf-segmented-btn.active');
  var ageGroup     = ageGroupEl ? ageGroupEl.getAttribute('data-age-val')    : '';
  var gender       = genderEl   ? genderEl.getAttribute('data-gender-val')  : '';

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

  /* ── brief "saving" spinner state (v5.1 — matches the Claude Design mockup) ── */
  var saveBtn     = this;
  var iconReady   = saveBtn.querySelector('.pf-save-icon-ready');
  var iconLoading = saveBtn.querySelector('.pf-save-icon-loading');
  var labelEl     = saveBtn.querySelector('.pf-save-label');
  if (saveBtn.classList.contains('is-saving')) return; /* debounce double-clicks */
  saveBtn.classList.add('is-saving');
  if (iconReady)   iconReady.hidden = true;
  if (iconLoading) iconLoading.hidden = false;
  if (labelEl)     labelEl.textContent = t('profile.saving');

  setTimeout(function() {
    saveProfile({ name: name, country: country, ageGroup: ageGroup, gender: gender, savedAt: Date.now() });
    profileEditMode = false;
    syncProfileUI();
    if (iconReady)   iconReady.hidden = false;
    if (iconLoading) iconLoading.hidden = true;
    if (labelEl)     labelEl.textContent = t('profile.save_btn');

    if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
    showToast(t('toast.profile_saved'), 'success', 3200);

    if (typeof gtag === 'function') {
      gtag('event', 'profile_saved', { has_name: !!name, has_country: !!country, has_age_group: !!ageGroup, has_gender: !!gender });
    }
  }, 500);
});

/* ── Age group / gender pill selection (v5.1) ── */
document.querySelectorAll('#profile-age-group .pf-segmented-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    setSegmentedActive('profile-age-group', 'pf-age-thumb', 'data-age-val', btn.getAttribute('data-age-val'), 5);
    if (navigator.vibrate) navigator.vibrate(10);
  });
});
document.querySelectorAll('#profile-gender .pf-segmented-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    setSegmentedActive('profile-gender', 'pf-gender-thumb', 'data-gender-val', btn.getAttribute('data-gender-val'), 2);
    if (navigator.vibrate) navigator.vibrate(10);
  });
});

/* ── Back button → reuse the existing bottom-nav "discover" handler (v5.1) ── */
var pfBackBtn = document.getElementById('profile-back-btn');
if (pfBackBtn) {
  pfBackBtn.addEventListener('click', function() {
    var discoverNav = document.querySelector('[data-target="screen-discover"]');
    if (discoverNav) discoverNav.click();
  });
}

/* ── Edit-avatar badge → enter edit mode (if needed) then focus name input ── */
var pfEditAvatarBtn = document.getElementById('profile-edit-avatar-btn');
if (pfEditAvatarBtn) {
  pfEditAvatarBtn.addEventListener('click', function() {
    if (profileEditMode) {
      var nameInput = document.getElementById('profile-name-input');
      if (nameInput) nameInput.focus();
    } else {
      enterProfileEditMode();
    }
  });
}

/* ── Live avatar preview while user types name ── */
(function initLivePreview() {
  var nameInputEl = document.getElementById('profile-name-input');
  if (!nameInputEl) return;
  nameInputEl.addEventListener('input', function() {
    var val        = this.value.trim();
    var avatarEl   = document.getElementById('profile-avatar-name');
    var bigInit    = document.getElementById('profile-big-initials');
    var avatarRing = document.getElementById('profile-avatar-ring');
    if (avatarEl) avatarEl.textContent = val || t('profile.default_name');
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
    var time   = document.querySelector('[data-group="time"].active');
    var mood   = document.querySelector('[data-group="mood"].active');
    var validForMode = isTravelMode ? !!mood : !!(city && time && mood);
    if (validForMode) {
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


/* ╔══════════════════════════════════════════════════════════════╗
   ║  UI / MOTION LAYER v4.1 — VISUALS ONLY                       ║
   ║  Cinematic header scenes, travel theme shift, cascade.       ║
   ║  ⚠️ Zero data logic here: no fetching, no filtering,         ║
   ║  no gamification. Additive event listeners only —            ║
   ║  the core handlers above are untouched.                      ║
   ╚══════════════════════════════════════════════════════════════╝ */
(function () {
  'use strict';

  /* ── Optional real photos ──
     ضع روابط صور مباشرة هنا (مثلاً من Unsplash: زر Share ← Copy image address)
     وستظهر فوق التدرج اللوني تلقائياً. اتركها فارغة = مشاهد CSS الجميلة.
     مثال: 'عمّان': 'https://images.unsplash.com/photo-XXXX?w=1600&q=80'   */
  var HEADER_IMAGES = {
    'عمّان': '', 'إربد': '', 'العقبة': '',
    'البحر الميت': '', 'السلط': '', 'جرش': '',
    'travel': '', 'default': ''
  };

  var CITY_SCENES = {
    'عمّان': 'scene-amman',
    'إربد': 'scene-irbid',
    'العقبة': 'scene-aqaba',
    'البحر الميت': 'scene-deadsea',
    'السلط': 'scene-salt',
    'جرش': 'scene-jerash'
  };
  var ALL_SCENES = ['scene-jordan','scene-amman','scene-irbid','scene-aqaba',
                    'scene-deadsea','scene-salt','scene-jerash','scene-travel'];

  var headerEl = document.getElementById('cinematic-header');
  var sceneEl  = document.getElementById('ch-scene');
  var chipEl   = document.getElementById('ch-location-chip');
  if (!headerEl || !sceneEl) return;   /* header missing → do nothing, never crash */

  /* ── swap the scene (gradient class + optional photo) ── */
  function setScene(sceneClass, chipText, imageKey) {
    ALL_SCENES.forEach(function (s) { sceneEl.classList.remove(s); });
    sceneEl.classList.add(sceneClass);

    var img = HEADER_IMAGES[imageKey] || '';
    sceneEl.style.backgroundImage = img ? 'url("' + img + '")' : '';

    if (chipEl && chipText) {
      chipEl.textContent = chipText;
      chipEl.style.transform = 'scale(1.12)';
      setTimeout(function () { chipEl.style.transform = ''; }, 220);
    }
  }

  function activeCity() {
    var btn = document.querySelector('[data-group="city"].active');
    return btn ? btn.dataset.val : null;
  }

  /* ── refresh header from current UI state ── */
  function refreshHeader() {
    var isTravel = document.body.classList.contains('travel-theme');
    if (isTravel) {
      headerEl.classList.add('is-travel');
      setScene('scene-travel', '✈️ سفر للخارج', 'travel');
    } else {
      headerEl.classList.remove('is-travel');
      var city = activeCity();
      setScene(city && CITY_SCENES[city] ? CITY_SCENES[city] : 'scene-jordan',
               city ? '📍 ' + city : '📍 الأردن',
               city || 'default');
    }
  }

  /* ── staggered cascade re-trigger on the active screen ── */
  function runCascade() {
    var screen = document.querySelector('.screen.is-active');
    if (!screen) return;
    screen.classList.remove('cascade');
    void screen.offsetWidth;            /* force reflow → restart animation */
    screen.classList.add('cascade');
  }

  /* ── additive listeners (core handlers untouched) ── */
  var btnTravel = document.getElementById('toggle-travel');
  var btnLocal  = document.getElementById('toggle-local');

  if (btnTravel) btnTravel.addEventListener('click', function () {
    document.body.classList.add('travel-theme');
    refreshHeader();
    runCascade();
  });
  if (btnLocal) btnLocal.addEventListener('click', function () {
    document.body.classList.remove('travel-theme');
    refreshHeader();
    runCascade();
  });

  /* city pills → header follows the chosen city
     (setTimeout 0: يضمن أن منطق التفعيل الأساسي حدّث .active أولاً) */
  document.querySelectorAll('[data-group="city"]').forEach(function (pill) {
    pill.addEventListener('click', function () {
      setTimeout(refreshHeader, 0);
    });
  });

  /* bottom-nav → cascade the newly opened screen */
  document.querySelectorAll('[data-target^="screen-"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      setTimeout(runCascade, 30);
    });
  });

  /* ── first paint ── */
  refreshHeader();
  runCascade();
})();


/* ╔══════════════════════════════════════════════════════════════╗
   ║  SMART SEARCH v4.4 — UI FEATURE (additive, isolated)         ║
   ║  Real-time search across `places` + `travelDestinations`.   ║
   ║  Bypasses filters; reuses the existing bottom-sheet DOM.    ║
   ║  ⚠️ Reads the data arrays — never mutates them.              ║
   ╚══════════════════════════════════════════════════════════════╝ */
(function () {
  'use strict';

  var input    = document.getElementById('smart-search-input');
  var clearBtn = document.getElementById('search-clear-btn');
  var listEl   = document.getElementById('search-results');
  if (!input || !listEl) return;   /* markup missing → skip silently */

  var debounceTimer = null;

  /* ── search core: title / desc / discount across both engines ── */
  function findMatches(query) {
    var q = normaliseStr(query).toLowerCase();
    if (q.length < 2) return [];

    var out = [];

    function hit(title, desc, discount) {
      return (title    && normaliseStr(title).toLowerCase().indexOf(q)    !== -1) ||
             (desc     && normaliseStr(desc).toLowerCase().indexOf(q)     !== -1) ||
             (discount && normaliseStr(discount).toLowerCase().indexOf(q) !== -1);
    }

    /* local places (Sheet 1) */
    (Array.isArray(places) ? places : []).forEach(function (p) {
      if (hit(p.title, p.desc, p.discount)) {
        out.push({ kind: 'local', item: p });
      }
    });

    /* travel destinations (Sheet 2 or fallback) */
    (Array.isArray(travelDestinations) ? travelDestinations : []).forEach(function (d) {
      if (hit(d.title, d.desc, d.discount)) {
        out.push({ kind: 'travel', item: d });
      }
    });

    return out.slice(0, 6);   /* keep the dropdown tight */
  }

  /* ── open the existing bottom sheet with a searched item ── */
  function openSearchResult(kind, item) {
    var isTravel  = (kind === 'travel');
    var mapsBtn   = document.getElementById('res-maps-btn');
    var badgeEl   = document.getElementById('res-badge-text');
    var pillsEl   = document.getElementById('res-pills');
    var saveBtn   = document.getElementById('save-wallet-btn');
    var copyBtn   = document.getElementById('copy-btn');
    var skeleton  = document.getElementById('sheet-skeleton');
    var resultCard  = document.getElementById('result-card');
    var noMatchCard = document.getElementById('no-match-card');

    var cityLabel = isTravel
      ? (item.flag || '✈️') + ' ' + (item.country || '')
      : '📍 ' + (Array.isArray(item.city) ? item.city[0] : (item.city || 'الأردن'));

    document.getElementById('res-city-tag').textContent       = cityLabel;
    document.getElementById('res-title').textContent          = item.title;
    document.getElementById('res-desc').textContent           = item.desc || '';
    document.getElementById('res-discount-code').textContent  = item.discount || '';
    document.getElementById('res-discount-note').textContent  = item.discountNote || '';

    var discountBox = document.querySelector('.discount-box');
    if (discountBox) discountBox.style.display = item.discount ? '' : 'none';

    if (badgeEl) {
      badgeEl.textContent = t('result.badge_search');
      badgeEl.classList.toggle('is-travel', isTravel);
    }

    if (mapsBtn) {
      if (!isTravel && item.mapQuery) {
        mapsBtn.style.display = '';
        mapsBtn.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(item.mapQuery);
      } else {
        mapsBtn.style.display = 'none';
      }
    }

    /* Wego referral — same rule as the main discover flow: travel only */
    var wegoBtnSearch = document.getElementById('res-wego-btn');
    var wegoDisclosureSearch = document.getElementById('res-wego-disclosure');
    if (wegoBtnSearch) {
      if (isTravel && WEGO_ENABLED) {
        wegoBtnSearch.href = buildWegoReferralUrl(item.country || item.title);
        wegoBtnSearch.style.display = '';
        if (wegoDisclosureSearch) wegoDisclosureSearch.style.display = '';
        wegoBtnSearch.onclick = function() {
          if (typeof gtag === 'function') {
            gtag('event', 'wego_referral_click', { destination: item.country || item.title, source: 'search' });
          }
        };
      } else {
        wegoBtnSearch.style.display = 'none';
        if (wegoDisclosureSearch) wegoDisclosureSearch.style.display = 'none';
      }
    }

    if (copyBtn) { copyBtn.textContent = t('result.copy_btn'); copyBtn.classList.remove('copied'); }

    if (saveBtn) {
      saveBtn.dataset.title    = isTravel ? ((item.flag || '✈️') + ' ' + item.title) : item.title;
      saveBtn.dataset.discount = item.discount || '';
      saveBtn.dataset.note     = item.discountNote || '';
      saveBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="1" y="4" width="22" height="16" rx="3" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M1 10h22" stroke="currentColor" stroke-width="1.8"/><circle cx="7.5" cy="15" r="1.2" fill="currentColor"/><path d="M12 15h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> ' + t('result.save_wallet_btn');
      saveBtn.classList.remove('saved');
    }

    var waBtn = document.getElementById('whatsapp-share-btn');
    if (waBtn) waBtn.onclick = function () { shareToWhatsApp(item.title); };

    if (pillsEl) {
      pillsEl.innerHTML = '';
      (item.pills || []).forEach(function (text) {
        var span = document.createElement('span');
        span.className = 'result-pill';
        span.textContent = text;
        pillsEl.appendChild(span);
      });
    }

    /* open the sheet instantly (no AI-thinking cycle for search) */
    if (skeleton)    skeleton.classList.remove('visible');
    if (noMatchCard) noMatchCard.classList.remove('show');
    if (resultCard)  { resultCard.classList.remove('show'); void resultCard.offsetWidth; resultCard.classList.add('show'); }
    document.getElementById('sheet-overlay').classList.add('show');
    document.getElementById('bottom-sheet').classList.add('show');
    if (navigator.vibrate) navigator.vibrate(12);

    if (typeof gtag === 'function') {
      gtag('event', 'search_result_opened', { kind: kind, title: item.title });
    }
  }

  /* ── render the dropdown ── */
  function renderResults(matches, query) {
    listEl.innerHTML = '';

    if (query.trim().length < 2) { listEl.hidden = true; return; }

    if (matches.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.textContent = t('search.no_results').replace('{q}', query.trim());
      listEl.appendChild(empty);
      listEl.hidden = false;
      return;
    }

    matches.forEach(function (m) {
      var item = m.item;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'search-result-item';

      var emoji = document.createElement('span');
      emoji.className = 'sri-emoji';
      emoji.textContent = m.kind === 'travel' ? (item.flag || '✈️') : '📍';

      var txt = document.createElement('span');
      txt.className = 'sri-text';
      var t = document.createElement('span');
      t.className = 'sri-title';
      t.textContent = item.title;
      var s = document.createElement('span');
      s.className = 'sri-sub';
      s.textContent = m.kind === 'travel'
        ? (item.country || 'وجهة سفر')
        : (Array.isArray(item.city) ? item.city.join('، ') : (item.city || ''));
      txt.appendChild(t); txt.appendChild(s);

      btn.appendChild(emoji);
      btn.appendChild(txt);

      if (item.discount) {
        var d = document.createElement('span');
        d.className = 'sri-discount';
        d.textContent = item.discount;
        btn.appendChild(d);
      }

      btn.addEventListener('click', function () {
        openSearchResult(m.kind, item);
      });

      listEl.appendChild(btn);
    });

    listEl.hidden = false;
  }

  /* ── real-time input (debounced 140ms) ── */
  input.addEventListener('input', function () {
    var q = input.value;
    clearBtn.hidden = q.length === 0;
    /* Map View hook: live-filter the pins as the user types */
    if (typeof window.talatyMapOnSearch === 'function') window.talatyMapOnSearch(q);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      renderResults(findMatches(q), q);
    }, 140);
  });

  clearBtn.addEventListener('click', function () {
    input.value = '';
    clearBtn.hidden = true;
    listEl.hidden = true;
    listEl.innerHTML = '';
    input.focus();
    if (navigator.vibrate) navigator.vibrate(8);
    if (typeof window.talatyMapOnSearch === 'function') window.talatyMapOnSearch('');
  });

  /* ── Public export: lets Map View popups open the exact same
     bottom sheet the search results use (single code path). ── */
  window.talatyOpenPlaceSheet = function(placeId) {
    var found = (Array.isArray(places) ? places : []).filter(function(p){ return p.id === placeId; })[0];
    if (found) openSearchResult('local', found);
  };
})();


/* ╔══════════════════════════════════════════════════════════════╗
   ║  SPLASH SCREEN v5.0 (RESTORED) — UI ONLY, isolated           ║
   ╚══════════════════════════════════════════════════════════════╝ */
(function () {
  'use strict';
  var splash = document.getElementById('splash-screen');
  var btn    = document.getElementById('splash-cta-btn');
  if (!splash || !btn) return;
  var SPLASH_SEEN_KEY = 'talaty_splash_seen_v1';
  function closeSplash() {
    splash.classList.add('is-closed');
    if (navigator.vibrate) navigator.vibrate(14);
    try { sessionStorage.setItem(SPLASH_SEEN_KEY, '1'); } catch (e) {}
    setTimeout(function () { splash.setAttribute('aria-hidden', 'true'); }, 700);
  }
  btn.addEventListener('click', closeSplash);
  try {
    if (sessionStorage.getItem(SPLASH_SEEN_KEY) === '1') {
      splash.classList.add('is-closed');
      splash.setAttribute('aria-hidden', 'true');
    }
  } catch (e) {}
})();


/* ╔══════════════════════════════════════════════════════════════╗
   ║  MAP VIEW v1.0 — Leaflet integration (Day 3 scaling plan)     ║
   ║  List ⇄ Map toggle on the discover screen (local mode only). ║
   ║  Fully additive: zero changes to PapaParse init, the Dual    ║
   ║  Engine, Gamification, or Bottom Nav. If Leaflet fails to    ║
   ║  load (offline/CDN blocked) the toggle hides itself and the  ║
   ║  app behaves exactly as before.                              ║
   ╚══════════════════════════════════════════════════════════════╝ */
(function initMapView() {
  var AMMAN_CENTER = [31.9522, 35.2332];

  var toggleWrap = document.getElementById('view-toggle-wrap');
  var listBtn    = document.getElementById('view-list-btn');
  var mapBtn     = document.getElementById('view-map-btn');
  var mapSection = document.getElementById('map-section');
  var mapEl      = document.getElementById('talaty-map');
  var emptyHint  = document.getElementById('map-empty-hint');
  var screenEl   = document.getElementById('screen-discover');
  if (!toggleWrap || !mapEl || !screenEl) return;   /* markup missing → skip silently */

  var map = null;              /* created lazily on first Map View open */
  var markersLayer = null;     /* single layer group → trivial clear/redraw */
  var isMapView = false;
  var searchQuery = '';

  /* ── Lazy init: Leaflet is only instantiated the first time the
     user opens Map View, so users who never touch it pay zero cost. ── */
  function ensureMap() {
    if (map) return true;
    if (typeof L === 'undefined') {
      /* CDN blocked / offline — degrade gracefully */
      showToast(t('discover.map_unavailable'), 'danger', 2800);
      return false;
    }
    map = L.map(mapEl, {
      center: AMMAN_CENTER,
      zoom: 12,
      zoomControl: true,
      attributionControl: true
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
    }).addTo(map);
    markersLayer = L.layerGroup().addTo(map);
    return true;
  }

  /* ── The lenient "map filter": city (always) + selected moods (OR)
     + live search text. Budget/time/distance intentionally excluded —
     on a map the user wants to SEE what's around; over-filtering
     would leave it empty most of the time. ── */
  function getMapFilteredPlaces() {
    var all = Array.isArray(places) ? places : [];
    var cityBtn  = document.querySelector('[data-group="city"].active');
    var cityKey  = cityBtn ? normaliseStr(cityBtn.dataset.val) : null;
    var moodBtns = document.querySelectorAll('[data-group="mood"].active');
    var nMoods   = Array.prototype.map.call(moodBtns, function(m) {
      return normaliseStr(MOOD_SYNONYMS[normaliseStr(m.dataset.val)] || m.dataset.val);
    });
    var q = normaliseStr(searchQuery).toLowerCase();

    return all.filter(function(p) {
      if (p.lat === null || p.lng === null || p.lat === undefined || p.lng === undefined) return false;

      if (cityKey) {
        var cityOk = p.city.some(function(c) { return normaliseStr(c) === cityKey; });
        if (!cityOk) return false;
      }
      if (nMoods.length > 0) {
        var moodOk = p.mood.some(function(m) {
          return nMoods.indexOf(normaliseStr(MOOD_SYNONYMS[normaliseStr(m)] || m)) !== -1;
        });
        if (!moodOk) return false;
      }
      if (q.length >= 2) {
        var hit = (p.title && normaliseStr(p.title).toLowerCase().indexOf(q) !== -1) ||
                  (p.desc  && normaliseStr(p.desc).toLowerCase().indexOf(q)  !== -1);
        if (!hit) return false;
      }
      return true;
    });
  }

  /* ── Core API (per spec): clear old markers, pin the new set ── */
  function updateMapMarkers(filteredPlaces) {
    if (!map || !markersLayer) return;
    markersLayer.clearLayers();

    var bounds = [];
    filteredPlaces.forEach(function(p) {
      var marker = L.marker([p.lat, p.lng]);
      /* Popup: title + a tiny CTA that opens the existing bottom sheet.
         textContent-based build (no string-concat HTML) so a malicious
         place title in the sheet can never inject markup. */
      var wrap  = document.createElement('div');
      var title = document.createElement('div');
      title.className = 'tl-popup-title';
      title.textContent = p.title;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tl-popup-btn';
      btn.textContent = t('discover.map_popup_btn');
      btn.addEventListener('click', function() {
        if (typeof window.talatyOpenPlaceSheet === 'function') window.talatyOpenPlaceSheet(p.id);
        if (typeof gtag === 'function') gtag('event', 'map_pin_opened', { place: p.title });
      });
      wrap.appendChild(title);
      wrap.appendChild(btn);
      marker.bindPopup(wrap, { closeButton: true, maxWidth: 220 });
      markersLayer.addLayer(marker);
      bounds.push([p.lat, p.lng]);
    });

    if (emptyHint) emptyHint.hidden = bounds.length > 0;

    if (bounds.length === 1)      map.setView(bounds[0], 15);
    else if (bounds.length > 1)   map.fitBounds(bounds, { padding: [36, 36], maxZoom: 15 });
    else                          map.setView(AMMAN_CENTER, 12);
  }
  /* Public export — other modules (or the console) can push a
     custom filtered set without knowing map internals. */
  window.updateMapMarkers = updateMapMarkers;

  function refreshMap() {
    if (!isMapView || !map) return;
    updateMapMarkers(getMapFilteredPlaces());
  }

  /* ── View switching ── */
  function setView(mode) {
    var wantMap = (mode === 'map');
    if (wantMap && !ensureMap()) return;   /* Leaflet unavailable → stay in list */
    isMapView = wantMap;

    toggleWrap.classList.toggle('mode-map', wantMap);
    listBtn.classList.toggle('active', !wantMap);
    mapBtn.classList.toggle('active', wantMap);
    listBtn.setAttribute('aria-selected', String(!wantMap));
    mapBtn.setAttribute('aria-selected', String(wantMap));

    screenEl.classList.toggle('map-view', wantMap);
    if (mapSection) mapSection.hidden = !wantMap;

    if (wantMap) {
      /* CRITICAL: the container was display:none while hidden, so
         Leaflet measured it at 0×0. invalidateSize() after it becomes
         visible re-measures and repaints — without this the map
         renders as grey tiles / a single corner. */
      requestAnimationFrame(function() {
        map.invalidateSize();
        refreshMap();
      });
      if (typeof gtag === 'function') gtag('event', 'map_view_opened');
    }
    if (navigator.vibrate) navigator.vibrate(10);
  }

  listBtn.addEventListener('click', function() { setView('list'); });
  mapBtn.addEventListener('click',  function() { setView('map');  });

  /* ── Live re-filtering hooks (spec: "every time the user filters
     places or searches") — city pills & mood buttons already exist;
     we listen passively so their own handlers stay untouched. ── */
  document.querySelectorAll('[data-group="city"], [data-group="mood"]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      /* run after the original handler has toggled .active */
      setTimeout(refreshMap, 0);
    });
  });

  /* Search hook — called by the smart-search input handler */
  window.talatyMapOnSearch = function(q) {
    searchQuery = q || '';
    refreshMap();
  };

  /* ── Travel mode has no local coordinates: hide the toggle and
     force back to List View whenever the user switches engines. ── */
  var localModeBtn  = document.getElementById('toggle-local');
  var travelModeBtn = document.getElementById('toggle-travel');
  function syncToggleVisibility() {
    var travelActive = travelModeBtn && travelModeBtn.classList.contains('active');
    toggleWrap.style.display = travelActive ? 'none' : '';
    if (travelActive && isMapView) setView('list');
  }
  if (localModeBtn)  localModeBtn.addEventListener('click',  function(){ setTimeout(syncToggleVisibility, 0); });
  if (travelModeBtn) travelModeBtn.addEventListener('click', function(){ setTimeout(syncToggleVisibility, 0); });
  syncToggleVisibility();

  /* Theme flips repaint tiles via CSS only — but a resize while the
     map is hidden (rotation, keyboard) needs a re-measure on return. */
  window.addEventListener('resize', function() {
    if (isMapView && map) map.invalidateSize();
  });
})();
