/* voter_guide.js — Striped ward fills by response mix; auto-apply filters; no buttons
   - Uses header1 "First name"/"Last name" for names
   - Issue filters, per-answer comments
   - Robust ward centroids; markers for all wards
   - Ward polygons filled with SVG stripe patterns proportional to Yes/No/Undecided counts

   Dependencies (load before this file):
     Leaflet, Papa Parse, @turf/turf
   Files (same folder): index.html, wards.geojson, survey.csv
*/

window.addEventListener('DOMContentLoaded', async () => {
  const WARDS_PATH  = 'wards.geojson';
  const SURVEY_PATH = 'survey.csv';

  // ---- single knob for stripe tile size (px) ----
  const STRIPE_SIZE = 25; // change this to adjust pattern tile width/height

  const COLORS = { yes: '#2c7a2c', no: '#b22222', undecided: '#b38f00', nodata: '#cccccc' };
  const SVGNS = 'http://www.w3.org/2000/svg';

  const normalize = v => (v == null ? '' : String(v).trim());
  const lc = s => s.toLowerCase();

  async function loadJSON(path){ const r=await fetch(path); if(!r.ok) throw new Error(`${path}: ${r.status}`); return r.json(); }
  async function loadCSV(path){ const r=await fetch(path); if(!r.ok) throw new Error(`${path}: ${r.status}`); const t=await r.text(); return Papa.parse(t,{skipEmptyLines:'greedy'}); }

  function ynuNormalize(s){ const t=lc(normalize(s)); return (t==='yes'||t==='no'||t==='undecided')?t:''; }
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function truncate(s,n=180){ const t=normalize(s); return t.length<=n?t:t.slice(0,n-1)+'…'; }

  // ---------- Survey cleaning (2-row headers + ward slice + per-issue comments) ----------
  function cleanSurveyFromPapa(papa){
    const data=papa.data;
    if(!Array.isArray(data)||data.length<2){
      return {rows:[],issueColumns:[],wardColumn:null,cols:[],commentForIssue:{},firstIdx:-1,lastIdx:-1,nameMixedCol:-1};
    }
    const header0=(data[0]||[]).map(h=>String(h??''));
    const header1=(data[1]||[]).map(h=>String(h??''));

    const CHOICE_TOKENS=new Set(['yes','no','undecided','additional comments','additional comments:','open-ended response','open-ended response:','mayor','first name','last name','email address','ward']);
    const isChoiceToken=s=>{ const t=lc(normalize(s)); if(!t) return false; if(CHOICE_TOKENS.has(t)) return true; return /^ward(\s*\d+)?$/i.test(t); };
    const nonEmpty1=header1.filter(x=>normalize(x)!=='');
    const header1IsChoices=nonEmpty1.length>0 && (nonEmpty1.filter(isChoiceToken).length/nonEmpty1.length>=0.5);

    const findIdx0=re=>header0.findIndex(h=>re.test(h));
    const idxStart=findIdx0(/i'm a candidate for:/i);
    const idxEnd=findIdx0(/candidate name and email address/i);
    const idxEndFallback=idxEnd>=0?idxEnd:header0.findIndex(h=>/candidate name/i.test(h)&&/email/i.test(h));
    const wardSlice=(idxStart>=0 && idxEndFallback>idxStart)?{start:idxStart+1,end:idxEndFallback}:null;

    const ffillHeaders=[];
    for(let i=0;i<header0.length;i++){
      const h=header0[i];
      ffillHeaders[i]=(h && !/^Unnamed/i.test(h)) ? h : (i>0 ? ffillHeaders[i-1] : '');
    }

    const skipIdx=new Set();
    if(wardSlice) for(let i=wardSlice.start;i<wardSlice.end;i++) skipIdx.add(i);

    const groups={};
    ffillHeaders.forEach((h,i)=>{ if(!h||skipIdx.has(i)) return; const k=h.trim(); (groups[k]??=[]).push(i); });

    // Lock First/Last from SECOND HEADER ROW explicitly
    const firstIdx=header1.findIndex(h=>/first\s*name/i.test(h));
    const lastIdx =header1.findIndex(h=>/last\s*name/i.test(h));
    const nameMixedCol = header0.findIndex(h=>/^\s*name\s*$/i.test(h) || /candidate.*name.*email.*address/i.test(h));

    const commentForIssue={}, choiceIndexByGroup={};
    if(header1IsChoices){
      for(const [g,idxs] of Object.entries(groups)){
        const bucket={yes:[],no:[],undecided:[],comment:[]};
        for(const idx of idxs){
          const lab=lc(normalize(header1[idx]));
          if(lab==='yes') bucket.yes.push(idx);
          else if(lab==='no') bucket.no.push(idx);
          else if(lab==='undecided') bucket.undecided.push(idx);
          else if(lab==='additional comments'||lab==='additional comments:'||lab==='open-ended response'||lab==='open-ended response:') bucket.comment.push(idx);
        }
        choiceIndexByGroup[g]=bucket;
        commentForIssue[g]=`__COMMENT::${g}`;
      }
    }

    const dataStart=header1IsChoices?2:1;
    const rows=[];
    for(let r=dataStart;r<data.length;r++){
      const arr=data[r]; if(!Array.isArray(arr)) continue;
      const obj={};
      for(const [g,idxs] of Object.entries(groups)){
        if(header1IsChoices){
          const bucket=choiceIndexByGroup[g]||{yes:[],no:[],undecided:[],comment:[]};
          let ans='';
          for(const label of ['yes','no','undecided']){
            for(const i of (bucket[label]||[])){ const v=arr[i]; if(v!=null && String(v).trim()!==''){ ans=label[0].toUpperCase()+label.slice(1); break; } }
            if(ans) break;
          }
          obj[g]=ans;
          const cField=commentForIssue[g];
          let comm='';
          for(const i of (bucket.comment||[])){ const v=arr[i]; if(v!=null && String(v).trim()!==''){ comm=String(v).trim(); break; } }
          obj[cField]=comm;
        }else{
          let chosen='';
          for(const idx of idxs){ const v=arr[idx]; if(v!=null && String(v).trim()!==''){ chosen=String(v).trim(); break; } }
          obj[g]=chosen;
        }
      }
      if(wardSlice){
        let wardVal='';
        for(let c=wardSlice.start;c<wardSlice.end;c++){
          const v=normalize(arr[c]); if(!v) continue;
          wardVal = (header1IsChoices && header1[c]) ? normalize(header1[c]) : (normalize(header0[c])||v);
          break;
        }
        obj['__Ward']=wardVal;
      }
      if(firstIdx>=0) obj['__FirstName']=normalize(arr[firstIdx]);
      if(lastIdx >=0) obj['__LastName'] =normalize(arr[lastIdx]);
      if(nameMixedCol>=0) obj['__NameMixed']=normalize(arr[nameMixedCol]);

      if(Object.values(obj).some(v=>normalize(v)!=='')) rows.push(obj);
    }

    const cols=Object.keys(groups).map(s=>s.trim());

    const ynu=new Set(['yes','no','undecided']);
    const issueColumns=[];
    for(const c of cols){
      let nonEmpty=0, ynuCount=0;
      for(const row of rows){ const v=normalize(row[c]); if(!v) continue; nonEmpty++; if(ynu.has(lc(v))) ynuCount++; }
      if(nonEmpty>0 && ynuCount/nonEmpty>=0.7) issueColumns.push(c);
    }

    const wardColumn = wardSlice?'__Ward':(cols.find(c=>/\bward\b/i.test(c))||null);

    return { rows, issueColumns, wardColumn, cols, commentForIssue, firstIdx, lastIdx, nameMixedCol };
  }

  // --- Map (default SVG renderer; we'll access the SVG after polygons are rendered) ---
  const mapEl=document.getElementById('map');
  if(!mapEl){ console.error('Missing <div id="map">'); return; }

  const map=L.map('map');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors'}).addTo(map);
  const polygonLayer=L.geoJSON(null,{style:()=>({color:'#555',weight:1,fillOpacity:0.35})}).addTo(map);
  const markerGroup=L.layerGroup().addTo(map);

  const wardsGeo=await loadJSON(WARDS_PATH);
  polygonLayer.addData(wardsGeo);
  try{ map.fitBounds(polygonLayer.getBounds(),{padding:[20,20]}); }catch{}

  const survey=cleanSurveyFromPapa(await loadCSV(SURVEY_PATH));

  // SVG helpers (created lazily after vector paths exist)
  function getSVGRoot(){
    const pane = map.getPanes().overlayPane;
    return pane ? pane.querySelector('svg') : null;
  }
  function ensureDefs(){
    const svg = getSVGRoot();
    if(!svg) return null;
    let defs = svg.querySelector('defs');
    if(!defs){
      defs = document.createElementNS(SVGNS,'defs');
      svg.insertBefore(defs, svg.firstChild);
    }
    return defs;
  }

  // Ward centers
  const wardCenters=[];
  for(const f of wardsGeo.features){
    const p=f.properties||{};
    const key = p.ward_num ? String(parseInt(String(p.ward_num),10))
      : (String((p.label||p.WARD||p.Ward||p.name||p.id||'')).match(/\d+/)||[''])[0];
    const disp=normalize(p.label)||(key?`Ward ${key}`:'(unknown ward)');
    let lat=0,lng=0;
    try{
      const com=turf.centerOfMass(f).geometry.coordinates; lng=com[0]; lat=com[1];
      if(!isFinite(lat)||!isFinite(lng)) throw 0;
    }catch{
      try{
        const cen=turf.centroid(f).geometry.coordinates; lng=cen[0]; lat=cen[1];
        if(!isFinite(lat)||!isFinite(lng)) throw 0;
      }catch{
        try{ const c=L.geoJSON(f).getBounds().getCenter(); lat=c.lat; lng=c.lng; }catch{}
      }
    }
    wardCenters.push({key,name:disp,lat,lng});
  }

  // Group rows by ward key
  const byWardAll=new Map();
  for(const row of survey.rows){
    const m=String(row['__Ward']||'').match(/\d+/);
    const k=m?String(parseInt(m[0],10)):'';
    if(!k) continue;
    if(!byWardAll.has(k)) byWardAll.set(k,[]);
    byWardAll.get(k).push(row);
  }

  // --- UI (auto-apply on change) ---
  injectControlUI();

  function injectControlUI(){
    const wrap=document.createElement('div');
    Object.assign(wrap.style,{position:'absolute',top:'12px',left:'12px',zIndex:1000,background:'white',border:'1px solid #ccc',borderRadius:'12px',padding:'8px 10px',fontSize:'12px',boxShadow:'0 1px 6px rgba(0,0,0,0.08)'});

    const title=document.createElement('div');
    Object.assign(title.style,{fontWeight:'600',marginBottom:'6px'});
    title.textContent='Issue Filter';

    const issueSel=document.createElement('select');
    issueSel.style.marginRight='6px'; issueSel.style.maxWidth='360px'; issueSel.title='Issue';
    const optAny=document.createElement('option'); optAny.value=''; optAny.textContent='(Select an issue)'; issueSel.appendChild(optAny);
    for(const c of survey.issueColumns){ const o=document.createElement('option'); o.value=c; o.textContent=c; issueSel.appendChild(o); }

    const ansSel=document.createElement('select');
    ansSel.style.marginLeft='6px';
    for(const v of ['(Any)','Yes','No','Undecided']){ const o=document.createElement('option'); o.value=(v==='(Any)')?'':v; o.textContent=v; ansSel.appendChild(o); }

    const legend=document.createElement('div');
    legend.style.marginTop='8px'; legend.style.color='#444';
    legend.innerHTML=`<div style="margin-bottom:4px"><b>Ward fill:</b> striped by response mix (tile ${STRIPE_SIZE}px)</div>
      <div style="display:flex;gap:8px;align-items:center">
        ${sw(COLORS.yes)} Yes ${sw(COLORS.no)} No ${sw(COLORS.undecided)} Undecided ${sw(COLORS.nodata)} No data
      </div>`;

    wrap.appendChild(title);
    wrap.appendChild(issueSel);
    wrap.appendChild(ansSel);
    wrap.appendChild(legend);
    map.getContainer().appendChild(wrap);

    issueSel.addEventListener('change', ()=>applyFilters(issueSel.value||'', ansSel.value||'' ));
    ansSel.addEventListener('change',   ()=>applyFilters(issueSel.value||'', ansSel.value||'' ));

    applyFilters('', '');
  }

  function sw(color){ return `<span style="display:inline-block;width:12px;height:12px;background:${color};border:1px solid #999;border-radius:3px;margin:0 6px 0 4px"></span>`; }

  // --- Pattern helpers (defs created lazily) ---
  function ensurePattern(id, segments){
    const defs = ensureDefs();
    if(!defs) return null;

    let pat = defs.querySelector(`#${CSS.escape(id)}`);
    if (pat) {
      while(pat.firstChild) pat.removeChild(pat.firstChild);
    } else {
      pat = document.createElementNS(SVGNS,'pattern');
      pat.setAttribute('id', id);
      pat.setAttribute('patternUnits','userSpaceOnUse');
      pat.setAttribute('width', STRIPE_SIZE);
      pat.setAttribute('height', STRIPE_SIZE);
      defs.appendChild(pat);
    }
    // background
    const bg = document.createElementNS(SVGNS,'rect');
    bg.setAttribute('x','0'); bg.setAttribute('y','0');
    bg.setAttribute('width', STRIPE_SIZE);
    bg.setAttribute('height', STRIPE_SIZE);
    bg.setAttribute('fill', COLORS.nodata);
    pat.appendChild(bg);

    // Normalize & draw vertical stripes across STRIPE_SIZE width
    let sum = segments.reduce((a,s)=>a+Math.max(0,s.frac||0),0);
    if (sum <= 0) return pat;
    let x = 0;
    for (const s of segments){
      const w = (Math.max(0,s.frac||0)/sum) * STRIPE_SIZE;
      if (w <= 0) continue;
      const rect = document.createElementNS(SVGNS,'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', '0');
      rect.setAttribute('width', String(w));
      rect.setAttribute('height', STRIPE_SIZE);
      rect.setAttribute('fill', s.color);
      pat.appendChild(rect);
      x += w;
    }
    return pat;
  }

  function setLayerPatternFill(layer, patternId){
    const path = layer._path;
    if (!path) return;
    path.setAttribute('fill', `url(#${patternId})`);
    path.setAttribute('fill-opacity', '0.45');
    path.setAttribute('stroke', '#555');
    path.setAttribute('stroke-width', '1');
  }

  function wardKeyFromFeature(feature){
    const p = feature.properties||{};
    return p.ward_num ? String(parseInt(String(p.ward_num),10))
      : (String((p.label||p.WARD||p.Ward||p.name||p.id||'')).match(/\d+/)||[''])[0];
  }

  // --- Filtering + rendering ---
  function applyFilters(issue, wantValue){
    const byWard=new Map();
    for(const [k,rows] of byWardAll.entries()){
      let list=rows;
      if(issue){
        list=rows.filter(r=>{
          const ans=ynuNormalize(r[issue]);
          if(!wantValue) return ans!==''; // has an answer
          return ans===lc(wantValue);
        });
      }
      byWard.set(k, list);
    }

    polygonLayer.setStyle(()=>({ color:'#555', weight:1, fillOpacity:0.35 }));

    // Ensure SVG exists before pattern work (first render path)
    requestAnimationFrame(() => {
      polygonLayer.eachLayer(layer=>{
        const feat = layer.feature;
        const key  = wardKeyFromFeature(feat);
        const rows = byWard.get(key)||[];
        let yes=0, no=0, und=0;
        if(issue){
          for(const r of rows){
            const a=ynuNormalize(r[issue]);
            if(a==='yes') yes++;
            else if(a==='no') no++;
            else if(a==='undecided') und++;
          }
        }
        const total = yes+no+und;

        let segments;
        if(!issue || total===0){
          segments = [{ color: COLORS.nodata, frac: 1 }];
        } else {
          segments = [
            { color: COLORS.yes, frac: yes },
            { color: COLORS.no,  frac: no  },
            { color: COLORS.undecided, frac: und }
          ];
        }

        const patId = `wardStripe-${key}-${hashSegments(segments)}`;
        ensurePattern(patId, segments);
        setLayerPatternFill(layer, patId);
      });
    });

    // Update markers/popups
    markerGroup.clearLayers();
    for(const wc of wardCenters){
      if(!isFinite(wc.lat)||!isFinite(wc.lng)) continue;
      const list=byWard.get(wc.key)||[];
      const items=list.map(r=>{
        const name=buildName(r);
        const ans = issue ? (r[issue]||'') : '';
        let comm='';
        if(issue){ const cf=survey.commentForIssue[issue]; if(cf) comm=r[cf]||''; }
        const right = issue ? ` — <b>${escapeHtml(ans||'—')}</b>${comm?` — <span style="color:#555">${escapeHtml(truncate(comm))}</span>`:''}` : '';
        return `<li>${escapeHtml(name)}${right}</li>`;
      }).join('');
      const html=`<div style="font-size:12px">
        <div style="font-weight:600">${wc.name}</div>
        <div>Candidates: ${list.length}${issue?` (issue: <i>${escapeHtml(issue)}</i>)`:''}</div>
        <ul style="max-height:220px;overflow:auto;margin-left:16px">${items||'<li><i>No candidates</i></li>'}</ul>
      </div>`;
      L.marker([wc.lat,wc.lng]).addTo(markerGroup).bindPopup(html);
    }

    updateInfo(byWard, issue, wantValue);
  }

  function hashSegments(segments){
    const parts = segments.map(s=>`${s.color}:${Math.round((s.frac||0)*1000)}`).join('|');
    let h=5381; for(let i=0;i<parts.length;i++){ h=((h<<5)+h)+parts.charCodeAt(i); h|=0; }
    return Math.abs(h).toString(36);
  }

  function buildName(row){
    const fn=normalize(row['__FirstName']);
    const ln=normalize(row['__LastName']);
    const combo=(fn+' '+ln).replace(/\s+/g,' ').trim();
    if(combo) return combo;
    const mix=normalize(row['__NameMixed']);
    if(mix) return mix.replace(/\s*<[^>]*>/g,'').replace(/\b\S+@\S+\b/g,'').replace(/\s+/g,' ').trim()||'(name)';
    return '(name)';
  }

  // Info control
  const Info=L.Control.extend({ onAdd:function(){ const d=L.DomUtil.create('div'); Object.assign(d.style,{background:'white',padding:'6px 10px',border:'1px solid #ccc',borderRadius:'8px',fontSize:'12px'}); d.id='info-box'; return d; }});
  map.addControl(new Info({position:'topright'}));

  function updateInfo(byWard, issue, want){
    const box=document.getElementById('info-box'); if(!box) return;
    let total=0; for(const rows of byWard.values()) total+=rows.length;
    box.innerHTML=`
      <div><b>Survey rows (shown):</b> ${total}</div>
      <div><b>Issue:</b> ${escapeHtml(issue||'(No issue selected)')}</div>
      <div><b>Answer filter:</b> ${escapeHtml(want||'(Any)')}</div>
      <div>Ward fill shows mix of Yes / No / Undecided for the current filter. Tile size: ${STRIPE_SIZE}px</div>
    `;
  }

  // Diagnostics
  console.log('Header1 First/Last indices:', {firstIdx: survey.firstIdx, lastIdx: survey.lastIdx});
  console.log('Issue columns (first 10):', survey.issueColumns.slice(0,10));
  console.log('Total survey rows:', survey.rows.length);
});
