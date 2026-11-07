'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const PORT=Number(process.env.PORT)||3000;
const ROOT=__dirname;
const LIST_URL='https://api-channel.sooplive.com/v1.3/channel/pumong/vod/review?startDate=&endDate=&keyword=&orderBy=reg_date&perPage=60&page=';
const LIST_TAIL='&field=title%2Ccontents%2Cuser_nick%2Cuser';
const HEADERS={'User-Agent':'Mozilla/5.0','Referer':'https://www.sooplive.com/','Accept':'application/json'};
let rawItems=[],lastFull=0,details=new Map(),lastRefresh=0,working=null,snapshot=null,lastError='';
let detailJob=null,detailProgress={checked:0,total:0,failed:0,running:false,finishedAt:null};
const DETAIL_INTERVAL=5*60*1000;
const DETAIL_CONCURRENCY=4;
const get=(o,...keys)=>{for(const k of keys)if(o&&o[k]!==undefined&&o[k]!==null)return o[k];return null};
const nonneg=v=>v!==null&&v!==undefined&&v!==''&&Number.isSafeInteger(Number(v))&&Number(v)>=0?Number(v):null;
function findList(node,depth=0){if(depth>8||!node||typeof node!=='object')return null;if(Array.isArray(node)){if(node.some(x=>get(x,'titleNo','title_no')!==null))return node;for(const x of node){const y=findList(x,depth+1);if(y)return y;}return null;}for(const x of Object.values(node)){const y=findList(x,depth+1);if(y)return y;}return null;}
async function request(url,opts={}){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),12000);try{const r=await fetch(url,{...opts,signal:controller.signal});if(!r.ok)throw Error('SOOP HTTP '+r.status);return await r.json();}finally{clearTimeout(timer);}}
async function loadList(){const first=findList(await request(LIST_URL+'1'+LIST_TAIL,{headers:HEADERS}));if(!first)throw Error('SOOP 목록 응답 형식 변경');const now=Date.now();const full=!rawItems.length||now-lastFull>=30*60*1000;const seen=new Set();const result=[];const append=batch=>{let n=0;for(const v of batch){const id=String(get(v,'titleNo','title_no')??'');if(/^\d+$/.test(id)&&!seen.has(id)){seen.add(id);result.push(v);n++;}}return n;};append(first);
 if(full){for(let page=2;page<=100&&page-1<=Math.ceil(6000/60);page++){let batch;try{batch=findList(await request(LIST_URL+page+LIST_TAIL,{headers:HEADERS}));}catch(e){if(!rawItems.length)throw e;break;}if(!batch||!batch.length||!append(batch)||batch.length<60)break;}lastFull=now;}else{append(rawItems);}rawItems=result;}
function normalize(item){const id=String(get(item,'titleNo','title_no'));const d=details.get(id)||{};const ucc=get(item,'ucc');let thumb=get(item,'thumbnail','thumbnailUrl','thumbnail_url','thumb','thumbUrl','snapshot')??get(ucc,'thumb','thumbnail','snapshot');if(thumb&&typeof thumb==='object')thumb=get(thumb,'url','thumb','image');return {id,title:String(get(item,'titleName','title_name','title','full_title')??'제목 없음'),views:d.views??null,live:d.live??null,created:get(item,'regDate','reg_date','write_tm'),thumbnail:(typeof thumb==='string'?thumb:null)||d.thumbnail||null,restriction:d.restriction??null,restrictionReason:d.restrictionReason||'',accessGrade:d.accessGrade??null,detailVerified:d.verified===true};}
async function updateOne(item){
 const id=String(get(item,'titleNo','title_no'));
 try{const body=new URLSearchParams({nTitleNo:id,nApiLevel:'11',nPlaylistIdx:'0'});const json=await request('https://api.m.sooplive.com/station/video/a/view',{method:'POST',headers:{'User-Agent':'Mozilla/5.0','Referer':'https://vod.sooplive.com/player/'+id,'Origin':'https://vod.sooplive.com','Accept':'application/json','Content-Type':'application/x-www-form-urlencoded'},body});const d=json.data;if(String(get(d,'title_no','titleNo'))!==id)throw Error('ID mismatch');const views=nonneg(get(d,'view_cnt')),live=nonneg(get(d,'live_total_view'));if(views===null||live===null)throw Error('missing views');const grade=get(d,'grade'),paid=get(d,'is_paid'),ppv=get(d,'is_ppv'),pub=get(d,'is_public');const yes=x=>x===true||x===1||x==='1'||x==='True';const no=x=>x===false||x===0||x==='0'||x==='False';let restriction=null,restrictionReason='';if(no(pub)){restriction='private';restrictionReason='비공개 표시';}else if(yes(ppv)||yes(paid)){restriction='paid';restrictionReason='유료 시청 표시';}else if(grade!==null&&/^\d+$/.test(String(grade))&&Number(grade)>0){restriction='age_possible';restrictionReason='시청 등급 제한 추정';}let thumbnail=get(d,'thumb','thumbnail','snapshot');if(!thumbnail&&Array.isArray(d.files))thumbnail=get(d.files[0],'snapshot');details.set(id,{views,live,accessGrade:grade,restriction,restrictionReason,thumbnail:typeof thumbnail==='string'?thumbnail:null,verified:true});
 }catch(e){detailProgress.failed++;}
 finally{detailProgress.checked++;}
}
function startDetailJob(){
 if(detailJob||!rawItems.length)return;
 const items=[...rawItems];detailProgress={checked:0,total:items.length,failed:0,running:true,finishedAt:null};
 let next=0;
 detailJob=(async()=>{
   const worker=async()=>{while(next<items.length){const item=items[next++];await updateOne(item);}};
   await Promise.all(Array.from({length:Math.min(DETAIL_CONCURRENCY,items.length)},worker));
 })().catch(e=>{lastError=e.message;}).finally(()=>{
   detailProgress.running=false;detailProgress.finishedAt=new Date().toISOString();
   lastRefresh=Date.now();detailJob=null;
 });
}
async function refreshList(){
 if(working)return working;
 working=loadList().then(()=>{
   snapshot=true;
   if(!detailJob)startDetailJob();
 }).catch(e=>{lastError=e.message;if(!snapshot)throw e;}).finally(()=>{working=null;});
 return working;
}
function getSnapshot(){return {items:rawItems.map(normalize),count:rawItems.length,detailProgress,updatedAt:detailProgress.finishedAt,warning:lastError||null};}
const html=fs.readFileSync(path.join(ROOT,'index.html'));
const server=http.createServer(async(req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname;res.setHeader('Cache-Control','no-store');if(pathname==='/'||pathname==='/index.html'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return;}if(pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,updatedAt:detailProgress.finishedAt||null}));return;}if(pathname==='/api/vods'){
 try{
   if(!snapshot)await refreshList();
   else if(!working&&Date.now()-lastFull>=30*60*1000)refreshList().catch(e=>console.error('SOOP list:',e.message));
   if(!detailJob&&rawItems.length&&(!lastRefresh||Date.now()-lastRefresh>=DETAIL_INTERVAL))startDetailJob();
   res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});
   res.end(JSON.stringify(getSnapshot()));
 }catch(e){res.writeHead(502,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'SOOP 정보 수집 실패: '+e.message}));}
 return;
}res.writeHead(404);res.end('Not found');});
server.listen(PORT,'0.0.0.0',()=>console.log('우몽 VOD 체크:',PORT));
