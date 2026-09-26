// Garmin activity summaries stay on this device, alongside the existing run log.
let garminPending=null;
let garminChoices={};
let garminReadVersion=0;

function parseGarminCSV(text){
  text=text.replace(/^\uFEFF/,'');
  const rows=[];
  let row=[],field='',quoted=false,closed=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){
      if(c==='"'){
        if(text[i+1]==='"'){field+='"';i++;}
        else {quoted=false;closed=true;}
      }else field+=c;
    }else if(c===','){row.push(field);field='';closed=false;}
    else if(c==='\r'||c==='\n'){
      if(c==='\r'&&text[i+1]==='\n')i++;
      row.push(field);if(row.some(v=>v.trim()))rows.push(row);
      row=[];field='';closed=false;
    }else if(c==='"'&&!field&&!closed)quoted=true;
    else if(closed||c==='"')throw Error('CSV 格式不完整，請重新從 Garmin 匯出');
    else field+=c;
  }
  if(quoted)throw Error('CSV 引號未結束，請重新匯出');
  row.push(field);if(row.some(v=>v.trim()))rows.push(row);
  if(rows.length<2)throw Error('檔案沒有活動資料');
  const headers=rows.shift().map(v=>v.trim().toLowerCase());
  const column=names=>headers.findIndex(h=>names.includes(h));
  const typeCol=column(['活動類型','activity type']);
  const dateCol=column(['日期','date']);
  const distanceCol=column(['距離','distance']);
  if([typeCol,dateCol,distanceCol].some(i=>i<0))throw Error('請選擇「所有活動 → 匯出 CSV」的檔案，需包含活動類型、日期和距離');
  const activities=[];
  let other=0,invalid=0;
  const runningTypes=new Set(['跑步','跑步機','越野跑步','越野跑','室內跑步','虛擬跑步','running','treadmill running','trail running','indoor running','virtual running','track running','跑道跑步','超級馬拉松','ultra running']);
  rows.forEach(values=>{
    const type=(values[typeCol]||'').trim();
    if(!runningTypes.has(type.toLowerCase())){other++;return;}
    const start=(values[dateCol]||'').trim().replace('T',' ');
    const match=/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(start);
    const raw=(values[distanceCol]||'').trim();
    const distance=/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)?Number(raw.replace(/,/g,'')):NaN;
    let valid=!!match&&values.length===headers.length&&Number.isFinite(distance)&&distance>0;
    if(match){
      const [,y,m,d,h,min,s]=match.map(Number);
      const date=new Date(Date.UTC(y,m-1,d));
      valid=valid&&y>=2020&&y<=2099&&date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d&&h<24&&min<60&&s<60;
    }
    if(!valid){invalid++;return;}
    activities.push({date:start.slice(0,10),start,type,distance,source:'garmin',sourceKey:'garmin:'+start});
  });
  return {activities,other,invalid};
}

function planGarminImport(parsed,unit,existing,choices){
  const seen=new Set(existing.filter(r=>r.sourceKey).map(r=>r.sourceKey));
  const candidates=[];
  let duplicates=0;
  parsed.activities.forEach(activity=>{
    if(seen.has(activity.sourceKey)){duplicates++;return;}
    seen.add(activity.sourceKey);
    candidates.push({...activity,km:Math.round(activity.distance*(unit==='mi'?1.609344:1)*100000)/100000});
  });
  const conflicts=[...new Set(candidates.filter(a=>existing.some(r=>r.date===a.date&&r.source!=='garmin')).map(a=>a.date))];
  const unresolved=conflicts.filter(date=>!['skip','replace','add'].includes(choices[date]));
  const added=candidates.filter(a=>!conflicts.includes(a.date)||['replace','add'].includes(choices[a.date]));
  const replaceDates=new Set(conflicts.filter(date=>choices[date]==='replace'));
  const retained=existing.filter(r=>r.source==='garmin'||!replaceDates.has(r.date));
  return {candidates,duplicates,conflicts,unresolved,added,retained,removed:existing.length-retained.length};
}

async function readGarminFile(input){
  const file=input.files[0];
  input.value='';
  if(!file)return;
  cancelGarminImport();
  const version=garminReadVersion;
  const message=document.getElementById('garmin-message');
  message.textContent='正在讀取…';
  try{
    if(file.size>10*1024*1024)throw Error('檔案太大，請在 Garmin 篩選較短期間後再匯出');
    const text=await file.text();
    if(version!==garminReadVersion)return;
    garminPending=parseGarminCSV(text);
    if(!garminPending.activities.length)throw Error(`沒有可匯入的跑步活動（其他活動 ${garminPending.other} 筆、格式或距離異常 ${garminPending.invalid} 筆）`);
    document.getElementById('garmin-filename').textContent=file.name;
    document.getElementById('garmin-preview').hidden=false;
    message.textContent='';
    previewGarmin();
  }catch(err){
    if(version!==garminReadVersion)return;
    garminPending=null;
    message.textContent=err.message||'讀取失敗，請重新選取 CSV';
  }
}

function previewGarmin(){
  if(!garminPending)return;
  const unit=document.getElementById('garmin-unit').value;
  const plan=planGarminImport(garminPending,unit,runLog,garminChoices);
  const total=plan.added.reduce((sum,r)=>sum+r.km,0);
  document.getElementById('garmin-summary').textContent=unit
    ?`將新增 ${plan.added.length} 筆，共 ${total.toFixed(2)} km；略過重複 ${plan.duplicates} 筆、其他活動 ${garminPending.other} 筆、異常 ${garminPending.invalid} 筆。${plan.removed?'將取代 '+plan.removed+' 筆手動紀錄。':''}`
    :`讀到 ${garminPending.activities.length} 筆跑步活動，請先確認匯出時的距離單位。`;
  const conflicts=plan.conflicts.map(date=>{
    const oldTotal=runLog.filter(r=>r.date===date&&r.source!=='garmin').reduce((sum,r)=>sum+Number(r.km),0);
    return `<div class="garmin-row"><label for="garmin-${date}">${date} 已有手動紀錄 ${oldTotal.toFixed(2)} km</label><select class="garmin-select" id="garmin-${date}" onchange="garminChoices['${date}']=this.value;previewGarmin()"><option value="">請選擇處理方式</option>${[['skip','保留手動紀錄，略過這天匯入'],['replace','以匯入資料取代這天手動紀錄'],['add','這是另外的跑步，全部保留']].map(([value,label])=>`<option value="${value}" ${garminChoices[date]===value?'selected':''}>${label}</option>`).join('')}</select></div>`;
  }).join('');
  document.getElementById('garmin-list').innerHTML=conflicts+plan.candidates.map(a=>`<div class="garmin-row">${a.start} · ${escHtml(a.type)}<br>${unit?a.km.toFixed(2)+' km':a.distance+'（單位待確認）'}${plan.conflicts.includes(a.date)&&garminChoices[a.date]==='skip'?' · 將略過':''}</div>`).join('');
  document.getElementById('garmin-confirm').disabled=!unit||!!plan.unresolved.length||!plan.added.length;
}

function confirmGarminImport(){
  if(!garminPending)return;
  const unit=document.getElementById('garmin-unit').value;
  const plan=planGarminImport(garminPending,unit,runLog,garminChoices);
  if(!['km','mi'].includes(unit)||plan.unresolved.length||!plan.added.length){previewGarmin();return;}
  const next=[...plan.retained,...plan.added.map(a=>({...a,id:uid()}))];
  try{localStorage.setItem(RUN_KEY,JSON.stringify(next));}
  catch(err){document.getElementById('garmin-message').textContent='儲存失敗，原有跑量未變更。請釋放儲存空間後重試。';return;}
  runLog=next;
  cancelGarminImport();
  renderRun();
  document.getElementById('garmin-message').textContent=`已匯入 ${plan.added.length} 筆 Garmin 跑步紀錄，月跑量與年跑量已更新。`;
  showToast('✓ Garmin 跑量已匯入');
}

function cancelGarminImport(){
  garminReadVersion++;
  garminPending=null;
  garminChoices={};
  document.getElementById('garmin-preview').hidden=true;
  document.getElementById('garmin-unit').value='';
  document.getElementById('garmin-message').textContent='';
}

// Import a compact, private transfer link. Fragments are not sent to the server.
function importGarminLink(){
  if(!location.hash.startsWith('#garmin-km='))return;
  const payload=location.hash.slice('#garmin-km='.length);
  history.replaceState(null,'',location.pathname+location.search);
  switchTab('run');
  try{
    if(!payload||payload.length>50000)throw Error('匯入連結不完整，請重新開啟');
    const lines=payload.split(';').map(row=>{
      if(!/^[rt],\d{8}T\d{6},\d+(?:\.\d+)?$/.test(row))throw Error('匯入連結格式不正確');
      const [kind,stamp,km]=row.split(',');
      const date=`${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)} ${stamp.slice(9,11)}:${stamp.slice(11,13)}:${stamp.slice(13,15)}`;
      return `${kind==='t'?'跑步機':'跑步'},${date},${km}`;
    });
    const parsed=parseGarminCSV('活動類型,日期,距離\n'+lines.join('\n'));
    if(parsed.invalid||!parsed.activities.length)throw Error('匯入連結包含無效日期或距離');
    garminPending=parsed;
    garminChoices={};
    document.getElementById('garmin-filename').textContent='Garmin 跑量匯入連結（公里）';
    document.getElementById('garmin-unit').value='km';
    document.getElementById('garmin-preview').hidden=false;
    const plan=planGarminImport(parsed,'km',runLog,garminChoices);
    if(plan.unresolved.length){
      previewGarmin();
      document.getElementById('garmin-message').textContent='部分日期已有手動紀錄，請先選擇保留或取代，避免重複計算。';
    }else if(!plan.added.length){
      cancelGarminImport();
      document.getElementById('garmin-message').textContent='這些跑步紀錄已經匯入，不會重複計算。';
    }else confirmGarminImport();
  }catch(err){
    cancelGarminImport();
    document.getElementById('garmin-message').textContent=err.message||'無法讀取匯入連結';
  }
}
window.addEventListener('hashchange',importGarminLink);
importGarminLink();
