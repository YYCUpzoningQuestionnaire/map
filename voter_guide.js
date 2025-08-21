/* voter_guide.js — Single-file, fixed-path (always show all wards, robust centroids, issue filters)
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

  function ynuNormalize(s) {
    const t = lc(normalize(s));
    if (t === 'yes' || t === 'no' || t === 'undecided') return t;
    return '';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
    ));
  }

  // ---------- Survey cleaning (handles 2-row SurveyMonkey headers + ward slice) ----------
  function cleanSurveyFromPapa(papa) {
    const data = papa.data;
    if (!Array.isArray(data) || data.length < 2) {
      return { rows: [], issueColumns: [], wardColumn: null, nameColumn: null, cols: [], firstCol: null, lastCol: null };
    }

    const header0 = (data[0] || []).map(h => String(h ?? '')); // question stems
    const header1 = (data[1] || []).map(h => String(h ?? '')); // choices row (Yes/No/Undecided/etc.)

    // Detect if header1 is a choices row
    const CHOICE_TOKENS = new Set([
      'yes','no','undecided','additional comments','additional comments:',
      'open-ended response','open-ended response:',
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
              // fallback: header0 or the cell value
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

  const polygonLayer = L.geoJSON(null, { style: baseWardStyle }).addTo(map);
  const markerGroup = L.layerGroup().addTo(map);

  function baseWardStyle() {
    return { color: '#555', weight: 1, fillOpacity: 0.06 };
  }

  // ---------- Load data ----------
  const wardsGeo = await loadJSON(WARDS_PATH);
  polygonLayer.addData(wardsGeo);
  try { map.fitBounds(polygonLayer.getBounds(), { padding: [20, 20] }); } catch {}

  const survey = cleanSurveyFromPapa(await loadCSV(SURVEY_PATH));

  // ---------- Ward centers + keys (prefer ward_num / label) ----------
  const wardCenters = []; // { key, name, lat, lng, feature }
  (function buildWardCenters(){
    for (const f of wardsGeo.features) {
      const p = f.properties || {};
      const key = p.ward_num
        ? String(parseInt(String(p.ward_num), 10))
        : (String((p.label || p.WARD || p.Ward || p.name || p.id || '')).match(/\d+/) || [''])[0];
      const disp = normalize(p.label) || (key ? `Ward ${key}` : '(unknown ward)');

      // robust centroid (centerOfMass -> centroid -> bounds center)
      let lat = 0, lng = 0;
      try {
        const com = turf.centerOfMass(f);
        [lng, lat] = com.geometry.coordinates;
        if (!isFinite(lat) || !isFinite(lng)) throw new Error('bad COM');
      } catch {
        try {
          const cen = turf.centroid(f);
          [lng, lat] = cen.geometry.coordinates;
          if (!isFinite(lat) || !isFinite(lng)) throw new Error('bad centroid');
        } catch {
          try {
            const ll = L.geoJSON(f).getBounds().getCenter();
            lat = ll.lat; lng = ll.lng;
          } catch {}
        }
      }

      wardCenters.push({ key, name: disp, lat, lng, feature: f });
    }
  })();

  // ---------- Group survey rows by derived ward key (digits from __Ward) ----------
  const byWardAll = new Map(); // key -> row[]
  for (const row of survey.rows) {
    const raw = survey.wardColumn ? row[survey.wardColumn] : '';
    const m = String(raw || '').match(/\d+/);
    const wkey = m ? String(parseInt(m[0], 10)) : '';
    if (!wkey) continue;
    if (!byWardAll.has(wkey)) byWardAll.set(wkey, []);
    byWardAll.get(wkey).push(row);
  }

  // ---------- UI: issue selector + answer filter ----------
  injectControlUI();

  function injectControlUI() {
    const wrap = document.createElement('div');
    wrap.style.position = 'absolute';
    wrap.style.top = '12px';
    wrap.style.left = '12px';
    wrap.style.zIndex = 1000;
    wrap.style.background = 'white';
    wrap.style.border = '1px solid #ccc';
    wrap.style.borderRadius = '12px';
    wrap.style.padding = '8px 10px';
    wrap.style.fontSize = '12px';
    wrap.style.boxShadow = '0 1px 6px rgba(0,0,0,0.08)';

    const title = document.createElement('div');
    title.style.fontWeight = '600';
    title.style.marginBottom = '6px';
    title.textContent = 'Issue Filter';

    const issueSel = document.createElement('select');
    issueSel.style.marginRight = '6px';
    issueSel.style.maxWidth = '360px';
    issueSel.title = 'Issue';
    const anyOption = document.createElement('option');
    anyOption.value = '';
    anyOption.textContent = '(Select an issue)';
    issueSel.appendChild(anyOption);
    for (const c of survey.issueColumns) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      issueSel.appendChild(opt);
    }

    const ansSel = document.createElement('select');
    ansSel.style.marginRight = '6px';
    ['(Any)','Yes','No','Undecided'].forEach(v => {
      const opt = document.createElement('option');
      opt.value = v === '(Any)' ? '' : v;
      opt.textContent = v;
      ansSel.appendChild(opt);
    });

    const btnApply = document.createElement('button');
    btnApply.textContent = 'Apply';
    btnApply.style.marginRight = '6px';
    styleBtn(btnApply);

    const btnClear = document.createElement('button');
    btnClear.textContent = 'Clear';
    styleBtn(btnClear);

    const legend = document.createElement('div');
    legend.style.marginTop = '8px';
    legend.style.color = '#444';
    legend.innerHTML = `
      <div style="margin-bottom:4px"><b>Ward color:</b> majority on selected issue</div>
      <div style="display:flex;gap:8px;align-items:center">
        ${legendSwatch('#2c7a2c')} Yes
        ${legendSwatch('#b22222')} No
        ${legendSwatch('#b38f00')} Undecided
        ${legendSwatch('#cccccc')} No data
      </div>
    `;

    wrap.appendChild(title);
    wrap.appendChild(issueSel);
    wrap.appendChild(ansSel);
    wrap.appendChild(btnApply);
    wrap.appendChild(btnClear);
    wrap.appendChild(legend);
    map.getContainer().appendChild(wrap);

    btnApply.addEventListener('click', () => applyFilters(issueSel.value || '', ansSel.value || ''));
    btnClear.addEventListener('click', () => { issueSel.value = ''; ansSel.value = ''; applyFilters('', ''); });
  }

  function styleBtn(b) {
    b.style.border = '1px solid #bbb';
    b.style.background = '#fff';
    b.style.borderRadius = '10px';
    b.style.padding = '4px 10px';
    b.style.cursor = 'pointer';
  }
  function legendSwatch(color) {
    return `<span style="display:inline-block;width:12px;height:12px;background:${color};border:1px solid #999;border-radius:3px"></span>`;
  }

  // ---------- Filtering + rendering ----------
  applyFilters('', ''); // initial draw

  function applyFilters(issue, wantValue) {
    // Build a filtered index by ward
    const byWard = new Map();

    for (const [wkey, rows] of byWardAll.entries()) {
      let list = rows;
      if (issue) {
        list = rows.filter(r => {
          const ans = ynuNormalize(r[issue]);
          if (!wantValue) return ans !== ''; // "(Any)" -> keep rows that have a Y/N/U answer
          return ans === lc(wantValue);
        });
      }
      if (!issue && !wantValue) list = rows; // no filtering at all
      byWard.set(wkey, list); // <-- note: we set it even if list.length === 0
    }

    // Update ward polygons style (color by majority on selected issue)
    polygonLayer.setStyle((feature) => {
      if (!issue) return baseWardStyle();

      const p = feature.properties || {};
      const key = p.ward_num
        ? String(parseInt(String(p.ward_num), 10))
        : (String((p.label || p.WARD || p.Ward || p.name || p.id || '')).match(/\d+/) || [''])[0];

      const rows = byWardAll.get(key) || [];
      if (!rows.length) return { color: '#777', weight: 1, fillColor: '#ccc', fillOpacity: 0.4 };

      const counts = { yes: 0, no: 0, undecided: 0 };
      for (const r of rows) {
        const a = ynuNormalize(r[issue]);
        if (counts.hasOwnProperty(a)) counts[a]++;
      }
      const total = counts.yes + counts.no + counts.undecided;
      if (!total) return { color: '#777', weight: 1, fillColor: '#ccc', fillOpacity: 0.4 };

      let color = '#cccccc';
      if (counts.yes >= counts.no && counts.yes >= counts.undecided) color = '#2c7a2c';
      else if (counts.no >= counts.yes && counts.no >= counts.undecided) color = '#b22222';
      else color = '#b38f00';

      return { color: '#555', weight: 1, fillColor: color, fillOpacity: 0.35 };
    });

    // Update markers/popups: ALWAYS place markers for all wards (even if 0 matches)
    markerGroup.clearLayers();
    for (const wc of wardCenters) {
      if (!isFinite(wc.lat) || !isFinite(wc.lng)) continue;

      const list = byWard.get(wc.key) || [];
      const items = list.map(r => {
        const name = buildCandidateNameDisplay(r);
        const ans = issue ? (r[issue] || '').toString() : '';
        return `<li>${name}${issue ? ` — <i>${escapeHtml(ans || '—')}</i>` : ''}</li>`;
      }).join('');

      const html = `
        <div style="font-size:12px">
          <div style="font-weight:600">${wc.name}</div>
          <div>Candidates: ${list.length}${issue ? ` (issue: <i>${escapeHtml(issue)}</i>)` : ''}</div>
          <ul style="max-height:180px;overflow:auto;margin-left:16px">${items || '<li><i>No candidates</i></li>'}</ul>
        </div>
      `;

      L.marker([wc.lat, wc.lng]).addTo(markerGroup).bindPopup(html);
    }

    updateInfo(byWard, issue, wantValue);
  }

  function buildCandidateNameDisplay(row) {
    const direct = survey.nameColumn ? normalize(row[survey.nameColumn]) : '';
    if (direct) return direct;
    const firstCol = survey.firstCol || Object.keys(row).find(k => /first\s*name/i.test(k));
    const lastCol  = survey.lastCol  || Object.keys(row).find(k => /last\s*name/i.test(k));
    const first = firstCol ? normalize(row[firstCol]) : '';
    const last  = lastCol  ? normalize(row[lastCol])  : '';
    const combined = `${first} ${last}`.trim();
    return combined || '(name)';
  }

  // ---------- Info control ----------
  const Info = L.Control.extend({
    onAdd: function() {
      const d = L.DomUtil.create('div');
      d.style.background = 'white';
      d.style.padding = '6px 10px';
      d.style.border = '1px solid #ccc';
      d.style.borderRadius = '8px';
      d.style.fontSize = '12px';
      d.id = 'info-box';
      return d;
    }
  });
  map.addControl(new Info({ position: 'topright' }));
  function updateInfo(byWard, issue, want) {
    const box = document.getElementById('info-box');
    if (!box) return;

    let totalRows = 0;
    for (const rows of byWard.values()) totalRows += rows.length;

    const wantText = want ? want : '(Any)';
    const issueText = issue ? issue : '(No issue selected)';

    box.innerHTML = `
      <div><b>Survey rows (shown):</b> ${totalRows}</div>
      <div><b>Issue:</b> ${escapeHtml(issueText)}</div>
      <div><b>Answer filter:</b> ${escapeHtml(wantText)}</div>
      <div><b>Total issue columns:</b> ${survey.issueColumns.length}</div>
      <div><b>Ward col:</b> ${survey.wardColumn || '(n/a)'}</div>
      <div><b>Name col:</b> ${survey.nameColumn || '(n/a)'}</div>
    `;
  }

  // ---------- Diagnostics (console) ----------
  console.log('Ward keys from GeoJSON:', wardCenters.map(w => w.key));
  console.log('Survey ward keys present:', Array.from(byWardAll.keys()));
  console.log('Detected nameColumn:', survey.nameColumn, 'firstCol:', survey.firstCol, 'lastCol:', survey.lastCol);
  console.log('Issue columns (first 10):', survey.issueColumns.slice(0, 10));
  console.log('Total survey rows:', survey.rows.length);
});
