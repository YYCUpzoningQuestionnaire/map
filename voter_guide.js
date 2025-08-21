/* voter_guide.js — Single-file, fixed-path
   ✔ Uses FIRST/LAST NAME FROM THE SECOND HEADER ROW (header1) explicitly
   ✔ Issue filters, ward coloring, per-answer comments
   ✔ Always shows all wards; robust centroids

   Dependencies (load in index.html BEFORE this file):
     - Leaflet JS/CSS
     - Papa Parse
     - @turf/turf

   Files (same folder):
     - wards.geojson
     - survey.csv
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
  function truncate(s, n = 180) {
    const t = normalize(s);
    if (t.length <= n) return t;
    return t.slice(0, n - 1) + '…';
  }

  // ---------- Survey cleaning (2-row headers + ward slice + per-issue comments) ----------
  function cleanSurveyFromPapa(papa) {
    const data = papa.data;
    if (!Array.isArray(data) || data.length < 2) {
      return {
        rows: [], issueColumns: [], wardColumn: null,
        cols: [], commentForIssue: {},
        nameMixedCol: null, firstIdx: -1, lastIdx: -1
      };
    }

    const header0 = (data[0] || []).map(h => String(h ?? '')); // stems
    const header1 = (data[1] || []).map(h => String(h ?? '')); // choices/meta (THIS is where "First name" & "Last name" live)

    // Detect if header1 is a choices/meta row
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
    const header1IsChoices = nonEmpty1.length > 0 &&
      (nonEmpty1.filter(isChoiceToken).length / nonEmpty1.length >= 0.5);

    // Ward slice anchors in header0
    const findIdx0 = (re) => header0.findIndex(h => re.test(h));
    const idxStart = findIdx0(/i'm a candidate for:/i); // inclusive anchor
    const idxEnd   = findIdx0(/candidate name and email address/i);
    const idxEndFallback = idxEnd >= 0 ? idxEnd
      : header0.findIndex(h => /candidate name/i.test(h) && /email/i.test(h));

    const wardSlice = (idxStart >= 0 && idxEndFallback > idxStart)
      ? { start: idxStart + 1, end: idxEndFallback }  // scan [start, end)
      : null;

    // Forward-fill header0 to collapse "Unnamed"
    const ffillHeaders = [];
    for (let i = 0; i < header0.length; i++) {
      const h = header0[i];
      ffillHeaders[i] = (h && !/^Unnamed/i.test(h)) ? h : (i > 0 ? ffillHeaders[i - 1] : '');
    }

    // Exclude ward slice from groups
    const skipIdx = new Set();
    if (wardSlice) for (let i = wardSlice.start; i < wardSlice.end; i++) skipIdx.add(i);

    // Group indices by header0 (forward-filled), excluding ward slice
    const groups = {};
    ffillHeaders.forEach((h, i) => {
      if (!h) return;
      if (skipIdx.has(i)) return;
      const key = h.trim();
      (groups[key] ||= []).push(i);
    });

    // ====== CRITICAL: lock FIRST/LAST NAME from header1 (SECOND HEADER ROW) ======
    const firstIdx = header1.findIndex(h => /first\s*name/i.test(h));
    const lastIdx  = header1.findIndex(h => /last\s*name/i.test(h));
    // Also capture a single mixed name field if it exists in header0 (rarely needed)
    const nameMixedIdx0 = header0.findIndex(h => /candidate.*name.*email.*address/i.test(h) || /^\s*name\s*$/i.test(h));
    const nameMixedCol = nameMixedIdx0 >= 0 ? nameMixedIdx0 : -1;

    // Per-issue choice/comment mapping using header1 labels
    const commentForIssue = {};
    const choiceIndexByGroup = {}; // group -> { yes:[], no:[], undecided:[], comment:[] }
    if (header1IsChoices) {
      for (const [g, idxs] of Object.entries(groups)) {
        const bucket = { yes: [], no: [], undecided: [], comment: [] };
        for (const idx of idxs) {
          const lab = lc(normalize(header1[idx]));
          if (lab === 'yes') bucket.yes.push(idx);
          else if (lab === 'no') bucket.no.push(idx);
          else if (lab === 'undecided') bucket.undecided.push(idx);
          else if (lab === 'additional comments' || lab === 'additional comments:' ||
                   lab === 'open-ended response' || lab === 'open-ended response:') {
            bucket.comment.push(idx);
          }
        }
        choiceIndexByGroup[g] = bucket;
        commentForIssue[g] = `__COMMENT::${g}`;
      }
    }

    const dataStart = header1IsChoices ? 2 : 1;

    // Merge rows
    const rows = [];
    for (let r = dataStart; r < data.length; r++) {
      const arr = data[r];
      if (!Array.isArray(arr)) continue;
      const obj = {};

      // regular grouped questions
      for (const [g, idxs] of Object.entries(groups)) {
        if (header1IsChoices) {
          const bucket = choiceIndexByGroup[g] || { yes: [], no: [], undecided: [], comment: [] };
          // Answer
          let ans = '';
          for (const label of ['yes', 'no', 'undecided']) {
            const arrIdxs = bucket[label];
            if (!arrIdxs) continue;
            for (const i of arrIdxs) {
              const v = arr[i];
              if (v !== undefined && v !== null && String(v).trim() !== '') {
                ans = label.charAt(0).toUpperCase() + label.slice(1);
                break;
              }
            }
            if (ans) break;
          }
          obj[g] = ans;
          // Comment
          const cField = commentForIssue[g];
          let comm = '';
          for (const i of (bucket.comment || [])) {
            const v = arr[i];
            if (v !== undefined && v !== null && String(v).trim() !== '') { comm = String(v).trim(); break; }
          }
          obj[cField] = comm;
        } else {
          // Fallback (no header1 choices)
          let chosen = '';
          for (const idx of idxs) {
            const v = arr[idx];
            if (v !== undefined && v !== null && String(v).trim() !== '') { chosen = String(v).trim(); break; }
          }
          obj[g] = chosen;
        }
      }

      // Ward from ward slice (use header1 label if present)
      if (wardSlice) {
        let wardVal = '';
        for (let c = wardSlice.start; c < wardSlice.end; c++) {
          const v = normalize(arr[c]);
          if (v) {
            if (header1IsChoices && header1[c]) wardVal = normalize(header1[c]);
            else wardVal = normalize(header0[c]) || v;
            break;
          }
        }
        obj['__Ward'] = wardVal;
      }

      // ====== CRITICAL: write names from header1 second-row indices ======
      if (firstIdx >= 0) obj['__FirstName'] = normalize(arr[firstIdx]);
      if (lastIdx  >= 0) obj['__LastName']  = normalize(arr[lastIdx]);
      if (nameMixedCol >= 0) obj['__NameMixed'] = normalize(arr[nameMixedCol]);

      if (Object.values(obj).some(v => normalize(v) !== '')) rows.push(obj);
    }

    const cols = Object.keys(groups).map(s => s.trim());

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

    const wardColumn = wardSlice ? '__Ward' : (cols.find(c => /\bward\b/i.test(c)) || null);

    return {
      rows, issueColumns, wardColumn, cols, commentForIssue,
      // expose indices so renderer can trust FIRST/LAST from header1
      firstIdx, lastIdx, nameMixedCol
    };
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
  const wardCenters = []; // { key, name, lat, lng }
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

      wardCenters.push({ key, name: disp, lat, lng });
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
  applyFilters('', ''); // initial

  function applyFilters(issue, wantValue) {
    // Build a filtered index by ward
    const byWard = new Map();

    for (const [wkey, rows] of byWardAll.entries()) {
      let list = rows;
      if (issue) {
        list = rows.filter(r => {
          const ans = ynuNormalize(r[issue]);
          if (!wantValue) return ans !== '';
          return ans === lc(wantValue);
        });
      }
      if (!issue && !wantValue) list = rows; // no filtering
      byWard.set(wkey, list);
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

    // Update markers/popups: ALWAYS place markers for all wards
    markerGroup.clearLayers();
    for (const wc of wardCenters) {
      if (!isFinite(wc.lat) || !isFinite(wc.lng)) continue;

      const list = byWard.get(wc.key) || [];
      const items = list.map(r => {
        const name = buildCandidateName(r); // <-- uses header1 "First name" & "Last name" directly
        const ans = issue ? (r[issue] || '').toString() : '';
        let comm = '';
        if (issue) {
          const cField = survey.commentForIssue[issue];
          if (cField) comm = r[cField] || '';
        }
        const right = issue
          ? ` — <b>${escapeHtml(ans || '—')}</b>${comm ? ` — <span style="color:#555">${escapeHtml(truncate(comm))}</span>` : ''}`
          : '';
        return `<li>${escapeHtml(name)}${right}</li>`;
      }).join('');

      const html = `
        <div style="font-size:12px">
          <div style="font-weight:600">${wc.name}</div>
          <div>Candidates: ${list.length}${issue ? ` (issue: <i>${escapeHtml(issue)}</i>)` : ''}</div>
          <ul style="max-height:220px;overflow:auto;margin-left:16px">${items || '<li><i>No candidates</i></li>'}</ul>
        </div>
      `;

      L.marker([wc.lat, wc.lng]).addTo(markerGroup).bindPopup(html);
    }

    updateInfo(byWard, issue, wantValue);
  }

  // ====== Candidate name: USE SECOND-ROW "First name" & "Last name" ======
  function buildCandidateName(row) {
    const fn = normalize(row['__FirstName']);
    const ln = normalize(row['__LastName']);
    const combo = `${fn} ${ln}`.replace(/\s+/g, ' ').trim();
    if (combo) return combo;

    // fallback: single mixed field if we captured it (rare)
    const mix = normalize(row['__NameMixed']);
    if (mix) {
      // strip emails if any slipped in
      return mix.replace(/\s*<[^>]*>/g, '').replace(/\b\S+@\S+\.\S+\b/g, '').replace(/\s+/g, ' ').trim() || '(name)';
    }
    return '(name)';
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
      <div><b>Name source:</b> ${survey.firstIdx >= 0 || survey.lastIdx >= 0 ? 'header1 (First/Last)' : (survey.nameMixedCol >= 0 ? 'single name field' : '(none found)')}</div>
    `;
  }

  // ---------- Diagnostics (console) ----------
  console.log('Header1 first/last indices:', { firstIdx: survey.firstIdx, lastIdx: survey.lastIdx });
  console.log('Single-name field index in header0 (if any):', survey.nameMixedCol);
  console.log('Issue → comment field map:', survey.commentForIssue);
  console.log('Issue columns (first 10):', survey.issueColumns.slice(0, 10));
  console.log('Total survey rows:', survey.rows.length);
});
