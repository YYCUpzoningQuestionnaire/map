/* voter_guide.js — Mobile FULL-SCREEN bottom sheet; right drawer on desktop
   - On phones, drawer = 100vw x 100vh, slides up (translateY)
   - On desktop, drawer = min(420px, 92vw) at right, slides in (translateX)
   - Uses visualViewport to detect true device width
   - Striped ward fills by response mix; per-ward drawer with filters; mayor marker

   Requires (before this file): Leaflet, Papa Parse, @turf/turf
   Assets: wards.geojson, survey.csv
*/

window.addEventListener('DOMContentLoaded', async () => {
  const WARDS_PATH  = 'wards.geojson';
  const SURVEY_PATH = 'survey.csv';

  // ---- knobs you can tweak ----
  const STRIPE_SIZE = 25;                 // px: stripe tile size
  const CITY_HALL = { lat: 51.0453, lng: -114.0580 };
  const DESKTOP_WIDTH_PX = 420;
  const MOBILE_BREAKPOINT = 900;          // a bit higher to catch high-DPR phones

  const COLORS = { yes:'#2c7a2c', no:'#b22222', undecided:'#b38f00', nodata:'#cccccc' };
  const SVGNS = 'http://www.w3.org/2000/svg';

  // Global state
  let currentFilteredByWard = new Map();
  let drawer = null, drawerOverlay = null, drawerTitle = null, drawerIssueSel = null,
      drawerAnsSel = null, drawerSearch = null, drawerTableBody = null, currentWardKey = null,
      drawerMode = 'desktop';

  const normalize = v => (v == null ? '' : String(v).trim());
  const lc = s => s.toLowerCase();

  const viewportWidth = () => {
    if (window.visualViewport && window.visualViewport.width) return window.visualViewport.width;
    return Math.min(window.innerWidth || 0, screen.width || 0) || window.innerWidth;
  };
  const isMobile = () => viewportWidth() < MOBILE_BREAKPOINT;

  async function loadJSON(path){ const r=await fetch(path); if(!r.ok) throw new Error(`${path}: ${r.status}`); return r.json(); }
  async function loadCSV(path){ const r=await fetch(path); if(!r.ok) throw new Error(`${path}: ${r.status}`); const t=await r.text(); return Papa.parse(t,{skipEmptyLines:'greedy'}); }

  function ynuNormalize(s){ const t=lc(normalize(s)); return (t==='yes'||t==='no'||t==='undecided')?t:''; }
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function truncate(s,n=180){ const t=normalize(s); return t.length<=n?t:t.slice(0,n-1)+'…'; }

  // ---------- Survey cleaning (handles 2-row headers + ward slice + per-issue comments) ----------
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
    const wardSlice=(idxStart>=0 && idxEndFallback>idxStart)?{start:idxStart,end:idxEndFallback}:null;

    const ffillHeaders=[];
    for(let i=0;i<header0.length;i++){
      const h=header0[i];
      ffillHeaders[i]=(h && !/^Unnamed/i.test(h)) ? h : (i>0 ? ffillHeaders[i-1] : '');
    }

    const skipIdx=new Set();
    if(wardSlice) for(let i=wardSlice.start;i<wardSlice.end;i++) skipIdx.add(i);

    const groups={};
    ffillHeaders.forEach((h,i)=>{ if(!h||skipIdx.has(i)) return; const k=h.trim(); (groups[k]??=[]).push(i); });

    // lock First/Last from header1
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

  // --- Map ---
  const mapEl=document.getElementById('map');
  if(!mapEl){ console.error('Missing <div id="map">'); return; }

  const map=L.map('map', { tap:false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors'}).addTo(map);
  const polygonLayer=L.geoJSON(null,{style:()=>({color:'#555',weight:1,fillOpacity:0.35})}).addTo(map);
  const markerGroup=L.layerGroup().addTo(map);

  const wardsGeo=await loadJSON(WARDS_PATH);
  polygonLayer.addData(wardsGeo);
  try{ map.fitBounds(polygonLayer.getBounds(),{padding:[20,20]}); }catch{}

  const survey=cleanSurveyFromPapa(await loadCSV(SURVEY_PATH));

  function getSVGRoot(){ const pane=map.getPanes().overlayPane; return pane?pane.querySelector('svg'):null; }
  function ensureDefs(){
    const svg=getSVGRoot(); if(!svg) return null;
    let defs=svg.querySelector('defs'); if(!defs){ defs=document.createElementNS(SVGNS,'defs'); svg.insertBefore(defs, svg.firstChild); }
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
    try{ const com=turf.centerOfMass(f).geometry.coordinates; lng=com[0]; lat=com[1]; if(!isFinite(lat)||!isFinite(lng)) throw 0; }
    catch{ try{ const cen=turf.centroid(f).geometry.coordinates; lng=cen[0]; lat=cen[1]; if(!isFinite(lat)||!isFinite(lng)) throw 0; }
    catch{ try{ const c=L.geoJSON(f).getBounds().getCenter(); lat=c.lat; lng=c.lng; }catch{} } }
    wardCenters.push({key,name:disp,lat,lng});
  }

  // Group rows by ward key + mayoral rows
  const byWardAll=new Map(); const mayorAll=[];
  for(const row of survey.rows){
    const rawWard=String(row['__Ward']||'');
    if(/mayor/i.test(rawWard)){ mayorAll.push(row); continue; }
    const m=rawWard.match(/\d+/); const k=m?String(parseInt(m[0],10)):'';
    if(!k) continue;
    if(!byWardAll.has(k)) byWardAll.set(k,[]);
    byWardAll.get(k).push(row);
  }

  // --- UI ---
  injectControlUI();
  buildDrawerUI();

  function injectControlUI(){
    const wrap=document.createElement('div');
    Object.assign(wrap.style,{position:'absolute',top:'12px',left:'12px',zIndex:1000,background:'white',border:'1px solid #ccc',borderRadius:'12px',padding:'8px 10px',fontSize:'15px',boxShadow:'0 1px 6px rgba(0,0,0,0.08)'});

    const title=document.createElement('div');
    Object.assign(title.style,{fontWeight:'600',marginBottom:'6px'}); title.textContent='Question Filter';

    const issueSel=document.createElement('select');
    issueSel.style.marginRight='6px'; issueSel.style.maxWidth='360px'; issueSel.title='Issue';
    const optAny=document.createElement('option'); optAny.value=''; optAny.textContent='(Select a question)'; issueSel.appendChild(optAny);
    for(const c of survey.issueColumns){ const o=document.createElement('option'); o.value=c; o.textContent=c; issueSel.appendChild(o); }

    const ansSel=document.createElement('select');
    ansSel.style.marginLeft='6px';
    for(const v of ['(Any)','Yes','No','Undecided']){ const o=document.createElement('option'); o.value=(v==='(Any)')?'':v; o.textContent=v; ansSel.appendChild(o); }

    const legend=document.createElement('div');
    legend.style.marginTop='8px'; legend.style.color='#444';
    legend.innerHTML=`<div style="margin-bottom:4px"><b>Ward fill:</b> striped by response mix (tile ${STRIPE_SIZE}px)</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${sw(COLORS.yes)} Yes ${sw(COLORS.no)} No ${sw(COLORS.undecided)} Undecided ${sw(COLORS.nodata)} No data
        <span style="margin-left:12px">🏛️ = Mayoral candidates</span>
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

  // --- Pattern helpers ---
  function ensurePattern(id, segments){
    const defs=ensureDefs(); if(!defs) return null;
    let pat=defs.querySelector(`#${CSS.escape(id)}`);
    if(pat){ while(pat.firstChild) pat.removeChild(pat.firstChild); }
    else{ pat=document.createElementNS(SVGNS,'pattern'); pat.setAttribute('id',id); pat.setAttribute('patternUnits','userSpaceOnUse'); pat.setAttribute('width',STRIPE_SIZE); pat.setAttribute('height',STRIPE_SIZE); defs.appendChild(pat); }
    const bg=document.createElementNS(SVGNS,'rect'); bg.setAttribute('x','0'); bg.setAttribute('y','0'); bg.setAttribute('width',STRIPE_SIZE); bg.setAttribute('height',STRIPE_SIZE); bg.setAttribute('fill',COLORS.nodata); pat.appendChild(bg);
    let sum=segments.reduce((a,s)=>a+Math.max(0,s.frac||0),0); if(sum<=0) return pat;
    let x=0; for(const s of segments){ const w=(Math.max(0,s.frac||0)/sum)*STRIPE_SIZE; if(w<=0) continue;
      const rect=document.createElementNS(SVGNS,'rect'); rect.setAttribute('x',String(x)); rect.setAttribute('y','0'); rect.setAttribute('width',String(w)); rect.setAttribute('height',STRIPE_SIZE); rect.setAttribute('fill',s.color); pat.appendChild(rect); x+=w; }
    return pat;
  }
  function setLayerPatternFill(layer, patternId){
    const path=layer._path; if(!path) return;
    path.setAttribute('fill',`url(#${patternId})`);
    path.setAttribute('fill-opacity','0.45');
    path.setAttribute('stroke','#555'); path.setAttribute('stroke-width','1');
  }
  function wardKeyFromFeature(feature){
    const p=feature.properties||{};
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
      byWard.set(k,list);
    }
    let mayorFiltered=mayorAll;
    if(issue){
      mayorFiltered=mayorAll.filter(r=>{
        const ans=ynuNormalize(r[issue]);
        if(!wantValue) return ans!==''; return ans===lc(wantValue);
      });
    }

    polygonLayer.setStyle(()=>({color:'#555',weight:1,fillOpacity:0.35}));

    requestAnimationFrame(()=> {
      polygonLayer.eachLayer(layer=>{
        const key=wardKeyFromFeature(layer.feature);
        const rows=byWard.get(key)||[];
        let yes=0,no=0,und=0;
        if(issue){
          for(const r of rows){
            const a=ynuNormalize(r[issue]);
            if(a==='yes') yes++; else if(a==='no') no++; else if(a==='undecided') und++;
          }
        }
        const total=yes+no+und;
        const segments = (!issue||total===0)
          ? [{color:COLORS.nodata,frac:1}]
          : [{color:COLORS.yes,frac:yes},{color:COLORS.no,frac:no},{color:COLORS.undecided,frac:und}];
        const patId=`wardStripe-${key}-${hashSegments(segments)}`;
        ensurePattern(patId,segments); setLayerPatternFill(layer,patId);
      });
    });

    markerGroup.clearLayers();

    for(const wc of wardCenters){
      if(!isFinite(wc.lat)||!isFinite(wc.lng)) continue;
      const list=byWard.get(wc.key)||[];
      const items=list.map(r=>{
        const name=buildName(r);
        const ans=issue?(r[issue]||''):'';
        let comm=''; if(issue){ const cf=survey.commentForIssue[issue]; if(cf) comm=r[cf]||''; }
        const right=issue?` — <b>${escapeHtml(ans||'—')}</b>${comm?` — <span style="color:#555">${escapeHtml(truncate(comm))}</span>`:''}`:'';
        return `<li>${escapeHtml(name)}${right}</li>`;
      }).join('');
      const btn = `<div style="margin-top:8px"><button onclick="window.openWardInNewTab && window.openWardInNewTab('${wc.key}')" style="border:1px solid #bbb;background:#fff;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:16px">See all responses for ${escapeHtml(wc.name)}</button></div>`;
      const html=`<div style="font-size:15px;max-width:320px"><div style="font-weight:600">${wc.name}</div><div>Candidates: ${list.length}${issue?` (Question: <i>${escapeHtml(issue)}</i>)`:''}</div><ul style="max-height:220px;overflow:auto;margin-left:16px;-webkit-overflow-scrolling:touch">${items||'<li><i>No candidates</i></li>'}</ul>${btn}</div>`;
      L.marker([wc.lat,wc.lng]).addTo(markerGroup).bindPopup(html,{maxWidth:340});
    }

    const items=mayorFiltered.map(r=>{
      const name=buildName(r);
      const ans=issue?(r[issue]||''):'';
      let comm=''; if(issue){ const cf=survey.commentForIssue[issue]; if(cf) comm=r[cf]||''; }
      const right=issue?` — <b>${escapeHtml(ans||'—')}</b>${comm?` — <span style="color:#555">${escapeHtml(truncate(comm))}</span>`:''}`:'';
      return `<li>${escapeHtml(name)}${right}</li>`;
    }).join('');
    const mayorBtn = `<div style="margin-top:8px"><button onclick="window.openWardInNewTab && window.openWardInNewTab('mayor')" style="border:1px solid #bbb;background:#fff;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:16px">See all mayoral candidate responses</button></div>`;
    const htmlMayor=`<div style="font-size:15px;max-width:320px"><div style="font-weight:600">Mayoral Candidates (City Hall)</div><div>${issue?`Issue: <i>${escapeHtml(issue)}</i>`:'All issues'} — Matches: ${mayorFiltered.length}</div><ul style="max-height:240px;overflow:auto;margin-left:16px;-webkit-overflow-scrolling:touch">${items || '<li><i>No mayoral candidates match the current filter.</i></li>'}</ul>${mayorBtn}</div>`;
    const mayorIcon=L.divIcon({className:'mayor-icon', html:'<div title="Mayoral candidates" style="font-size:24px;line-height:24px">🏛️</div>', iconSize:[24,24], iconAnchor:[12,12]});
    L.marker([CITY_HALL.lat,CITY_HALL.lng],{icon:mayorIcon,zIndexOffset:1500}).addTo(markerGroup).bindPopup(htmlMayor,{maxWidth:340});

   // updateInfo(byWard,issue,wantValue,mayorFiltered.length);
    currentFilteredByWard = byWard;
  }

  function hashSegments(segments){
    const parts=segments.map(s=>`${s.color}:${Math.round((s.frac||0)*1000)}`).join('|');
    let h=5381; for(let i=0;i<parts.length;i++){ h=((h<<5)+h)+parts.charCodeAt(i); h|=0; }
    return Math.abs(h).toString(36);
  }

  function buildName(row){
    const fn=normalize(row['__FirstName']); const ln=normalize(row['__LastName']);
    const combo=(fn+' '+ln).replace(/\s+/g,' ').trim(); if(combo) return combo;
    const mix=normalize(row['__NameMixed']); if(mix) return mix.replace(/\s*<[^>]*>/g,'').replace(/\b\S+@\S+\b/g,'').replace(/\s+/g,' ').trim()||'(name)';
    return '(name)';
  }

  // Info control
/*  const Info=L.Control.extend({ onAdd:function(){ const d=L.DomUtil.create('div'); Object.assign(d.style,{background:'white',padding:'6px 10px',border:'1px solid #ccc',borderRadius:'8px',fontSize:'15px'}); d.id='info-box'; return d; }});
  map.addControl(new Info({position:'topright'}));
  function updateInfo(byWard, issue, want, mayorCount){
    const box=document.getElementById('info-box'); if(!box) return;
    let total=0; for(const rows of byWard.values()) total+=rows.length;
    box.innerHTML=`<div><b>Survey rows (shown, wards):</b> ${total}</div><div><b>Mayoral rows (shown):</b> ${mayorCount}</div><div><b>Issue:</b> ${escapeHtml(issue||'(No questionselected)')}</div><div><b>Answer filter:</b> ${escapeHtml(want||'(Any)')}</div><div>Ward fill shows mix of Yes / No / Undecided for the current filter. Tile size: ${STRIPE_SIZE}px</div><div>🏛️ marker at City Hall always visible; popup reflects current filter.</div>`;
  }*/

  // ---------- Drawer UI (fixed to body; mobile bottom sheet or desktop side drawer) ----------
  function buildDrawerUI(){
    // overlay
    drawerOverlay=document.createElement('div');
    Object.assign(drawerOverlay.style,{position:'fixed',inset:'0',background:'rgba(0,0,0,0.25)',display:'none',zIndex:9998});
    // removed drawer append
  //  drawerOverlay.addEventListener('click', closeWardDrawer);

    // drawer
    drawer=document.createElement('div');
    Object.assign(drawer.style,{position:'fixed',background:'white',zIndex:9999,display:'flex',flexDirection:'column',overflow:'hidden',transition:'transform 220ms ease-out'});
    document.body.appendChild(drawer);

    function setDrawerMode(){
      if(isMobile()){
        drawerMode='mobile';
        Object.assign(drawer.style,{
          left:'0', right:'0', bottom:'0', top:'auto',
          width:'100vw', height:'100vh',
          borderTop:'1px solid #ccc', borderLeft:'none',
          boxShadow:'0 -2px 10px rgba(0,0,0,0.12)',
          transform:'translateY(100%)'
        });
      }else{
        drawerMode='desktop';
        Object.assign(drawer.style,{
          top:'0', bottom:'0', right:'0', left:'auto',
          width:`min(${DESKTOP_WIDTH_PX}px, 92vw)`, height:'100vh',
          borderLeft:'1px solid #ccc', borderTop:'none',
          boxShadow:'-2px 0 10px rgba(0,0,0,0.12)',
          transform:'translateX(100%)'
        });
      }
    }
    setDrawerMode();
    window.addEventListener('resize', setDrawerMode);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', setDrawerMode);

    // header
    const header=document.createElement('div');
    Object.assign(header.style,{padding:'10px 12px',borderBottom:'1px solid #eee',display:'flex',alignItems:'center',gap:'8px',flex:'0 0 auto'});
    const closeBtn=document.createElement('button'); closeBtn.textContent='✕';
    Object.assign(closeBtn.style,{border:'1px solid #bbb',background:'#fff',borderRadius:'8px',padding:'6px 10px',cursor:'pointer',fontSize:'17px'});
    closeBtn.addEventListener('click', closeWardDrawer);
    drawerTitle=document.createElement('div');
    Object.assign(drawerTitle.style,{fontWeight:'700',fontSize:'17px',flex:'1 1 auto',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'});
    header.appendChild(closeBtn); header.appendChild(drawerTitle); drawer.appendChild(header);

    // controls
    const controls=document.createElement('div');
    Object.assign(controls.style,{padding:'8px 12px',borderBottom:'1px solid #eee',display:'grid',gridTemplateColumns:'1fr 1fr',gap:'8px',flex:'0 0 auto'});
    drawerIssueSel=document.createElement('select');
    const optAll=document.createElement('option'); optAll.value=''; optAll.textContent='(All issues)'; drawerIssueSel.appendChild(optAll);
    for(const c of survey.issueColumns){ const o=document.createElement('option'); o.value=c; o.textContent=c; drawerIssueSel.appendChild(o); }
    drawerAnsSel=document.createElement('select');
    for(const v of ['(Any answer)','Yes','No','Undecided']){ const o=document.createElement('option'); o.value=(v==='(Any answer)')?'':v; o.textContent=v; drawerAnsSel.appendChild(o); }
    drawerSearch=document.createElement('input'); drawerSearch.type='search'; drawerSearch.placeholder='Search comments…'; drawerSearch.style.gridColumn='1 / span 2';
    controls.appendChild(drawerIssueSel); controls.appendChild(drawerAnsSel); controls.appendChild(drawerSearch);
    drawer.appendChild(controls);

    // table
    const tableWrap=document.createElement('div');
    Object.assign(tableWrap.style,{flex:'1 1 auto',overflow:'auto',WebkitOverflowScrolling:'touch',overscrollBehavior:'contain'});
    const table=document.createElement('table');
    Object.assign(table.style,{width:'100%',borderCollapse:'collapse',fontSize:'15px'});
    table.innerHTML=`<thead style="position:sticky;top:0;background:#fafafa;z-index:1"><tr>
      <th style="text-align:left;border-bottom:1px solid #eee;padding:8px;white-space:nowrap">Candidate</th>
      <th style="text-align:left;border-bottom:1px solid #eee;padding:8px">Issue</th>
      <th style="text-align:left;border-bottom:1px solid #eee;padding:8px;white-space:nowrap">Answer</th>
      <th style="text-align:left;border-bottom:1px solid #eee;padding:8px">Comment</th>
    </tr></thead><tbody></tbody>`;
    drawerTableBody=table.querySelector('tbody');
    tableWrap.appendChild(table); drawer.appendChild(tableWrap);

    // Filtering is now handled in the new tab's JavaScript

    window.openWardInNewTab=openWardInNewTab;
    // Keep these for backward compatibility
    window.openWardDrawer=openWardInNewTab;
    window.closeWardDrawer=closeWardDrawer;
  }

  function openWardInNewTab(wardKey) {
    const wardKey_safe = String(wardKey || '');
    
    // Special case for mayoral candidates
    if (wardKey_safe === 'mayor') {
      const rows = mayorAll || [];
      const wardName = "Mayoral Candidates";
      generateTab(rows, wardName);
      return;
    }
    
    const wc = wardCenters.find(w => w.key === wardKey_safe);
    const rows = (currentFilteredByWard.get(wardKey_safe) || []);
    const wardName = wc ? wc.name : `Ward ${wardKey_safe}`;
    
    generateTab(rows, wardName);
  }
  
  function generateTab(rows, wardName) {
    
    // Generate HTML for the new tab
    let tableRows = [];
    for(const r of rows) {
      const name = buildName(r);
      const candidateIssues = [];
      
      for(const issue of survey.issueColumns) {
        const ansRaw = r[issue] || '';
        const ans = ynuNormalize(ansRaw);
        if(!ans) continue;
        
        const cField = survey.commentForIssue[issue];
        const comment = (cField ? (r[cField] || '') : '');
        
        candidateIssues.push(`
          <div class="issue">
            <div class="issue-name">${escapeHtml(issue)}</div>
            <div class="issue-answer" style="color:${ans==='yes'?COLORS.yes:ans==='no'?COLORS.no:COLORS.undecided}">
              <strong>${ans ? ans[0].toUpperCase() + ans.slice(1) : '—'}</strong>
            </div>
            ${comment ? `<div class="issue-comment">${escapeHtml(comment)}</div>` : ''}
          </div>
        `);
      }
      
      // Always include the candidate even if they have no issues with answers
      tableRows.push(`
        <div class="candidate">
          <h2>${escapeHtml(name)}</h2>
          ${candidateIssues.length ? candidateIssues.join('') : '<div class="no-responses">No responses recorded for any issues.</div>'}
        </div>
      `);
    }
    
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>All Responses - ${escapeHtml(wardName)}</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            line-height: 1.5;
            margin: 0;
            padding: 20px;
            color: #333;
          }
          header {
            background: #f5f5f5;
            padding: 15px 20px;
            margin: -20px -20px 20px -20px;
            border-bottom: 1px solid #ddd;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          h1 {
            margin: 0;
            font-size: 24px;
          }
          .controls {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
          }
          select, input {
            padding: 8px 10px;
            border: 1px solid #ddd;
            border-radius: 4px;
          }
          input[type="search"] {
            flex: 1;
          }
          .candidate {
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 1px solid #eee;
          }
          .candidate h2 {
            margin-top: 0;
            padding-bottom: 8px;
            border-bottom: 1px solid #f0f0f0;
          }
          .issue {
            margin-bottom: 15px;
            padding-left: 15px;
            border-left: 3px solid #f0f0f0;
          }
          .issue-name {
            font-weight: 600;
            margin-bottom: 5px;
          }
          .issue-comment {
            margin-top: 5px;
            color: #555;
            font-style: italic;
          }
          .no-responses {
            padding: 15px;
            color: #666;
            font-style: italic;
            background-color: #f9f9f9;
            border-radius: 4px;
            border-left: 3px solid #ddd;
          }
          .back-button {
            padding: 10px 20px;
            background-color: #f5f5f5;
            border: 1px solid #ddd;
            border-radius: 4px;
            cursor: pointer;
            font-size: 16px;
            margin-top: 20px;
          }
          .back-button:hover {
            background-color: #e9e9e9;
          }
          @media (max-width: 600px) {
            .controls {
              flex-direction: column;
            }
            input[type="search"] {
              width: 100%;
            }
          }
        </style>
      </head>
      <body>
        <header>
          <h1>All Responses - ${escapeHtml(wardName)}</h1>
          <button class="back-button" onclick="window.close()">Close</button>
        </header>
        
        <div class="controls">
          <select id="issueFilter">
            <option value="">All Questions</option>
            ${survey.issueColumns.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}
          </select>
          <select id="answerFilter">
            <option value="">Any Answer</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
            <option value="undecided">Undecided</option>
          </select>
          <input type="search" id="commentSearch" placeholder="Search comments...">
        </div>
        
        <div id="candidates">
          ${tableRows.length ? tableRows.join('') : '<p>No candidates found for this ward.</p>'}
        </div>
        
        <script>
          // Simple filtering functionality
          const issueFilter = document.getElementById('issueFilter');
          const answerFilter = document.getElementById('answerFilter');
          const commentSearch = document.getElementById('commentSearch');
          const candidates = document.querySelectorAll('.candidate');
          
          function applyFilters() {
            const issue = issueFilter.value.toLowerCase();
            const answer = answerFilter.value.toLowerCase();
            const search = commentSearch.value.toLowerCase();
            
            candidates.forEach(candidate => {
              const issues = candidate.querySelectorAll('.issue');
              let showCandidate = false;
              
              issues.forEach(issueEl => {
                const issueName = issueEl.querySelector('.issue-name').textContent.toLowerCase();
                const issueAnswer = issueEl.querySelector('.issue-answer').textContent.toLowerCase();
                const comment = issueEl.querySelector('.issue-comment')?.textContent.toLowerCase() || '';
                
                // Check if this issue matches all filters
                let showIssue = true;
                
                if (issue && issueName !== issue) {
                  showIssue = false;
                }
                
                if (answer && !issueAnswer.includes(answer)) {
                  showIssue = false;
                }
                
                if (search && !comment.includes(search)) {
                  showIssue = false;
                }
                
                if (showIssue) {
                  showCandidate = true;
                  issueEl.style.display = '';
                } else {
                  issueEl.style.display = issue ? 'none' : '';
                }
              });
              
              candidate.style.display = (showCandidate || (!issue && !answer && !search)) ? '' : 'none';
            });
          }
          
          issueFilter.addEventListener('change', applyFilters);
          answerFilter.addEventListener('change', applyFilters);
          commentSearch.addEventListener('input', applyFilters);
        </script>
      </body>
      </html>
    `;
    
    // Open in new tab
    const win = window.open('', '_blank');
    if (win) {
      win.document.write(html);
      win.document.close();
    } else {
      alert('Please allow pop-ups to see ward responses');
    }
  }
  
  // Keep closeWardDrawer for backward compatibility but it's not needed anymore
  function closeWardDrawer() {
    // This function is kept for backward compatibility but doesn't do anything anymore
    console.log('closeWardDrawer called but no action needed with new tab approach');
  }

/* function closeWardDrawer(){
    if(drawer){ if(drawerMode==='mobile') drawer.style.transform='translateY(100%)'; else drawer.style.transform='translateX(100%)'; }
    if(drawerOverlay) drawerOverlay.style.display='none';
    document.documentElement.style.overflow=''; document.body.style.overflow='';
    map.invalidateSize();
  }
*/
  // renderWardDrawer function has been replaced by opening data in a new tab

  // Diagnostics
  console.log('Issue columns (first 10):', survey.issueColumns.slice(0,10));
  console.log('Total survey rows:', survey.rows.length);
});


// openWardInNewTab is now defined within the main function scope
