/* voter_guide.js — Auto-apply filters on change; no buttons
   - Uses header1 "First name"/"Last name" explicitly
   - Issue filters, ward coloring, per-answer comments
   - Robust ward centroids; markers for all wards

   Dependencies (load before this file):
     Leaflet, Papa Parse, @turf/turf
   Files (same folder): index.html, wards.geojson, survey.csv
*/

window.addEventListener('DOMContentLoaded', async () => {
  const WARDS_PATH  = 'wards.geojson';
  const SURVEY_PATH = 'survey.csv';

  const normalize = v => (v == null ? '' : String(v).trim());
  const lc = s => s.toLowerCase();

  async function loadJSON(path){ const r=await fetch(path); if(!r.ok) throw new Error(`${path}: ${r.status}`); return r.json(); }
  async function loadCSV(path){ const r=await fetch(path); if(!r.ok) throw new Error(`${path}: ${r.status}`); const t=await r.text(); return Papa.parse(t,{skipEmptyLines:'greedy'}); }

  function ynuNormalize(s){ const t=lc(normalize(s)); return (t==='yes'||t==='no'||t==='undecided')?t:''; }
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function truncate(s,n=180){ const t=normalize(s); return t.length<=n?t:t.slice(0,n-1)+'…'; }

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
      ffillHeaders[i]=(h && !/^Unnamed/i.test(h))?h:(i>0?ffillHeaders[i-1]:'');
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

  // Map
  const mapEl=document.getElementById('map');
  if(!mapEl){ console.error('Missing <div id="map">'); return; }
  const map=L.map('map');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors'}).addTo(map);
  const polygonLayer=L.geoJSON(null,{style:()=>({color:'#555',weight:1,fillOpacity:0.06})}).addTo(map);
  const markerGroup=L.layerGroup().addTo(map);

  const wardsGeo=await loadJSON(WARDS_PATH);
  polygonLayer.addData(wardsGeo);
  try{ map.fitBounds(polygonLayer.getBounds(),{padding:[20,20]}); }catch{}

  const survey=cleanSurveyFromPapa(await loadCSV(SURVEY_PATH));

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

  // UI — auto-apply on change
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
    legend.innerHTML=`<div style="margin-bottom:4px"><b>Ward color:</b> majority on selected issue</div>
      <div style="display:flex;gap:8px;align-items:center">
        ${sw('#2c7a2c')} Yes ${sw('#b22222')} No ${sw('#b38f00')} Undecided ${sw('#cccccc')} No data
      </div>`;

    wrap.appendChild(title);
    wrap.appendChild(issueSel);
    wrap.appendChild(ansSel);
    wrap.appendChild(legend);
    map.getContainer().appendChild(wrap);

    // Auto-apply on change
    issueSel.addEventListener('change', ()=>applyFilters(issueSel.value||'', ansSel.value||'' ));
    ansSel.addEventListener('change',   ()=>applyFilters(issueSel.value||'', ansSel.value||'' ));

    // Initial draw
    applyFilters('', '');
  }

  function sw(color){ return `<span style="display:inline-block;width:12px;height:12px;background:${color};border:1px solid #999;border-radius:3px;margin:0 6px 0 4px"></span>`; }

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
      if(!issue && !wantValue) list=rows;
      byWard.set(k,list);
    }

    polygonLayer.setStyle((feature)=>{
      if(!issue) return {color:'#555',weight:1,fillOpacity:0.06};
      const p=feature.properties||{};
      const key = p.ward_num ? String(parseInt(String(p.ward_num),10))
        : (String((p.label||p.WARD||p.Ward||p.name||p.id||'')).match(/\d+/)||[''])[0];
      const rows=byWardAll.get(key)||[];
      if(!rows.length) return {color:'#777',weight:1,fillColor:'#ccc',fillOpacity:0.4};
      const cts={yes:0,no:0,undecided:0};
      for(const r of rows){ const a=ynuNormalize(r[issue]); if(cts.hasOwnProperty(a)) cts[a]++; }
      const total=cts.yes+cts.no+cts.undecided;
      if(!total) return {color:'#777',weight:1,fillColor:'#ccc',fillOpacity:0.4};
      let fill='#cccccc';
      if(cts.yes>=cts.no && cts.yes>=cts.undecided) fill='#2c7a2c';
      else if(cts.no>=cts.yes && cts.no>=cts.undecided) fill='#b22222';
      else fill='#b38f00';
      return {color:'#555',weight:1,fillColor:fill,fillOpacity:0.35};
    });

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

  function buildName(row){
    const fn=normalize(row['__FirstName']);
    const ln=normalize(row['__LastName']);
    const combo=(fn+' '+ln).replace(/\s+/g,' ').trim();
    if(combo) return combo;
    const mix=normalize(row['__NameMixed']);
    if(mix) return mix.replace(/\s*<[^>]*>/g,'').replace(/\b\S+@\S+\.\S+\b/g,'').replace(/\s+/g,' ').trim()||'(name)';
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
    `;
  }

  // Diagnostics
  console.log('Header1 First/Last indices:', {firstIdx: survey.firstIdx, lastIdx: survey.lastIdx});
  console.log('Issue columns (first 10):', survey.issueColumns.slice(0,10));
  console.log('Total survey rows:', survey.rows.length);
});
