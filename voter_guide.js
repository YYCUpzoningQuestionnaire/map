/* voter_guide.js — Single-file, fixed-path implementation (handles SurveyMonkey 2-row headers)
   Dependencies (load in index.html BEFORE this file):
     - Leaflet JS/CSS
     - Papa Parse
     - @turf/turf
   Files expected in the same directory:
     - wards.geojson   (GeoJSON FeatureCollection; props include ward_num or label)
     - survey.csv      (raw SurveyMonkey CSV export)
*/

window.addEventListener('DOMContentLoaded', async () => {
  // ---------- Config ----------
  const WARDS_PATH  = 'wards.geojson';
  const SURVEY_PATH = 'survey.csv';

  // ---------- Utils ----------
  const normalize = (v) => (v == null ? '' : String(v).trim());
  const lc = (s) => s.toLowerCase();

  async function loadJSON(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }
  async function loadCSV(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    const text = await res.text();
    return Papa.parse(text, { skipEmptyLines: 'greedy' }); // array-of-arrays
  }

  // ---------- Survey cleaning (SurveyMonkey with 2 header rows) ----------
  function cleanSurveyFromPapa(papa) {
    const data = papa.data;
    if (!Array.isArray(data) || data.length < 2) {
      return { rows: [], issueColumns: [], wardColumn: null, nameColumn: null, cols: [], firstCol: null, lastCol: null };
    }

    const header0 = (data[0] || []).map(h => String(h ?? '')); // question stems
    const header1 = (data[1] || []).map(h => String(h ?? '')); // choices row (Yes/No/Undecided/etc.)

    // Detect if header1 is a choices row
    const CHOICE_TOKENS = new Set([
      'yes','no','undecided','additional comments','additional comments:','open-ended response','open-ended response:',
      'mayor','first name','last name','email address','ward'
    ]);
    const isChoiceToken = (s) => {
      const t = lc(normalize(s));
      if (!t) return false;
      if (CHOICE_TOKENS.has(t)) return true;
      if (/^ward(\s*\d+)?$/i.test(t)) return true;
      return false;
    };
    const nonEmpty1 = header1.filter(x => normalize(x) !== '');
    const choiceHits = nonEmpty1.filter(isChoiceToken);
    const header1IsChoices = nonEmpty1.length > 0 && (choiceHits.length / nonEmpty1.length >= 0.5);

    // Anchors for the ward slice in header0
    const findIdx = (re, arr) => arr.findIndex(h => re.test(h));
    const idxStart = findIdx(/i'm a candidate for:/i, header0); // inclusive anchor
    const idxEnd   = findIdx(/candidate name and email address/i, header0);
    const idxEndFallback = idxEnd >= 0 ? idxEnd
      : header0.findIndex(h => /candidate name/i.test(h) && /email/i.test(h));

    const wardSlice = (idxStart >= 0 && idxEndFallback > idxStart)
      ? { start: idxStart + 1, end: idxEndFallback }  // scan [start, end)
      : null;

    // Forward-fill header0 to collapse Unnamed spillover for normal questions
    const ffillHeaders = [];
    for (let i = 0; i < header0.length; i++) {
      const h = header0[i];
      ffillHeaders[i] = (h && !/^Unnamed/i.test(h)) ? h : (i > 0 ? ffillHeaders[i - 1] : '');
    }

    // Exclude ward slice indices from grouped Q/A columns
    const skipIdx = new Set();
    if (wardSlice) for (let i = wardSlice.start; i < wardSlice.end; i++) skipIdx.add(i);

    // Group indices by (forward-filled) header, excluding ward slice
    const groups = {};
    ffillHeaders.forEach((h, i) => {
      if (!h) return;
      if (skipIdx.has(i)) return;
      const key = h.trim();
      (groups[key] ||= []).push(i);
    });

    // Determine where data starts (row 2 if header1 is choices; else row 1)
    const dataStart = header1IsChoices ? 2 : 1;

    // Merge rows
    const rows = [];
    for (let r = dataStart; r < data.length; r++) {
      const arr = data[r];
      if (!Array.isArray(arr)) continue;
      const obj = {};

      // Normal grouped columns
      for (const [h, idxs] of Object.entries(groups)) {
        let chosen = '';
        for (const idx of idxs) {
          const v = arr[idx];
          if (v !== undefined && v !== null && String(v).trim() !== '') {
            chosen = String(v).trim();
            break;
          }
        }
        obj[h] = chosen;
      }

      // Derive ward from special slice: use CHOICE LABEL from header1 when present
      if (wardSlice) {
        let wardVal = '';
        for (let c = wardSlice.start; c < wardSlice.end; c++) {
          const v = normalize(arr[c]);
          if (v) {
            if (header1IsChoices && header1[c]) {
              wardVal = normalize(header1[c]); // e.g., "Ward 14"
            } else {
              // fallback: if choices row not available, use header0 or the cell value
              wardVal = normalize(header0[c]) || v;
            }
            break;
          }
        }
        obj['__Ward'] = wardVal;
      }

      // Keep non-empty rows
      if (Object.values(obj).some(v => normalize(v) !== '')) rows.push(obj);
    }

    const cols = Object.keys(groups).map(s => s.trim());

    // Name detection; fallback to First/Last later
    const nameColumn =
      cols.find(c => /candidate\s*name/i.test(c)) ||
      cols.find(c => /\bname\b/i.test(c)) ||
      null;

    // Ward column is synthetic if slice exists
    const wardColumn = wardSlice ? '__Ward' : (cols.find(c => /\bward\b/i.test(c)) || null);

    // Issue columns: dominated by Yes/No/Undecided values
    const ynu = new Set(['yes','no','undecided']);
    const issueColumns = [];
    for (const c of cols) {
      let nonEmpty = 0, ynuCount = 0;
      for (const row of rows) {
        const v = normalize(row[c]); if (!v) continue;
        nonEmpty++; if (ynu.has(lc(v))) ynuCount++;
      }
      if (nonEmpty > 0 && ynuCount / nonEmpty >= 0.7) issueColumns.push(c);
    }

    // First/Last for fallback name
    const firstCol = cols.find(c => /first\s*name/i.test(c)) || null;
    const lastCol  = cols.find(c => /last\s*name/i.test(c))  || null;

    return { rows, issueColumns, wardColumn, nameColumn, cols, firstCol, lastCol };
  }

  // ---------- Map ----------
  const mapEl = document.getElementById('map');
  if (!mapEl) {
    console.error('Missing <div id="map">');
    return;
  }

  const map = L.map('map');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
  }).addTo(map);
  const markerGroup = L.layerGroup().addTo(map);

  // ---------- Load data ----------
  const wardsGeo = await loadJSON(WARDS_PATH);
  const wardLayer = L.geoJSON(wardsGeo, { style: { color: '#444', weight: 1, fillOpacity: 0.07 } }).addTo(map);
  try { map.fitBounds(wardLayer.getBounds(), { padding: [20, 20] }); } catch {}

  const survey = cleanSurveyFromPapa(await loadCSV(SURVEY_PATH));

  // ---------- Build ward centroids + keys (prefer ward_num / label) ----------
  const wardCenters = []; // { key, name, lat, lng }
  for (const f of wardsGeo.features) {
    const p = f.properties || {};
    const key = p.ward_num
      ? String(parseInt(String(p.ward_num), 10))
      : (String((p.label || p.WARD || p.Ward || p.name || p.id || '')).match(/\d+/) || [''])[0];
    const disp = normalize(p.label) || (key ? `Ward ${key}` : '(unknown ward)');

    let lat = 0, lng = 0;
    try {
      const c = turf.centerOfMass(f);
      [lng, lat] = c.geometry.coordinates;
    } catch {}
    wardCenters.push({ key, name: disp, lat, lng });
  }

  // ---------- Group survey rows by derived ward key (digits from __Ward) ----------
  const byWard = new Map();
  for (const row of survey.rows) {
    const raw = survey.wardColumn ? row[survey.wardColumn] : '';
    const m = String(raw || '').match(/\d+/);
    const wkey = m ? String(parseInt(m[0], 10)) : '';
    if (!wkey) continue;
    if (!byWard.has(wkey)) byWard.set(wkey, []);
    byWard.get(wkey).push(row);
  }

  // ---------- Candidate name builder ----------
  function buildCandidateName(row) {
    const direct = survey.nameColumn ? normalize(row[survey.nameColumn]) : '';
    if (direct) return direct;
    const firstCol = survey.firstCol || Object.keys(row).find(k => /first\s*name/i.test(k));
    const lastCol  = survey.lastCol  || Object.keys(row).find(k => /last\s*name/i.test(k));
    const first = firstCol ? normalize(row[firstCol]) : '';
    const last  = lastCol  ? normalize(row[lastCol])  : '';
    const combined = `${first} ${last}`.trim();
    return combined || '(name)';
  }

  // ---------- Place markers per ward with candidate list ----------
  markerGroup.clearLayers();
  let totalMatches = 0;
  for (const wc of wardCenters) {
    const list = byWard.get(wc.key) || [];
    totalMatches += list.length;
    if (!wc.lat || !wc.lng) continue;

    const items = list.map(r => `<li>${buildCandidateName(r)}</li>`).join('');
    const html = `
      <div style="font-size:12px">
        <div style="font-weight:600">${wc.name}</div>
        <div>Candidates: ${list.length}</div>
        <ul style="max-height:160px;overflow:auto;margin-left:16px">${items}</ul>
      </div>`;

    L.marker([wc.lat, wc.lng]).addTo(markerGroup).bindPopup(html);
  }

  // ---------- Simple info control ----------
  const Info = L.Control.extend({
    onAdd: function() {
      const d = L.DomUtil.create('div');
      d.style.background = 'white';
      d.style.padding = '6px 10px';
      d.style.border = '1px solid #ccc';
      d.style.borderRadius = '8px';
      d.style.fontSize = '12px';
      d.innerHTML = `
        <div><b>Survey rows:</b> ${survey.rows.length}</div>
        <div><b>Issue cols:</b> ${survey.issueColumns.length}</div>
        <div><b>Ward col:</b> ${survey.wardColumn || '(n/a)'}</div>
        <div><b>Name col:</b> ${survey.nameColumn || '(n/a)'}</div>
        <div><b>Matched candidates:</b> ${totalMatches}</div>
      `;
      return d;
    }
  });
  map.addControl(new Info({ position: 'topright' }));

  // ---------- Diagnostics (console) ----------
  console.log('Detected columns:', survey.cols);
  console.log('Detected wardColumn:', survey.wardColumn);
  console.log('Detected nameColumn:', survey.nameColumn, 'firstCol:', survey.firstCol, 'lastCol:', survey.lastCol);
  console.log('Issue columns (first 10):', survey.issueColumns.slice(0, 10));
  console.log('Total survey rows:', survey.rows.length);
  console.log('Total matched candidate rows to wards:', totalMatches);
});
